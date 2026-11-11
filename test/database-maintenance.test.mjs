import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { inspectDatabase, createDatabaseBackup, migrateDatabase, prepareDatabaseRestore, assertDatabaseAvailable, databaseMaintenanceLockPath } from '../src/database-maintenance.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  const store = new Store(path);
  store.setMeta('sample', { value: 'before' }); store.close();
  return { root, path, assertStopped: () => true };
}
const migration = { id: 'v3-example', from: 2, to: 3, up(db) { db.exec('CREATE TABLE example (id TEXT PRIMARY KEY)'); db.prepare('INSERT INTO example VALUES (?)').run('migrated'); } };

test('backup captures consistent state, integrity, identity and a private immutable artifact', async t => {
  const f = fixture(t);
  const before = inspectDatabase(f.path);
  assert.equal(before.schemaVersion, 2); assert.equal(before.integrity, 'ok');
  const backup = await createDatabaseBackup(f);
  assert.equal(backup.source, realpathSync(f.path));
  assert.equal(backup.schemaVersion, 2);
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(statSync(backup.path).mode & 0o777, 0o600);
  const db = new DatabaseSync(backup.path, { readOnly: true });
  try { assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM kv WHERE key=?').get('sample').data), { value: 'before' }); }
  finally { db.close(); }
  await assert.rejects(createDatabaseBackup({ ...f, destination: backup.path }), /Refusing to replace/);
  assert.equal(existsSync(databaseMaintenanceLockPath(f.path)), false);
});

test('idle daemon stop proof and durable owner checks are both required', async t => {
  const f = fixture(t);
  await assert.rejects(createDatabaseBackup({ path: f.path }), /assertStopped/);
  await assert.rejects(createDatabaseBackup({ ...f, assertStopped: () => false }), /not been confirmed stopped/);
  for (const owner of [{ pid: process.pid, host: hostname() }, { pid: process.pid, host: 'unknown-host' }, { pid: -1, host: hostname() }]) {
    const store = new Store(f.path); store.setMeta('execution', owner); store.close();
    await assert.rejects(createDatabaseBackup(f), /live or unverifiable owners/);
  }
  const store = new Store(f.path);
  store.deleteMeta('execution');
  store.db.prepare('INSERT INTO effects(kind,key,payload,due,token,owner) VALUES (?,?,?,?,?,?)').run('reply', 'outbound', '{}', 0, 'claim', JSON.stringify({ pid: process.pid, host: hostname() }));
  store.close();
  await assert.rejects(createDatabaseBackup(f), /effect:reply:outbound/);
});

test('maintenance lock excludes simultaneous maintenance and participating runtime opens', async t => {
  const f = fixture(t);
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const first = createDatabaseBackup({ ...f, assertStopped: () => stopped });
  assert.throws(() => assertDatabaseAvailable(f.path), /maintenance is in progress/);
  await assert.rejects(createDatabaseBackup(f), /EEXIST/);
  release(true); await first;
  assert.doesNotThrow(() => assertDatabaseAvailable(f.path));
});

test('ordered migrations commit one versioned history and leave prior package backup', async t => {
  const f = fixture(t);
  const result = await migrateDatabase({ ...f, targetVersion: 4, migrations: [migration, { id: 'v4-example', from: 3, to: 4, up(db) { db.exec('ALTER TABLE example ADD COLUMN note TEXT'); } }] });
  assert.equal(result.backup.schemaVersion, 2);
  assert.deepEqual(result.applied, ['v3-example', 'v4-example']);
  const facts = inspectDatabase(f.path);
  assert.equal(facts.schemaVersion, 4);
  assert.deepEqual(facts.migrations.map(item => item.toVersion), [3, 4]);
  const current = new Store(f.path); current.close();
  await assert.rejects(migrateDatabase({ ...f, targetVersion: 2, migrations: [] }), /downgrade/);
  const noChange = await migrateDatabase({ ...f, targetVersion: 4 });
  assert.equal(noChange.backup, null);
  const future = new DatabaseSync(f.path); future.exec('PRAGMA user_version=5'); future.close();
  const supported = new Store(f.path);
  supported.db.exec('PRAGMA user_version = 16');
  assert.throws(() => supported.setMeta('unexpected-future-write', true), /Unsupported state schema: 16/);
  assert.equal(supported.getMeta('unexpected-future-write'), undefined);
  supported.close();
  assert.throws(() => new Store(f.path), /Unsupported state schema: 16/);
});

test('later migration failure rolls all schema and data back while retaining snapshot', async t => {
  const f = fixture(t), backupPath = join(f.root, 'before.sqlite');
  await assert.rejects(migrateDatabase({ ...f, backupPath, targetVersion: 4, migrations: [migration, { id: 'v4-fail', from: 3, to: 4, up(db) { db.exec('ALTER TABLE example ADD COLUMN note TEXT'); throw new Error('disk simulation'); } }] }), /original schema 2 retained/);
  assert.equal(existsSync(backupPath), true);
  assert.equal(inspectDatabase(f.path).schemaVersion, 2);
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('example','schema_migrations')").get().n, 0);
    assert.equal(JSON.parse(db.prepare("SELECT data FROM kv WHERE key='sample'").get().data).value, 'before');
  } finally { db.close(); }
  await assert.rejects(migrateDatabase({ ...f, targetVersion: 4, migrations: [migration] }), /Missing migration/);
  await assert.rejects(migrateDatabase({ ...f, targetVersion: 3, migrations: [{ ...migration, up: async () => {} }] }), /synchronous/);
});

test('restore stages a verified snapshot only after external-effects reconciliation', async t => {
  const f = fixture(t), backup = await createDatabaseBackup(f);
  const store = new Store(f.path); store.setMeta('sample', { value: 'after' }); store.close();
  const options = { ...f, backupPath: backup.path, expectedVersion: 2 };
  await assert.rejects(prepareDatabaseRestore(options), /reconciliation/);
  await assert.rejects(prepareDatabaseRestore({ ...options, reconciliation: { backupId: 'other', note: 'checked' } }), /reconciliation/);
  const staged = await prepareDatabaseRestore({ ...options, reconciliation: { backupId: backup.id, note: 'No remote writes occurred after this backup; checked service and delivery records.' } });
  assert.equal(staged.installRequired, true);
  const current = new Store(f.path);
  try { assert.equal(current.getMeta('sample').value, 'after'); }
  finally { current.close(); }
  const restored = new Store(staged.path);
  try { assert.equal(restored.getMeta('sample').value, 'before'); }
  finally { restored.close(); }
});

test('restore rejects tampered, wrong-project and wrong-version backups', async t => {
  const f = fixture(t), backup = await createDatabaseBackup(f);
  const options = { ...f, backupPath: backup.path, expectedVersion: 2, reconciliation: { backupId: backup.id, note: 'reviewed' } };
  await assert.rejects(prepareDatabaseRestore({ ...options, expectedVersion: 1 }), /does not match/);
  const other = fixture(t);
  await assert.rejects(prepareDatabaseRestore({ ...options, path: other.path }), /does not match/);
  const manifest = JSON.parse(readFileSync(backup.manifestPath, 'utf8'));
  writeFileSync(backup.manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
  await assert.rejects(prepareDatabaseRestore(options), /does not match/);
});

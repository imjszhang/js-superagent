import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-store-'));
  const instances = [];
  t.after(() => { for (const store of instances) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { path: join(root, 'state.sqlite'), open() { const store = new Store(this.path); instances.push(store); return store; } };
}
const ticket = id => ({ id, assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-01', updatedAt: '2026-11-01' });

test('SQLite repositories preserve core ordering and return isolated snapshots', t => {
  const f = fixture(t), store = f.open();
  const one = ticket('one'); store.tickets.save(one); store.tickets.save(ticket('two'));
  one.inputs.push({ text: 'not saved' });
  const read = store.tickets.get('one'); read.inputs.push({ text: 'also not saved' });
  assert.equal(store.tickets.get('one').inputs.length, 0);
  assert.deepEqual(store.tickets.list().map(x => x.id), ['two', 'one']);
  store.tickets.save({ ...store.tickets.get('one'), assignments: [{ id: 'a', state: 'pending' }] });
  assert.deepEqual(store.tickets.active().map(x => x.id), ['one']);
  assert.equal(store.tickets.get('missing'), undefined);
  store.threads.save({ key: 'local:t', pending: ['x'], subscriptions: [] });
  store.triggers.save({ id: 'x', text: 'request' });
  store.triggers.saveDisposition('x', { fanout: ['one'] });
  store.decisions.save({ id: 'd', threadKey: 'local:t' });
  store.setMeta('ticket:one', { text: 'first' });
  const second = f.open();
  assert.equal(second.threads.active()[0].key, 'local:t');
  assert.equal(second.triggers.get('x').text, 'request');
  assert.deepEqual(second.triggers.disposition('x'), { fanout: ['one'] });
  assert.equal(second.decisions.byThread('local:t')[0].id, 'd');
  assert.deepEqual(second.listMeta('ticket:'), [{ key: 'ticket:one', value: { text: 'first' } }]);
});

test('nested transactions roll back domain, metadata, queued work and receipts together', t => {
  const store = fixture(t).open(), effects = new Effects(store), outbox = new Outbox(store, effects);
  assert.throws(() => store.atomic(() => {
    store.tickets.save(ticket('bad'));
    store.atomic(() => { store.setMeta('bad', true); effects.enqueue('launch', 'a', {}); });
    outbox.send({ id: 'm', channel: { source: 'local' }, text: 'Hello' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.tickets.get('bad'), undefined);
  assert.equal(store.getMeta('bad'), undefined);
  assert.equal(effects.list().length, 0);
  assert.equal(outbox.list().length, 0);
  store.atomic(() => {
    store.setMeta('keep', true);
    assert.throws(() => store.atomic(() => { store.setMeta('drop', true); throw new Error('inner'); }));
    assert.equal(store.getMeta('keep'), true);
  });
  assert.equal(store.getMeta('drop'), undefined);
  assert.equal(store.getMeta('keep'), true);
  assert.equal(store.inTransaction, false);
  assert.throws(() => store.atomic(async () => {}), /synchronous/);
  assert.throws(() => store.atomic(() => Promise.resolve()), /synchronous/);
  assert.equal(store.inTransaction, false);
});

test('v1 upgrade preserves legacy records and makes a consistent one-time backup', t => {
  const f = fixture(t);
  const before = new DatabaseSync(f.path);
  before.exec('PRAGMA journal_mode=WAL; CREATE TABLE tickets(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1');
  before.prepare('INSERT INTO tickets VALUES (?, ?)').run('old', JSON.stringify({ id: 'old', status: 'queued' }));
  before.close();
  const store = f.open();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(store.legacyList(), [{ id: 'old', status: 'queued' }]);
  assert.deepEqual(store.legacyGet('old'), { id: 'old', status: 'queued' });
  assert.equal(store.legacyGet('missing'), undefined);
  assert.equal(existsSync(`${f.path}.v1-backup`), true);
  const backup = new DatabaseSync(`${f.path}.v1-backup`);
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(backup.prepare('SELECT id FROM tickets').get().id, 'old'); }
  finally { backup.close(); }
  assert.equal(f.open().legacyList().length, 1);
});

test('future database versions are rejected without rewriting their schema', t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version=16'); db.close();
  assert.throws(() => new Store(f.path), /Unsupported state schema: 16/);
  const after = new DatabaseSync(f.path);
  try { assert.equal(after.prepare('PRAGMA user_version').get().user_version, 16); }
  finally { after.close(); }
});


test('v1 live or unverifiable owners are rejected before backup and schema changes', t => {
  for (const [label, owner] of [
    ['live', { host: hostname(), pid: process.pid }],
    ['remote', { host: 'a-different-machine', pid: process.pid }],
    ['invalid', { host: hostname(), pid: -1 }],
  ]) {
    const f = fixture(t), db = new DatabaseSync(f.path);
    const legacy = { id: label, status: 'running', owner };
    db.exec('CREATE TABLE tickets(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1');
    db.prepare('INSERT INTO tickets VALUES (?,?)').run(label, JSON.stringify(legacy));
    db.close();
    assert.throws(() => new Store(f.path), /execution owner/);
    assert.equal(existsSync(`${f.path}.v1-backup`), false);
    const after = new DatabaseSync(f.path);
    try {
      assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1);
      assert.deepEqual(JSON.parse(after.prepare('SELECT data FROM tickets').get().data), legacy);
      assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'domain_%'").get().n, 0);
      assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('kv','effects','receipts')").get().n, 0);
    } finally { after.close(); }
  }
});


test('invalid existing v1 backup prevents upgrade and is never overwritten', t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE tickets(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1');
  db.prepare('INSERT INTO tickets VALUES (?, ?)').run('old', '{"id":"old","status":"queued"}');
  db.close();
  writeFileSync(`${f.path}.v1-backup`, 'incomplete snapshot');
  assert.throws(() => new Store(f.path), /Invalid v1 migration backup/);
  assert.equal(readFileSync(`${f.path}.v1-backup`, 'utf8'), 'incomplete snapshot');
  const after = new DatabaseSync(f.path);
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(after.prepare('SELECT id FROM tickets').get().id, 'old');
    assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'domain_%'").get().n, 0);
  } finally { after.close(); }
});

test('backup validation rejects a wrong-schema snapshot and new snapshots leave no temporary files', t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE tickets(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1'); db.close();
  const invalid = new DatabaseSync(`${f.path}.v1-backup`);
  invalid.exec('CREATE TABLE tickets(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=2'); invalid.close();
  assert.throws(() => new Store(f.path), /Invalid v1 migration backup/);
  rmSync(`${f.path}.v1-backup`);
  const store = f.open();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(readdirSync(join(f.path, '..')).some(name => name.endsWith('.tmp')), false);
});

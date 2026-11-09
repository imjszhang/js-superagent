import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAgent, inspectDatabase, prepareDatabaseRestore } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-schema6-'));
  const runtime = createProjectAgent({ projectRoot: root }).init(), directory = stateDir(root), path = join(directory, 'state.sqlite');
  const store = new Store(path); store.db.exec('PRAGMA user_version=5');
  const failed = { id: 'legacy-failed', status: 'failed', attempts: 2, error: 'Requires inspection', createdAt: '2026-01-01T00:00:00.000Z' };
  store.setMeta('coordination:event:legacy-failed', failed);
  store.setMeta('ticket:old-recovery', { id: 'old-recovery', recovery: { status: 'inspect', attempt: 1, createdAt: '2026-01-01T00:00:00.000Z' } });
  t.after(async () => { store.close(); await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, store, path, directory, failed };
}

// Frozen compatibility guard from the 0.4 Store (schema 5 maximum); future readers must not relax this contract.
function openPreviousReader(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > 5) { db.close(); throw new Error(`Unsupported state schema: ${version}`); }
  return db;
}

test('W14 schema5 query remains compatible, explicit upgrade snapshots and stages an old-reader rollback', async t => {
  const f = fixture(t);
  f.runtime.init(); f.runtime.coordinationStatus();
  assert.equal(inspectDatabase(f.path).schemaVersion, 5);
  assert.equal(readdirSync(f.directory).filter(file => file.endsWith('.backup')).length, 0);
  assert.throws(() => f.runtime.configureCoordinator({ workflowMode: 'unknown' }, { expectedRevision: 0 }), /workflowMode/);
  assert.equal(inspectDatabase(f.path).schemaVersion, 5);
  assert.equal(f.runtime.upgradeRuntime().schemaVersion, 14);
  assert.equal(f.store.getMeta('runtime:minimum-version'), '0.13.0-alpha.0');
  assert.equal(f.runtime.coordinationStatus().pending, 0);
  assert.equal(f.store.getMeta('coordination:event:legacy-failed').status, 'failed');
  assert.equal(f.store.getMeta('coordination:event:legacy-failed').cycleAttempts, 2);
  assert.equal(f.store.getMeta('coordinator:settings')?.workRetry?.autoRetry ?? false, false);
  assert.equal(f.store.getMeta('ticket:old-recovery').recovery.deadlineAt, '2026-01-01T00:10:00.000Z');
  assert.throws(() => openPreviousReader(f.path), /Unsupported state schema: 14/);
  const [name] = readdirSync(f.directory).filter(file => file.endsWith('.backup'));
  const backupPath = join(f.directory, name), manifest = JSON.parse(readFileSync(`${backupPath}.json`, 'utf8'));
  assert.equal(manifest.schemaVersion, 5); assert.equal(manifest.targetVersion, 14);
  const restored = await prepareDatabaseRestore({ path: f.path, backupPath, expectedVersion: 5, assertStopped: () => true,
    reconciliation: { backupId: manifest.id, note: 'Isolated fixture only; no external actions occurred.' } });
  const legacy = openPreviousReader(restored.path);
  try { assert.deepEqual(JSON.parse(legacy.prepare('SELECT data FROM kv WHERE key=?').get('coordination:event:legacy-failed').data), f.failed); }
  finally { legacy.close(); }
  assert.equal(inspectDatabase(f.path).schemaVersion, 14); // Preparing rollback never installs it.
});

test('W14 live ownership and rejected configuration leave legacy schema and backups untouched', t => {
  const f = fixture(t);
  f.store.setMeta('coordinator:owner', { pid: process.pid, host: hostname(), token: 'another-owner' });
  assert.throws(() => f.runtime.upgradeRuntime(), /live or unverifiable project execution owners/);
  f.store.deleteMeta('coordinator:owner');
  assert.throws(() => f.runtime.configureCoordinator({ assessor: { driver: 'codex-app-server' } }, { expectedRevision: 1 }), /revision conflict/);
  assert.throws(() => f.runtime.configureExecutor({ driver: 'removed-driver' }, { expectedRevision: 0 }), /Unknown executor/);
  assert.equal(inspectDatabase(f.path).schemaVersion, 5);
  assert.deepEqual(f.store.getMeta('coordination:event:legacy-failed'), f.failed);
  assert.equal(readdirSync(f.directory).filter(file => file.endsWith('.backup')).length, 0);
});

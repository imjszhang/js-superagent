import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { BusinessHealthRegistry } from '../src/runtime/business-health.mjs';
import { createManagementServer } from '../src/management.mjs';

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-health-observation-')));
  const runtime = createProjectAgent({ projectRoot: root, driver: { async run() { throw new Error('No model work is authorized by this test'); } }, ...options }).init();
  const db = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { await runtime.stop(); runtime.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, runtime, db };
}
async function until(predicate) {
  for (let i = 0; i < 800; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Runtime owner did not publish its health observation');
}

test('SDK, CLI and management health reads preserve durable failures even without registered adapters', async t => {
  const f = fixture(t), registry = new BusinessHealthRegistry(f.db); const now = Date.now();
  assert.equal(f.runtime.businessHealth().at, null);
  assert.deepEqual(f.db.listMeta('health:'), []);
  for (let i = 0; i < 3; i++) registry.observe({ running: true, sources: [{ id: 'feishu', connection: 'ready', lastAttempt: now + i,
    lastSuccess: now, error: [{ scope: 'oc_failed', code: 230027, category: 'permission', operation: 'history', container: { type: 'chat', id: 'oc_failed', chatId: 'oc_failed' } }] }] });
  assert.deepEqual(f.runtime.sourceStatus(), []);
  const before = f.db.listMeta('health:');
  for (let i = 0; i < 5; i++) assert.equal(f.runtime.businessHealth().incidents[0].status, 'active');
  assert.deepEqual(f.db.listMeta('health:'), before);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/js-superagent.mjs', import.meta.url)), 'health', '--project', f.root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).business.sources[0].consecutiveFailures, 3);
  assert.deepEqual(f.db.listMeta('health:'), before);
  const server = await createManagementServer(f.runtime);
  try {
    const response = await fetch(new URL('/api/status', server.url), { headers: { Authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.sources[0].id, 'feishu'); assert.equal(value.sources[0].healthy, false);
    assert.equal(value.business.incidents[0].status, 'active');
    assert.deepEqual(f.db.listMeta('health:'), before);
  } finally { await server.close(); }
});

test('a configured source that fails before adapter registration retains history failures and reports the connection fault', async t => {
  const f = fixture(t, { feishuSDK: {} });
  const envKey = 'JS_SUPERAGENT_MISSING_HEALTH_FIXTURE_SECRET';
  assert.equal(process.env[envKey], undefined);
  f.runtime.configure({ feishu: { appId: 'cli_fixture', appSecretEnv: envKey, botOpenId: 'ou_bot', tenantKey: 'fixture',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } });
  const at = Date.now() - 10000, registry = new BusinessHealthRegistry(f.db, { now: () => at });
  const source = { id: 'feishu', connection: 'ready', lastSuccess: at, error: [{ scope: 'oc_group', code: 230027, operation: 'history', category: 'permission' }] };
  for (let i = 0; i < 3; i++) { source.lastAttempt = at + i; registry.observe({ running: true, sources: [source] }); }
  f.db.setMeta('source:feishu:state', { lastAttempt: source.lastAttempt, lastSuccess: source.lastSuccess, error: source.error });
  f.runtime.start({ intervalMs: 10 });
  await until(() => f.runtime.businessHealth().sources[0]?.connection === 'error');
  const health = f.runtime.businessHealth();
  assert.deepEqual(f.runtime.sourceStatus(), []);
  assert.equal(health.sources[0].history.issues[0].code, 230027);
  assert.equal(health.sources[0].history.consecutiveFailures, 3);
  assert.equal(health.sources[0].live.healthy, false);
  assert.equal(health.incidents[0].status, 'active');
  assert.equal(health.transitions.some(transition => transition.transition === 'resolved'), false);
});

test('only the active loop owner records observations and confirmed poll recovery resolves its incident', { timeout: 15000 }, async t => {
  const f = fixture(t); let failing = true;
  f.runtime.registerSource({ id: 'fixture-source', source: 'test', pollIntervalMs: 1000, normalize: value => value,
    async poll() { return { events: [], errors: failing ? [{ scope: 'test', error: 'offline' }] : [] }; } });
  f.runtime.start({ intervalMs: 10 });
  await until(() => f.runtime.businessHealth().sources[0]?.consecutiveFailures >= 3);
  assert.equal(f.runtime.businessHealth().incidents[0].status, 'active');
  const inspector = createProjectAgent({ projectRoot: f.root }).init();
  try {
    const before = f.db.listMeta('health:'); inspector.businessHealth(); inspector.businessHealth();
    assert.deepEqual(f.db.listMeta('health:'), before);
  } finally { inspector.close(); }
  failing = false;
  await until(() => f.runtime.businessHealth().sources[0]?.state === 'healthy');
  assert.equal(f.runtime.businessHealth().incidents.length, 0);
  assert.equal(f.runtime.getIncidents()[0].resolution, 'recovered');
  const owner = f.db.getMeta('runtime:loop');
  f.db.setMeta('runtime:loop', { ...owner, token: 'a-different-owner' });
  const before = f.db.listMeta('health:');
  await delay(1200);
  assert.deepEqual(f.db.listMeta('health:'), before, 'The previous owner must not overwrite a successor observation');
  f.db.setMeta('runtime:loop', owner);
});

test('owner verification and observation hold one SQLite writer boundary against competing ownership changes', async t => {
  const f = fixture(t), original = BusinessHealthRegistry.prototype.observe;
  f.db.db.exec('PRAGMA busy_timeout = 0');
  let competingWrite;
  t.mock.method(BusinessHealthRegistry.prototype, 'observe', function (snapshot) {
    if (competingWrite === undefined) {
      const owner = f.db.getMeta('runtime:loop');
      try {
        f.db.setMeta('runtime:loop', { ...owner, token: 'racing-owner' });
        f.db.setMeta('runtime:loop', owner);
        competingWrite = 'unexpectedly succeeded';
      } catch (error) { competingWrite = error.message; }
    }
    return original.call(this, snapshot);
  });
  f.runtime.start({ intervalMs: 10 });
  await until(() => competingWrite !== undefined);
  assert.match(competingWrite, /database is locked/);
  assert.ok(f.runtime.businessHealth().at);
});

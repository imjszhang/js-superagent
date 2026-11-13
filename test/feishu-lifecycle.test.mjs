import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (id = 'om_request') => ({ sender: { sender_id: { open_id: 'ou_person' }, sender_type: 'user', tenant_key: 'tenant' },
  message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1800000000000',
    content: JSON.stringify({ text: 'inspect fixture' }), mentions: [{ id: 'cli_bot' }] } });
function fixture(t, hooks = {}) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-lifecycle-'))), connections = [];
  writeFileSync(join(projectRoot, 'secret'), 'fixture-secret', { mode: 0o600 });
  let callbacks;
  const sdk = { Client: class {
    constructor() {
      hooks.construct?.();
      this.im = { message: { async list() { return { code: 0, data: { items: [], has_more: false } }; },
        async get() { return { code: 0, data: { items: [] } }; }, async reply() { throw new Error('No unrequested reply'); } } };
    }
  }, EventDispatcher: class { register(value) { callbacks = value; return this; } },
  WSClient: class {
    constructor(options) { this.options = options; connections.push(this); }
    async start() { hooks.started?.resolve(); await hooks.start?.promise; }
    close() { hooks.close?.(); }
  } };
  const runtime = createProjectAgent({ projectRoot, driver: { async run() { return { status: 'completed', summary: 'fixture' }; } }, feishuSDK: sdk }).init();
  runtime.configure({ feishu: { appId: 'cli_bot', botOpenId: 'ou_bot', tenantKey: 'tenant', appSecretPath: 'secret',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } });
  runtime.configureCoordinator({ policy: { mode: 'off', rules: [], sourceRows: [{ id: 'group', source: 'feishu',
    scope: { tenantKey: 'tenant', chatId: 'oc_group' }, actors: ['ou_person'], bots: [], admission: {} }] } }, { expectedRevision: 0 });
  t.after(async () => { hooks.start?.resolve(); hooks.close = undefined; await runtime.stop(); runtime.close(); rmSync(projectRoot, { recursive: true, force: true }); });
  return { runtime, hooks, connections, callbacks: () => callbacks };
}

test('stop during connection construction discards the late connection before source registration', async t => {
  const f = fixture(t); let stopping;
  f.hooks.construct = () => { stopping = f.runtime.stop(); };
  const preparation = f.runtime.prepareExecution();
  await preparation.catch(() => {}); await stopping;
  assert.deepEqual(f.runtime.sourceStatus(), []);
  assert.equal(f.connections.length, 0);
  assert.equal(f.runtime.feishuStatus().connection, 'stopped');
  f.hooks.construct = undefined;
  await f.runtime.prepareExecution();
  assert.equal(f.connections.length, 1, 'a later explicit prepare owns a fresh connection');
});

test('runtime shares its stop drain and fences old connection callbacks across restart', async t => {
  const started = deferred(), start = deferred(), f = fixture(t, { started, start });
  const preparation = f.runtime.prepareExecution();
  const cancelled = assert.rejects(preparation, /stopped/);
  await started.promise;
  const callbacks = f.callbacks(), old = f.connections[0];
  const first = f.runtime.stop(); assert.equal(first, f.runtime.stop());
  try {
    await assert.rejects(callbacks['im.message.receive_v1'](event()), /stopped/);
    old.options.onReady(); old.options.onError({ code: 123 });
    assert.throws(() => f.runtime.start(), /stopping/);
    assert.throws(() => f.runtime.close(), /await/);
  } finally { start.resolve(); await first; await cancelled; }
  assert.equal(f.runtime.list().length, 0); assert.equal(f.runtime.feishuStatus().connection, 'stopped');
  await f.runtime.prepareExecution();
  const state = f.runtime.feishuStatus().connection;
  old.options.onReconnected(); old.options.onReconnecting();
  await assert.rejects(callbacks['im.message.receive_v1'](event('om_stale')), /stopped/);
  assert.equal(f.runtime.feishuStatus().connection, state);
  f.runtime.pause('fixture pause');
  await f.callbacks()['im.message.receive_v1'](event('om_paused'));
  assert.equal(f.runtime.list().length, 1, 'a business pause still preserves authorized reception');
});

test('a failed connection close cannot release ownership while another source is still draining', async t => {
  const wait = deferred(), entered = deferred(); let failClose = true;
  const f = fixture(t, { close() { if (failClose) throw new Error('Fixture close failed'); } });
  f.runtime.registerSource({ id: 'holding', source: 'fixture', normalize: value => value, async poll() {
    entered.resolve(); await wait.promise; return { events: [], cursor: 'must-not-advance' };
  } });
  await f.runtime.prepareExecution();
  const cycle = f.runtime.runNext(); await entered.promise;
  let settled = false;
  const stopping = f.runtime.stop(); const failed = assert.rejects(stopping, /stop did not complete/).then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'one rejection must not complete the rest of the drain');
    assert.equal(f.runtime.sourceStatus().find(source => source.id === 'holding').active, true);
    assert.throws(() => f.runtime.start(), /stopping/);
    await assert.rejects(f.runtime.prepareExecution(), /stopping/);
  } finally { wait.resolve(); await cycle; await failed; }
  assert.equal(f.runtime.sourceStatus().find(source => source.id === 'holding').cursor, null);
  assert.throws(() => f.runtime.start(), /stopping/, 'failed cleanup must not reopen the runtime');
  failClose = false; await f.runtime.stop();
  await f.runtime.prepareExecution();
  assert.ok(f.runtime.sourceStatus().some(source => source.id === 'feishu'));
});

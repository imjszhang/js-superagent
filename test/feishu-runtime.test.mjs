import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { validateProjectOptions } from '../src/config.mjs';
import { initializeProjectConfig, writeProjectConfig } from '../src/config.mjs';
import { createServiceManager } from '../src/service.mjs';
import { assertFeishuServiceConfig, feishuSdkAvailable } from '../src/channels/feishu.mjs';

const secret = 'fixture-feishu-secret';
function message(id = 'om_message', options = {}) {
  return { sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 'tenant', ...options.sender },
    message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1793491200000',
      content: JSON.stringify({ text: '@_user_1 fix the fixture' }), mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1', name: 'Bot' }], ...options.message } };
}
function sdkFor(api) {
  let handler;
  return { api, handler: () => handler, sdk: {
    Client: class { constructor() { this.im = { message: api }; } },
    EventDispatcher: class { register(value) { handler = value['im.message.receive_v1']; return this; } },
    WSClient: class { async start() {} close() {} },
  } };
}
function runtimeFixture(t, driver) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-feishu-')));
  const calls = [];
  const api = {
    list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async request => ({ code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: 'oc_group' }] } }),
    reply: async request => { calls.push(request); return { code: 0, data: { message_id: `om_sent_${calls.length}` } }; },
  };
  const transport = sdkFor(api);
  const previous = process.env.TEST_FEISHU_APP_SECRET;
  process.env.TEST_FEISHU_APP_SECRET = secret;
  const runtime = createProjectAgent({ projectRoot: root, driver, feishuSDK: transport.sdk }).init();
  t.after(async () => {
    if (previous === undefined) delete process.env.TEST_FEISHU_APP_SECRET; else process.env.TEST_FEISHU_APP_SECRET = previous;
    await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true });
  });
  runtime.configure({ feishu: { appId: 'cli_bot', appSecretEnv: 'TEST_FEISHU_APP_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } });
  runtime.configureCoordinator({ policy: { mode: 'off', rules: [], sourceRows: [{ id: 'group', source: 'feishu', scope: { tenantKey: 'tenant', chatId: 'oc_group' }, actors: ['ou_alice'], bots: [], admission: {} }] } }, { expectedRevision: 0 });
  return { root, runtime, calls, transport };
}

test('feishu configuration accepts one secret reference and the supported chat scope', () => {
  const value = validateProjectOptions({ feishu: { appId: 'cli_bot', appSecretEnv: 'FEISHU_APP_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant', chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } });
  assert.equal(value.feishu.enabled, true);
  assert.throws(() => validateProjectOptions({ feishu: { appId: 'cli_bot', appSecretEnv: 'FEISHU_APP_SECRET', appSecretPath: 'secret.txt', botOpenId: 'ou_bot', tenantKey: 'tenant', chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } }), /exactly one/);
  assert.throws(() => validateProjectOptions({ feishu: { appId: 'cli_bot', appSecretEnv: 'FEISHU_APP_SECRET', botOpenId: 'bot', tenantKey: 'tenant', chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } }), /open id/);
});

test('an authorized Feishu mention opens one ticket and the result returns once to its thread', async t => {
  const { runtime, calls } = runtimeFixture(t, { async run() { return { status: 'completed', summary: 'Fixture change verified' }; } });
  await runtime.prepareExecution();
  const received = runtime.receiveSourceEvent('feishu', message());
  assert.equal(received.status, 'received');
  assert.equal(runtime.receiveSourceEvent('feishu', message()).status, 'duplicate');
  assert.equal(runtime.receiveSourceEvent('feishu', message('om_other', { sender: { sender_id: { open_id: 'ou_bob' } } })).status, 'received');
  assert.equal(runtime.receiveSourceEvent('feishu', message('om_self', { sender: { sender_id: { open_id: 'ou_bot' } } })).status, 'ignored');
  assert.equal(runtime.receiveSourceEvent('feishu', message('om_else', { message: { chat_id: 'oc_else' } })).status, 'ignored');
  assert.equal(runtime.list().length, 1);
  const result = await runtime.runNext();
  assert.equal(result.status, 'completed');
  const results = calls.filter(request => request.data.content.includes('Fixture change verified'));
  assert.equal(results.length, 1);
  assert.equal(results[0].data.reply_in_thread, true);
  assert.equal(JSON.parse(results[0].data.content).text.includes('Fixture change verified'), true);
  const follow = runtime.receiveSourceEvent('feishu', message('om_follow', { message: { root_id: 'om_message', mentions: [], content: JSON.stringify({ text: 'also check the edge' }) } }));
  assert.equal(follow.status, 'received');
  assert.equal(runtime.list().length, 1);
});

test('a Worker answer to the Feishu request completes the ticket and returns once to the original thread', async t => {
  const { runtime, calls } = runtimeFixture(t, { async run(input) {
    input.checkpoint({ driver: 'fixture', id: 'feishu-answer-session' });
    return { version: 2, state: 'ready', summary: 'MARK-feishu-answer', artifacts: [], attention: null, answers: input.domainTicket.origin.triggerId };
  } });
  await runtime.prepareExecution();
  const received = runtime.receiveSourceEvent('feishu', message());
  assert.equal(received.status, 'received');
  const result = await runtime.runNext();
  assert.equal(result.status, 'completed');
  await runtime.flushNotifications();
  const answers = calls.filter(request => JSON.parse(request.data.content).text === 'MARK-feishu-answer');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].path.message_id, 'om_message');
  assert.equal(answers[0].data.reply_in_thread, true);
});

test('a Feishu group mention identified by the app id still opens a ticket', async t => {
  const { runtime } = runtimeFixture(t, { async run() { return { status: 'completed', summary: 'unused' }; } });
  await runtime.prepareExecution();
  assert.equal(runtime.receiveSourceEvent('feishu', message('om_app', { message: { mentions: [{ id: 'cli_bot', key: '@_user_1', name: 'Bot' }] } })).status, 'received');
  assert.equal(runtime.receiveSourceEvent('feishu', message('om_other_app', { message: { mentions: [{ id: 'cli_other', key: '@_user_1', name: 'Other' }] } })).status, 'ignored');
  assert.equal(runtime.list().length, 1);
});

test('a delayed live request recovers offline follow-ups from its platform time into the same ticket', async t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { runtime, transport } = runtimeFixture(t, { async run() { return { status: 'waiting', summary: 'Waiting for confirmation' }; } });
  await runtime.prepareExecution();
  runtime.receiveSourceEvent('feishu', message('om_root', { message: { thread_id: 'omt_existing', create_time: String(now - 40_000) } }));
  const ticketId = runtime.list()[0].id, requests = [];
  transport.api.list = async ({ params }) => {
    requests.push(params);
    return { code: 0, data: { has_more: false, items: params.container_id_type === 'thread' ? [{
      ...message('om_offline', { message: { mentions: [], thread_id: 'omt_existing', create_time: String(now - 10_000), content: JSON.stringify({ text: 'also inspect the offline edge' }) } }).message,
      sender: { id_type: 'open_id', id: 'ou_alice', sender_type: 'user' },
    }] : [] } };
  };
  t.mock.timers.tick(2000);
  await runtime.runNext();
  assert.equal(runtime.list().length, 1);
  assert.ok(requests.some(request => request.container_id_type === 'thread' && request.container_id === 'omt_existing'));
  assert.ok(runtime.getDomainTicket(ticketId).inputs.some(input => input.triggerId === 'feishu:tenant:om_offline'));
  assert.equal(runtime.getDomainTicket(ticketId).channels[0].thread, 'tenant:oc_group:om_root');
});

test('a missed first mention and later follow-up spanning poll rounds enter one ticket in chronological order', async t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { runtime, transport } = runtimeFixture(t, { async run() { return { status: 'waiting', summary: 'Waiting for confirmation' }; } });
  await runtime.prepareExecution();
  const cursor = { schemaVersion: 2, scopes: { oc_group: { since: now / 1000 - 100 } }, discovery: { oc_group: { complete: true } }, topics: {
    'oc_group:omt_missed': { chatId: 'oc_group', threadId: 'omt_missed', rootId: 'om_root', since: now / 1000 - 100, lastSeen: now - 10_000 },
  } };
  const database = new DatabaseSync(join(stateDir(runtime.projectRoot), 'state.sqlite'));
  try { database.prepare('INSERT INTO kv(key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
    .run('source:feishu:state', JSON.stringify({ cursor })); } finally { database.close(); }
  transport.api.list = async ({ params }) => {
    if (params.container_id_type === 'chat') return { code: 0, data: { has_more: false, items: [] } };
    const page = Number(params.page_token ?? 0), final = page === 10;
    const raw = message(final ? 'om_first_missed' : 'om_later_missed', { message: { thread_id: 'omt_missed',
      create_time: String(now - (final ? 40_000 : 10_000)), mentions: final ? [{ id: 'cli_bot' }] : [],
      content: JSON.stringify({ text: final ? '@_user_1 inspect this fixture' : 'also inspect the follow-up edge' }) } });
    return { code: 0, data: { has_more: !final, ...(final ? {} : { page_token: String(page + 1) }),
      items: page === 0 || final ? [{ ...raw.message, sender: { id_type: 'open_id', id: 'ou_alice', sender_type: 'user' } }] : [] } };
  };
  await runtime.runNext();
  assert.equal(runtime.list().length, 0, 'newer follow-up must not enter the domain before the older first mention');
  t.mock.timers.tick(61_000);
  await runtime.runNext();
  assert.equal(runtime.list().length, 1);
  const domain = runtime.getDomainTicket(runtime.list()[0].id);
  assert.equal(domain.origin.triggerId, 'feishu:tenant:om_first_missed');
  assert.ok(domain.inputs.some(input => input.triggerId === 'feishu:tenant:om_later_missed'));
});

test('history receives an unrelated unaddressed topic reply without granting a new ticket', async t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { runtime, transport } = runtimeFixture(t, { async run() { throw new Error('unaddressed context must not execute'); } });
  await runtime.prepareExecution();
  const database = new DatabaseSync(join(stateDir(runtime.projectRoot), 'state.sqlite'));
  try { database.prepare('INSERT INTO kv(key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
    .run('source:feishu:state', JSON.stringify({ cursor: { schemaVersion: 1, scopes: { oc_group: { since: now / 1000 - 100 } } } })); }
  finally { database.close(); }
  transport.api.list = async ({ params }) => {
    const root = params.container_id_type === 'chat';
    const raw = message(root ? 'om_unsubscribed_root' : 'om_unaddressed_history', { message: { thread_id: 'omt_unsubscribed', mentions: [],
      create_time: String(now - (root ? 50_000 : 10_000)), content: JSON.stringify({ text: 'ordinary group discussion' }) } });
    return { code: 0, data: { has_more: false, items: [{ ...raw.message, sender: { id_type: 'open_id', id: 'ou_alice', sender_type: 'user' } }] } };
  };
  await runtime.runNext(); assert.equal(runtime.list().length, 0);
  const verify = new DatabaseSync(join(stateDir(runtime.projectRoot), 'state.sqlite'));
  try {
    assert.ok(verify.prepare('SELECT data FROM domain_triggers WHERE id = ?').get('feishu:tenant:om_unaddressed_history'), 'the reply arrived; a zero ticket count alone is not sufficient');
    const disposition = JSON.parse(verify.prepare('SELECT data FROM domain_dispositions WHERE id = ?').get('feishu:tenant:om_unaddressed_history').data);
    assert.equal(disposition.filtered, undefined); assert.deepEqual(disposition.fanout, []);
    const decision = JSON.parse(verify.prepare('SELECT data FROM domain_decisions WHERE id = ?').get(disposition.decisionId).data);
    assert.equal(decision.kind, 'ignore', 'retained ordinary context still cannot independently authorize work');
  } finally { verify.close(); }
});

test('a Feishu event is accepted while a worker is running, and a dropped connection keeps the reply pending', async t => {
  let release;
  const { runtime, calls } = runtimeFixture(t, { async run() { await new Promise(resolve => { release = resolve; }); return { status: 'completed', summary: 'Finished after the mention' }; } });
  await runtime.prepareExecution();
  const local = runtime.submit({ text: 'Hold the worker' });
  const running = runtime.runNext();
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.receiveSourceEvent('feishu', message()).status, 'received');
  assert.equal(runtime.list().some(ticket => ticket.id !== local.id), true);
  release();
  await running;
  const held = runtimeFixture(t, { async run() { return { status: 'completed', summary: 'not used' }; } });
  await held.runtime.prepareExecution();
  held.runtime.receiveSourceEvent('feishu', message());
  await held.runtime.stop();
  const before = held.calls.length;
  await held.runtime.flushNotifications();
  assert.equal(held.calls.length, before);
  await held.runtime.prepareExecution();
  const database = new DatabaseSync(join(stateDir(held.runtime.projectRoot), 'state.sqlite'));
  try { database.exec('UPDATE effects SET due = 0'); } finally { database.close(); }
  await held.runtime.flushNotifications();
  assert.ok(held.calls.length > before);
  assert.ok(held.calls.every(request => request.data.reply_in_thread === true));
});

test('service installation rejects a Feishu source without a private secret file or the optional SDK', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-feishu-service-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'home'), codex = join(base, 'codex');
  mkdirSync(root); mkdirSync(home); writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  initializeProjectConfig(root, { execution: { driver: 'codex-app-server', executable: codex }, feishu: { appId: 'cli_bot', appSecretEnv: 'FEISHU_APP_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant', chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } });
  const deps = { platform: 'darwin', uid: 501, coordinationDirectory: join(base, 'machine'), launchctl() { return ''; } };
  assert.throws(() => createServiceManager({ projectRoot: root, homeDirectory: home }, deps).install(), /appSecretPath/);
  const secretPath = join(root, 'feishu-secret');
  writeFileSync(secretPath, 'fixture-secret\n', { mode: 0o600 }); chmodSync(secretPath, 0o600);
  writeProjectConfig(root, { feishu: { appSecretPath: 'feishu-secret' } });
  if (feishuSdkAvailable()) assert.doesNotThrow(() => assertFeishuServiceConfig({ feishu: { enabled: true, appSecretPath: secretPath } }));
  else assert.throws(() => assertFeishuServiceConfig({ feishu: { enabled: true, appSecretPath: secretPath } }), /node-sdk/);
});

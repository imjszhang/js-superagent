import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuSource, createFeishuConnection } from '../src/channels/feishu.mjs';

function message(id = 'om_message', options = {}) {
  return { sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 'tenant' },
    message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1793491200000',
      content: JSON.stringify({ text: '@_user_1 fix the test' }), mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1', name: 'Bot' }], ...options } };
}
function fixture(overrides = {}) {
  const calls = [];
  const api = { list: async request => { calls.push(['list', request]); return { code: 0, data: { items: [], has_more: false } }; },
    get: async request => { calls.push(['get', request]); return { code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: 'oc_group' }] } }; },
    reply: async request => { calls.push(['reply', request]); return { code: 0, data: { message_id: 'om_sent' } }; }, ...overrides };
  const source = createFeishuSource({ client: { im: { message: api } }, botOpenId: 'ou_bot', botAppId: 'cli_bot', tenantKey: 'tenant',
    scopes: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], now: () => 1793491300000 });
  return { source, calls, api };
}
test('Feishu uses stable identities, actual mentions and scoped tenants; display names grant nothing', () => {
  const { source } = fixture(), raw = message(); const normalized = source.normalize(raw);
  assert.equal(normalized.actor.id, 'ou_alice'); assert.equal(normalized.addressed, 'mention'); assert.equal(normalized.human, true);
  assert.equal(normalized.channel.address.messageId, 'om_message'); assert.equal(normalized.meta.tenantKey, 'tenant');
  const fakeMention = message('om_fake', { mentions: [{ id: { open_id: 'ou_else' }, name: 'Bot' }] }); assert.equal(source.normalize(fakeMention), null);
  assert.equal(source.normalize(message('om_outside', { chat_id: 'oc_else' })), null);
  const wrongTenant = message(); wrongTenant.sender.tenant_key = 'other'; assert.equal(source.normalize(wrongTenant), null);
  const self = message(); self.sender.sender_id.open_id = 'ou_bot'; assert.equal(source.normalize(self), null);
});
test('replies stay in their root thread, attachments retain references without fetching external bytes', () => {
  const { source } = fixture();
  const value = source.normalize(message('om_reply', { root_id: 'om_root', mentions: [], message_type: 'image', content: JSON.stringify({ image_key: 'img_resource' }) }));
  assert.equal(value.addressed, undefined); assert.equal(value.channel.address.messageId, 'om_root');
  assert.deepEqual(value.meta.attachments, [{ type: 'image', key: 'img_resource' }]);
});
test('history establishes a baseline, paginates and emits the same message ID as realtime', async () => {
  let n = 0; const { source, calls } = fixture({ list: async request => { calls.push(['list', request]); n++;
    return { code: 0, data: { items: [{ ...message('om_polled').message, sender: { id_type: 'open_id', id: 'ou_alice', sender_type: 'user' } }], has_more: n === 1, page_token: n === 1 ? 'page-2' : undefined } }; } });
  const baseline = await source.poll(); assert.equal(calls.length, 0); assert.equal(baseline.events.length, 0);
  const polled = await source.poll({ cursor: baseline.cursor }); assert.equal(calls.length, 2);
  assert.equal(source.normalize(polled.events[0]).id, source.normalize(message('om_polled')).id);
  assert.equal(calls[1][1].params.page_token, 'page-2'); assert.equal(polled.cursor.scopes.oc_group.since, 1793491300);
});
test('failed chat history keeps its cursor and records an error', async () => {
  const { source } = fixture({ list: async () => ({ code: 99991672 }) });
  const cursor = { schemaVersion: 1, scopes: { oc_group: { since: 1 } } }, result = await source.poll({ cursor });
  assert.deepEqual(result.cursor, cursor); assert.equal(result.errors.length, 1); assert.match(result.errors[0].error, /99991672/);
});
test('delivery rechecks the destination and uses a stable platform deduplication UUID', async () => {
  const { source, calls } = fixture(); const trigger = source.normalize(message());
  const outgoing = { id: 'reply-123', channel: trigger.channel, text: 'Completed the change.' };
  const one = await source.deliver(outgoing), two = await source.deliver(outgoing);
  assert.equal(one.uuid, two.uuid); assert.equal(one.messageId, 'om_sent');
  assert.equal(calls.filter(([name]) => name === 'get').length, 2); assert.equal(calls.find(([name]) => name === 'reply')[1].data.reply_in_thread, true);
  await assert.rejects(source.deliver({ ...outgoing, channel: { ...trigger.channel, address: { ...trigger.channel.address, chatId: 'oc_foreign' } } }), /scope/);
});
test('server-side destination mismatch prevents sending or exposing context', async () => {
  const { source, calls } = fixture({ get: async () => ({ code: 0, data: { items: [{ message_id: 'om_message', chat_id: 'oc_foreign' }] } }) });
  await assert.rejects(source.deliver({ id: 'reply', text: 'Done', channel: source.normalize(message()).channel }), /does not belong/);
  await assert.rejects(source.readContext({ messageId: 'om_message', chatId: 'oc_group' }), /outside/);
  assert.equal(calls.length, 0);
});
test('optional long connection routes authenticated SDK events to durable reception and closes explicitly', async t => {
  const old = process.env.TEST_FEISHU_APP_SECRET; process.env.TEST_FEISHU_APP_SECRET = 'local-test-only';
  t.after(() => { if (old === undefined) delete process.env.TEST_FEISHU_APP_SECRET; else process.env.TEST_FEISHU_APP_SECRET = old; });
  let handler, closed = 0, started = 0;
  const api = fixture().api;
  const sdk = { Client: class { constructor() { this.im = { message: api }; } },
    EventDispatcher: class { register(value) { handler = value['im.message.receive_v1']; return this; } },
    WSClient: class { async start() { started++; } close() { closed++; } } };
  const connection = await createFeishuConnection({ appId: 'cli_example', appSecretEnv: 'TEST_FEISHU_APP_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant', scopes: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], sdk });
  const received = []; assert.equal(started, 0);
  await connection.start({ receive: raw => received.push(raw) }); await handler(message()); assert.equal(received.length, 1);
  await connection.stop(); assert.equal(closed, 1);
});

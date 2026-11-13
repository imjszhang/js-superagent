import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as sdk from '@larksuiteoapi/node-sdk';
import { createFeishuConnection, createFeishuSource } from '../src/channels/feishu.mjs';
import { createFeishuTransport, FEISHU_HANDSHAKE_TIMEOUT_MS } from '../src/channels/feishu-transport.mjs';
import { Store } from '../src/store.mjs';
import { SourceRegistry } from '../src/sources.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
let appSequence = 0;
const nextAppId = () => `cli_${(++appSequence).toString(16).padStart(16, '0')}`;
const options = { appId: 'cli_0123456789abcdef', appSecret: 'fixture-secret', botOpenId: 'ou_bot', tenantKey: 'tenant',
  scopes: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] };
const send = (res, value) => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(value)); };
const token = res => send(res, { code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
async function serverFor(t, handle) {
  const server = createServer(handle), sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, sockets, url: `http://127.0.0.1:${server.address().port}` };
}
function localSDK(url, WSClient = class { async start() {} close() {} }) {
  return { ...sdk, Client: class extends sdk.Client { constructor(config) { super({ ...config, appId: nextAppId(), domain: url, logger: quiet }); } }, WSClient };
}

for (const phase of ['token', 'history', 'context']) test(`actual SDK ${phase} read cancels the HTTP socket and stops without advancing intake`, { timeout: 5000 }, async t => {
  const entered = deferred(), closed = deferred(); let requests = 0;
  const { url } = await serverFor(t, (req, res) => {
    requests++;
    if (req.url.includes('/auth/') && phase !== 'token') return token(res);
    req.socket.once('close', closed.resolve); entered.resolve();
  });
  const connection = await createFeishuConnection({ ...options, sdk: localSDK(url) });
  const store = new Store(':memory:'), registry = new SourceRegistry({ store, receive() { throw new Error('Cancelled reads cannot receive'); } });
  registry.register(connection.source);
  t.after(async () => { await connection.stop(); await registry.close(); store.close(); });
  const work = phase === 'context' ? connection.source.readContext({ chatId: 'oc_group', messageId: 'om_root' }) : registry.poll('feishu');
  const rejected = assert.rejects(work);
  await entered.promise;
  if (phase === 'context') await connection.stop(); else await registry.stop();
  await rejected; await closed.promise;
  assert.equal(registry.state('feishu').cursor, null);
  assert.equal(store.getMeta('source:feishu:owner'), undefined);
  assert.equal(store.listMeta('source:feishu:event:').length, 0);
  const count = requests; await connection.stop();
  await assert.rejects(connection.source.readContext({ chatId: 'oc_group', messageId: 'om_root' }), /stopped/);
  assert.equal(requests, count, 'closed transports must not start another request');
});

test('actual SDK timeout retains the failed history window and other container progress', { timeout: 5000 }, async t => {
  const closed = deferred();
  const { url } = await serverFor(t, (req, res) => {
    if (req.url.includes('/auth/')) return token(res);
    if (req.url.includes('container_id=oc_bad')) { req.socket.once('close', closed.resolve); return; }
    send(res, { code: 0, data: { items: [], has_more: false } });
  });
  const transport = createFeishuTransport(sdk.defaultHttpInstance, { readTimeoutMs: 100 });
  t.after(() => transport.stop());
  const client = new sdk.Client({ appId: nextAppId(), appSecret: options.appSecret, domain: url, logger: quiet, httpInstance: transport.httpInstance });
  const source = createFeishuSource({ ...options, client, transport, now: () => 200_000,
    scopes: [{ chatId: 'oc_bad', type: 'group', mode: 'mentions' }, { chatId: 'oc_good', type: 'group', mode: 'mentions' }] });
  const cursor = { schemaVersion: 2, scopes: { oc_bad: { since: 100 }, oc_good: { since: 100 } },
    discovery: { oc_bad: { complete: true }, oc_good: { complete: true } }, topics: {}, failures: {} };
  const result = await source.poll({ cursor }); await closed.promise;
  assert.equal(result.cursor.scopes.oc_bad.since, 100);
  assert.equal(result.cursor.scopes.oc_good.since, 200);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].category, 'transport');
  assert.equal(result.errors[0].scope, 'oc_bad');
});

test('a read deadline includes token preparation instead of restarting for the business request', { timeout: 5000 }, async t => {
  let businessRequests = 0;
  const { url } = await serverFor(t, (req, res) => {
    if (req.url.includes('/auth/')) { setTimeout(() => token(res), 150); return; }
    businessRequests++; send(res, { code: 0, data: { items: [], has_more: false } });
  });
  const transport = createFeishuTransport(sdk.defaultHttpInstance, { readTimeoutMs: 50 });
  const client = new sdk.Client({ appId: nextAppId(), appSecret: options.appSecret, domain: url, logger: quiet, httpInstance: transport.httpInstance });
  await assert.rejects(transport.read(() => client.im.message.list({ params: { container_id_type: 'chat', container_id: 'oc_group' } })));
  assert.equal(businessRequests, 0);
  await transport.stop();
});

test('stopping preserves an already dispatched reply and rejects new writes', { timeout: 5000 }, async t => {
  const dispatched = deferred(), release = deferred(); let replies = 0;
  const { url } = await serverFor(t, (req, res) => {
    if (req.url.includes('/auth/')) return token(res);
    if (req.method === 'GET') return send(res, { code: 0, data: { items: [{ message_id: 'om_root', chat_id: 'oc_group' }] } });
    replies++; dispatched.resolve(); void release.promise.then(() => send(res, { code: 0, data: { message_id: 'om_sent' } }));
  });
  const connection = await createFeishuConnection({ ...options, sdk: localSDK(url) });
  t.after(() => { release.resolve(); return connection.stop(); });
  const message = { id: 'reply-once', text: 'fixture reply', channel: { source: 'feishu', thread: 'tenant:oc_group:om_root',
    address: { sourceId: 'feishu', tenantKey: 'tenant', chatId: 'oc_group', messageId: 'om_root' } } };
  const delivering = connection.source.deliver(message); await dispatched.promise;
  let stopped = false; const stopping = connection.stop().then(() => { stopped = true; });
  await assert.rejects(connection.source.deliver({ ...message, id: 'not-started' }), /stopped/);
  assert.equal(stopped, false, 'the original response remains in flight');
  release.resolve(); const receipt = await delivering; await stopping;
  assert.equal(receipt.messageId, 'om_sent'); assert.equal(replies, 1);
});

test('connection startup and stale message/card/state callbacks cannot reopen stopped ingress', async () => {
  const wait = deferred(), callbacks = {}, states = []; let handler, closed = 0;
  const api = { async list() {}, async get() {}, async reply() {} };
  const fake = { Client: class { constructor() { this.im = { message: api }; } },
    EventDispatcher: class { register(value) { handler = value; return this; } },
    WSClient: class {
      constructor(config) { Object.assign(callbacks, config); }
      async start() { await wait.promise; }
      close() { closed++; }
    } };
  const connection = await createFeishuConnection({ ...options, sdk: fake });
  let received = 0, cards = 0;
  const starting = connection.start({ receive() { received++; }, cardAction() { cards++; }, onState: value => states.push(value), onError: () => states.push('error') });
  const stop = connection.stop(); assert.equal(stop, connection.stop());
  try {
    callbacks.onReady(); callbacks.onReconnected(); callbacks.onReconnecting(); callbacks.onError({ code: 123 });
    await assert.rejects(handler['im.message.receive_v1']({}), /stopped/);
    await assert.rejects(handler['card.action.trigger']({}), /stopped/);
    assert.deepEqual(states, []); assert.equal(received, 0); assert.equal(cards, 0);
    assert.equal(callbacks.handshakeTimeoutMs, FEISHU_HANDSHAKE_TIMEOUT_MS);
  } finally { wait.resolve(); await Promise.all([starting, stop]); }
  assert.ok(closed >= 1);
});

test('actual SDK discards a handshake completed after stop and does not reconnect', { timeout: 5000 }, async t => {
  const upgrading = deferred(), closed = deferred(); let endpointRequests = 0, ready = 0;
  const { url, server } = await serverFor(t, (req, res) => {
    endpointRequests++;
    send(res, { code: 0, data: { URL: `${url.replace('http:', 'ws:')}/ws?device_id=fixture&service_id=1`,
      ClientConfig: { PingInterval: 100, ReconnectCount: 1, ReconnectInterval: 1, ReconnectNonce: 0 } } });
  });
  server.on('upgrade', (req, socket) => {
    socket.resume(); socket.once('end', () => { socket.destroy(); closed.resolve(); }); socket.once('close', closed.resolve);
    upgrading.resolve({ req, socket });
  });
  const local = localSDK(url, class extends sdk.WSClient { constructor(config) { super({ ...config, domain: url, logger: quiet }); } });
  const connection = await createFeishuConnection({ ...options, sdk: local });
  t.after(() => connection.stop());
  await connection.start({ receive() { throw new Error('Stopped socket must not deliver'); }, onState: state => { if (state === 'ready') ready++; } });
  const { req, socket } = await upgrading.promise;
  await connection.stop();
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  await closed.promise;
  assert.equal(ready, 0); assert.equal(endpointRequests, 1);
});

test('actual SDK handshake watchdog closes a peer that never completes its upgrade after stop', { timeout: 5000 }, async t => {
  const upgrading = deferred(), closed = deferred(); let endpointRequests = 0;
  const { url, server } = await serverFor(t, (req, res) => {
    endpointRequests++;
    send(res, { code: 0, data: { URL: `${url.replace('http:', 'ws:')}/ws?device_id=fixture&service_id=1`,
      ClientConfig: { PingInterval: 100, ReconnectCount: 1, ReconnectInterval: 1, ReconnectNonce: 0 } } });
  });
  server.on('upgrade', (_req, socket) => {
    socket.resume(); socket.once('end', () => { socket.destroy(); closed.resolve(); }); socket.once('close', closed.resolve);
    upgrading.resolve();
  });
  const local = localSDK(url, class extends sdk.WSClient {
    constructor(config) {
      assert.equal(config.handshakeTimeoutMs, 10_000);
      // Exercise the real watchdog without imposing its production interval on the suite.
      super({ ...config, domain: url, logger: quiet, handshakeTimeoutMs: 100 });
    }
  });
  const connection = await createFeishuConnection({ ...options, sdk: local }); t.after(() => connection.stop());
  await connection.start({ receive() { throw new Error('A stopped handshake cannot receive'); } });
  await upgrading.promise; await connection.stop(); await closed.promise;
  assert.equal(endpointRequests, 1);
});

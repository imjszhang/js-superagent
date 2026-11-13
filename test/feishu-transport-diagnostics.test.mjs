import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as sdk from '@larksuiteoapi/node-sdk';
import { createFeishuTransport } from '../src/channels/feishu-transport.mjs';
import { getFeishuReadDiagnostic, getFeishuTransportErrorDiagnostic, sanitizeFeishuDiagnostic } from '../src/channels/feishu-diagnostics.mjs';

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let sequence = 0;
const send = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(body)); };
const success = res => send(res, { code: 0, data: { items: [], has_more: false } });
async function fixture(t, handle, readTimeoutMs = 200) {
  const server = createServer(handle), sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const transport = createFeishuTransport(sdk.defaultHttpInstance, { readTimeoutMs });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await transport.stop(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new sdk.Client({ appId: `cli_diag_${++sequence}`, appSecret: 'fixture-app-secret', domain: url, logger: quiet, httpInstance: transport.httpInstance });
  const list = (chat = 'oc_fixture', options) => transport.read(() => client.im.message.list({ params: { container_id_type: 'chat', container_id: chat } }), options);
  return { transport, list, url };
}
const token = res => send(res, { code: 0, tenant_access_token: 'fixture-access-token', expire: 7200 });
function checkTime(value) {
  assert.equal(new Date(value.failedAt).toISOString(), value.failedAt);
  assert.ok(Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 86_400_000);
}

test('actual SDK deadline diagnoses its hidden abort reason while an independent read succeeds', { timeout: 5000 }, async t => {
  let slowRequests = 0;
  const { transport, list } = await fixture(t, (req, res) => {
    if (req.url.includes('/auth/')) return token(res);
    if (req.url.includes('oc_slow')) { slowRequests++; return; }
    success(res);
  });
  await list();
  const [slow, fast] = await Promise.allSettled([list('oc_slow'), list('oc_fast')]);
  assert.equal(fast.status, 'fulfilled'); assert.equal(fast.value.code, 0);
  assert.equal(slow.status, 'rejected'); assert.equal(slow.reason.code, 'ERR_CANCELED');
  const diagnostic = getFeishuReadDiagnostic(slow.reason);
  assert.equal(diagnostic.reason, 'timeout'); assert.equal(diagnostic.transportCode, 'ERR_CANCELED');
  assert.equal(diagnostic.cancellationSource, 'deadline'); assert.equal(diagnostic.phase, 'request'); checkTime(diagnostic);
  assert.ok(diagnostic.elapsedMs >= 150); assert.equal(slowRequests, 1, 'diagnostics add no retry');
  assert.ok(Object.isFrozen(diagnostic)); await transport.stop();
});

for (const source of ['caller', 'stop', 'request']) test(`actual SDK ${source} cancellation is not diagnosed as a deadline`, { timeout: 5000 }, async t => {
  const entered = deferred(), controller = new AbortController();
  const { transport, list, url } = await fixture(t, (req, res) => {
    if (req.url.includes('/auth/')) return token(res);
    entered.resolve();
  }, 2000);
  const work = source === 'request' ? transport.httpInstance.get(`${url}/pending`, { signal: controller.signal })
    : list('oc_fixture', { signal: controller.signal });
  const rejected = assert.rejects(work, error => {
    const diagnostic = getFeishuReadDiagnostic(error);
    assert.equal(diagnostic.reason, 'cancelled'); assert.equal(diagnostic.cancellationSource, source);
    assert.equal(diagnostic.transportCode, 'ERR_CANCELED'); checkTime(diagnostic); return true;
  });
  await entered.promise;
  if (source === 'stop') await transport.stop(); else controller.abort(new Error('private cancellation context'));
  await rejected;
});

test('the first request cancellation stays distinct when the outer caller aborts before the rejection settles', async () => {
  const started = deferred(), rejected = deferred(), caller = new AbortController(), request = new AbortController();
  const transport = createFeishuTransport({ request(options) { started.resolve(options); return rejected.promise; } });
  const original = Object.assign(new Error('private request details'), { code: 'ERR_CANCELED' });
  const work = transport.read(() => transport.httpInstance.request({ method: 'get', url: 'https://fixture.invalid/read', signal: request.signal }), { signal: caller.signal });
  const checked = assert.rejects(work, error => {
    assert.equal(error, original); assert.equal(getFeishuReadDiagnostic(error).cancellationSource, 'request'); return true;
  });
  await started.promise; request.abort(new Error('first')); caller.abort(new Error('second')); rejected.reject(original);
  await checked; await transport.stop();
});

for (const mode of ['timeout', 'http']) test(`actual SDK authentication ${mode} retains auth phase without token or credential text`, { timeout: 5000 }, async t => {
  let historyRequests = 0;
  const { list } = await fixture(t, (req, res) => {
    if (req.url.includes('/auth/')) {
      if (mode === 'http') send(res, { msg: 'fixture-app-secret fixture-access-token' }, 503);
      return;
    }
    historyRequests++; success(res);
  });
  await assert.rejects(list(), error => {
    const diagnostic = getFeishuReadDiagnostic(error);
    assert.equal(diagnostic.phase, 'auth'); assert.equal(diagnostic.reason, mode === 'http' ? 'http' : 'timeout');
    if (mode === 'http') assert.equal(diagnostic.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-app-secret|fixture-access-token|Authorization|config|response/);
    checkTime(diagnostic); return true;
  });
  assert.equal(historyRequests, 0);
});

for (const failure of [429, 503, 'reset']) test(`actual SDK history ${failure} records the safe HTTP or network cause once`, { timeout: 5000 }, async t => {
  let requests = 0;
  const { list } = await fixture(t, (req, res) => {
    if (req.url.includes('/auth/')) return token(res);
    requests++;
    if (failure === 'reset') req.socket.destroy(); else send(res, { msg: 'private response content' }, failure);
  }, 2000);
  await assert.rejects(list(), error => {
    const diagnostic = getFeishuReadDiagnostic(error);
    assert.equal(diagnostic.phase, 'request');
    assert.equal(diagnostic.reason, failure === 'reset' ? 'network' : 'http');
    if (failure === 'reset') assert.equal(diagnostic.transportCode, 'ECONNRESET'); else assert.equal(diagnostic.statusCode, failure);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private response|fixture-app-secret|fixture-access-token/); checkTime(diagnostic); return true;
  });
  assert.equal(requests, 1);
});

test('diagnostic allowlist drops arbitrary codes, response bodies, signal text and invalid field values', () => {
  const sensitive = { code: 'SECRET_TOKEN', message: 'private message', response: { status: 987, data: { code: 'private-code' } },
    config: { signal: { aborted: true, reason: { code: 'FEISHU_READ_TIMEOUT' } }, headers: { Authorization: 'secret' } } };
  assert.deepEqual(getFeishuTransportErrorDiagnostic(sensitive), { reason: 'unknown' });
  assert.deepEqual(getFeishuTransportErrorDiagnostic({ code: 'ERR_CANCELED', config: sensitive.config }), { reason: 'cancelled', transportCode: 'ERR_CANCELED' });
  assert.deepEqual(getFeishuTransportErrorDiagnostic({ cause: { code: 'ENOTFOUND' } }), { reason: 'network', transportCode: 'ENOTFOUND' });
  assert.deepEqual(sanitizeFeishuDiagnostic({ reason: 'secret', transportCode: 'SECRET_TOKEN', statusCode: 1000, elapsedMs: -1,
    phase: 'private path', cancellationSource: 'private value', failedAt: '2026-02-30T00:00:00.000Z', ...sensitive }), {});
  assert.deepEqual(sanitizeFeishuDiagnostic({ elapsedMs: 86_400_001, failedAt: '2026-11-13T00:00:00Z' }), {});
  assert.deepEqual(sanitizeFeishuDiagnostic({ reason: 'response', failedAt: '2026-11-13T00:00:00.000Z' }), { reason: 'response', failedAt: '2026-11-13T00:00:00.000Z' });
});

test('frozen errors and primitive thrown values preserve their identities; writes gain no read diagnostics', async () => {
  const original = Object.freeze(Object.assign(new Error('private SDK payload'), { code: 'ECONNRESET' }));
  const transport = createFeishuTransport({ request() { throw original; } });
  await assert.rejects(transport.read(() => transport.httpInstance.request({ method: 'get', url: 'https://fixture.invalid/read' })), error => {
    assert.equal(error, original); assert.equal(getFeishuReadDiagnostic(error).transportCode, 'ECONNRESET'); return true;
  });
  const writeError = new Error('private write context');
  await assert.rejects(transport.write(() => { throw writeError; }), error => error === writeError);
  assert.equal(getFeishuReadDiagnostic(writeError), undefined);
  let thrown;
  try { await transport.read(() => { throw 'fixture primitive'; }); } catch (error) { thrown = error; }
  assert.equal(thrown, 'fixture primitive'); assert.equal(getFeishuReadDiagnostic(thrown), undefined);
  await transport.stop();
});

test('a frozen error reused by a later read receives the new operation phase, time and duration', async t => {
  const original = Object.freeze(Object.assign(new Error('fixture reused error'), { code: 'ECONNRESET' }));
  let clock = 100;
  t.mock.method(performance, 'now', () => clock);
  const transport = createFeishuTransport({ post() { clock += 40; throw original; } });
  await assert.rejects(transport.read(() => transport.httpInstance.post('https://fixture.invalid/auth/v3/tenant_access_token/internal', {})), error => error === original);
  const first = getFeishuReadDiagnostic(original);
  assert.equal(first.phase, 'auth'); assert.equal(first.elapsedMs, 40);
  // A later SDK operation may throw its cached Error without entering an HTTP method.
  await new Promise(resolve => setTimeout(resolve, 5));
  clock = 200;
  await assert.rejects(transport.read(() => { clock += 3; throw original; }), error => error === original);
  const second = getFeishuReadDiagnostic(original);
  assert.equal(second.phase, 'request'); assert.equal(second.elapsedMs, 3);
  assert.ok(Date.parse(second.failedAt) > Date.parse(first.failedAt));
  assert.notEqual(second, first); assert.equal(first.phase, 'auth');
  await transport.stop();
});

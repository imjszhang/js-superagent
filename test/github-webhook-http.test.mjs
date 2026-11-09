import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { verifyGitHubWebhook, listenGitHubWebhook } from '../src/channels/github-webhook.mjs';

const secret = 'local-webhook-fixture-secret-not-a-credential';
const body = Buffer.from('{"action":"opened","issue":{"title":"你好 🌎","number":7}}');
const headers = (data = body, overrides = {}) => ({ 'content-type': 'application/json', 'x-github-delivery': randomUUID(),
  'x-github-event': 'issues', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(data).digest('hex')}`, ...overrides });
const statusError = code => error => error.statusCode === code && !error.message.includes(secret);

function fixtureRuntime() {
  const seen = new Map(), calls = [];
  return { calls, seen,
    receiveGitHubWebhook(input) {
      const verified = verifyGitHubWebhook({ ...input, secret }); calls.push(verified);
      const identity = `${verified.event}:${verified.bodySha256}`, previous = seen.get(verified.deliveryId);
      if (previous && previous !== identity) throw Object.assign(new Error(`must not echo ${secret}`), { statusCode: 409 });
      seen.set(verified.deliveryId, identity);
      return { deliveryId: verified.deliveryId, status: previous ? 'duplicate' : verified.event === 'ping' ? 'ignored' : 'accepted' };
    },
    runNext() { throw new Error('The HTTP handler must not execute a Worker'); },
    syncGitHub() { throw new Error('The HTTP handler must not poll GitHub'); },
  };
}
async function fixture(t, options = {}, runtime = fixtureRuntime()) {
  const receiver = await listenGitHubWebhook(runtime, options);
  t.after(() => receiver.close());
  return { receiver, runtime };
}
function send(url, data = body, supplied = headers(data), { method = 'POST', chunks } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers: supplied, agent: false }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers }));
    });
    request.on('error', reject);
    if (chunks) for (const chunk of chunks) request.write(chunk);
    else request.write(data);
    request.end();
  });
}
function raw(url, text, { end = false, onConnect, resetIsClose = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url), socket = connect(Number(target.port), target.hostname);
    let result = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Raw HTTP fixture timed out')); }, 4000);
    socket.setEncoding('utf8'); socket.on('data', chunk => { result += chunk; });
    socket.on('error', error => { if (!result && !(resetIsClose && error.code === 'ECONNRESET')) { clearTimeout(timer); reject(error); } });
    socket.on('close', () => { clearTimeout(timer); resolve(result); });
    socket.on('connect', () => { socket.write(text); if (end) socket.end(); onConnect?.(socket); });
  });
}
function wireHeaders(url, supplied, rest = '') {
  const target = new URL(url);
  return `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\n${Object.entries(supplied).map(([key, value]) => `${key}: ${value}\r\n`).join('')}${rest}\r\n`;
}

test('verification uses exact UTF-8 wire bytes and normalizes only the delivery identifier', () => {
  const supplied = headers(body); supplied['x-github-delivery'] = supplied['x-github-delivery'].toUpperCase();
  const verified = verifyGitHubWebhook({ body, headers: supplied, secret });
  assert.equal(verified.payload.issue.title, '你好 🌎');
  assert.equal(verified.bodySha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(verified.deliveryId, supplied['x-github-delivery'].toLowerCase());
  assert.equal(verified.event, 'issues');
  const reformatted = Buffer.from(JSON.stringify(JSON.parse(body), null, 2));
  assert.throws(() => verifyGitHubWebhook({ body: reformatted, headers: supplied, secret }), statusError(401));
});

test('invalid signatures are rejected before malformed JSON or attacker-supplied payloads are parsed', () => {
  const invalid = Buffer.from('{this is not JSON');
  assert.throws(() => verifyGitHubWebhook({ body: invalid, headers: headers(body), secret }), statusError(401));
  assert.throws(() => verifyGitHubWebhook({ body, headers: headers(body, { 'x-hub-signature-256': undefined }), secret }), statusError(401));
  assert.throws(() => verifyGitHubWebhook({ body, headers: headers(body, { 'x-hub-signature-256': 'sha1=abcd' }), secret }), statusError(401));
  assert.throws(() => verifyGitHubWebhook({ body, headers: headers(body), secret: 'wrong secret' }), statusError(401));
  assert.throws(() => verifyGitHubWebhook({ body, headers: headers(body), secret: '' }), statusError(503));
});

test('authenticated payloads still require valid metadata, JSON objects and valid UTF-8', () => {
  for (const data of [Buffer.from('null'), Buffer.from('[]'), Buffer.from('true'), Buffer.from('{oops'), Buffer.from([123, 34, 97, 34, 58, 34, 0xff, 34, 125])]) {
    assert.throws(() => verifyGitHubWebhook({ body: data, headers: headers(data), secret }), statusError(400));
  }
  for (const override of [{ 'x-github-delivery': 'not-a-uuid' }, { 'x-github-event': 'Issues\n' }, { 'x-github-event': ['issues', 'ping'] }]) {
    assert.throws(() => verifyGitHubWebhook({ body, headers: headers(body, override), secret }), statusError(400));
  }
  assert.throws(() => verifyGitHubWebhook({ body, headers: { ...headers(body), 'X-GitHub-Event': 'issues' }, secret }), statusError(400));
  assert.throws(() => verifyGitHubWebhook({ body, headers: headers(body), secret, maxBodyBytes: body.byteLength - 1 }), statusError(413));
});

test('real HTTP ingress acknowledges durable acceptance and redelivery without executing or polling', async t => {
  const { receiver, runtime } = await fixture(t);
  const supplied = headers(body), first = await send(receiver.url, body, supplied), second = await send(receiver.url, body, supplied);
  assert.equal(first.status, 202); assert.equal(JSON.parse(first.text).status, 'accepted');
  assert.equal(second.status, 200); assert.equal(JSON.parse(second.text).status, 'duplicate');
  assert.equal(runtime.seen.size, 1); assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[0].bodySha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(first.headers['cache-control'], 'no-store');
  const ping = await send(receiver.url, body, headers(body, { 'x-github-event': 'ping' }));
  assert.equal(ping.status, 200); assert.equal(JSON.parse(ping.text).status, 'ignored');
});

test('HTTP signature failures and delivery collisions never leak handler errors or secrets', async t => {
  const { receiver, runtime } = await fixture(t);
  const supplied = headers(body), changed = Buffer.from('{"action":"changed"}');
  assert.equal((await send(receiver.url, changed, supplied)).status, 401); assert.equal(runtime.calls.length, 0);
  await send(receiver.url, body, supplied);
  const conflict = await send(receiver.url, changed, headers(changed, { 'x-github-delivery': supplied['x-github-delivery'] }));
  assert.equal(conflict.status, 409); assert.ok(!conflict.text.includes(secret)); assert.equal(runtime.seen.size, 1);
  const missing = { ...headers(body) }; delete missing['x-hub-signature-256'];
  assert.equal((await send(receiver.url, body, missing)).status, 401);
});

test('HTTP route, method, content type and compression are checked before runtime ingestion', async t => {
  const { receiver, runtime } = await fixture(t, { path: '/custom/hook' });
  assert.equal((await send(receiver.url + '?query=1')).status, 404);
  assert.equal((await send(receiver.url.replace('/custom/hook', '/other'))).status, 404);
  assert.equal((await send(receiver.url, body, headers(body), { method: 'GET' })).status, 405);
  assert.equal((await send(receiver.url, body, headers(body, { 'content-type': 'application/x-www-form-urlencoded' }))).status, 415);
  assert.equal((await send(receiver.url, body, headers(body, { 'content-encoding': 'gzip' }))).status, 415);
  assert.equal(runtime.calls.length, 0);
  assert.equal((await send(receiver.url, body, headers(body, { 'content-type': 'application/json; charset=utf-8' }))).status, 202);
});

test('raw duplicate authentication and framing headers are rejected before runtime ingestion', async t => {
  const { receiver, runtime } = await fixture(t);
  for (const header of ['x-hub-signature-256', 'x-github-delivery', 'x-github-event', 'content-type']) {
    const supplied = headers(body);
    const response = await raw(receiver.url, wireHeaders(receiver.url, supplied, `${header}: ${supplied[header]}\r\nContent-Length: ${body.byteLength}\r\n`) + body);
    assert.match(response, /^HTTP\/1\.1 400 /);
  }
  const response = await raw(receiver.url, wireHeaders(receiver.url, headers(body), `Content-Length: ${body.byteLength}\r\nContent-Length: ${body.byteLength}\r\n`) + body);
  assert.match(response, /^HTTP\/1\.1 400 /); assert.equal(runtime.calls.length, 0);
});

test('chunked requests preserve signed bytes and enforce the streaming limit', async t => {
  const { receiver, runtime } = await fixture(t, { maxBodyBytes: body.byteLength });
  const result = await send(receiver.url, body, headers(body), { chunks: [body.subarray(0, 9), body.subarray(9, 20), body.subarray(20)] });
  assert.equal(result.status, 202);
  const tooLarge = Buffer.concat([body, Buffer.from(' ')]);
  assert.equal((await send(receiver.url, tooLarge, headers(tooLarge), { chunks: [body, Buffer.from(' ')] })).status, 413);
  assert.equal((await send(receiver.url, tooLarge, headers(tooLarge, { 'content-length': String(tooLarge.byteLength) }))).status, 413);
  assert.equal(runtime.calls.length, 1);
});

test('truncated content-length bodies are never ingested', async t => {
  const { receiver, runtime } = await fixture(t, { requestTimeoutMs: 200 });
  await raw(receiver.url, wireHeaders(receiver.url, headers(body), `Content-Length: ${body.byteLength + 4}\r\n`) + body, { end: true });
  assert.equal(runtime.calls.length, 0);
});

test('slow bodies time out and concurrent body readers are bounded', async t => {
  const { receiver, runtime } = await fixture(t, { requestTimeoutMs: 300, maxConcurrentRequests: 1 });
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const slow = raw(receiver.url, wireHeaders(receiver.url, headers(body), `Content-Length: ${body.byteLength}\r\n`), { onConnect: connected });
  await ready;
  assert.equal((await send(receiver.url)).status, 429);
  assert.match(await slow, /^HTTP\/1\.1 408 /); assert.equal(runtime.calls.length, 0);
});

test('incomplete headers are covered by the same bounded request deadline', async t => {
  const { receiver, runtime } = await fixture(t, { requestTimeoutMs: 100 });
  const response = await raw(receiver.url, `POST /github/webhook HTTP/1.1\r\nHost: localhost\r\nX-Slow: `);
  assert.match(response, /^HTTP\/1\.1 408 /); assert.equal(runtime.calls.length, 0);
});

test('closing rejects partial requests, is idempotent and leaves no active HTTP listener', async t => {
  const { receiver, runtime } = await fixture(t);
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const slow = raw(receiver.url, wireHeaders(receiver.url, headers(body), `Content-Length: ${body.byteLength}\r\n`), { onConnect: connected, resetIsClose: true });
  await ready;
  // Allow the server to receive the already written request before initiating shutdown.
  await new Promise(resolve => setImmediate(resolve));
  const closed = receiver.close(); assert.equal(receiver.close(), closed); await closed;
  const response = await slow;
  assert.ok(!response || /^HTTP\/1\.1 503 /.test(response)); assert.equal(runtime.calls.length, 0);
  await assert.rejects(send(receiver.url), /ECONNREFUSED|socket hang up/);
});

test('unexpected runtime failures and asynchronous handlers receive generic errors without false acceptance', async t => {
  for (const receiveGitHubWebhook of [() => { throw new Error(secret); }, () => ({ status: 'accepted', deliveryId: secret }), () => Promise.reject(new Error(secret))]) {
    const { receiver } = await fixture(t, {}, { receiveGitHubWebhook });
    const response = await send(receiver.url); assert.equal(response.status, 500); assert.ok(!response.text.includes(secret));
    await receiver.close();
  }
});

test('listener configuration is explicit and rejects invalid resource limits', async () => {
  for (const options of [{ host: 'https://example.com' }, { port: -1 }, { path: '/hook?secret=abc' }, { maxBodyBytes: 26 * 1024 * 1024 },
    { requestTimeoutMs: 0 }, { maxConcurrentRequests: 0 }]) {
    await assert.rejects(listenGitHubWebhook(fixtureRuntime(), options));
  }
  await assert.rejects(listenGitHubWebhook({}), /receiveGitHubWebhook/);
});

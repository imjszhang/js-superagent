import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuSource } from '../src/channels/feishu.mjs';
import { createFeishuTransport } from '../src/channels/feishu-transport.mjs';

const NOW = 1_800_000_000_000, SINCE = NOW / 1000 - 100;
const page = (items = []) => ({ code: 0, data: { items, has_more: false } });
const baseline = () => ({ schemaVersion: 2, scopes: { oc_group: { since: SINCE } },
  discovery: { oc_group: { complete: true } } });
const row = extra => ({ message_id: 'om_message', chat_id: 'oc_group', message_type: 'text', create_time: String(NOW - 10_000),
  body: { content: JSON.stringify({ text: 'fixture request' }) }, sender: { id_type: 'open_id', id: 'ou_author', sender_type: 'user' },
  mentions: [{ id: 'ou_bot' }], ...extra });
function fixture(list, options = {}) {
  let calls = 0;
  const source = createFeishuSource({ botOpenId: 'ou_bot', tenantKey: 'fixture', now: () => NOW,
    scopes: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }],
    client: { im: { message: { async list(request) { calls++; return list(request); }, async get() { return page(); }, async reply() {} } } },
    ...options });
  return { source, calls: () => calls };
}
function assertTiming(error) {
  assert.ok(Number.isSafeInteger(error.elapsedMs));
  assert.ok(error.elapsedMs >= 0 && error.elapsedMs <= 86_400_000);
  assert.equal(new Date(error.failedAt).toISOString(), error.failedAt);
}

for (const [label, details, expected] of [
  ['connection reset', { code: 'ECONNRESET' }, { reason: 'network', transportCode: 'ECONNRESET' }],
  ['DNS failure', { cause: { code: 'ENOTFOUND' } }, { reason: 'network', transportCode: 'ENOTFOUND' }],
  ['HTTP failure', { code: 'ERR_BAD_RESPONSE', response: { status: 503, data: { message: 'private-value' } } },
    { reason: 'http', transportCode: 'ERR_BAD_RESPONSE', statusCode: 503 }],
  ['untrusted cancellation', { code: 'ERR_CANCELED', config: { signal: { reason: { code: 'FEISHU_READ_TIMEOUT' } } } },
    { reason: 'cancelled', transportCode: 'ERR_CANCELED' }],
  ['unknown error', { code: 'PRIVATE_VALUE', validation: true, reason: 'timeout', phase: 'auth', elapsedMs: 123 },
    { reason: 'unknown' }],
]) test(`history keeps safe ${label} facts without retrying or trusting attached diagnostics`, async () => {
  const failure = Object.assign(new Error('private-value in SDK URL, token and message'), details,
    { request: { authorization: 'private-value' }, diagnostic: { reason: 'timeout', private: 'private-value' } });
  const f = fixture(async () => { throw failure; }), cursor = baseline();
  const result = await f.source.poll({ cursor });
  assert.equal(f.calls(), 1, 'diagnostics must not add a retry');
  assert.deepEqual(result.events, []);
  assert.equal(result.cursor.scopes.oc_group.since, SINCE);
  assert.deepEqual(cursor, baseline(), 'poll leaves its input cursor untouched');
  const error = result.errors[0];
  assert.equal(error.category, 'transport'); assert.equal(error.phase, 'history');
  for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
  if (!expected.transportCode) assert.equal(error.transportCode, undefined);
  assert.equal(error.cancellationSource, undefined, 'arbitrary request config is not trusted cancellation evidence');
  assertTiming(error);
  assert.ok(!JSON.stringify(result).includes('private-value'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
});

for (const [label, response, expected] of [
  ['permission', { code: 230027, msg: 'private-value' }, { category: 'permission', reason: 'api', code: 230027 }],
  ['platform rejection', { code: 123456, msg: 'private-value' }, { category: 'transport', reason: 'api', code: 123456 }],
  ['unknown envelope', { message: 'private-value' }, { category: 'transport', reason: 'response' }],
]) test(`history distinguishes ${label} from a network failure`, async () => {
  const { source, calls } = fixture(async () => response);
  const result = await source.poll({ cursor: baseline() }), error = result.errors[0];
  for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
  assert.equal(error.phase, 'history'); assertTiming(error);
  assert.equal(result.cursor.scopes.oc_group.since, SINCE);
  assert.equal(calls(), 1); assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('HTTP permission failure retains both the platform code and the HTTP status safely', async () => {
  const { source } = fixture(async () => { throw Object.assign(new Error('private-value'), {
    response: { status: 403, data: { code: 230027, msg: 'private-value' }, headers: { authorization: 'private-value' } },
  }); });
  const result = await source.poll({ cursor: baseline() }), error = result.errors[0];
  assert.equal(error.category, 'permission'); assert.equal(error.reason, 'api');
  assert.equal(error.code, 230027); assert.equal(error.statusCode, 403);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('throwing SDK error accessors cannot escape redaction or replace a failed page with a poll-wide exception', async () => {
  const failure = new Error('private-value');
  Object.defineProperty(failure, 'response', { get() { throw new Error('private-value'); } });
  const { source } = fixture(async () => { throw failure; });
  const result = await source.poll({ cursor: baseline() });
  assert.equal(result.errors[0].reason, 'unknown');
  assert.equal(result.cursor.scopes.oc_group.since, SINCE);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

for (const [label, invalid, expected] of [
  ['message ID', { message_id: 'private-value' }, 'Invalid message ID'],
  ['content JSON', { body: { content: 'private-value{' } }, 'Malformed Feishu message content'],
  ['attachment ID', { message_type: 'image', body: { content: JSON.stringify({ image_key: 'private-value' }) } }, 'Invalid image key'],
  ['message size', { body: { content: JSON.stringify({ text: 'private-value'.repeat(12_000) }) } }, 'Feishu message text exceeds 128 KiB'],
]) test(`history classifies known invalid ${label} without skipping the failed window`, async () => {
  const { source, calls } = fixture(async () => page([row(invalid)]));
  const result = await source.poll({ cursor: baseline() }), error = result.errors[0];
  assert.equal(error.category, 'validation'); assert.equal(error.reason, 'validation');
  assert.equal(error.phase, 'validation'); assert.equal(error.error, expected); assertTiming(error);
  assert.equal(result.cursor.scopes.oc_group.since, SINCE); assert.equal(calls(), 1);
  assert.deepEqual(result.events, []); assert.ok(!JSON.stringify(result).includes('private-value'));
});

for (const [label, invalid] of [
  ['mentions', { mentions: { private: 'private-value' } }],
  ['rich text rows', { message_type: 'post', body: { content: JSON.stringify({ content: { private: 'private-value' } }) } }],
]) test(`unknown local ${label} errors are identified by phase without claiming a known validation cause`, async () => {
  const { source } = fixture(async () => page([row(invalid)]));
  const result = await source.poll({ cursor: baseline() }), error = result.errors[0];
  assert.equal(error.category, 'transport'); assert.equal(error.reason, 'unknown');
  assert.equal(error.phase, 'validation'); assert.equal(error.error, 'Feishu history message processing failed');
  assert.equal(result.cursor.scopes.oc_group.since, SINCE); assert.deepEqual(result.events, []);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('trusted auth-stage failure reaches the history diagnostic without becoming a history-request failure', async t => {
  const transport = createFeishuTransport({ async request() { throw Object.assign(new Error('private-value'), { code: 'ECONNRESET' }); } });
  t.after(() => transport.stop());
  const { source } = fixture(() => transport.httpInstance.request({ method: 'post', url: 'https://fixture.invalid/auth/v3/tenant_access_token/internal',
    data: { app_secret: 'private-value' } }), { transport });
  const result = await source.poll({ cursor: baseline() }), error = result.errors[0];
  assert.equal(error.phase, 'auth'); assert.equal(error.reason, 'network'); assert.equal(error.transportCode, 'ECONNRESET');
  assertTiming(error); assert.equal(result.cursor.scopes.oc_group.since, SINCE);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('a skipped failed container retains its diagnostic until that same container succeeds', async () => {
  let broken = true;
  const { source, calls } = fixture(async ({ params }) => {
    if (params.container_id_type === 'chat' && broken) throw Object.assign(new Error('private-value'), { code: 'ECONNRESET' });
    return page();
  }, { maxPages: 1 });
  const cursor = baseline(); cursor.topics = { 'oc_group:omt_topic': {
    chatId: 'oc_group', threadId: 'omt_topic', rootId: 'om_root', since: SINCE, lastSeen: NOW - 10_000,
  } };
  const failed = await source.poll({ cursor }), diagnostic = structuredClone(failed.errors[0]);
  const skipped = await source.poll({ cursor: failed.cursor });
  assert.equal(skipped.cursor.scopes.oc_group.since, SINCE);
  assert.equal(skipped.cursor.topics['oc_group:omt_topic'].since, NOW / 1000);
  assert.deepEqual(skipped.errors, [diagnostic]);
  broken = false;
  const recovered = await source.poll({ cursor: skipped.cursor });
  assert.equal(recovered.cursor.scopes.oc_group.since, NOW / 1000);
  assert.deepEqual(recovered.errors, []); assert.deepEqual(recovered.cursor.failures, {});
  assert.equal(calls(), 3, 'one request per existing round budget, with no diagnostic retries');
});

test('source cancellation still aborts the poll instead of persisting a failed-scope diagnostic', async () => {
  const controller = new AbortController(), cursor = baseline();
  const { source, calls } = fixture(async () => { controller.abort(); throw Object.assign(new Error('private-value'), { code: 'ERR_CANCELED' }); });
  await assert.rejects(source.poll({ cursor, signal: controller.signal }), /Feishu operation cancelled/);
  assert.deepEqual(cursor, baseline()); assert.equal(calls(), 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerInputUnreadFailure, createHostFailureNotice, verifyHostFailureNotice, HOST_FAILURE_NOTICE_TEXT, WORKER_INPUT_UNREAD_CODE } from '../src/runtime/host-failure-notice.mjs';

const fixture = () => ({ publicId: 'public-ticket', domainId: 'domain-ticket', assignmentId: 'assignment', runId: 'run', originTriggerId: 'feishu:tenant:root',
  failure: { ...createWorkerInputUnreadFailure(['input-two', 'input-one']), runId: 'run', at: '2026-11-16T00:00:00.000Z' },
  channel: { source: 'feishu', thread: 'tenant:oc_group:om_root', address: { tenantKey: 'tenant', chatId: 'oc_group', rootId: 'om_root' } },
  route: { source: 'feishu', appId: 'cli_bot', tenantKey: 'tenant', botOpenId: 'ou_bot', chatId: 'oc_group' } });

test('unread failure preserves bounded original IDs without asserting a budget rejection', () => {
  const failure = createWorkerInputUnreadFailure([...Array.from({ length: 40 }, (_, i) => `input-${i}`), 'input-0']);
  assert.equal(failure.code, WORKER_INPUT_UNREAD_CODE); assert.equal(failure.origin, 'host-context-unread'); assert.equal(failure.requiresInspection, true);
  assert.equal(failure.unreadInputIds.length, 32); assert.equal(failure.unreadInputCount, 40); assert.equal(failure.omittedInputCount, 8);
  assert.match(failure.summary, /remain unread/); assert.doesNotMatch(failure.summary, /budget|input-0/);
  for (const value of [[], null, [''], ['body\nnot an identifier'], ['x'.repeat(257)], [17]]) assert.throws(() => createWorkerInputUnreadFailure(value), TypeError);
});

test('fixed notice binds its original run and destination and exposes no raw failure details', () => {
  const input = fixture(), { message, proof } = createHostFailureNotice(input);
  assert.equal(verifyHostFailureNotice(message, proof, input.failure), true);
  assert.equal(message.kind, 'notice'); assert.equal(message.ticketId, input.domainId); assert.equal(message.text, `${HOST_FAILURE_NOTICE_TEXT}\n\n工单 public-ticket`);
  assert.doesNotMatch(message.text, /input-one|input-two|assignment|feishu:tenant:root/);
  assert.deepEqual(proof.route, input.route); assert.equal(proof.publicId, input.publicId); assert.equal(proof.runId, input.runId);
  input.channel.address.chatId = 'replacement'; input.route.appId = 'replacement';
  assert.equal(message.channel.address.chatId, 'oc_group'); assert.equal(proof.route.appId, 'cli_bot');
});

test('receipt identity is stable across diagnostic changes and property ordering but separate across runs or destinations', () => {
  const input = fixture(), first = createHostFailureNotice(input);
  const diagnostic = createHostFailureNotice({ ...input, failure: { ...input.failure, at: '2026-11-17T00:00:00.000Z' } });
  assert.equal(first.message.id, diagnostic.message.id); assert.deepEqual(first.message, diagnostic.message);
  assert.notEqual(first.proof.failureDigest, diagnostic.proof.failureDigest);
  const reordered = structuredClone(input); reordered.channel = { address: reordered.channel.address, thread: reordered.channel.thread, source: reordered.channel.source };
  assert.equal(createHostFailureNotice(reordered).message.id, first.message.id);
  assert.notEqual(createHostFailureNotice({ ...input, runId: 'another-run' }).message.id, first.message.id);
  assert.notEqual(createHostFailureNotice({ ...input, channel: { ...input.channel, thread: 'other-thread' } }).message.id, first.message.id);
});

for (const field of ['text', 'kind', 'id', 'ticketId', 'channel']) test(`notice rejects modified message ${field}`, () => {
  const input = fixture(), { message, proof } = createHostFailureNotice(input);
  message[field] = field === 'channel' ? { ...message.channel, address: { ...message.channel.address, chatId: 'oc_other' } } : `${message[field]}-forged`;
  assert.equal(verifyHostFailureNotice(message, proof, input.failure), false);
});

for (const field of ['publicId', 'domainId', 'assignmentId', 'runId', 'originTriggerId', 'requestTriggerId', 'route', 'template', 'failureDigest', 'messageDigest']) test(`notice rejects modified proof ${field}`, () => {
  const input = fixture(), { message, proof } = createHostFailureNotice(input);
  proof[field] = field === 'route' ? { ...proof.route, appId: 'another-app' } : `${proof[field]}-forged`;
  assert.equal(verifyHostFailureNotice(message, proof, input.failure), false);
});

test('coordinator wrappers retain both the domain request and the actual original channel trigger', () => {
  const input = { ...fixture(), requestTriggerId: 'local:coordinator-request' }, { message, proof } = createHostFailureNotice(input);
  assert.equal(proof.requestTriggerId, input.requestTriggerId); assert.equal(proof.originTriggerId, input.originTriggerId);
  assert.equal(verifyHostFailureNotice(message, proof, input.failure), true);
  assert.equal(createHostFailureNotice(fixture()).proof.requestTriggerId, fixture().originTriggerId);
});

test('model claims, ordinary blocked records and historical summary text do not qualify as saved host faults', () => {
  const input = fixture(), { message, proof } = createHostFailureNotice(input);
  for (const failure of [{ origin: 'business', requiresInspection: false }, { code: WORKER_INPUT_UNREAD_CODE }, { ...input.failure, origin: 'native-execution' },
    { ...input.failure, requiresInspection: false }, { ...input.failure, summary: 'Required inputs exceeded budget' }, { ...input.failure, unreadInputIds: [] },
    { ...input.failure, unreadInputCount: 1 }, { ...input.failure, omittedInputCount: 3 }, { ...input.failure, at: 'changed' }]) {
    assert.equal(verifyHostFailureNotice(message, proof, failure), false);
  }
  assert.equal(verifyHostFailureNotice(message, undefined, input.failure), false);
  assert.equal(verifyHostFailureNotice(message, { ...proof, invented: true }, input.failure), false);
});

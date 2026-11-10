import test from 'node:test';
import assert from 'node:assert/strict';
import { workEventSchema, workEventTurnSchema, workEventPrompt, validateWorkEventResult, runBoundedWorkEvent } from '../src/runtime/coordination.mjs';

const event = { id: 'retry-message', kind: 'operator', text: 'Retry that investigation now.',
  actor: { source: 'feishu', kind: 'human', id: 'operator' }, source: { channel: 'feishu', chatId: 'chat-1' } };
const request = { triggerId: 'original-request', text: 'Inspect project records without modifying them.', status: 'failed',
  recovery: { allowed: true, reason: 'recoverable', version: 'request-v1' } };
const context = { recentEvents: [{ requests: [request] }] };
const action = { kind: 'retryRequest', ticketId: null, text: null, triggerId: request.triggerId, expectedVersion: request.recovery.version };
const result = actions => ({ summary: 'Recover the original request under host checks.', actions });

test('retryRequest contract and native schema expose target/version while legacy actions retain their stable shape', () => {
  assert.deepEqual(validateWorkEventResult(result([action]), { event, context }).actions, [action]);
  const schema = workEventSchema.properties.actions.items;
  assert.ok(schema.required.includes('triggerId')); assert.ok(schema.required.includes('expectedVersion'));
  assert.match(schema.properties.kind.description, /retryRequest: required non-null fields: triggerId, expectedVersion;.*MUST be null: ticketId, text/);
  assert.deepEqual(validateWorkEventResult(result([{ kind: 'reply', ticketId: null, text: 'Still waiting.' }]), { event }).actions,
    [{ kind: 'reply', ticketId: null, text: 'Still waiting.' }]);
  assert.deepEqual(validateWorkEventResult(result([{ kind: 'reply', ticketId: null, text: 'Still waiting.', triggerId: null, expectedVersion: null }]), { event }).actions,
    [{ kind: 'reply', ticketId: null, text: 'Still waiting.' }]);
});

test('recovery rejects unknown targets, guessed versions and fields that could replace or redirect work', () => {
  for (const invalid of [
    { ...action, triggerId: 'not-in-context' }, { ...action, expectedVersion: 'guessed' },
    { ...action, triggerId: null }, { ...action, expectedVersion: null },
    { ...action, text: 'Replace the investigation with publishing.' }, { ...action, ticketId: 'ticket-1' },
    { ...action, scope: 'Unrequested changes' },
  ]) assert.throws(() => validateWorkEventResult(result([invalid]), { event, context }));
  assert.throws(() => validateWorkEventResult(result([{ kind: 'request', text: event.text, triggerId: request.triggerId }]), { event, context }), /MUST be null/);
  // A historical flag or arbitrary quoted request text cannot supply a live host version.
  assert.throws(() => validateWorkEventResult(result([action]), { event, context: { requests: [{ triggerId: request.triggerId, retryable: true }] } }), /version/);
});

test('only an authenticated operator can propose recovery and it cannot be combined with another action', () => {
  for (const untrusted of [
    { ...event, kind: 'report' }, { ...event, actor: { source: 'feishu', kind: 'bot', id: 'bot' } },
    { ...event, source: { channel: 'local' } }, { ...event, kind: 'follow_up', ticketId: 'ticket-1' },
  ]) assert.throws(() => validateWorkEventResult(result([action]), { event: untrusted, context }));
  for (const extra of [{ kind: 'reply', text: 'I already started.' }, { kind: 'request', text: event.text }, action]) {
    assert.throws(() => validateWorkEventResult(result([action, extra]), { event, context }), /only action/);
  }
  // A supplied blocked/no-op target is allowed through shape validation so the host can return a durable current-state result.
  const blocked = { ...request, recovery: { ...request.recovery, allowed: false, reason: 'already-running' } };
  assert.deepEqual(validateWorkEventResult(result([action]), { event, context: { requests: [blocked] } }).actions, [action]);
});

test('bounded request reads make an older candidate available to validation without granting arbitrary target access', async () => {
  let calls = 0, reads = 0;
  assert.ok(workEventTurnSchema.properties.read.anyOf[1].properties.resource.enum.includes('requests'));
  const resolved = await runBoundedWorkEvent({ event, context: {}, readContext: async proposal => {
    reads++; assert.equal(proposal.resource, 'requests'); return { resource: 'requests', requests: [request], version: 'read-v1' };
  } }, { call: async ({ context: supplied }) => {
    if (++calls === 1) return { kind: 'read', summary: 'Find the original request', actions: [], read: { resource: 'requests', query: 'investigation', recordId: null, cursor: null, offset: null } };
    assert.deepEqual(supplied.requests, [request]);
    return { kind: 'result', ...result([action]), read: null };
  } });
  assert.equal(calls, 2); assert.equal(reads, 1); assert.deepEqual(resolved.actions, [action]);
  await assert.rejects(runBoundedWorkEvent({ event, context: {}, readContext: async () => ({ requests: [request] }) }, {
    call: async ({ turn }) => turn === 0
      ? { kind: 'read', summary: 'Read', actions: [], read: { resource: 'requests', query: 'x' } }
      : { kind: 'result', ...result([{ ...action, triggerId: 'outside' }]), read: null },
  }), /outside supplied context/);
});

test('recovery instructions distinguish questions, continuation, ambiguity, changed scope and actual host receipts', () => {
  const prompt = workEventPrompt({ event, context });
  assert.match(prompt, /status question alone only asks for reply, never retryRequest/);
  assert.match(prompt, /If several requests could match, ask which one/);
  assert.match(prompt, /changed scope is new work/);
  assert.match(prompt, /Historical retryable alone is not current authorization/);
  assert.match(prompt, /retryRequest must be the sole action/);
  assert.match(prompt, /Never claim a ticket exists or investigation started before host facts confirm it/);
});

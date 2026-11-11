import test from 'node:test';
import assert from 'node:assert/strict';
import { workEventSchema, workEventPrompt, validateWorkEventResult, runBoundedWorkEvent } from '../src/runtime/coordination.mjs';
import { createCoordinationReader } from '../src/runtime/coordination-context.mjs';

const event = { id: 'retry-failed-ticket', kind: 'operator', text: 'Resume the failed read-only investigation.',
  actor: { source: 'feishu', kind: 'human', id: 'operator' }, source: { channel: 'feishu', chatId: 'original-chat' } };
const ticket = { id: 'original-ticket', status: 'failed', scope: 'Inspect the existing records without modifying them.',
  recovery: { allowed: true, reason: 'recoverable', version: 'ticket-failure-v1', state: 'inspection' } };
const context = { tickets: [ticket] };
const action = { kind: 'retryTicket', ticketId: ticket.id, text: null, triggerId: null, expectedVersion: ticket.recovery.version };
const result = actions => ({ summary: 'Request recovery of the existing ticket under host checks.', actions });

test('retryTicket schema binds the existing ticket and failure version without carrying replacement work', () => {
  assert.deepEqual(validateWorkEventResult(result([action]), { event, context }).actions, [action]);
  const schema = workEventSchema.properties.actions.items;
  assert.ok(schema.properties.kind.enum.includes('retryTicket'));
  assert.match(schema.properties.kind.description, /retryTicket: required non-null fields: ticketId, expectedVersion;.*MUST be null: text, triggerId/);
  assert.match(schema.properties.expectedVersion.description, /retryRequest, retryTicket/);
  assert.doesNotMatch(schema.properties.triggerId.description, /Allowed only for [^.]*retryTicket/);
  assert.deepEqual(validateWorkEventResult(result([{ kind: 'reply', ticketId: null, text: 'The ticket is still failed.' }]), { event }).actions,
    [{ kind: 'reply', ticketId: null, text: 'The ticket is still failed.' }]);
});

test('ticket recovery rejects unknown IDs, stale or absent versions, and scope-bearing fields', () => {
  for (const invalid of [
    { ...action, ticketId: 'not-supplied' }, { ...action, ticketId: null },
    { ...action, expectedVersion: 'ticket-failure-v0' }, { ...action, expectedVersion: null },
    { ...action, text: 'Publish instead of investigating.' }, { ...action, triggerId: 'old-candidate' },
    { ...action, newScope: 'Unrequested work' },
  ]) assert.throws(() => validateWorkEventResult(result([invalid]), { event, context }));
  assert.throws(() => validateWorkEventResult(result([action]), { event, context: { tickets: [{ ...ticket, recovery: undefined }] } }), /version/);
  // An old candidate's version is not the failed ticket's current version.
  assert.throws(() => validateWorkEventResult(result([{ ...action, expectedVersion: 'candidate-v1' }]), {
    event, context: { ...context, requests: [{ triggerId: 'old-candidate', ticketId: ticket.id, recovery: { version: 'candidate-v1' } }] },
  }), /supplied ticket/);
});

test('ticket recovery requires the authenticated operator event and cannot accompany another action', () => {
  for (const untrusted of [
    { ...event, kind: 'report' }, { ...event, kind: 'result' },
    { ...event, actor: { source: 'feishu', kind: 'bot', id: 'operator' } },
    { ...event, actor: { source: 'github', kind: 'human', id: 'operator' } },
    { ...event, source: { channel: 'local' } },
    { ...event, kind: 'follow_up', ticketId: ticket.id, actor: { source: 'github', kind: 'human', id: 'operator' }, references: { triggerId: 'quoted-retry' } },
  ]) assert.throws(() => validateWorkEventResult(result([action]), { event: untrusted, context }));
  const local = { ...event, actor: { source: 'local', kind: 'human', id: 'operator' } };
  assert.deepEqual(validateWorkEventResult(result([action]), { event: local, context }).actions, [action]);
  const request = { triggerId: 'old-candidate', recovery: { version: 'candidate-v1' } };
  for (const extra of [
    { kind: 'reply', text: 'Recovery has already succeeded.' },
    { kind: 'note', ticketId: ticket.id, text: 'Also run a different investigation.' },
    { kind: 'request', text: event.text },
    { kind: 'retryRequest', triggerId: request.triggerId, expectedVersion: request.recovery.version }, action,
  ]) assert.throws(() => validateWorkEventResult(result([action, extra]), { event, context: { ...context, requests: [request] } }), /only action/);
});

test('supplied blocked and in-progress tickets reach host revalidation without granting recovery', () => {
  // Shape validation does not authorize execution; the host emits the current blocked/no-op receipt.
  for (const reason of ['in-progress', 'already-completed', 'authority', 'pending-delivery', 'native-history-unavailable']) {
    const blocked = { ...ticket, recovery: { ...ticket.recovery, allowed: false, reason } };
    assert.deepEqual(validateWorkEventResult(result([action]), { event, context: { tickets: [blocked] } }).actions, [action]);
  }
});

test('bounded ticket reads supply recovery facts and reject invented targets after discovery', async () => {
  let reads = 0;
  const resolve = target => runBoundedWorkEvent({ event, context: {}, readContext: async request => {
    reads++; assert.equal(request.resource, 'tickets');
    return { resource: 'tickets', tickets: [ticket], version: 'read-v1' };
  } }, { call: async ({ turn, context: supplied }) => {
    if (!turn) return { kind: 'read', summary: 'Locate the original failed ticket', actions: [], read: { resource: 'tickets', query: 'investigation', recordId: null, cursor: null, offset: null } };
    assert.deepEqual(supplied.tickets, [ticket]);
    return { kind: 'result', ...result([{ ...action, ticketId: target }]), read: null };
  } });
  assert.deepEqual((await resolve(ticket.id)).actions, [action]);
  await assert.rejects(resolve('not-supplied'), /outside supplied context/);
  assert.equal(reads, 2);
});

test('ticket reader exposes recovery card on search and expansion and detects eligibility changes', () => {
  const meta = { id: ticket.id, domainId: 'domain-1', messages: [] };
  const domain = { id: meta.domainId, title: 'Original investigation', inputs: [], assignments: [], threads: [], follows: [] };
  const store = { listMeta: () => [{ value: meta }], tickets: { get: () => domain } };
  let recovery = structuredClone(ticket.recovery);
  const reader = createCoordinationReader(store, { ticketCard: () => ({ ...ticket, recovery }) });
  const search = reader.read({ resource: 'tickets', query: 'investigation' });
  assert.deepEqual(search.tickets[0].recovery, recovery);
  const expanded = reader.read({ resource: 'tickets', recordId: ticket.id, offset: 0 });
  assert.deepEqual(expanded.tickets[0].recovery, recovery);
  assert.equal(reader.verify(), true);
  // The underlying ticket text can stay unchanged while its recovery ownership/version changes.
  recovery = { ...recovery, allowed: false, reason: 'in-progress', version: 'ticket-failure-v2', state: 'pending' };
  assert.throws(() => reader.verify(), /context or policy changed/);
});

test('recovery prompt distinguishes failed tickets from candidates and does not overclaim acceptance', () => {
  const prompt = workEventPrompt({ event, context });
  assert.match(prompt, /same failed request that has NOT created a ticket/);
  assert.match(prompt, /candidate marked already-owned means a ticket exists; it does not determine whether that ticket can recover/);
  assert.match(prompt, /status question alone only asks for reply, never retryTicket/);
  assert.match(prompt, /If several tickets could match, ask which one/);
  assert.match(prompt, /Changed scope is new work and cannot be inserted by retryTicket/);
  assert.match(prompt, /retryTicket must be the sole action/);
  assert.match(prompt, /checking receipt means inspection was requested, not that execution resumed or succeeded/);
  assert.match(prompt, /do not create a replacement ticket, retry its original candidate, or use note\/requestStatus to restart it/);
});

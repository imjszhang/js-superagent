import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { createTurnAssessor } from '../src/runtime/turn-assessor.mjs';
import { AssessmentFormatError } from '../src/runtime/assessment.mjs';
import { runBoundedWorkEvent, validateWorkEventResult, WorkEventOutputError } from '../src/runtime/coordination.mjs';

const event = { id: 'correction', kind: 'operator', actor: { source: 'local', kind: 'human', id: 'operator' }, text: 'Correct the explanation and confirm status only; do not reopen the task.' };
const context = { tickets: [{ id: 'finished-ticket', status: 'completed', ended: { by: 'executor' } }] };
const reply = { kind: 'reply', ticketId: null, text: 'Correction: the files differ; their numbering does not prove edit order. The task is completed.' };
const invalid = { kind: 'result', read: null, summary: 'Correct the historical explanation', actions: [{ kind: 'note', ticketId: 'finished-ticket', text: 'Retain the correction on this completed ticket.' }, reply] };
const corrected = { kind: 'result', read: null, summary: 'Explain the correction without changing the completed task', actions: [reply] };

test('a completed-ticket correction regenerates the whole result as reply-only before committing any action', async t => {
  const root = mkdtempSync(join(tmpdir(), 'coordination-ended-correction-'));
  const calls = [], prompts = [];
  let ticket;
  const assessor = createTurnAssessor({ config: { timeoutMs: 5000 }, runTurn: async input => {
    calls.push(input.runId); prompts.push(input.prompt);
    input.checkpoint({ driver: 'fixture-assessor', id: 'same-coordination-session' });
    if (calls.length === 1) return { ...invalid, actions: [{ ...invalid.actions[0], ticketId: ticket.id }, reply] };
    assert.equal(input.session.id, 'same-coordination-session');
    return corrected;
  } });
  const runtime = createProjectAgent({ projectRoot: root,
    driver: { async run() { return { version: 2, state: 'ready', summary: 'Original report retained', artifacts: [], attention: null }; } }, assessor,
  }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' }, workflowMode: 'continuous' }, { expectedRevision: 0 });
  ticket = runtime.submit({ text: 'Inspect fictional material', operatorNotifications: false }); await runtime.runNext();
  const before = runtime.getDomainTicket(ticket.id);
  runtime.coordinate(event); await runtime.runNext();
  const result = runtime.coordinationStatus().events.find(value => value.id === event.id);
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.receipts.map(receipt => receipt.kind), ['reply']);
  assert.deepEqual(runtime.getDomainTicket(ticket.id), before, 'no note, new input, report rewrite or resumed assignment is committed');
  assert.equal(runtime.list().length, 1, 'the rejected proposal never creates replacement work');
  assert.equal(runtime.notifications().find(message => message.text === reply.text)?.status, 'sent');
  assert.equal(calls.length, 2); assert.match(calls[1], /-correction-1$/);
  assert.match(prompts[1], /before any action was applied/); assert.match(prompts[1], /reply only/);
});

test('ended-ticket context rejects every mutating action but preserves active-ticket notes', () => {
  for (const card of [{ id: 'finished-ticket', ended: { by: 'human' } }, { id: 'finished-ticket', status: 'completed' }, { id: 'finished-ticket', status: 'cancelled' }]) {
    for (const kind of ['note', 'requestStatus', 'answer', 'stop']) {
      const action = { kind, ticketId: card.id, text: kind === 'requestStatus' ? null : kind === 'answer' ? event.text : 'Authorized factual context' };
      assert.throws(() => validateWorkEventResult({ summary: 'Check contract', actions: [action] }, { event, context: { tickets: [card] } }), WorkEventOutputError);
    }
  }
  const note = { kind: 'note', ticketId: 'active-ticket', text: 'Additional factual context' };
  assert.deepEqual(validateWorkEventResult({ summary: 'Preserve active note behavior', actions: [note] }, { event, context: { tickets: [{ id: note.ticketId, status: 'waiting', ended: null }] } }).actions, [note]);
});

test('persistent model contract errors stop after two corrections without returning a partial reply', async () => {
  const calls = [];
  await assert.rejects(runBoundedWorkEvent({ event, context }, { call: async input => { calls.push(input); return invalid; } }), error => error instanceof WorkEventOutputError && error.exhausted === true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.corrections), [0, 1, 2]);
});

test('corrections share the original deadline and stop on cancellation', async () => {
  let time = 0;
  const budgets = [];
  await assert.rejects(runBoundedWorkEvent({ event, context }, { timeoutMs: 100, now: () => time, call: async input => {
    budgets.push(input.remainingMs); time += 60; return invalid;
  } }), /time budget exhausted/);
  assert.deepEqual(budgets, [100, 40]);
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runBoundedWorkEvent({ event, context, signal: controller.signal }, { call: async () => { calls++; controller.abort(); return invalid; } }), /cancelled/);
  assert.equal(calls, 1);
});

test('authority, version and host context failures do not enter model-output correction', async () => {
  const cases = [
    async () => { throw new Error('Coordination context or policy changed; reassessment required'); },
    async () => ({ ...corrected, actions: [{ kind: 'note', ticketId: 'outside-context', text: 'Unowned content' }] }),
    async () => ({ ...corrected, actions: [{ kind: 'retryTicket', ticketId: 'finished-ticket', expectedVersion: 'invented-version' }] }),
    async () => ({ ...corrected, actions: [{ kind: 'request', ticketId: null, text: 'New unauthorized work' }] }),
  ];
  for (const proposal of cases) {
    let calls = 0;
    await assert.rejects(runBoundedWorkEvent({ event, context }, { call: async () => { calls++; return proposal(); } }), error => !(error instanceof WorkEventOutputError));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(runBoundedWorkEvent({ event, context, readContext() { throw new Error('Context record changed'); } }, { call: async () => {
    calls++; return { kind: 'read', summary: 'Inspect record', actions: [], read: { resource: 'tickets', recordId: 'finished-ticket' } };
  } }), /Context record changed/);
  assert.equal(calls, 1);
});

test('correction does not reset the read budget or its count across read turns', async () => {
  let calls = 0, reads = 0;
  await assert.rejects(runBoundedWorkEvent({ event, context, readContext() { reads++; return { tickets: context.tickets }; } }, { maxReads: 1, call: async () => {
    calls++;
    if ([1, 3, 4].includes(calls)) return invalid;
    return { kind: 'read', summary: 'Read one record', actions: [], read: { resource: 'tickets', recordId: 'finished-ticket' } };
  } }), error => error instanceof WorkEventOutputError && error.exhausted === true);
  assert.equal(calls, 4); assert.equal(reads, 1);
});

test('adapter JSON format correction is bounded while checkpoint revocation remains terminal', async () => {
  const calls = [];
  const assessor = createTurnAssessor({ config: { timeoutMs: 5000 }, runTurn: async input => {
    calls.push(input); if (calls.length === 1) throw new AssessmentFormatError('Model JSON is malformed'); return corrected;
  } });
  assert.deepEqual((await assessor.handleEvent({ event, context, runId: 'json-correction' })).actions, [reply]);
  assert.equal(calls.length, 2); assert.match(calls[1].prompt, /Model JSON is malformed/);
  let revokedCalls = 0;
  const revoked = createTurnAssessor({ config: { timeoutMs: 5000 }, runTurn: async input => { revokedCalls++; input.checkpoint({ driver: 'fixture', id: 'native' }); return corrected; } });
  await assert.rejects(revoked.handleEvent({ event, context, runId: 'revoked-checkpoint', checkpoint() { throw new Error('Stale coordinator callback'); } }), /Stale coordinator/);
  assert.equal(revokedCalls, 1);
});

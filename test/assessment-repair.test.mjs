import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTurnAssessor } from '../src/runtime/turn-assessor.mjs';
import { jsonAssessmentPrompt, candidateAssessmentSchema, validateAssessment, parseAssessmentReport, AssessmentFormatError, assessmentFailure } from '../src/runtime/assessment.mjs';

const trigger = { id: 'request-1', source: 'local', human: true, actor: { source: 'local', id: 'operator' },
  text: 'Read the project index and report its current status without changing files.', threads: [{ source: 'local', id: 'request-thread' }] };
const candidate = { evalId: 'eval-1', policyVersion: 'policy-1', strength: 'explicit',
  thread: { key: 'local:request-thread' }, triggers: [trigger], tickets: [] };
const accepted = { kind: 'accept', reason: 'Explicit read-only investigation.', title: 'Inspect project status', scope: trigger.text, rules: [] };
function assessor(runTurn, config = {}) { return createTurnAssessor({ config: { timeoutMs: 5000, ...config }, assessmentPrompt: jsonAssessmentPrompt, runTurn }); }
const input = { candidate, runId: 'repair' };

test('accept field contract explains and rejects trigger selection without changing the original output', () => {
  const proposal = { ...accepted, triggerId: trigger.id };
  assert.match(candidateAssessmentSchema.properties.triggerId.description, /MUST be null for every other kind/);
  assert.match(candidateAssessmentSchema.properties.kind.description, /accept:.*MUST be null:.*triggerId/);
  assert.throws(() => validateAssessment(proposal, candidate), error => error instanceof AssessmentFormatError && error.field === 'triggerId');
  assert.equal(proposal.triggerId, trigger.id);
  assert.deepEqual(validateAssessment({ ...proposal, triggerId: null }, candidate), accepted);
});

test('one correction retains original candidate and session, consumes the deadline, and returns exactly one accepted proposal', async () => {
  const turns = [], progress = [], original = structuredClone(candidate);
  const runner = assessor(async turn => {
    turns.push(turn);
    if (turns.length === 1) { turn.checkpoint({ driver: 'fixture', id: 'session-1' }); await delay(5); return { ...accepted, triggerId: trigger.id }; }
    assert.match(turn.prompt, /triggerId MUST be null for accept/);
    assert.deepEqual(turn.session, { driver: 'fixture', id: 'session-1' });
    assert.equal(turn.input.candidate, candidate);
    assert.ok(turn.timeoutMs < turns[0].timeoutMs);
    return { ...accepted, triggerId: null };
  });
  assert.deepEqual(await runner.assess({ ...input, onAssessmentAttempt: row => progress.push(row) }), accepted);
  assert.deepEqual(candidate, original);
  assert.equal(turns.length, 2); assert.equal(new Set(turns.map(turn => turn.runId)).size, 2);
  assert.deepEqual(progress.at(-1), { attempts: 2, corrections: 1, retries: 0, phase: 'completed' });
});

test('malformed JSON is repairable while arbitrary transport and authority errors never trigger output correction', async () => {
  let count = 0;
  const runner = assessor(async () => parseAssessmentReport(++count === 1 ? '{broken' : JSON.stringify(accepted), 'fixture'));
  assert.deepEqual(await runner.assess(input), accepted); assert.equal(count, 2);
  for (const value of [
    { kind: 'attach', ticketId: 'outside', title: 'extraneous', reason: 'x', rules: [] },
    { kind: 'ignore', triggerId: 'outside', answer: 'extraneous', reason: 'x', rules: [] },
    { kind: 'answer', triggerId: null, answer: 'No eligible source', reason: 'x', rules: [] },
  ]) {
    count = 0;
    await assert.rejects(assessor(async () => { count++; return value; }).assess(input), error => ['authority', 'context'].includes(error.failureKind));
    assert.equal(count, 1);
  }
  count = 0;
  await assert.rejects(assessor(async () => { count++; throw new Error('context changed or arbitrary error'); }).assess(input), /context changed/);
  assert.equal(count, 1);
});

test('format correction limit is shared across read turns and exhaustion preserves typed failure metadata', async () => {
  let calls = 0, reads = 0;
  const runner = assessor(async () => {
    calls++;
    if (calls === 1 || calls >= 3) return { ...accepted, triggerId: trigger.id };
    return { kind: 'read', reason: 'Need current record', rules: [], resource: 'threads', recordId: candidate.thread.key, offset: 0 };
  });
  await assert.rejects(runner.assess({ ...input, readContextRecord(resource, id) { reads++; return { resource, id, version: 'v1', offset: 0, text: 'Existing authorized context.' }; } }), error => {
    assert.deepEqual(assessmentFailure(error), { code: 'assessment_format', failureKind: 'format', retryable: true,
      error: 'triggerId MUST be null for accept', attempts: 4, corrections: 2, retries: 0, exhausted: true });
    return true;
  });
  assert.equal(calls, 4); assert.equal(reads, 1);
});

test('format corrections do not replenish the context-read budget', async () => {
  let calls = 0, reads = 0;
  const runner = assessor(async () => ++calls === 1 ? { ...accepted, triggerId: trigger.id }
    : { kind: 'read', reason: 'Need context', rules: [], resource: 'threads', recordId: candidate.thread.key, offset: 0 }, { contextLimits: { maxReads: 1 } });
  const result = await runner.assess({ ...input, readContextRecord(resource, id) { reads++; return { resource, id, version: 'v1', offset: 0, text: 'Context' }; } });
  assert.equal(result.kind, 'unavailable'); assert.match(result.reason, /read budget exhausted/);
  assert.equal(reads, 1); assert.equal(calls, 3);
});

test('host deadline and cancellation stop corrections before another model call', async () => {
  let calls = 0;
  const runner = assessor(async () => { calls++; await delay(20); return { ...accepted, triggerId: trigger.id }; });
  await assert.rejects(runner.assess({ ...input, timeoutMs: 10 }), error => error.failureKind === 'timeout');
  assert.equal(calls, 1);
  calls = 0; const controller = new AbortController();
  await assert.rejects(assessor(async () => { calls++; return { ...accepted, triggerId: trigger.id }; }).assess({ ...input, signal: controller.signal,
    onAssessmentAttempt(row) { if (row.phase === 'correcting') controller.abort(new Error('policy changed')); } }), /policy changed/);
  assert.equal(calls, 1);
});

test('only typed transient failures receive bounded delayed retries; auth never retries', async () => {
  let calls = 0; const seen = [];
  const runner = assessor(async turn => { seen.push(turn.timeoutMs); if (++calls < 3) throw Object.assign(new Error('service temporarily unavailable'), { code: 'SERVER', statusCode: 503 }); return accepted; });
  assert.deepEqual(await runner.assess(input), accepted);
  assert.equal(calls, 3); assert.ok(seen[1] < seen[0]); assert.ok(seen[2] < seen[1]);
  calls = 0;
  await assert.rejects(assessor(async () => { calls++; throw Object.assign(new Error('rate limit'), { code: 'RATE_LIMIT', statusCode: 429 }); }).assess(input), error => {
    assert.equal(error.exhausted, true); assert.equal(error.retries, 2); assert.equal(assessmentFailure(error).failureKind, 'transient'); return true;
  });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(assessor(async () => { calls++; throw Object.assign(new Error('sign in required'), { code: 'AUTH', statusCode: 401 }); }).assess(input), error => {
    assert.equal(assessmentFailure(error).failureKind, 'authority'); assert.equal(assessmentFailure(error).retryable, false); return true;
  });
  assert.equal(calls, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/core/index.js';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';
import { applyAssessment, createRuntimePolicy, validateAssessment } from '../src/coordinator.mjs';

const repository = 'owner/repo';
const trigger = (id = 'question-1') => ({ id, source: 'github', human: true, addressed: 'direct',
  actor: { source: 'github', id: 'alice' }, threads: [{ source: 'github', id: `${repository}#1` }],
  channel: { source: 'github', thread: `${repository}#1`, address: { repository, issueNumber: '1' } },
  at: '2026-11-03T00:00:00.000Z', text: '/js-superagent What does this check verify?', meta: { repository } });
const outcome = (id = 'question-1') => ({ kind: 'answer', triggerId: id, answer: 'It verifies the parser contract.', reason: 'The supplied evidence answers the question.', rules: [] });
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const policy = createRuntimePolicy({ config: { mode: 'off', sourceRows: [
    { id: 'github', source: 'github', scope: { repository }, actors: ['alice'], bots: [] },
  ] } });
  const candidates = [], effects = new Effects(store), outbox = new Outbox(store, effects);
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: input => policy.scope(input) },
    now: () => '2026-11-03T00:00:01.000Z', assessor: { request: value => candidates.push(value) },
    executor: { start() {}, deliver() {}, stop() {} }, outbox });
  engine.receive(trigger()); engine.evaluateDue();
  return { store, policy, engine, outbox, candidate: candidates.at(-1), outcome: outcome(),
    onAnswer: answer => engine.reply({ purpose: 'answer', triggerId: answer.triggerId, text: answer.answer }) };
}

test('answer contract selects one original human GitHub question, including from a batch, without work-routing fields', () => {
  const candidate = { strength: 'explicit', triggers: [trigger()], tickets: [] }, value = outcome();
  assert.deepEqual(validateAssessment(value, candidate), value);
  for (const changed of [
    { ...candidate, triggers: [] },
    { ...candidate, strength: 'inferred' },
    { ...candidate, triggers: [{ ...trigger(), human: false }] },
    { ...candidate, triggers: [{ ...trigger(), source: 'local' }] },
  ]) assert.throws(() => validateAssessment(value, changed), /one explicit GitHub human/);
  assert.deepEqual(validateAssessment(outcome('question-2'), { ...candidate, triggers: [trigger(), trigger('question-2')] }), outcome('question-2'));
  for (const patch of [{ triggerId: 'different-question' }, { ticketId: 'ticket' }, { title: 'Implement it' },
    { scope: 'Modify parser' }, { note: 'Attach this task' }, { rules: ['new-work'] }]) {
    assert.throws(() => validateAssessment({ ...value, ...patch }, candidate), /cannot route work/);
  }
  for (const answer of ['', 'x'.repeat(8001), 'answer\0payload']) assert.throws(() => validateAssessment({ ...value, answer }, candidate), /assessment answer/);
  assert.throws(() => validateAssessment({ kind: 'ignore', reason: 'No task', rules: [], answer: 'Still send it' }, candidate), /only valid/);
});

test('unsupported answer host leaves the candidate and outbox unchanged', t => {
  const f = fixture(t);
  assert.throws(() => applyAssessment({ ...f, onAnswer: undefined }), /does not support coordinator answers/);
  assert.equal(f.engine.candidate(f.candidate.triggers[0].id).evalId, f.candidate.evalId);
  assert.deepEqual(f.outbox.list(), []); assert.equal(f.store.tickets.list().length, 0);
});

test('answer callback failure rolls back its queued reply and preserves assessment', t => {
  const f = fixture(t);
  assert.throws(() => applyAssessment({ ...f, onAnswer: answer => { f.onAnswer(answer); throw new Error('proof refused'); } }), /proof refused/);
  assert.deepEqual(f.outbox.list(), []);
  assert.equal(f.engine.candidate(f.candidate.triggers[0].id).evalId, f.candidate.evalId);
});

test('stale evaluation, changed policy and pause never invoke the answer host', t => {
  const f = fixture(t); let invoked = 0;
  for (const patch of [
    { candidate: { ...f.candidate, evalId: 'previous-evaluation' } },
    { policy: { ...f.policy, version: 'changed-policy' } },
    { policy: { ...f.policy, paused: true } },
  ]) {
    const result = applyAssessment({ ...f, ...patch, onAnswer() { invoked++; throw new Error('must not run'); } });
    assert.deepEqual(result, { applied: false, reason: 'stale-or-paused-assessment' });
  }
  assert.equal(invoked, 0); assert.deepEqual(f.outbox.list(), []);
});

test('answer ends assessment as an audited ignore and duplicate completion cannot queue another reply', t => {
  const f = fixture(t); let invoked = 0;
  const args = { ...f, onAnswer: (...values) => { invoked++; return f.onAnswer(...values); } };
  const first = applyAssessment(args);
  assert.equal(first.applied, true); assert.equal(first.kind, 'answer');
  assert.equal(first.decision.kind, 'ignore');
  assert.deepEqual(first.decision.audit.coordinatorAnswer, { triggerId: f.outcome.triggerId, replyId: first.reply.id });
  assert.equal(f.store.tickets.list().length, 0); assert.equal(f.outbox.list().length, 1);
  assert.equal(f.outbox.list()[0].ticketId, undefined); assert.equal(f.outbox.list()[0].kind, 'reply');
  assert.equal(f.engine.candidate(f.outcome.triggerId), undefined);
  assert.equal(applyAssessment(args).applied, false);
  assert.equal(invoked, 1); assert.equal(f.outbox.list().length, 1);
});

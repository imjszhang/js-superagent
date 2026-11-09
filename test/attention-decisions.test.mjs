import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { normalizeAnswers, normalizeDecision, renderAnswerText, renderDecisionText } from '../src/runtime/decisions.mjs';
import { normalizeDriverReport } from '../src/runtime/reports.mjs';
import { parseDshReport } from '../src/drivers/dsh.mjs';
import { parseCursorReport } from '../src/drivers/cursor-agent.mjs';

export const decision = {
  items: [{ id: 'C0001', title: 'First source', summary: 'Author, 2026-09-04', url: 'https://example.com/a' }, { id: 'C0002', title: 'Second source' }],
  options: [{ id: 'adopted', label: '采纳' }, { id: 'rejected', label: '拒绝' }, { id: 'later', label: '稍后' }],
  reason: 'required',
};
const answers = { C0001: { option: 'adopted', reason: 'fits the series' }, C0002: { option: 'rejected', reason: 'duplicate' } };

test('decision shape is bounded and answers must cover every item with an allowed option', () => {
  assert.deepEqual(normalizeDecision(decision).items[1], { id: 'C0002', title: 'Second source' });
  assert.throws(() => normalizeDecision({ ...decision, options: decision.options.slice(0, 1) }), /2 to 4/);
  assert.throws(() => normalizeDecision({ ...decision, items: [{ id: 'x', title: 't', url: 'http://example.com' }] }), /https/);
  assert.throws(() => normalizeDecision({ ...decision, items: [decision.items[0], decision.items[0]] }), /Duplicate/);
  assert.throws(() => normalizeDecision({ ...decision, extra: true }), /Unknown decision field/);
  const normalized = normalizeDecision(decision);
  assert.deepEqual(normalizeAnswers(normalized, answers), answers);
  assert.throws(() => normalizeAnswers(normalized, { C0001: answers.C0001 }), /missing items: C0002/);
  assert.throws(() => normalizeAnswers(normalized, { ...answers, C0003: answers.C0001 }), /unknown items/);
  assert.throws(() => normalizeAnswers(normalized, { ...answers, C0002: { option: 'maybe', reason: 'x' } }), /must choose/);
  assert.throws(() => normalizeAnswers(normalized, { ...answers, C0002: { option: 'later' } }), /needs a reason/);
  assert.throws(() => normalizeAnswers({ ...normalized, reason: 'none' }, answers), /must not carry a reason/);
  assert.match(renderDecisionText('Pick each.', normalized), /1\. C0001：First source https:\/\/example\.com\/a/);
  const text = renderAnswerText('attention-1', normalized, answers);
  assert.match(text, /C0001 First source：采纳。理由：fits the series/);
  assert.deepEqual(JSON.parse(text.match(/```json\n(.+)\n```/)[1]), { attentionId: 'attention-1', answers });
});

test('all Worker report parsers keep the decision, and a terminal report cannot carry one', () => {
  const report = { version: 2, state: 'waiting', summary: 'Five candidates', artifacts: [], attention: { question: 'Pick each.', decision }, answers: null };
  assert.deepEqual(normalizeDriverReport(parseDshReport(JSON.stringify(report))).attention.decision, normalizeDecision(decision));
  assert.deepEqual(normalizeDriverReport(parseCursorReport(JSON.stringify(report))).attention.decision, normalizeDecision(decision));
  assert.throws(() => normalizeDriverReport({ ...report, state: 'ready' }), /terminal result/);
  assert.throws(() => normalizeDriverReport({ ...report, attention: { question: 'q', decision: { ...decision, reason: 'maybe' } } }), /decision.reason/);
});

function fixture(t, driver) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-decision-')));
  const runtime = createProjectAgent({ projectRoot: root, driver }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return runtime;
}

test('a structured question is answered once, reaches the Worker as text and JSON, and stays readable', async t => {
  const seen = [];
  const runtime = fixture(t, { async run(input) {
    seen.push(input.ticket.messages.at(-1).text);
    input.checkpoint({ driver: 'fixture', id: 'decision-session' });
    return seen.length === 1
      ? { version: 2, state: 'waiting', summary: 'Two candidates found', artifacts: [], attention: { question: 'Decide each candidate.', decision } }
      : { version: 2, state: 'ready', summary: 'Decisions recorded', artifacts: [], attention: null };
  } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Find candidates' });
  assert.equal((await runtime.runNext()).status, 'waiting');
  const asked = runtime.getDetailed(ticket.id).attention;
  assert.equal(asked.question, 'Decide each candidate.');
  assert.deepEqual(asked.decision, normalizeDecision(decision));
  assert.equal(asked.answered, false);
  assert.match(runtime.notifications().find(message => message.ticketId && /Two candidates found/.test(message.text)).text, /1\. C0001：First source/);

  assert.throws(() => runtime.answer(ticket.id, { answers: { C0001: answers.C0001 } }), /missing items/);
  assert.throws(() => runtime.answer(ticket.id, { answers, attentionId: 'stale' }), /no longer open/);
  const record = runtime.answer(ticket.id, { answers, attentionId: asked.id });
  assert.equal(record.kind, 'structured');
  assert.deepEqual(record.answers, answers);
  assert.throws(() => runtime.answer(ticket.id, { answers }), /already answered/);
  assert.equal(runtime.getDetailed(ticket.id).attention.answered, true);

  assert.equal((await runtime.runNext()).status, 'completed');
  assert.match(seen[1], /C0002 Second source：拒绝。理由：duplicate/);
  assert.deepEqual(JSON.parse(seen[1].match(/```json\n(.+)\n```/)[1]).answers, answers);
  assert.deepEqual(runtime.listAnswers(ticket.id).map(item => item.attentionId), [asked.id]);
  assert.deepEqual(runtime.getDetailed(ticket.id).answers[0].answers, answers);
});

test('a plain reply is the first answer of an open question and closes it for structured answers', async t => {
  let calls = 0;
  const runtime = fixture(t, { async run(input) {
    calls++; input.checkpoint({ driver: 'fixture', id: 'decision-text-session' });
    return { version: 2, state: 'waiting', summary: 'Need a choice', artifacts: [], attention: { question: 'Pick one.', decision } };
  } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Ask me' });
  await runtime.runNext();
  runtime.reply(ticket.id, 'Adopt C0001 and reject C0002');
  const [record] = runtime.listAnswers(ticket.id);
  assert.equal(record.kind, 'text');
  assert.equal(record.text, 'Adopt C0001 and reject C0002');
  assert.throws(() => runtime.answer(ticket.id, { answers }), /already answered/);
  assert.equal(calls, 1);
});

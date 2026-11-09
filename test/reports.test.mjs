import test from 'node:test';
import assert from 'node:assert/strict';
import { driverCapabilities, normalizeDriverReport, publicTicketReport, domainReport, detailedTicketView, sameBusinessReport } from '../src/runtime/reports.mjs';

test('retired v1 reports are rejected while ticket status projection stays readable', () => {
  const capabilities = driverCapabilities({ reportVersion: 2, run() {} });
  assert.equal(capabilities.reportVersion, 2);
  assert.equal(capabilities.realtimeInput, false);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.throws(() => normalizeDriverReport({ status: 'waiting', summary: 'Which branch?' }), /version: 2/);
  assert.throws(() => driverCapabilities({ reportVersion: 1 }), /reportVersion/);
  const normalized = normalizeDriverReport({ version: 2, state: 'waiting', summary: 'Which branch?', artifacts: ['note.md'], attention: { question: 'Which branch?' } });
  assert.deepEqual(domainReport(normalized), { state: 'waiting', summary: 'Which branch?', question: 'Which branch?' });
  assert.deepEqual(publicTicketReport(normalized), { status: 'waiting', summary: 'Which branch?', artifacts: ['note.md'] });
});

test('a directed question matches only when the tool and final report name the same original message', () => {
  const staged = { state: 'waiting', question: 'Which file?', questionForTriggerId: 'github:fixture/repo:comment:2', artifacts: [], answers: null };
  const parsed = { state: 'waiting', attention: { question: 'Which file?', triggerId: 'github:fixture/repo:comment:2' }, artifacts: [], answers: null };
  assert.equal(sameBusinessReport(staged, parsed), true);
  assert.equal(sameBusinessReport(staged, { ...parsed, attention: { question: 'Which file?' } }), false);
});

test('v2 idle waiting, independent attention, and explicit clearing are different facts', () => {
  const waiting = normalizeDriverReport({ version: 2, state: 'waiting', summary: 'Waiting on CI' }, { version: 2 });
  assert.deepEqual(domainReport(waiting), { state: 'waiting', summary: 'Waiting on CI' });
  const blocked = normalizeDriverReport({ version: 2, state: 'blocked', summary: 'Need access', attention: { question: 'Can you grant access?', triggerId: 'human-1' } }, { version: 2 });
  assert.deepEqual(domainReport(blocked), { state: 'blocked', summary: 'Need access', question: 'Can you grant access?', askedBy: 'human-1' });
  const progress = normalizeDriverReport({ version: 2, state: 'progress', summary: 'Access received', attention: null }, { version: 2 });
  assert.equal(domainReport(progress).question, null);
  assert.equal(domainReport(blocked, { hasPendingInput: true }).question, 'Can you grant access?');
});

test('all v2 states project into the existing report union without hiding the detailed state', () => {
  const expected = { progress: 'waiting', waiting: 'waiting', ready: 'completed', blocked: 'failed', failed: 'failed', dropped: 'completed' };
  for (const [state, status] of Object.entries(expected)) {
    const report = normalizeDriverReport({ version: 2, state, summary: state }, { version: 2 });
    assert.equal(publicTicketReport(report).status, status);
    assert.equal(domainReport(report).state, state);
  }
  const ready = normalizeDriverReport({ version: 2, state: 'ready', summary: 'Patch ready' }, { version: 2 });
  assert.equal(domainReport(ready, { hasPendingInput: true }).state, 'waiting');
});

test('invalid capability and report contracts fail before reaching the domain', () => {
  for (const driver of [
    { reportVersion: 9 },
    { reportVersion: 1, capabilities: { reportVersion: 2 } },
    { capabilities: { inputAcknowledgements: true } },
    { capabilities: { realtimeInput: 'yes' } },
  ]) assert.throws(() => driverCapabilities(driver));
  for (const report of [
    { state: 'ready', summary: 'missing version' },
    { version: 2, state: 'unknown', summary: 'bad state' },
    { version: 2, state: 'ready', summary: 'Done', attention: { question: 'Also a question?' } },
    { version: 2, state: 'waiting', summary: 'Question', attention: { question: 'Who?', arbitraryCommand: 'execute' } },
    { version: 2, state: 'progress', summary: '   ' },
    { version: 2, state: 'ready', summary: 'Done', artifacts: [3] },
    { version: 2, state: 'ready', summary: 'Done', status: 'completed' },
  ]) assert.throws(() => normalizeDriverReport(report, { version: 2 }));
});

test('detailed view reports ready as review while the PR remains open', () => {
  const legacy = { id: 'ticket-1', status: 'queued', reports: [] };
  const domain = { id: 'ticket-1', assignments: [{ id: 'assignment-1', state: 'running', report: { state: 'ready', summary: 'Review PR', at: '2026-11-01' } }], follows: [{ thread: 'github:repo#1', own: true }] };
  const detail = detailedTicketView({ domain, legacy, meta: { verification: { status: 'passed' }, reportsV2: [{ state: 'ready' }] } });
  assert.equal(detail.stage, 'person');
  assert.equal(detail.action, 'review');
  assert.equal(detail.outcome, null);
  assert.equal(detail.reportState, 'ready');
  assert.equal(detail.ticket.status, 'queued');
  detail.ticket.status = 'changed';
  assert.equal(legacy.status, 'queued');
  assert.equal(detailedTicketView({ domain: { ...domain, ended: { outcome: 'merged' } }, legacy }).stage, 'ended');
});

test('an original-question answer preserves waiting/progress and remains exclusive with a new question', () => {
  for (const state of ['progress', 'waiting', 'ready']) {
    const report = normalizeDriverReport({ version: 2, state, summary: 'The original answer.', answers: 'source-question' });
    assert.deepEqual(domainReport(report), { state, summary: 'The original answer.', answers: 'source-question' });
  }
  for (const answers of [null, '', ' ', 'bad\nidentity', 'x'.repeat(2001)]) {
    assert.throws(() => normalizeDriverReport({ version: 2, state: 'waiting', summary: 'Answer', answers }));
  }
  assert.throws(() => normalizeDriverReport({ version: 2, state: 'progress', summary: 'Answer', answers: 'question', attention: { question: 'Which?' } }), /cannot also ask/);
  assert.throws(() => normalizeDriverReport({ version: 2, state: 'waiting', summary: '答'.repeat(11000), answers: 'question' }), /32000/);
});

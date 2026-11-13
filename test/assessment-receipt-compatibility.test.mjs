import test from 'node:test';
import assert from 'node:assert/strict';
import { assessmentFailureMessage, assessmentTicketReceiptProof, verifyAssessmentTicketReceipt } from '../src/runtime/assessment-status.mjs';
import { CONTEXT_REFRESH_EXHAUSTED } from '../src/runtime/assessment-refresh.mjs';

test('queued exhausted v1 receipts survive wording changes without admitting arbitrary text or sibling inputs', () => {
  const record = { evalId: 'eval', triggerIds: ['original', 'sibling'], failedTriggerIds: ['original'], status: 'failed', code: CONTEXT_REFRESH_EXHAUSTED };
  for (const text of [
    '建单评估的上下文持续变化，已用尽两次自动刷新。请求已保留，尚未开始执行；可重新评估原请求。',
    assessmentFailureMessage(record),
  ]) {
    const message = { id: 'assessment-result:eval:original', kind: 'reply', channel: { source: 'feishu', thread: 'fixture' }, text };
    const proof = assessmentTicketReceiptProof(message, { evalId: 'eval', triggerId: 'original', status: 'failed' });
    assert.equal(verifyAssessmentTicketReceipt(message, proof, record), true);
    assert.equal(verifyAssessmentTicketReceipt(message, proof, { ...record, code: 'assessment_internal' }), false);
    const arbitrary = { ...message, text: text + ' Other ticket text' };
    assert.equal(verifyAssessmentTicketReceipt(arbitrary, assessmentTicketReceiptProof(arbitrary, proof), record), false);
    const sibling = { ...message, id: 'assessment-result:eval:sibling' };
    assert.equal(verifyAssessmentTicketReceipt(sibling, assessmentTicketReceiptProof(sibling, { ...proof, triggerId: 'sibling' }), record), false);
    assert.equal(verifyAssessmentTicketReceipt(message, proof, { ...record, status: 'finished' }), false);
  }
});

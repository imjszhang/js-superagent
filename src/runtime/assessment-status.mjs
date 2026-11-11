import { followupOwners } from '../../dist/core/index.js';
import { createHash } from 'node:crypto';

const receiptDigest = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');
const RECEIPT_TEMPLATE = 'assessment-ticket-status-v1';

/** Only these fixed host facts can be disclosed without a material body. */
export function assessmentTicketReceiptProof(message, { evalId, triggerId, status }) {
  return { version: 1, template: RECEIPT_TEMPLATE, evalId, triggerId, status, ticketId: message.ticketId, messageDigest: receiptDigest(message) };
}

export function verifyAssessmentTicketReceipt(message, proof, record, publicId = id => id) {
  if (proof?.version !== 1 || proof.template !== RECEIPT_TEMPLATE || !['accepted', 'attached'].includes(proof.status) ||
      !record || typeof proof.evalId !== 'string' || typeof proof.triggerId !== 'string' ||
      record.evalId !== proof.evalId || record.status !== 'finished' || !record.triggerIds?.includes(proof.triggerId) ||
      !record.result?.applied || !proof.ticketId || message.ticketId !== proof.ticketId || message.kind !== 'reply' ||
      Object.keys(message).some(key => !['id', 'kind', 'ticketId', 'channel', 'text'].includes(key)) ||
      message.id !== `assessment-result:${proof.evalId}:${proof.triggerId}` || proof.messageDigest !== receiptDigest(message)) return false;
  const result = record.result;
  if (proof.status === 'accepted' && (result.kind !== 'accept' || publicId(result.decision?.ticketId) !== proof.ticketId || !result.decision.triggerIds?.includes(proof.triggerId))) return false;
  if (proof.status === 'attached' && (result.kind !== 'attach' || publicId(result.ticket?.id) !== proof.ticketId || result.triggerId !== proof.triggerId)) return false;
  return message.text === (proof.status === 'accepted' ? `已建立工单 ${proof.ticketId}，将按授权范围执行。` : `请求已关联到现有工单 ${proof.ticketId}。`);
}

/** Read-only projection of one original request; old databases resolve through decision eval IDs. */
export function assessmentStatus(store, triggerId, { includeOwners = true } = {}) {
  const trigger = store.triggers.get(triggerId);
  if (!trigger) return { triggerId, status: 'missing', ticketId: null };
  const thread = store.threads.get(`${trigger.threads[0].source}:${trigger.threads[0].id}`);
  const disposition = store.triggers.disposition(triggerId);
  const pointer = store.getMeta(`assessment-trigger:${triggerId}`);
  const evaluation = thread?.evaluating?.triggerIds.includes(triggerId) ? thread.evaluating : null;
  const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : null;
  // decideTrigger creates a per-input decision/eval; the assessor run belongs to its source eval.
  const evalId = evaluation?.id ?? pointer?.evalId ?? decision?.audit?.triggerDecision?.sourceEvalId ?? disposition?.evalId ?? decision?.evalId;
  const record = evalId ? store.getMeta(`assessment:${evalId}`) : null;
  const accepted = store.decisions.byThread(thread?.key ?? `${trigger.threads[0].source}:${trigger.threads[0].id}`)
    .find(item => item.kind === 'accept' && item.triggerIds.includes(triggerId));
  const owners = includeOwners ? followupOwners(trigger, store) : [];
  const ticketId = accepted?.ticketId ?? owners[0] ?? (record?.result?.applied ? record.result.ticket?.id ?? record.result.decision?.ticketId : null);
  const status = accepted ? 'accepted' : owners.length || record?.result?.applied && record.result.kind === 'attach' ? 'attached' : evaluation ? (record?.phase === 'correcting' ? 'correcting' : 'evaluating')
    : thread?.pending.includes(triggerId) ? 'pending' : record?.status === 'failed' ? 'failed' : decision?.kind ?? record?.status ?? 'pending';
  return { triggerId, evalId: evalId ?? null, status, ...(owners.length > 1 ? { ownerTicketIds: owners.map(id => store.getMeta(`public:${id}`) ?? id) } : {}), ticketId: ticketId ? store.getMeta(`public:${ticketId}`) ?? ticketId : null,
    ...(status === 'failed' ? publicAssessmentFailure(record) : {}),
    ...(record?.attempts != null ? { attempts: record.attempts, corrections: record.corrections ?? 0, retries: record.retries ?? 0 } : {}),
    ...(status === 'failed' ? { message: assessmentFailureMessage(record) } : {}),
    ...(record?.status === 'finished' && typeof record.outcome?.reason === 'string' ? { reason: record.outcome.reason.slice(0, 600) } : {}) };
}

export function assessmentFailureMessage(record) {
  const kind = publicAssessmentFailure(record).failureKind;
  if (kind === 'format') return `建单评估返回格式不符合要求${record.corrections ? `，已尝试纠正 ${record.corrections} 次` : ''}。请求已保留，尚未开始执行。`;
  if (kind === 'transient' || kind === 'timeout') return '建单评估暂时无法完成。请求已保留，尚未开始执行，可在服务恢复后重试。';
  if (kind === 'authority') return '建单评估未通过授权检查。请求已保留，尚未开始执行，需要核对权限或授权。';
  if (kind === 'context') return '建单评估所需上下文不可用或已经变化。请求已保留，尚未开始执行，需要重新核对。';
  return '建单评估发生内部错误。请求已保留，尚未开始执行，需要检查诊断记录。';
}

export function publicAssessmentFailure(record) {
  // Exact historical validator message only; this is display compatibility, not automatic retry authorization.
  const legacyFormat = record.error === 'Answer fields are only valid for an answer outcome; triggerId may also select attach, ignore or unavailable input';
  return { failureKind: record.failureKind ?? (legacyFormat ? 'format' : 'internal'),
    code: record.code ?? (legacyFormat ? 'assessment_format' : 'assessment_internal'), retryable: record.retryable === true || legacyFormat };
}

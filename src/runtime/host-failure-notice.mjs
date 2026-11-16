import { createHash } from 'node:crypto';

export const WORKER_INPUT_UNREAD_CODE = 'WORKER_INPUT_UNREAD';
export const HOST_FAILURE_NOTICE_TEXT = '本轮执行未完成：必读输入尚未完整读取，原输入已保留。请由项目维护者检查后显式重试原工单。';
const SUMMARY = 'Required inputs remain unread: complete consumption was not verified. The original inputs are retained; inspect before explicitly retrying the original ticket.';
const TEMPLATE = 'worker-input-unread-v1';
const MAX_IDS = 32;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/u.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Call only after the host's final consumption check; model fields are not authority. */
export function createWorkerInputUnreadFailure(inputIds) {
  if (!Array.isArray(inputIds) || !inputIds.length || !inputIds.every(identifier)) throw new TypeError('Unread failure requires original input IDs');
  const ids = [...new Set(inputIds)].sort();
  return { code: WORKER_INPUT_UNREAD_CODE, origin: 'host-context-unread', requiresInspection: true,
    unreadInputIds: ids.slice(0, MAX_IDS), unreadInputCount: ids.length, omittedInputCount: Math.max(0, ids.length - MAX_IDS), summary: SUMMARY };
}

function validFailure(failure) {
  return failure?.code === WORKER_INPUT_UNREAD_CODE && failure.origin === 'host-context-unread' && failure.requiresInspection === true &&
    failure.summary === SUMMARY && Array.isArray(failure.unreadInputIds) && failure.unreadInputIds.length > 0 &&
    failure.unreadInputIds.length <= MAX_IDS && failure.unreadInputIds.every(identifier) &&
    new Set(failure.unreadInputIds).size === failure.unreadInputIds.length &&
    Number.isSafeInteger(failure.unreadInputCount) && failure.unreadInputCount >= failure.unreadInputIds.length &&
    failure.omittedInputCount === failure.unreadInputCount - failure.unreadInputIds.length;
}

/** Proof is a host-persisted attestation, not a permission or a cryptographic signature. */
export function createHostFailureNotice({ publicId, domainId, assignmentId, runId, failure, originTriggerId, requestTriggerId = originTriggerId, channel, route }) {
  if (![publicId, domainId, assignmentId, runId, originTriggerId, requestTriggerId].every(identifier) || !validFailure(failure)) throw new TypeError('Host failure notice requires a verified unread failure and execution identity');
  if (!channel || !identifier(channel.source) || !identifier(channel.thread) || !channel.address || typeof channel.address !== 'object' || Array.isArray(channel.address) ||
      !route || typeof route !== 'object' || Array.isArray(route) || route.source !== channel.source) throw new TypeError('Host failure notice requires its original channel and route identity');
  const identity = { publicId, domainId, assignmentId, runId, originTriggerId, requestTriggerId, channel: structuredClone(channel), route: structuredClone(route) };
  const message = { id: `host-failure-notice-${digest([domainId, assignmentId, runId, channel])}`, kind: 'notice', ticketId: domainId,
    channel: structuredClone(channel), text: `${HOST_FAILURE_NOTICE_TEXT}\n\n工单 ${publicId}` };
  return { message, proof: { version: 1, template: TEMPLATE, ...identity, identityDigest: digest(identity), failureDigest: digest(failure), messageDigest: digest(message) } };
}

/** The caller must additionally check the saved run, current mandate, route and delivery state. */
export function verifyHostFailureNotice(message, proof, failure) {
  if (proof?.version !== 1 || proof.template !== TEMPLATE) return false;
  try {
    const expected = createHostFailureNotice({ ...proof, failure });
    return digest(message) === digest(expected.message) && digest(proof) === digest(expected.proof);
  } catch { return false; }
}

import { createHash } from 'node:crypto';

const prefix = 'github:pull-feedback:';
const key = (domainId, eventId) => `${prefix}${domainId}:${eventId}`;
// observedAt and the enclosing PR title are refreshed by polling. They are not
// permission to replace the original author, revision, source or pinned head.
function fingerprint(event) {
  return createHash('sha256').update(JSON.stringify([event.id, event.repository, event.pullNumber, event.kind,
    event.actor.id, event.actor.login, event.actor.type, event.text, event.createdAt, event.updatedAt ?? null,
    event.headSha, event.pullState, event.commitId ?? null, event.state ?? null,
    event.reviewId ?? null, event.reviewCommentId ?? null, event.reviewRootId ?? null, event.inReplyToId ?? null,
    event.path ?? null, event.line ?? null, event.side ?? null])).digest('hex');
}

/** Record only the owner that missed a genuine new-head human discussion input. */
export function deferPullFeedback({ store, binding, domain, event, trigger, admission, now }) {
  if (!trigger.human || event.actor.type !== 'User' || !['pr_comment', 'review', 'review_comment'].includes(event.kind) ||
      event.pullState !== 'open' || event.headSha === binding.headSha || event.commitId && event.commitId !== event.headSha ||
      !admission.admissible || admission.strength !== 'explicit' || domain.ended?.by === 'human') return false;
  const recordKey = key(domain.id, event.id);
  if (store.getMeta(recordKey)) return true;
  if (store.listMeta(prefix).filter(row => row.value.status === 'pending').length >= 1000) throw new Error('Deferred PR feedback inbox is full');
  store.setMeta(recordKey, { version: 1, status: 'pending', ticketId: binding.ticketId, domainId: domain.id,
    repository: event.repository, pullNumber: event.pullNumber, triggerId: event.id, headSha: event.headSha,
    associationId: binding.associationId ?? null, fingerprint: fingerprint(event), reason: 'pull-request-version-unavailable', at: now });
  return true;
}

/** A fresh trusted source observation can complete only this owner's prior miss. */
export function pendingPullFeedback({ store, binding, domain, meta, event, now }) {
  const record = binding && store.getMeta(key(domain.id, event.id));
  if (!record || record.status !== 'pending' || record.ticketId !== binding.ticketId || record.domainId !== domain.id ||
      !binding.associationId || binding.associationId === record.associationId || binding.headSha !== record.headSha ||
      event.headSha !== record.headSha || binding.blockedReason) return null;
  const disposition = store.triggers.disposition(event.id), revision = event.commentVersion;
  const current = store.getMeta(`github:comment-version:${revision?.baseId ?? event.id}`);
  let reason;
  if (fingerprint(event) !== record.fingerprint) reason = 'source-facts-changed';
  else if (revision && (!current || current.eventId !== event.id || current.digest !== revision.digest || current.actorId !== revision.actorId || current.location !== revision.location) ||
      !revision && current && current.eventId !== event.id) reason = 'source-revision-retired';
  else if (store.getMeta(`input:retired:${domain.id}:${event.id}`) || store.getMeta(`github:retired:${domain.id}:${event.id}`) ||
      disposition?.handbacks?.some(item => item.ticketId === domain.id)) reason = 'input-retired';
  else if (domain.ended?.by === 'human' || meta.cancelRequested) reason = 'cancelled';
  else if (domain.inputs.some(input => input.kind === 'trigger' && input.triggerId === event.id) ||
      meta.messages.some(message => message.triggerId === event.id) || disposition?.fanout?.includes(domain.id) ||
      disposition?.context?.includes(domain.id) || disposition?.acked?.includes(domain.id)) reason = 'already-delivered';
  if (reason) {
    store.setMeta(key(domain.id, event.id), { ...record, status: reason === 'already-delivered' ? 'delivered' : 'retired', reason, resolvedAt: now });
    return null;
  }
  return record;
}

export function completePullFeedback({ store, record, result, now }) {
  store.setMeta(key(record.domainId, record.triggerId), { ...record,
    status: result.status === 'received' ? 'delivered' : 'retired', reason: result.reason ?? result.feedback?.reason ?? result.status,
    result, resolvedAt: now });
}

export function unlinkPullFeedback({ store, binding, now }) {
  for (const row of store.listMeta(prefix)) if (row.value.status === 'pending' && row.value.ticketId === binding.ticketId &&
      row.value.repository === binding.repository && row.value.pullNumber === binding.number) {
    store.setMeta(row.key, { ...row.value, status: 'retired', reason: 'association-removed', resolvedAt: now });
  }
}

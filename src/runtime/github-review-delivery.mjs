import { createHash } from 'node:crypto';

const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const key = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);

/** The host records the verified source comment separately from its reply root. */
export function pullReplyChannel(pull, headSha = pull.headSha) {
  const number = pull.number ?? pull.pullNumber;
  return { source: 'github', thread: `${pull.repository}#pr:${number}`, address: {
    repository: pull.repository, pullNumber: String(number), headSha,
    ...(positive(pull.reviewRootId) ? { reviewRootId: String(pull.reviewRootId),
      ...(positive(pull.reviewCommentId) ? { reviewCommentId: String(pull.reviewCommentId) } : {}) } : {}),
  } };
}

export function pullDeliveryDestinations(triggers, originPull) {
  const destinations = new Map();
  for (const trigger of triggers) {
    const event = trigger?.meta?.pullEvent;
    if (!event) continue;
    const root = event.kind === 'review_comment' && positive(event.reviewRootId) ? event.reviewRootId : undefined;
    const pull = { repository: event.repository, number: event.pullNumber, headSha: event.headSha,
      ...(root ? { reviewRootId: root, reviewCommentId: event.reviewCommentId, sourceTriggerId: trigger.id } : {}) };
    destinations.set(JSON.stringify([pull.repository, pull.number, pull.headSha, root ?? null]), pull);
  }
  if (originPull) destinations.set(JSON.stringify([originPull.repository, originPull.number, originPull.headSha, null]),
    { repository: originPull.repository, number: originPull.number, headSha: originPull.headSha });
  return [...destinations.values()];
}

/** A run summary belongs to the PR conversation. Individual review findings
 * use their explicit disposition and receipt, never this generic fan-out. */
export function generalPullResultDestinations(pulls) {
  return pulls.filter(pull=>!positive(pull.reviewRootId));
}

export function samePullReplyDestination(left, right) {
  if (left?.source !== 'github' || right?.source !== 'github') return false;
  const a = left.address ?? {}, b = right.address ?? {};
  return a.repository === b.repository && a.pullNumber === b.pullNumber && a.headSha === b.headSha &&
    (a.reviewRootId ?? null) === (b.reviewRootId ?? null);
}

/** Metadata-only migration. Never infer a thread from message text or the newest review. */
export function reconcilePendingReviewDestination(store, message) {
  const address = message.channel?.address;
  if (message.channel?.source !== 'github' || !positive(address?.pullNumber) || address.reviewRootId || !message.ticketId) return message;
  const publicId = store.getMeta(`public:${message.ticketId}`) ?? message.ticketId;
  const meta = store.getMeta(`ticket:${publicId}`);
  const domain = store.tickets.get(meta?.domainId ?? message.ticketId);
  if (!domain) return message;
  const ids = new Set([domain.origin?.triggerId, ...domain.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId)].filter(Boolean));
  const matches = [];
  for (const id of ids) {
    const trigger = store.triggers.get(id), event = trigger?.meta?.pullEvent;
    if (trigger?.source !== 'github' || event?.kind !== 'review_comment' || !positive(event.reviewRootId) ||
        event.repository !== address.repository || String(event.pullNumber) !== address.pullNumber ||
        event.headSha !== address.headSha) continue;
    const stableSource = message.sourceTriggerId === id ||
      positive(address.reviewCommentId) && Number(address.reviewCommentId) === event.reviewCommentId ||
      message.kind === 'acknowledgement' && message.id === key('ack', id) ||
      message.id === key('reply', id, message.text) ||
      domain.origin?.triggerId === id && message.id === key('reply', domain.id, message.text) ||
      domain.attention?.triggerId === id && message.id === key('attention-reply', domain.attention.id);
    if (stableSource) matches.push({ id, event });
  }
  if (!matches.length || new Set(matches.map(item => item.event.reviewRootId)).size !== 1) return message;
  const { id, event } = matches[0];
  const updated = { ...message, sourceTriggerId: id, channel: { ...message.channel, address: { ...address,
    reviewRootId: String(event.reviewRootId), ...(positive(event.reviewCommentId) ? { reviewCommentId: String(event.reviewCommentId) } : {}) } } };
  const result = store.db.prepare("UPDATE receipts SET data = ? WHERE id = ? AND status = 'pending'").run(JSON.stringify(updated), message.id);
  if (!result.changes) return message;
  store.setMeta(`receipt:destination:${message.id}`, { sourceTriggerId: id, reviewRootId: String(event.reviewRootId), reason: 'stored-review-source' });
  return updated;
}

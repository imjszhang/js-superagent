import { pullEventAllowed } from '../github-pull-intake.mjs';

const prefix = 'pull-link-required:';
export const pullLinkKey = triggerId => `${prefix}${triggerId}`;

function revisionCurrent(store, event) {
  const revision = event.commentVersion;
  const current = store.getMeta(`github:comment-version:${revision?.baseId ?? event.id}`);
  if (revision && (!current || current.eventId !== event.id || current.digest !== revision.digest || current.actorId !== revision.actorId || current.location !== revision.location)) return false;
  if (!revision && current && current.eventId !== event.id) return false;
  return true;
}

/** A PR-sourced attach may proceed only when the target already owns that head. */
export function pullAttachReady({ store, config, policy, trigger, domain }) {
  const event = trigger?.meta?.pullEvent;
  if (!event) return { ready: true };
  const publicId = store.getMeta(`public:${domain?.id}`);
  const binding = store.getMeta(`github:pull:${event.repository}#${event.pullNumber}`);
  const allowed = binding && domain && config && pullEventAllowed(config, binding, event, { policy, trigger, ticket: domain, allowHistoricalDiscussion: true });
  if (!domain || !publicId || !binding || binding.ticketId !== publicId || binding.headSha !== event.headSha || binding.blockedReason ||
      config?.repository !== event.repository || !policy.revalidate(domain.mandate) || !allowed || !revisionCurrent(store, event)) {
    return { ready: false, event, publicId };
  }
  return { ready: true, event, publicId, binding };
}

/** Remember the intended attach without putting the input on the ticket queue. */
export function holdPullLink({ store, trigger, domain, publicId, event, evalId, note, now }) {
  const key = pullLinkKey(trigger.id);
  const existing = store.getMeta(key);
  if (existing?.status === 'pending') return existing;
  if (store.listMeta(prefix).filter(row => row.value.status === 'pending').length >= 1000) throw new Error('Pull link handoff inbox is full');
  const record = { version: 1, status: 'pending', triggerId: trigger.id, ticketId: publicId, domainId: domain.id,
    repository: event.repository, pullNumber: event.pullNumber, headSha: event.headSha, evalId: evalId ?? null, note: note ?? null, at: now };
  store.setMeta(key, record);
  return record;
}

/**
 * Complete one saved attach after an explicit link, using the newly observed source.
 * A changed head, another ticket's binding, or a revoked mandate stays pending.
 */
export function claimPullLink({ store, binding, domain, meta, event, policy, config, now }) {
  const record = event && store.getMeta(pullLinkKey(event.id));
  if (!record || record.status !== 'pending' || !binding || !domain || !meta) return null;
  const retire = reason => { store.setMeta(pullLinkKey(event.id), { ...record, status: 'retired', reason, resolvedAt: now }); return null; };
  if (record.ticketId !== binding.ticketId || record.domainId !== domain.id || record.repository !== event.repository || record.pullNumber !== event.pullNumber) return null;
  if (domain.ended?.by === 'human' || meta.cancelRequested) return retire('cancelled');
  if (binding.headSha !== record.headSha || event.headSha !== record.headSha || binding.blockedReason || binding.repository !== record.repository) return null;
  const trigger = store.triggers.get(event.id);
  const disposition = store.triggers.disposition(event.id);
  if (!trigger || !revisionCurrent(store, event)) return retire('source-revision-retired');
  if (store.getMeta(`input:retired:${domain.id}:${event.id}`) || store.getMeta(`github:retired:${domain.id}:${event.id}`) ||
      disposition?.handbacks?.some(item => item.ticketId === domain.id)) return retire('input-retired');
  if (!policy.revalidate(domain.mandate) || !pullEventAllowed(config, binding, event, { policy, trigger, ticket: domain, allowHistoricalDiscussion: true })) return null;
  return record;
}

export function completePullLink({ store, record, now }) {
  store.setMeta(pullLinkKey(record.triggerId), { ...record, status: 'attached', resolvedAt: now });
}

export function pendingPullLinks(store, ticketId) {
  return store.listMeta(prefix).map(row => row.value).filter(row => row.status === 'pending' && row.ticketId === ticketId);
}

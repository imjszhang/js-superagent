import { createHash } from 'node:crypto';
const kinds = new Set(['comment', 'pr_comment', 'review', 'review_comment']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Stable remote identity is separate from the observed body/state revision. */
export function versionGitHubComment(event) {
  if (!kinds.has(event.kind)) return event;
  const prefix = `github:${event.repository}:${event.kind}:`;
  const match = typeof event.id === 'string' && event.id.startsWith(prefix) && /^(\d+)(?::v:[a-f0-9]{24})?$/.exec(event.id.slice(prefix.length));
  if (!match) throw new Error('Invalid GitHub comment identity');
  const baseId = `github:${event.repository}:${event.kind}:${match[1]}`;
  // Older trusted adapters remain ID-only. Their first versioned observation is baselined.
  if (event.updatedAt === undefined) {
    if (event.id !== baseId) throw new Error('Versioned comment requires an update timestamp');
    return { ...event, remoteId: match[1] };
  }
  if (!Number.isFinite(Date.parse(event.updatedAt)) || (event.observedAt !== undefined && !Number.isFinite(Date.parse(event.observedAt)))) throw new Error('Invalid GitHub comment update timestamp');
  const updatedAt = new Date(event.updatedAt).toISOString();
  const digest = hash({ text: event.text, state: event.kind === 'review' ? event.state : null, commitId: event.commitId ?? null });
  const revision = hash({ updatedAt, digest }).slice(0, 24);
  const id = `${baseId}:v:${revision}`;
  if (event.id !== baseId && event.id !== id) throw new Error('GitHub comment revision mismatch');
  return { ...event, id, remoteId: match[1], updatedAt,
    commentVersion: { baseId, revision, digest, updatedAt, observedAt: event.observedAt ?? updatedAt,
      actorId: String(event.actor.id), actor: event.actor.login, location: event.issueNumber ?? event.pullNumber ?? event.number } };
}

/** Called in the existing ingestion transaction. No external action or authorization here. */
export function observeGitHubComment(store, event, now) {
  const version = event.commentVersion;
  if (!version) return { event };
  const key = `github:comment-version:${version.baseId}`, previous = store.getMeta(key);
  const legacyReceipt = store.getMeta(`github:event:${version.baseId}`);
  const legacyTrigger = store.triggers.get(version.baseId);
  if (previous) {
    if (previous.actorId !== version.actorId || previous.location !== version.location) return { skip: 'comment-identity-conflict' };
    const before = Date.parse(previous.updatedAt), after = Date.parse(version.updatedAt);
    if (after < before || after === before && Date.parse(version.observedAt) < Date.parse(previous.observedAt)) return { skip: 'stale-comment-version' };
    if (previous.digest === version.digest) {
      if (after >= before) store.setMeta(key, { ...previous, updatedAt: version.updatedAt, observedAt: version.observedAt });
      return { skip: 'duplicate-comment-content' };
    }
    if (after === before && Date.parse(version.observedAt) <= Date.parse(previous.observedAt)) return { skip: 'ambiguous-comment-version' };
  } else if (legacyReceipt || legacyTrigger) {
    // Pre-version records do not reliably preserve raw body/update time. Never replay all history.
    store.setMeta(key, { ...version, eventId: version.baseId, legacyId: version.baseId, baseline: true, at: now });
    return { skip: 'legacy-comment-baseline' };
  }
  const supersedes = previous?.eventId;
  store.setMeta(key, { ...version, eventId: event.id, at: now });
  return { event: { ...event, ...(supersedes ? { supersedes } : {}) }, supersedes };
}

export function commentCorrection(event, text = event.text) {
  return event.supersedes ? `Updated GitHub comment ${event.commentVersion.baseId}; supersedes ${event.supersedes}. Treat this as a correction under the existing mandate, not a second task. Already completed actions are not undone.\n\n${text}` : text;
}

/** Retire only undelivered copies, never claim that an old input was read. */
export function supersedeGitHubInput(store, previousId, replacementId, now) {
  if (!previousId) return;
  for (const domain of store.tickets.list()) {
    const retired = domain.inputs.filter(input => input.kind === 'trigger' && input.triggerId === previousId && !input.readAt && !input.deliveredTo);
    const publicId = store.getMeta(`public:${domain.id}`), meta = publicId && store.getMeta(`ticket:${publicId}`);
    const held = meta?.heldFeedback?.some(item => item.id === previousId);
    if (!retired.length && !held) continue;
    const entry = { reason: 'A newer revision of the same GitHub comment replaced this undelivered input', at: now, eventId: previousId, replacementId };
    store.setMeta(`input:retired:${domain.id}:${previousId}`, entry);
    domain.undelivered = domain.undelivered.filter(id => !retired.some(input => input.id === id));
    domain.updatedAt = now; store.tickets.save(domain);
    const current = store.triggers.disposition(previousId);
    if (current) store.triggers.saveDisposition(previousId, { ...current, fanout: current.fanout.filter(id => id !== domain.id) });
    if (meta) {
      for (const [index, message] of (meta.messages ?? []).entries()) if ((message.triggerId ?? (index === 0 ? domain.origin.triggerId : null)) === previousId) message.superseded = entry;
      meta.heldFeedback = (meta.heldFeedback ?? []).filter(item => item.id !== previousId);
      store.setMeta(`ticket:${publicId}`, meta);
    }
  }
}

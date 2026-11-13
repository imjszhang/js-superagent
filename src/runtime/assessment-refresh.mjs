import { randomUUID } from 'node:crypto';

// Only host-created errors, never matching model text or arbitrary error codes,
// can discard a snapshot and request another assessment attempt.
export class AssessmentContextChanged extends Error {
  constructor(reason = 'record-version') {
    super(reason === 'record-version' ? 'Context record changed; reread its current version' : 'Coordination context or policy changed; reassessment required');
    this.name = 'AssessmentContextChanged'; this.code = 'assessment_context_changed';
    this.failureKind = 'context'; this.retryable = true; this.reason = reason;
  }
}
export const isAssessmentContextChanged = error => error instanceof AssessmentContextChanged;
export const CONTEXT_REFRESH_LIMIT = 2;
export const CONTEXT_REFRESH_EXHAUSTED = 'assessment_context_stale_exhausted';
const key = triggerId => `assessment-refresh:${triggerId}`;
export function refreshState(store, triggerId) {
  const value = store.getMeta(key(triggerId));
  if (value == null) return { cycle: 'initial', refreshesUsed: 0 };
  if (typeof value.cycle !== 'string' || !value.cycle || !Number.isSafeInteger(value.refreshesUsed) || value.refreshesUsed < 0 || value.refreshesUsed > CONTEXT_REFRESH_LIMIT) {
    throw new Error('Invalid assessment refresh state; inspect the original request');
  }
  return value;
}
/** Called only after a public manual re-evaluation was actually accepted. */
export function resetRefreshCycle(store, triggerId) {
  store.setMeta(key(triggerId), { cycle: randomUUID(), refreshesUsed: 0 });
}
/** All batch inputs share this attempt, but keep their own durable allowance. */
export function recordContextRefresh(store, triggerIds, { runId, evalId, reason, at }) {
  if (!store.inTransaction) return store.atomic(() => recordContextRefresh(store, triggerIds, { runId, evalId, reason, at }));
  const entries = [...new Set(triggerIds)].map(id => [id, refreshState(store, id)]);
  const exhausted = entries.filter(([, value]) => value.lastRefreshRunId !== runId && value.refreshesUsed >= CONTEXT_REFRESH_LIMIT).map(([id]) => id);
  if (exhausted.length) return { exhausted };
  for (const [id, value] of entries) if (value.lastRefreshRunId !== runId) store.setMeta(key(id), {
    ...value, refreshesUsed: value.refreshesUsed + 1, lastRefreshRunId: runId, evalId, reason, at,
  });
  return { exhausted: [], refreshesUsed: Math.max(...entries.map(([id]) => refreshState(store, id).refreshesUsed)) };
}

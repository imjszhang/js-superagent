/** Feedback never supplies new authority. Classify only after source/mandate checks. */
export function feedbackDisposition({ meta, domain, human, active = false, pendingDelivery = false }) {
  if (domain.ended?.by === 'human') return { status: 'rejected', reason: 'cancelled' };
  const report = domain.assignments.at(-1)?.report;
  if (meta.interrupted || pendingDelivery || (['blocked', 'failed'].includes(report?.state) &&
      (active || meta.failure?.requiresInspection !== false))) return { status: 'held', reason: 'inspection-required' };
  if (['blocked', 'failed'].includes(report?.state)) return human
    ? { status: 'continue', reason: 'human-feedback' } : { status: 'recorded', reason: 'waiting-for-human' };
  return { status: 'received', reason: null };
}

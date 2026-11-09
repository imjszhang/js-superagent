import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const ID = /^[A-Za-z\d._:/-]{1,512}$/;
const JOB_TOOLS = new Set(['start', 'status', 'wait', 'cancel', 'preview', 'message', 'resume'].map(name => `js_superagent_job_${name}`).concat('js_superagent_preview_close'));

export function hostRecoveryBlockReason(store, ticketId) {
  const operation = store.getMeta('operation:owner');
  if (operation && (!operation.ticketId || operation.ticketId === ticketId)) return 'host-operation-unreconciled';
  const adoptions = store.listMeta('child-adoption:').map(row => row.value);
  if (adoptions.some(record => record.ticketId === ticketId && !['applied', 'rolled-back'].includes(record.status))) return 'child-adoption-unreconciled';
  return null;
}

/** Only the runtime sees its journal; adapters receive this ticket-scoped proof predicate. */
export function createHostToolVerifier({ store, ticketId, session, ownerExited = () => false }) {
  return query => {
    if (!query || !ID.test(query.runId ?? '') || !ID.test(query.callId ?? '') || query.sessionId !== session?.id || query.driver !== session.driver) return false;
    // A dead owner is not proof that an interrupted host filesystem operation
    // rolled back. Reconcile its journal before trusting a native tool result.
    if (hostRecoveryBlockReason(store, ticketId)) return false;
    const signature = hash([query.name, query.arguments]);
    const record = store.getMeta(`native-host-tool:${query.runId}:${query.callId}`) ?? store.getMeta(`agent-tool:${query.runId}:call:${query.callId}`);
    const matched = record?.ticketId === ticketId && record.runId === query.runId && record.sessionId === query.sessionId &&
      (!query.turnId || record.turnId === query.turnId) && record.name === query.name && record.signature === signature && record.status === 'completed' && stable(record.result) === stable(query.result);
    if (query.name === 'js_superagent_native_preview_start') {
      // A successful start receipt proves the endpoint existed, not that its
      // native owner settled. Recovery must never recreate a live preview or
      // infer cleanup from a missing handoff after a crash during startup.
      if (!matched || !ID.test(query.result?.jobId ?? '')) return false;
      const leases = store.listMeta('native-handoff:').map(row => row.value).filter(lease => lease.ticketId === ticketId &&
        lease.session?.id === query.sessionId && lease.session?.driver === query.driver && lease.jobIds?.includes(query.result.jobId));
      if (leases.some(lease => ['holding', 'resuming', 'closing'].includes(lease.status))) return false;
      return leases.some(lease => lease.status === 'completed' && lease.assignmentId === record.assignmentId && lease.owner?.host &&
        lease.previews?.some(preview => preview.jobId === query.result.jobId && preview.profileId === query.arguments?.profileId &&
          preview.commandPid === query.result.commandPid && preview.guardianPid === query.result.guardianPid) &&
        lease.results?.some(event => event.type === 'settled' && event.job?.id === query.result.jobId && ['completed', 'failed', 'killed'].includes(event.job.status)) &&
        lease.guardianPids?.length && lease.guardianPids.every(pid => ownerExited({ pid, host: lease.owner.host })));
    }
    if (!JOB_TOOLS.has(query.name)) return !!matched;
    const jobId = query.name === 'js_superagent_job_start' ? query.result?.id : query.arguments?.jobId;
    if (!ID.test(jobId ?? '')) return false;
    const job = store.getMeta(`managed-job:${jobId}`);
    if (job?.parent?.ticketId !== ticketId || !job.endedAt || !job.completion ||
      !['completed', 'failed', 'cancelled', 'timeout', 'timed-out', 'handed-off', 'killed'].includes(job.status) || job.previewLease?.status === 'active' ||
      (job.guardians ?? []).some(owner => !ownerExited(owner)) || job.guardian && !ownerExited(job.guardian)) return false;
    if (query.name === 'js_superagent_job_start') {
      return job.requestId === query.callId && job.requestDigest === hash(query.arguments) && job.parent.runId === query.runId &&
        query.result?.profileId === job.profileId && (matched || !record);
    }
    if (['js_superagent_job_message','js_superagent_job_resume'].includes(query.name)) return !!matched && job.kind === 'agent' &&
      job.messages?.some(message => message.id === query.callId && message.text === query.arguments.text && message.status === 'consumed' &&
        job.turns?.some(turn => turn.runId === message.runId && turn.messageId === message.id && turn.status === 'completed'));
    return !!matched;
  };
}

export function recordHostToolResult(store, identity, query, at) {
  if (!query || !ID.test(query.callId ?? '') || query.sessionId !== identity.sessionId || typeof query.name !== 'string' ||
      !query.arguments || typeof query.arguments !== 'object' || query.result === undefined || Buffer.byteLength(JSON.stringify(query)) > 128 * 1024) throw new Error('Invalid native host tool receipt');
  const key = `native-host-tool:${identity.runId}:${query.callId}`, signature = hash([query.name, query.arguments]);
  const previous = store.getMeta(key);
  if (previous && (previous.signature !== signature || stable(previous.result) !== stable(query.result))) throw new Error('Native host tool receipt conflict');
  if (!previous) store.setMeta(key, { ...identity, callId: query.callId, turnId: query.turnId, name: query.name, signature,
    arguments: structuredClone(query.arguments), result: structuredClone(query.result), status: 'completed', at });
}

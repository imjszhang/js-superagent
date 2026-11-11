import { createHash } from 'node:crypto';
import { normalizeDriverReport } from './reports.mjs';

export function normalizeRecoverySettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['retryBeforeStart', 'autoResume', 'maxAttempts', 'initialDelayMs'].includes(key))) throw new Error('Invalid recovery settings');
  const result = { retryBeforeStart: value.retryBeforeStart ?? false, autoResume: value.autoResume ?? false, maxAttempts: value.maxAttempts ?? 3, initialDelayMs: value.initialDelayMs ?? 15000 };
  if (typeof result.retryBeforeStart !== 'boolean' || typeof result.autoResume !== 'boolean' || !Number.isSafeInteger(result.maxAttempts) || result.maxAttempts < 1 || result.maxAttempts > 3 || !Number.isSafeInteger(result.initialDelayMs) || result.initialDelayMs < 10 || result.initialDelayMs > 60000) throw new Error('Invalid recovery retry limits');
  return result;
}

/** Evidence comes from a trusted adapter after settling its processes, never HTTP-text matching. */
export function recoveryEvidence(value, { session, runId, kind = 'transient' } = {}) {
  if (!value || value.version !== 1 || value.kind !== kind || value.safeToResume !== true || value.toolsSettled !== true ||
      !session?.id || value.session?.driver !== session.driver || value.session?.id !== session.id ||
      value.checkpoint?.runId !== runId || !Number.isSafeInteger(value.checkpoint?.eventSequence) || value.checkpoint.eventSequence < 0 ||
      !(kind === 'transient' ? ['RATE_LIMIT', 'SERVER', 'TIMEOUT'] : ['HISTORY_VERIFIED']).includes(value.code)) return null;
  const result={ version:1,kind,session:{...session},safeToResume:true,toolsSettled:true,checkpoint:{runId,eventSequence:value.checkpoint.eventSequence},code:value.code };
  if(value.outcome!==undefined){
    if(!['resume','completed','adopt-pending'].includes(value.outcome))return null;
    result.outcome=value.outcome;
    if(value.outcome==='completed'){
      try{const {sourceVersion,...report}=normalizeDriverReport(value.report,{version:2});result.report=report;}catch{return null;}
      if(result.report.state==='progress')return null;
    }
  }
  if(value.outcome==='adopt-pending'){
    const adoption=value.adoption;
    if(kind!=='interrupted'||adoption?.sourceRunId!==runId||adoption.sessionId!==session.id||adoption.eventSequence!==value.checkpoint.eventSequence||
      !Array.isArray(adoption.pending)||!adoption.pending.length||adoption.pending.length>1000||adoption.pending.some(item=>!item||
        ['inputId','messageId','sourceRunId'].some(key=>typeof item[key]!=='string'||!item[key]||item[key].length>256)||!/^[a-f\d]{64}$/.test(item.nativeDigest??''))||
      new Set(adoption.pending.map(item=>item.inputId)).size!==adoption.pending.length||new Set(adoption.pending.map(item=>item.messageId)).size!==adoption.pending.length)return null;
    result.adoption={sourceRunId:adoption.sourceRunId,sessionId:adoption.sessionId,eventSequence:adoption.eventSequence,
      pending:adoption.pending.map(({inputId,messageId,nativeDigest,sourceRunId})=>({inputId,messageId,nativeDigest,sourceRunId}))};
  }
  if(value.finalReportFailure!==undefined){
    if(kind!=='interrupted'||value.outcome!=='resume'||!['missing-final-report','invalid-final-report'].includes(value.finalReportFailure))return null;
    result.finalReportFailure=value.finalReportFailure;
  }
  if(value.readInputIds!==undefined){if(!Array.isArray(value.readInputIds)||value.readInputIds.length>1000||value.readInputIds.some(id=>typeof id!=='string'||!id||id.length>256))return null;result.readInputIds=[...new Set(value.readInputIds)];}
  if(value.contextRecords!==undefined){if(!Array.isArray(value.contextRecords)||value.contextRecords.length>1000||value.contextRecords.some(ref=>!ref||['resource','id','version'].some(key=>typeof ref[key]!=='string'||ref[key].length>512)))return null;result.contextRecords=value.contextRecords.map(ref=>({resource:ref.resource,id:ref.id,version:ref.version}));}
  return result;
}

export function nextRecoveryPlan(previous, { settings, evidence, runId, now = Date.now() } = {}) {
  settings=normalizeRecoverySettings(settings);
  if (!settings.autoResume || !evidence) return null;
  const attempt = previous?.status === 'resuming' ? previous.attempt : 0;
  return { status:attempt >= settings.maxAttempts ? 'exhausted' : 'pending',attempt,runId,session:evidence.session,evidence,
    nextAt:new Date(now + Math.min(60000,settings.initialDelayMs * 2 ** attempt)).toISOString(),createdAt:previous?.createdAt ?? new Date(now).toISOString() };
}

/** Only a failure before the trusted adapter registered any process can be retried.
 * Network/model failures are deliberately excluded even when their HTTP code is transient. */
export async function retryBeforeStart(run, { settings = {}, started, signal, record = () => {} } = {}) {
  settings = normalizeRecoverySettings(settings);
  for (let attempt = 1;; attempt++) {
    if (signal?.aborted) throw new Error('Execution cancelled before launch');
    try { return await run(); }
    catch (error) {
      const safe = settings.retryBeforeStart && !started() && ['EAGAIN', 'EMFILE', 'ENFILE'].includes(error?.code);
      record({ attempt, retryable: safe, phase: started() ? 'started' : 'before-start', code: error?.code ?? null });
      if (!safe || attempt >= settings.maxAttempts || signal?.aborted) throw error;
      const delay = Math.min(60000, settings.initialDelayMs * 2 ** (attempt - 1));
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Execution cancelled during retry')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

/** Trusted operator view. Model tools use a separate, narrower resource projection. */
export function buildTicketTrace(store, meta, { cursor, limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Trace limit must be 1..100');
  const domain = store.tickets.get(meta.domainId), events = [];
  const add = (kind, id, at, value) => events.push({ kind, id, at: at ?? domain.createdAt, value });
  add('authorization', domain.id, domain.createdAt, { mandate: domain.mandate, origin: domain.origin, ended: domain.ended ?? null });
  const triggerIds = new Set([domain.origin?.triggerId, ...domain.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId)].filter(Boolean));
  for (const id of triggerIds) { const trigger = store.triggers.get(id); if (trigger) add('trigger', id, trigger.at, { trigger, disposition: store.triggers.disposition(id) }); }
  for (const decision of store.decisions.byThread?.(domain.origin?.threadKey) ?? []) if (decision.ticketId === domain.id || triggerIds.has(decision.triggerId)) add('decision', decision.id, decision.at, decision);
  // Origin decisions may be in a different thread after explicit attachment.
  for (const row of store.db.prepare('SELECT id,data FROM domain_decisions').all()) {
    const decision = JSON.parse(row.data);
    if ((decision.ticketId === domain.id || triggerIds.has(decision.triggerId)) && !events.some(event => event.kind === 'decision' && event.id === decision.id)) add('decision', decision.id, decision.at, decision);
  }
  for (const input of domain.inputs) add('input', input.id, input.at ?? input.deliveredAt, input);
  for (const assignment of domain.assignments) add('assignment', assignment.id, assignment.startedAt ?? assignment.createdAt, assignment);
  for (const thread of store.threads.list()) if (thread.subscriptions?.includes(domain.id) || domain.follows?.some(follow => follow.thread === thread.key)) add('thread', thread.key, thread.updatedAt, thread);
  for (const [index, report] of (meta.reportsV2 ?? meta.reports).entries()) add('report', `${report.runId}:${index}`, report.at, report);
  for (const item of meta.sessionHistory ?? []) add('session', item.id, item.at, item);
  if (meta.recovery) add('recovery', meta.recovery.runId, meta.recovery.updatedAt ?? meta.recovery.createdAt, meta.recovery);
  if (meta.nativeFacts) add('native-facts', meta.runId ?? domain.id, meta.updatedAt, meta.nativeFacts);
  const runs=new Set([meta.runId,...meta.reports.map(report=>report.runId)].filter(Boolean));
  for(const row of store.listMeta('execution-observation:'))if(runs.has(row.value.runId))add('execution-observation',row.value.runId,row.value.at,row.value);
  for(const runId of runs){
    const selected=store.getMeta(`worker-policy:run:${runId}`),applied=store.getMeta(`worker-policy:applied:${runId}`),adoption=store.getMeta(`input-adoption:${runId}`);
    if(selected)add('worker-policy',runId,selected.status?.selectedAt,{...selected.status,revision:selected.snapshot?.revision??null,digest:selected.snapshot?.digest??null,applied});
    if(adoption)add('input-adoption',runId,adoption.adoptedAt??adoption.preparedAt,adoption);
  }
  for(const row of store.listMeta('live-input:'))if(meta.reports.some(report=>report.runId===row.value.runId)||meta.runId===row.value.runId)add('input-delivery',`${row.value.runId}:${row.value.inputId}`,row.value.readAt??row.value.at,row.value);
  for (const row of store.listMeta('managed-job:')) if (row.value.parent.ticketId === meta.id) add('job', row.value.id, row.value.startedAt ?? row.value.createdAt, row.value);
  for (const field of ['verification', 'delivery', 'deliveryAttempt']) if (meta[field]) add(field, meta[field].id ?? field, meta[field].at ?? meta.updatedAt, meta[field]);
  events.sort((a,b) => String(a.at).localeCompare(String(b.at)) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const version = createHash('sha256').update(JSON.stringify(events)).digest('hex');
  let offset = 0;
  if (cursor) {
    let parsed; try { parsed = JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { throw new Error('Invalid trace cursor'); }
    if (parsed.ticketId !== meta.id || parsed.version !== version || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error('Trace changed; refresh its first page');
    offset = parsed.offset;
  }
  return { ticketId: meta.id, domainId: domain.id, version, total: events.length, items: events.slice(offset,offset+limit),
    nextCursor: offset+limit<events.length ? Buffer.from(JSON.stringify({ticketId:meta.id,version,offset:offset+limit})).toString('base64url') : null };
}

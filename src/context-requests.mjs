const resources = ['tickets', 'threads', 'decisions', 'triggers', 'sources', 'repository'];
const unavailable = reason => ({ kind: 'unavailable', reason, rules: [] });

/** References are derived from stored domain records, never from model supplied IDs. */
export function candidateReferences(candidate, additionalReferences = []) {
  const refs = Object.fromEntries(resources.map(resource => [resource, new Set()]));
  for (const reference of additionalReferences) {
    if (!reference || !['sources', 'repository'].includes(reference.resource) || typeof reference.id !== 'string' || !reference.id || reference.id.length > 1024) throw new Error('Invalid trusted candidate context reference');
    refs[reference.resource].add(reference.id);
  }
  refs.threads.add(candidate.thread.key);
  for (const trigger of candidate.triggers) {
    refs.triggers.add(trigger.id);
    for (const thread of trigger.threads) refs.threads.add(`${thread.source}:${thread.id}`);
  }
  for (const ticket of candidate.tickets) {
    refs.tickets.add(ticket.id);
    if (ticket.decisionId) refs.decisions.add(ticket.decisionId);
    if (ticket.origin?.triggerId) refs.triggers.add(ticket.origin.triggerId);
    for (const input of ticket.inputs ?? []) if (input.triggerId) refs.triggers.add(input.triggerId);
    for (const follow of ticket.follows ?? []) refs.threads.add(follow.thread);
  }
  return refs;
}

/** Structured read proposals consume a shared budget; only the host performs the actual lookup. */
export async function runBoundedAssessment({ candidate, call, readContextRecord, signal, timeoutMs = 120_000, maxReads = 3, maxBytes = 32_000, now = () => Date.now(), contextReferences = [] }) {
  const refs = candidateReferences(candidate, contextReferences), facts = [], versions = new Map(), deadline = now() + timeoutMs;
  let bytes = 0;
  for (let turn = 0; turn <= maxReads; turn++) {
    if (signal?.aborted) throw new Error('Assessment cancelled');
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return unavailable('Coordinator time budget exhausted');
    const visibleReferences = ['sources', 'repository'].flatMap(resource => [...refs[resource]].map(id => ({ resource, id })));
    const outcome = await call({ turn, facts: structuredClone(facts), remainingMs, contextReferences: visibleReferences });
    if (outcome.kind !== 'read') return outcome;
    if (turn === maxReads) return unavailable('Coordinator context-read budget exhausted');
    if (typeof readContextRecord !== 'function') return unavailable('Required context lookup is not available in this host');
    if (!resources.includes(outcome.resource) || typeof outcome.recordId !== 'string' || !refs[outcome.resource].has(outcome.recordId)) return unavailable('Requested record is outside the candidate context');
    if (!Number.isSafeInteger(outcome.offset) || outcome.offset < 0) return unavailable('Invalid requested context offset');
    const key = `${outcome.resource}:${outcome.recordId}`, version = versions.get(key), limit = Math.min(8000, maxBytes - bytes);
    if (limit < 100) return unavailable('Coordinator context byte budget exhausted');
    let record;
    try { record = await readContextRecord(outcome.resource, outcome.recordId, { offset: outcome.offset, limit, ...(version ? { version } : {}) }); }
    catch { return unavailable('Requested context changed or could not be read; reassessment is needed'); }
    if (signal?.aborted) throw new Error('Assessment cancelled');
    if (!record) return unavailable('Requested context record is no longer available');
    if (record.resource !== outcome.resource || record.id !== outcome.recordId || record.offset !== outcome.offset || typeof record.version !== 'string' || typeof record.text !== 'string' ||
        version && record.version !== version) return unavailable('Context reader returned an inconsistent record');
    bytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (bytes > maxBytes) return unavailable('Coordinator context byte budget exhausted');
    if (record.references !== undefined) {
      if (!Array.isArray(record.references) || record.references.length > 100 || record.references.some(reference => !reference || !['sources', 'repository'].includes(reference.resource) || typeof reference.id !== 'string' || !reference.id || reference.id.length > 1024)) return unavailable('Source reader returned invalid scoped references');
      for (const reference of record.references) refs[reference.resource].add(reference.id);
      if (refs.sources.size + refs.repository.size > 256) return unavailable('Coordinator source reference budget exhausted');
    }
    versions.set(key, record.version); facts.push(record);
  }
  return unavailable('Coordinator context-read budget exhausted');
}

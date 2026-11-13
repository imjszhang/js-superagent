import { createHash } from 'node:crypto';
import { sourceDiagnostic } from '../sources.mjs';

const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : value?.at ? Date.parse(value.at) : NaN;
const bounded = value => String(value ?? '').slice(0, 200);
const identity = key => createHash('sha256').update(key).digest('hex').slice(0, 24);
function limit(value, fallback = 100) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error('Health limit must be 1 to 500'); return value; }

/** Durable local incidents. Observations count poll attempts, never repeated UI reads. No outbound notification is sent. */
export class BusinessHealthRegistry {
  constructor(store, { now = () => Date.now() } = {}) { this.store = store; this.now = now; }
  current() { return this.store.getMeta('health:current') ?? { at: null, sources: [], models: [], incidents: [], transitions: [] }; }
  listIncidents({ includeResolved = true, limit: count } = {}) {
    return this.store.listMeta('health:incident:').map(row => row.value).filter(item => includeResolved || item.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit(count));
  }
  acknowledge(id, { expectedRevision } = {}) {
    if (!/^[a-f\d]{24}$/.test(id ?? '') || !Number.isSafeInteger(expectedRevision)) throw new Error('Incident identity and revision are required');
    return this.store.atomic(() => {
      const key = `health:incident:${id}`, previous = this.store.getMeta(key);
      if (!previous) throw new Error('Unknown incident');
      if (previous.revision !== expectedRevision) throw new Error('Incident revision conflict');
      const next = { ...previous, revision: previous.revision + 1, acknowledgedAt: new Date(this.now()).toISOString() };
      this.store.setMeta(key, next); return next;
    });
  }
  observe(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.sources ?? []) || (snapshot.sources?.length ?? 0) > 100) throw new Error('Invalid health snapshot');
    const poll = snapshot.pollIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(poll) || poll < 1 || poll > 3_600_000) throw new Error('Invalid health poll interval');
    const clock = this.now(), at = new Date(clock).toISOString(), staleAfter = Math.max(3 * poll, 120_000);
    return this.store.atomic(() => {
      const previousState = this.store.getMeta('health:observations') ?? { sources: {}, firstObservedAt: at };
      const observations = { sources: Object.create(null), firstObservedAt: previousState.firstObservedAt }, problems = new Map(), transitions = [], seen = new Set();
      const sources = (snapshot.sources ?? []).map(source => {
        if (typeof source.id !== 'string' || !source.id || source.id.length > 200) throw new Error('Invalid health source ID');
        if (seen.has(source.id)) throw new Error('Duplicate health source ID'); seen.add(source.id);
        const previous = Object.hasOwn(previousState.sources, source.id) ? previousState.sources[source.id] : {}, attempt = timestamp(source.lastAttempt), success = timestamp(source.lastSuccess);
        const failed = !!source.error && (!Array.isArray(source.error) || source.error.length > 0);
        let consecutiveFailures = previous.consecutiveFailures ?? 0;
        if (Number.isFinite(attempt) && attempt !== previous.attempt) consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
        else if (!failed && Number.isFinite(success) && success !== previous.success) consecutiveFailures = 0;
        const since = Number.isFinite(success) ? success : timestamp(source.startedAt ?? previous.firstObservedAt ?? at);
        const stale = snapshot.running !== false && source.enabled !== false && clock - since > staleAfter;
        const historyState = source.enabled === false ? 'disabled' : snapshot.running === false ? 'stopped' : stale ? 'stale' : consecutiveFailures >= 3 ? 'degraded' : Number.isFinite(success) ? 'healthy' : 'starting';
        const connection = ['starting', 'ready', 'reconnecting', 'error', 'stopped'].includes(source.connection) ? source.connection : null;
        const liveFailed = connection !== null && snapshot.running !== false && source.enabled !== false && ['error', 'stopped'].includes(connection);
        const liveStarting = connection === 'starting' || connection === 'reconnecting';
        const state = ['disabled', 'stopped', 'stale'].includes(historyState) ? historyState
          : liveFailed || connection !== null && failed ? 'degraded' : liveStarting ? 'starting' : historyState;
        const issues = connection === null ? [] : Array.isArray(source.error) ? source.error.slice(0, 100).map(sourceDiagnostic) : [];
        observations.sources[source.id] = { attempt: Number.isFinite(attempt) ? attempt : previous.attempt ?? null, success: Number.isFinite(success) ? success : null, firstObservedAt: previous.firstObservedAt ?? at, consecutiveFailures };
        if (['stale', 'degraded'].includes(historyState) || liveFailed) problems.set(`source:${source.id}`, { kind: historyState === 'stale' ? 'source-stale' : liveFailed ? 'source-connection' : 'source-failures', subject: source.id, severity: 'error', summary: historyState === 'stale' ? 'Source has not synchronized within its expected interval' : liveFailed ? 'Source live connection is unavailable' : 'Source has failed at least three consecutive polls', action: 'Inspect source credentials, connection and synchronization logs', facts: { consecutiveFailures, staleAfterMs: staleAfter, lastSuccess: Number.isFinite(success) ? new Date(success).toISOString() : null, ...(connection === null ? {} : { connection, historyIssues: issues }) } });
        const times = { lastAttempt: Number.isFinite(attempt) ? new Date(attempt).toISOString() : null, lastSuccess: Number.isFinite(success) ? new Date(success).toISOString() : null };
        return { id: source.id, state, healthy: state === 'healthy', enabled: source.enabled !== false, ...times, consecutiveFailures, staleAfterMs: staleAfter,
          ...(connection === null ? {} : { connection, live: { state: connection, healthy: connection === 'ready' && source.enabled !== false && snapshot.running !== false },
            history: { state: failed && !['disabled', 'stopped', 'stale'].includes(historyState) ? 'degraded' : historyState, healthy: !failed && historyState === 'healthy', ...times, consecutiveFailures, issues } }) };
      });
      if (snapshot.running !== false && !snapshot.paused) {
        for (const item of (snapshot.queue ?? []).slice(0, 1000)) {
          const due = timestamp(item.due);
          if (!Number.isFinite(due)) continue;
          if ((item.attempts ?? 0) >= 3 || clock - due > Math.max(300_000, poll * 10)) problems.set(`queue:${bounded(item.id ?? item.kind)}`, { kind: 'queue-stalled', subject: bounded(item.id ?? item.kind), severity: 'error', summary: 'A durable action is repeatedly failing or overdue', action: 'Inspect and reconcile the original action before retrying', facts: { kind: bounded(item.kind), due: new Date(due).toISOString(), attempts: item.attempts ?? 0 } });
        }
      }
      // An already-running Worker continues during business pause and must still have a live owner.
      if (snapshot.running !== false) for (const execution of (snapshot.executions ?? []).slice(0, 100)) {
        const heartbeat = timestamp(execution.heartbeatAt);
        if (Number.isFinite(heartbeat) && clock - heartbeat > (execution.timeoutMs ?? 120_000)) problems.set(`execution:${bounded(execution.id)}`, { kind: 'execution-stale', subject: bounded(execution.id), severity: 'error', summary: 'An active execution has stopped reporting its ownership heartbeat', action: 'Inspect the owned process and reconcile before resuming', facts: { heartbeatAt: new Date(heartbeat).toISOString() } });
      }
      const models = snapshot.running === false ? [] : (snapshot.executions ?? []).slice(0, 100).flatMap(execution => {
        const observation = execution.observation;
        if (!observation || observation.runId !== execution.id || observation.state !== 'waiting' || !['budget', 'rate-limit', 'authentication', 'transient', 'unknown'].includes(observation.reason)) return [];
        const item = { runId: bounded(execution.id), sessionId: bounded(observation.sessionId), driver: bounded(observation.driver), reason: observation.reason,
          provider: observation.provider == null ? null : bounded(observation.provider), attempts: Number.isSafeInteger(observation.attempts) ? observation.attempts : null,
          since: observation.since ?? null, at: observation.at ?? null, nextAt: observation.nextAt ?? null };
        problems.set(`model:${item.runId}`, { kind: item.reason === 'budget' ? 'model-budget-wait' : 'model-retry-wait', subject: item.runId,
          severity: ['budget', 'authentication'].includes(item.reason) ? 'error' : 'warning', summary: item.reason === 'budget' ? 'The native model is waiting because its provider budget is exhausted' : 'The native model is waiting to retry a request',
          action: 'Inspect the reported native wait; existing timeout, cancellation and retry settings still apply', facts: item });
        return [item];
      });
      const existing = new Map(this.store.listMeta('health:incident:').map(row => [row.value.key, row.value]));
      for (const [key, problem] of problems) {
        const old = existing.get(key), changed = !old || old.status !== 'active' || old.kind !== problem.kind || key.startsWith('model:') && JSON.stringify(old.facts) !== JSON.stringify(problem.facts);
        if (!changed) continue;
        const next = { ...problem, id: identity(key), key, status: 'active', revision: (old?.revision ?? 0) + 1, occurrences: (old?.occurrences ?? 0) + (old?.status === 'active' ? 0 : 1), startedAt: old?.status === 'active' ? old.startedAt : at, updatedAt: at, resolvedAt: null, acknowledgedAt: null };
        this.store.setMeta(`health:incident:${next.id}`, next); transitions.push({ incidentId: next.id, revision: next.revision, transition: old?.status === 'active' ? 'changed' : 'opened', at });
      }
      for (const [key, old] of existing) if (old.status === 'active' && !problems.has(key)) {
        const observed = key.startsWith('model:') ? (snapshot.executions ?? []).find(item => `model:${item.id}` === key)?.observation : null;
        const reason = key.startsWith('queue:') && snapshot.paused ? 'business-paused' : snapshot.running === false ? 'runtime-stopped'
          : key.startsWith('model:') ? observed?.state === 'active' ? 'native-progress' : observed?.state === 'ended' ? `execution-${bounded(observed.reason ?? 'ended')}` : 'execution-not-active'
          : key.startsWith('source:') && sources.some(source => `source:${source.id}` === key && source.state === 'disabled') ? 'source-disabled' : 'recovered';
        const next = { ...old, status: 'resolved', revision: old.revision + 1, updatedAt: at, resolvedAt: at, resolution: reason };
        this.store.setMeta(`health:incident:${next.id}`, next); transitions.push({ incidentId: next.id, revision: next.revision, transition: 'resolved', reason, at });
      }
      const result = { at, sources, models, incidents: this.listIncidents({ includeResolved: false }), transitions };
      this.store.setMeta('health:observations', observations); this.store.setMeta('health:current', result);
      for (const transition of transitions) this.store.setMeta(`health:transition:${transition.incidentId}:${transition.revision}`, transition);
      return result;
    });
  }
}

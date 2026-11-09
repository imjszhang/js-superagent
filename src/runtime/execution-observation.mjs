const REASONS = new Set(['budget', 'rate-limit', 'authentication', 'transient', 'unknown']);
const short = value => typeof value === 'string' && value.length <= 200 && !/[\0\r\n]/.test(value) ? value : null;
const iso = value => value !== undefined && value !== null && value !== '' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

/** Only fixed protocol failure fields are inspected; model text and unrelated account limits are never evidence. */
export function nativeRetryReason(failure) {
  if (!failure || typeof failure !== 'object') return 'unknown';
  const code = failure.code ?? failure.type;
  if (['AUTH', 'unauthorized', 'authentication_error'].includes(code) || [401, 403].includes(failure.status ?? failure.statusCode)) return 'authentication';
  if (['RATE_LIMIT', 'rate_limit_error', 'rateLimitExceeded'].includes(code) || (failure.status ?? failure.statusCode) === 429) return 'rate-limit';
  if (code === 'budget_exceeded') return 'budget';
  if (['SERVER', 'TIMEOUT', 'internalServerError', 'serverOverloaded', 'flexUnavailable'].includes(code)) return 'transient';
  return 'unknown';
}

/** Pure projection of one run's trusted adapter observations. Store ownership/authorization is checked by the caller. */
export function applyExecutionObservation(previous, event, { runId, sessionId, now = () => new Date().toISOString() } = {}) {
  if (!event || event.version !== 1 || event.runId !== runId || event.sessionId !== sessionId || !/^[a-z][a-z\d-]{0,63}$/.test(event.driver ?? '') ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 0 || !['waiting', 'active', 'ended'].includes(event.state) || !short(event.evidence)) throw new Error('Invalid execution-state observation');
  if (previous && previous.runId === runId && event.sequence <= previous.sequence) return previous;
  const at = iso(event.at) ?? now(), inherited = previous?.runId === runId && previous.state === 'waiting' ? previous : null;
  if (event.state === 'waiting') {
    if (!REASONS.has(event.reason)) throw new Error('Invalid native wait reason');
    return { version: 1, driver: event.driver, runId, sessionId, turnId: short(event.turnId), sequence: event.sequence, state: 'waiting', reason: event.reason,
      provider: short(event.provider), attempts: Number.isSafeInteger(event.attempts) && event.attempts >= 0 ? event.attempts : null,
      since: inherited?.since ?? iso(event.since) ?? at, at, nextAt: iso(event.nextAt), evidence: event.evidence };
  }
  return { version: 1, driver: event.driver, runId, sessionId, turnId: short(event.turnId), sequence: event.sequence, state: event.state,
    at, reason: short(event.reason), evidence: event.evidence, ...(inherited ? { previousWait: inherited } : {}) };
}

/** Thin protocol observer; it never schedules a retry or changes a native retry policy. */
export function createNativeExecutionObserver({ driver, runId, sessionId, emit, now = () => new Date().toISOString() } = {}) {
  let sequence = 0, waiting = false, ended = false, lastState = 'active';
  const emitState = value => {
    const id = sessionId();
    if (!id || ended && value.state !== 'ended') return;
    if (value.state === 'waiting') waiting = true;
    if (value.state === 'active') waiting = false;
    if (value.state === 'ended') waiting = false;
    lastState = value.state;
    emit?.({ version: 1, driver, runId, sessionId: id, sequence: sequence++, at: now(), ...value });
  };
  return {
    emit: emitState,
    end(reason) { if (!ended) { emitState({ state: 'ended', reason, evidence: 'adapter-lifecycle' }); ended = true; } },
    state() { return { waiting, ended, lastState }; },
  };
}

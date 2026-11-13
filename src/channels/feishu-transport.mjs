import { AsyncLocalStorage } from 'node:async_hooks';
import { recordFeishuReadDiagnostic } from './feishu-diagnostics.mjs';

export const FEISHU_READ_TIMEOUT_MS = 30_000;
export const FEISHU_HANDSHAKE_TIMEOUT_MS = 10_000;
const stopped = () => Object.assign(new Error('Feishu connection is stopped'), { code: 'FEISHU_STOPPED' });
const deadlines = new WeakSet();
const timeout = () => {
  const error = Object.assign(new Error('Feishu read timed out'), { code: 'FEISHU_READ_TIMEOUT' });
  deadlines.add(error); return error;
};
const signalCheck = signal => { if (signal?.aborted) throw signal.reason ?? stopped(); };
const elapsed = startedAt => Math.min(86_400_000, Math.max(0, Math.round(performance.now() - startedAt)));
const cancelled = (error, signal) => signal?.aborted &&
  (error === signal.reason || error?.code === 'ERR_CANCELED' || error?.name === 'AbortError');
function cancellation(error, scope, requestSignal) {
  if (deadlines.has(error)) return 'deadline';
  // The composed request signal retains the first abort reason, even if the read scope stops later.
  if (cancelled(error, requestSignal) && requestSignal.reason !== scope.signal.reason) return 'request';
  if (cancelled(error, scope.signal)) {
    for (const [source, signal] of [['deadline', scope.deadlineSignal], ['stop', scope.lifetimeSignal], ['caller', scope.callerSignal]]) {
      if (signal?.aborted && signal.reason === scope.signal.reason) return source;
    }
  }
  if (cancelled(error, requestSignal)) return 'request';
  return undefined;
}
function diagnose(error, scope, requestSignal, phase = scope.phase) {
  try {
    const cancellationSource = cancellation(error, scope, requestSignal);
    recordFeishuReadDiagnostic(error, { phase, elapsedMs: elapsed(scope.startedAt),
      ...(cancellationSource ? { cancellationSource, reason: cancellationSource === 'deadline' ? 'timeout' : 'cancelled' } : {}) });
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) scope.recordedErrors.add(error);
  } catch { /* An uninspectable SDK error must still reject with the original thrown value. */ }
}

/** Per-connection SDK transport. Read deadlines include token acquisition; dispatched writes are never aborted here. */
export function createFeishuTransport(base, { readTimeoutMs = FEISHU_READ_TIMEOUT_MS } = {}) {
  const context = new AsyncLocalStorage(), active = new Set();
  let lifetime = new AbortController(), stopping, drained = false;
  const tracked = work => {
    const pending = Promise.resolve().then(work); active.add(pending);
    pending.then(() => active.delete(pending), () => active.delete(pending));
    return pending;
  };
  const assertOpen = () => signalCheck(lifetime.signal);
  const read = (call, { signal } = {}) => {
    const startedAt = performance.now();
    try { assertOpen(); signalCheck(signal); } catch (error) {
      recordFeishuReadDiagnostic(error, { reason: 'cancelled', cancellationSource: lifetime.signal.aborted ? 'stop' : 'caller',
        phase: 'request', elapsedMs: elapsed(startedAt) });
      return Promise.reject(error);
    }
    const controller = new AbortController(), signals = [lifetime.signal, controller.signal, ...(signal ? [signal] : [])];
    const scope = { signal: AbortSignal.any(signals), deadline: Date.now() + readTimeoutMs, startedAt, phase: 'request',
      deadlineSignal: controller.signal, lifetimeSignal: lifetime.signal, callerSignal: signal, recordedErrors: new WeakSet() };
    const timer = setTimeout(() => controller.abort(timeout()), readTimeoutMs); timer.unref?.();
    return tracked(() => context.run(scope, () => { signalCheck(scope.signal); return call(); }))
      .catch(error => {
        // An individual HTTP failure knows its own phase even if the SDK had concurrent preparation work.
        if (!scope.recordedErrors.has(error)) diagnose(error, scope);
        throw error;
      })
      .finally(() => clearTimeout(timer));
  };
  const invoke = (method, args) => {
    assertOpen();
    const index = method === 'request' ? 0 : ['post', 'put', 'patch'].includes(method) ? 2 : 1;
    const options = args[index] ?? {}, url = method === 'request' ? options.url : args[0];
    const verb = String(method === 'request' ? options.method ?? 'get' : method).toLowerCase();
    const scope = context.getStore();
    // Token preparation and WS discovery are bounded reads even though the platform uses POST.
    const preparation = /\/auth\/v3\/(?:tenant_access_token|app_access_token)(?:\/|$)|\/callback\/ws\/endpoint(?:\?|$)/.test(String(url));
    if (!scope && (preparation || ['get', 'head', 'options'].includes(verb))) return read(() => invoke(method, args));
    const phase = /\/auth\/v3\/(?:tenant_access_token|app_access_token)(?:\/|$)/.test(String(url)) ? 'auth' : 'request';
    let requestSignal;
    if (scope) {
      scope.phase = phase;
      signalCheck(scope.signal);
      const remaining = scope.deadline - Date.now();
      if (remaining <= 0) throw timeout();
      requestSignal = options.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal;
      args = [...args]; args[index] = { ...options, signal: requestSignal,
        timeout: options.timeout > 0 ? Math.min(options.timeout, remaining) : remaining };
    }
    if (typeof base?.[method] !== 'function') throw new Error('Feishu SDK HTTP transport is unavailable');
    // Keep SDK body/header transformations and proxy options; never mutate its global instance.
    const pending = tracked(() => { assertOpen(); if (scope) signalCheck(scope.signal); return base[method](...args); });
    return scope ? pending.catch(error => { diagnose(error, scope, requestSignal, phase); throw error; }) : pending;
  };
  const httpInstance = Object.fromEntries(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].map(method =>
    [method, (...args) => invoke(method, args)]));
  return { httpInstance, read, assertOpen,
    write(call) { assertOpen(); return tracked(() => { assertOpen(); return call(); }); },
    restart() {
      if (!lifetime.signal.aborted) return;
      if (!drained || active.size) throw stopped();
      lifetime = new AbortController(); stopping = undefined; drained = false;
    },
    stop() {
      if (stopping) return stopping;
      lifetime.abort(stopped());
      stopping = (async () => { while (active.size) await Promise.allSettled([...active]); drained = true; })();
      return stopping;
    },
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';

export const FEISHU_READ_TIMEOUT_MS = 30_000;
export const FEISHU_HANDSHAKE_TIMEOUT_MS = 10_000;
const stopped = () => Object.assign(new Error('Feishu connection is stopped'), { code: 'FEISHU_STOPPED' });
const timeout = () => Object.assign(new Error('Feishu read timed out'), { code: 'FEISHU_READ_TIMEOUT' });
const signalCheck = signal => { if (signal?.aborted) throw signal.reason ?? stopped(); };

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
    try { assertOpen(); signalCheck(signal); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), signals = [lifetime.signal, controller.signal, ...(signal ? [signal] : [])];
    const scope = { signal: AbortSignal.any(signals), deadline: Date.now() + readTimeoutMs };
    const timer = setTimeout(() => controller.abort(timeout()), readTimeoutMs); timer.unref?.();
    return tracked(() => context.run(scope, () => { signalCheck(scope.signal); return call(); }))
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
    if (scope) {
      signalCheck(scope.signal);
      const remaining = scope.deadline - Date.now();
      if (remaining <= 0) throw timeout();
      const requestSignal = options.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal;
      args = [...args]; args[index] = { ...options, signal: requestSignal,
        timeout: options.timeout > 0 ? Math.min(options.timeout, remaining) : remaining };
    }
    if (typeof base?.[method] !== 'function') throw new Error('Feishu SDK HTTP transport is unavailable');
    // Keep SDK body/header transformations and proxy options; never mutate its global instance.
    return tracked(() => { assertOpen(); if (scope) signalCheck(scope.signal); return base[method](...args); });
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

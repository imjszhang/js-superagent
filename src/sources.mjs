import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function validTrigger(value, source) {
  if (!value || value.source !== source || value.actor?.source !== source || typeof value.id !== 'string' || !value.id || typeof value.text !== 'string' ||
      typeof value.actor?.id !== 'string' || !value.actor.id || typeof value.human !== 'boolean' || !Array.isArray(value.threads) || !value.threads.length ||
      value.threads.some(thread => thread.source !== source || typeof thread.id !== 'string' || !thread.id) || !Number.isFinite(Date.parse(value.at))) throw new Error('Source returned an invalid domain trigger');
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Source trigger exceeded 1 MiB');
  return value;
}

/** Shared ingestion only. Model execution and outbound delivery have independent owners. */
export class SourceRegistry {
  #adapters = new Map(); #pending = new Map(); #closed = false; #stopping = false;
  constructor({ store, receive, leaseMs = 30_000, now = () => Date.now() }) {
    if (!store || typeof receive !== 'function') throw new Error('SourceRegistry requires store and receive');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error('Source lease must be at least 1000ms');
    this.store = store; this.receive = receive; this.leaseMs = leaseMs; this.now = now;
  }
  register(adapter) {
    identity(adapter?.id, 'source adapter id'); identity(adapter.source, 'source name');
    if (typeof adapter.poll !== 'function' || typeof adapter.normalize !== 'function') throw new Error('Source adapter requires poll and normalize');
    if (adapter.pollIntervalMs !== undefined && (!Number.isSafeInteger(adapter.pollIntervalMs) || adapter.pollIntervalMs < 1000)) throw new Error('Source pollIntervalMs must be at least 1000');
    if (this.#adapters.has(adapter.id)) throw new Error('Source adapter already registered');
    this.#adapters.set(adapter.id, adapter); return this;
  }
  unregister(id) {
    this.#adapter(id);
    const owner = this.store.getMeta(`source:${id}:owner`);
    if (this.#pending.has(id) || owner?.expires > this.now()) throw new Error('Stop source polling before changing its configuration');
    this.#adapters.delete(id); return this;
  }
  #adapter(id) { const adapter = this.#adapters.get(id); if (!adapter) throw new Error('Unknown source adapter'); return adapter; }
  state(id) { this.#adapter(id); return this.store.getMeta(`source:${id}:state`) ?? { cursor: null, lastAttempt: null, lastSuccess: null, error: null }; }
  status() { return [...this.#adapters.keys()].map(id => ({ id, ...this.state(id), active: this.#pending.has(id) })); }
  ingest(id, event) {
    if (this.#closed) throw new Error('Source registry is stopped');
    const adapter = this.#adapter(id), trigger = adapter.normalize(event);
    if (!trigger) return { status: 'ignored' };
    validTrigger(trigger, adapter.source);
    return this.store.atomic(() => this.#save(id, trigger));
  }
  #save(id, trigger) {
    const key = `source:${id}:event:${hash(trigger.id)}`;
    const previous = this.store.getMeta(key);
    if (previous) return { status: 'duplicate', triggerId: previous.triggerId };
    const result = this.receive(trigger);
    if (result && typeof result.then === 'function') throw new Error('Source receive must be synchronous and transactional');
    this.store.setMeta(key, { triggerId: trigger.id, receivedAt: new Date(this.now()).toISOString(), digest: hash(trigger) });
    return { status: 'received', triggerId: trigger.id };
  }
  poll(id) {
    if (this.#closed || this.#stopping) return Promise.reject(new Error('Source registry is stopped'));
    if (this.#pending.has(id)) return this.#pending.get(id).work;
    const adapter = this.#adapter(id), token = randomUUID(), lockKey = `source:${id}:owner`, stateKey = `source:${id}:state`;
    const acquired = this.store.atomic(() => {
      const lock = this.store.getMeta(lockKey);
      if (lock && lock.expires > this.now()) return false;
      this.store.setMeta(lockKey, { token, host: hostname(), pid: process.pid, expires: this.now() + this.leaseMs });
      const state = this.state(id); this.store.setMeta(stateKey, { ...state, lastAttempt: new Date(this.now()).toISOString(),
        ...(adapter.configurationKey ? { configurationKey: adapter.configurationKey } : {}) }); return true;
    });
    if (!acquired) return Promise.resolve({ busy: true, received: 0, duplicates: 0 });
    const controller = new AbortController();
    const owned = () => this.store.getMeta(lockKey)?.token === token;
    const timer = setInterval(() => {
      try { this.store.atomic(() => { if (owned()) this.store.setMeta(lockKey, { token, host: hostname(), pid: process.pid, expires: this.now() + this.leaseMs }); else controller.abort(); }); }
      catch { controller.abort(); }
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    const work = (async () => {
      try {
        const result = await adapter.poll({ cursor: this.state(id).cursor, signal: controller.signal });
        if (!result || !Array.isArray(result.events) || result.events.length > 10_000) throw new Error('Invalid source poll result');
        const triggers = result.events.map(event => adapter.normalize(event)).filter(Boolean).map(trigger => validTrigger(trigger, adapter.source));
        return this.store.atomic(() => {
          if (!owned() || controller.signal.aborted) throw new Error('Stale source poll result rejected');
          let received = 0, duplicates = 0;
          for (const trigger of triggers) { const value = this.#save(id, trigger); if (value.status === 'received') received++; else duplicates++; }
          const error = result.errors?.length ? result.errors.map(item => ({ scope: String(item.scope), error: String(item.error).slice(0, 1000),
            ...(item.object && ['issue', 'pull', 'comment', 'review_comment', 'check', 'status'].includes(item.object.kind) ? { object: structuredClone(item.object) } : {}),
            ...(typeof item.category === 'string' ? { category: item.category.slice(0, 64) } : {}),
            ...(item.repositoryFailure === true ? { repositoryFailure: true } : {}),
            ...(Number.isSafeInteger(item.statusCode) ? { statusCode: item.statusCode } : {}) })) : null;
          this.store.setMeta(stateKey, { ...this.state(id), cursor: result.cursor ?? null, lastSuccess: new Date(this.now()).toISOString(), error });
          return { busy: false, received, duplicates, error };
        });
      } catch (error) {
        this.store.atomic(() => { if (owned()) this.store.setMeta(stateKey, { ...this.state(id), error: String(error.message ?? error).slice(0, 1000) }); });
        throw error;
      } finally {
        clearInterval(timer);
        this.store.atomic(() => { if (owned()) this.store.deleteMeta(lockKey); });
        this.#pending.delete(id);
      }
    })();
    this.#pending.set(id, { work, controller });
    // Public callers share the promise, while close retains access to cancellation.
    return work;
  }
  async pollAll() { return Promise.allSettled([...this.#adapters.keys()].map(id => this.poll(id))); }
  async pollDue({ intervalMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('Source poll interval must be at least 1000ms');
    if (this.#closed || this.#stopping) return [];
    const due = [...this.#adapters.values()].filter(adapter => {
      if (this.#pending.has(adapter.id)) return false;
      const last = this.state(adapter.id).lastAttempt;
      return !last || this.now() - Date.parse(last) >= (adapter.pollIntervalMs ?? intervalMs);
    });
    return Promise.allSettled(due.map(adapter => this.poll(adapter.id)));
  }
  async deliver(message) {
    const matches = [...this.#adapters.values()].filter(adapter => adapter.source === message.channel.source && typeof adapter.deliver === 'function' &&
      (!message.channel.address?.sourceId || message.channel.address.sourceId === adapter.id));
    if (matches.length !== 1) throw new Error('No unique delivery adapter for source');
    const adapter = matches[0];
    return adapter.deliver(message);
  }
  async read(id, reference) {
    const adapter = this.#adapter(id);
    if (typeof adapter.readContext !== 'function') throw new Error('Source does not support context reads');
    return adapter.readContext(reference);
  }
  async stop() {
    this.#stopping = true;
    const active = [...this.#pending.values()]; active.forEach(entry => entry.controller.abort());
    try { await Promise.allSettled(active.map(entry => entry.work)); }
    finally { this.#stopping = false; }
  }
  async close() { this.#closed = true; await this.stop(); }
}

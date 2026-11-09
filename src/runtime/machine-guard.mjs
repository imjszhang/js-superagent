import { createMachineCoordinator } from '../machine-coordination.mjs';
import { inspectProjectIdentity, assertProjectIdentity, assertLegacyProjectRoot } from '../project-identity.mjs';
import { captureProcessIdentity } from '../machine-coordination.mjs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Internal injection for isolated tests and sibling lanes, not a user configuration escape hatch.
export const MACHINE_DEPENDENCIES = Symbol('machine coordination test dependencies');
export const MACHINE_GUARD = Symbol('shared project machine guard');

export class RuntimeMachineGuard {
  constructor({ projectRoot, projectId, dependencies, prepare, github, channel, guardians, retained }) {
    Object.assign(this, { projectRoot, projectId, prepare, github, channel, guardians, retained });
    this.now = dependencies?.now ?? Date.now;
    this.coordinator = createMachineCoordinator({ projectRoot, projectId }, dependencies);
    this.references = 0; this.holds = 0; this.slots = new Map(); this.yieldedSlots = new Map(); this.finishedSlots = new Set(); this.waiting = new Map();
  }
  writable() {
    this.coordinator.assertWritable();
    // Legacy state is adopted only after the existing stopped-owner migration checks.
    const identity = inspectProjectIdentity(this.projectRoot, this.projectId);
    if (identity?.identity || identity?.instanceId || identity?.exists) assertProjectIdentity(this.projectRoot, this.projectId);
    else assertLegacyProjectRoot(this.projectRoot, this.projectId);
  }
  acquire() {
    if (!this.lease) {
      this.prepare();
      this.coordinator.register({ adoptLegacy: true });
      this.lease = this.coordinator.acquireLease('runtime');
      this.timer = setInterval(() => {
        try { this.assert(); this.coordinator.heartbeat(this.lease, { guardians: this.guardians() }); this.reapSlots(); this.releaseIdle(); }
        catch (error) { this.failure = error; }
      }, 1000);
      this.timer.unref();
    }
    this.assert();
    this.references++;
    let released = false;
    return () => { if (released) return; released = true; this.references--; this.releaseIdle(); };
  }
  assert() {
    if (this.failure) throw this.failure;
    if (!this.lease) throw Object.assign(new Error('Project execution lease is required'), { code: 'PROJECT_LEASE_REQUIRED' });
    this.writable(); this.coordinator.assertLease(this.lease);
  }
  heartbeat() {
    this.assert();
    this.coordinator.heartbeat(this.lease, { guardians: this.guardians() });
  }
  claim() {
    this.assert();
    const github = this.github();
    return github ? this.coordinator.claimRepository({ repository: github.repository, host: 'github.com' }) : null;
  }
  isReady() {
    const github = this.github();
    return !github || this.verified === JSON.stringify(github) && this.now() < this.verifiedUntil;
  }
  async ready({ force = false } = {}) {
    this.claim();
    const github = this.github();
    if (!github) return;
    const key = JSON.stringify(github);
    if (!force && this.isReady()) return;
    if (this.verifying) { await this.verifying; if (this.verified === key) return; }
    const previouslyVerified = this.verified === key;
    this.verified = undefined; this.verifiedUntil = 0;
    this.verifying = (async () => {
      // Raw channel: probing must not recurse through the guarded channel facade.
      const channel = this.channel();
      let facts;
      if (!previouslyVerified && typeof channel?.probe === 'function') facts = await channel.probe();
      if (typeof channel?.repositoryIdentity === 'function') facts = await channel.repositoryIdentity();
      else if (previouslyVerified && typeof channel?.probe === 'function') facts = await channel.probe();
      this.assert();
      if (JSON.stringify(this.github()) !== key) throw new Error('GitHub configuration changed during identity verification');
      if (facts?.repository && facts.repository.toLowerCase() !== github.repository.toLowerCase()) throw new Error('GitHub repository identity changed');
      this.coordinator.claimRepository({ repository: github.repository, host: 'github.com', ...(facts?.repositoryId ? { repositoryId: facts.repositoryId } : {}) });
      this.verified = key; this.verifiedAt = this.now(); this.verifiedUntil = this.verifiedAt + 60_000;
      this.identityVerified = Number.isSafeInteger(facts?.repositoryId) && facts.repositoryId > 0;
    })();
    try { await this.verifying; }
    catch (error) { error.githubScope = 'repository'; throw error; }
    finally { this.verifying = undefined; }
  }
  async beforeGitHubWrite(repository = this.github()?.repository) {
    if (!repository || repository.toLowerCase() !== this.github()?.repository?.toLowerCase()) throw new Error('GitHub write target differs from the configured repository');
    await this.ready({ force: true });
    this.assert(); this.claim();
  }
  channelFacade(channel) {
    return new Proxy({}, { get: (_target, key) => {
      const value = Reflect.get(channel, key, channel);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        this.assert(); this.claim();
        if (key !== 'probe' && key !== 'repositoryIdentity') await this.ready();
        const hook = key === 'deliver' ? 'authorizeSend' : key === 'applyReviewAction' ? 'beforeWrite' : null;
        if (hook) {
          try { await this.beforeGitHubWrite(); }
          catch (error) { if (key === 'applyReviewAction') error.reviewWriteSent = false; throw error; }
          const options = args[1] ?? {}, original = options[hook];
          args[1] = { ...options, [hook]: async (...hookArgs) => {
            const result = await original?.(...hookArgs);
            await this.beforeGitHubWrite();
            this.assert(); return result;
          } };
        }
        return value.apply(channel, args);
      };
    } });
  }
  deliveryTransport(transport) {
    return { ...transport,
      push: async (...args) => { await this.beforeGitHubWrite(transport.repository); return transport.push(...args); },
      request: async (endpoint, options = {}) => {
        if (!['GET', 'HEAD'].includes(options.method ?? 'GET')) await this.beforeGitHubWrite(transport.repository);
        else await this.ready();
        return transport.request(endpoint, options);
      },
    };
  }
  async run(work) {
    const release = this.acquire();
    try { await this.ready(); return await work(); }
    finally { this.heartbeatIfOwned(); release(); }
  }
  sync(work, { github = false } = {}) {
    const release = this.acquire();
    try { if (github) this.claim(); return work(); }
    finally { this.heartbeatIfOwned(); release(); }
  }
  hold() { const release = this.acquire(); try { this.claim(); this.holds++; } finally { release(); } }
  unhold() { this.holds = Math.max(0, this.holds - 1); this.releaseIdle(); }
  heartbeatIfOwned() { if (this.lease) this.coordinator.heartbeat(this.lease, { guardians: this.guardians() }); }
  releaseIdle() {
    this.reapSlots();
    if (!this.lease || this.references || this.holds || this.retained() || this.slots.size || this.yieldedSlots.size || this.waiting.size) return;
    this.heartbeatIfOwned();
    try { this.coordinator.releaseLease(this.lease); }
    catch (error) { if (error.code !== 'PROJECT_GUARDIANS_ACTIVE') throw error; return; }
    this.lease = undefined; this.verified = undefined;
    clearInterval(this.timer); this.timer = undefined;
  }
  async takeSlot(key, kind, signal) {
    this.assert();
    this.waiting.set(key, { key, kind, since: new Date().toISOString() });
    try {
      for (;;) {
        signal?.throwIfAborted(); this.assert();
        const result = this.coordinator.acquireSlot({ key, kind });
        if (result.acquired) { this.yieldedSlots.delete(key); this.slots.set(key, result.slot); return result.slot; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } catch (error) { this.coordinator.cancelSlot(key); throw error; }
    finally { this.waiting.delete(key); }
  }
  releaseSlot(key) {
    const slot = this.slots.get(key) ?? this.yieldedSlots.get(key);
    if (!slot) return;
    try { this.coordinator.releaseSlot(slot); this.slots.delete(key); this.yieldedSlots.delete(key); this.finishedSlots.delete(key); }
    catch(error) { if(error.code !== 'PROJECT_GUARDIANS_ACTIVE')throw error;this.finishedSlots.add(key); }
  }
  reapSlots() { for(const key of this.finishedSlots)this.releaseSlot(key); }
  async slotChanged({ parent, held }, signal) {
    const key = parent.runId;
    if (!held) { const slot=this.slots.get(key); if(slot){this.coordinator.yieldSlot(slot);this.yieldedSlots.set(key,slot);this.slots.delete(key);} return; }
    if (!this.slots.has(key)) await this.takeSlot(key, parent.jobId ? 'child' : 'worker', signal);
  }
  assertWait({ record, releaseSlot }) {
    if (record.kind === 'agent' && releaseSlot === false && this.coordinator.status().limits.maxActiveExecutions !== null) {
      throw Object.assign(new Error('A limited machine budget requires handing off the parent slot while waiting for a child'), {code:'MACHINE_CHILD_CAPACITY'});
    }
  }
  async model(work, input, kind) {
    const key = input.runId ?? `${kind}-${randomUUID()}`;
    await this.takeSlot(key, kind, input.signal);
    const registerProcess = input.registerProcess;
    const guardians = [];
    try {
      await this.ready();
      return await work({ ...input, registerProcess: pid => {
        this.assert(); const result = registerProcess?.(pid);
        const owner = captureProcessIdentity(pid); if (owner !== null) guardians.push(owner ?? {pid,host:hostname(),unknown:true});
        const slot=this.slots.get(key);if(slot)this.coordinator.heartbeatSlot(slot,{guardians});
        this.heartbeat(); return result;
      } });
    } finally { this.heartbeatIfOwned(); this.releaseSlot(key); }
  }
  driver(driver, kind = 'worker') {
    const methods = new Set(['run','assess','handleEvent','inspectContinuation']), cache = new Map();
    // A facade also supports frozen adapters; proxying their non-configurable
    // method properties directly would violate JavaScript proxy invariants.
    return new Proxy({}, { ownKeys:()=>Reflect.ownKeys(driver), has:(_target,key)=>key in driver,
      getOwnPropertyDescriptor:(_target,key)=>{const descriptor=Object.getOwnPropertyDescriptor(driver,key);return descriptor?{enumerable:descriptor.enumerable,configurable:true}:undefined;},
      get: (_target,key) => {
      const value=Reflect.get(driver,key,driver);
      if(typeof value!=='function')return value;
      if(!cache.has(key))cache.set(key,methods.has(key) ? input=>this.model(arg=>value.call(driver,arg),input,kind) : value.bind(driver));
      return cache.get(key);
    } });
  }
  status() { return { ...this.coordinator.inspect(), waiting: [...this.waiting.values()], failure: this.failure?.message ?? null, githubIdentity: this.github() ? { verified: !!this.identityVerified && this.isReady(), checkedAt: this.verifiedAt ?? null, expiresAt: this.verifiedUntil ?? null } : null }; }
  close() {
    this.releaseIdle();
    if(this.lease)throw Object.assign(new Error('Runtime still owns managed execution; await stop and inspect remaining processes before closing'),{code:'PROJECT_GUARDIANS_ACTIVE'});
    this.coordinator.close();
  }
}

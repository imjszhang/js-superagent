import { inspectProcessOwner } from './machine-coordination.mjs';

export const SERVICE_HEARTBEAT_INTERVAL_MS = 5000;
export const SERVICE_HEARTBEAT_STALE_MS = 20000;
const RUN_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const SOURCE_STATES = new Set(['healthy', 'starting', 'disabled', 'stopped', 'stale', 'degraded']);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Only small diagnostic facts cross IPC. Never persist error text, tasks, tokens or model output. */
function businessSnapshot(value) {
  return {
    available: value?.available === true,
    paused: value?.paused === true,
    machineReady: value?.machineReady === true,
    active: value?.active === true,
    activeIncidents: count(value?.activeIncidents),
    modelWaits: count(value?.modelWaits),
    sources: Array.isArray(value?.sources) ? value.sources.slice(0, 100).filter(source => typeof source?.id === 'string' && source.id.length <= 200 && SOURCE_STATES.has(source.state))
      .map(source => ({ id: source.id, state: source.state, lastSuccess: date(source.lastSuccess) })) : [],
  };
}

/** CLI-only publisher; plain SDK, foreground CLI and imports open no timer or endpoint. */
export function startServiceHeartbeat(runtime, { host = process, intervalMs = SERVICE_HEARTBEAT_INTERVAL_MS, setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = {}) {
  const runId = host.env?.JS_SUPERAGENT_SERVICE_RUN_ID;
  if (!RUN_ID.test(runId ?? '') || typeof host.send !== 'function' || host.connected === false) return () => {};
  let sequence = 0, closed = false;
  const publish = () => {
    if (closed || host.connected === false) return;
    let business;
    try {
      const status = runtime.status(), health = runtime.businessHealth();
      business = businessSnapshot({ available: true, paused: status.paused, active: status.active, machineReady: status.machine?.ready,
        activeIncidents: health.incidents?.length, modelWaits: health.models?.length, sources: health.sources });
    } catch { business = businessSnapshot({ available: false }); }
    try { host.send({ type: 'js-superagent:heartbeat', runId, sequence: ++sequence, business }, () => {}); }
    catch { /* IPC closing is part of normal stop; it must not keep the runtime alive. */ }
  };
  publish();
  const timer = schedule(publish, intervalMs); timer.unref?.();
  return () => { if (closed) return; closed = true; cancel(timer); };
}

/** The wrapper supplies the receiving time and exact child identity, never the child message. */
export function acceptServiceHeartbeat(message, { runId, sequence = 0, now = Date.now(), pid, childPid }) {
  if (message?.type !== 'js-superagent:heartbeat' || !RUN_ID.test(runId ?? '') || message.runId !== runId ||
      !Number.isSafeInteger(message.sequence) || message.sequence <= sequence) return null;
  return { schemaVersion: 1, runId, sequence: message.sequence, pid, childPid, receivedAt: new Date(now).toISOString(), business: businessSnapshot(message.business) };
}

/** Read-only external diagnosis. A live PID or old ready receipt alone never proves health. */
export function evaluateServiceHealth({ status, runtime, heartbeat, now = Date.now(), ownerState = inspectProcessOwner, staleAfterMs = SERVICE_HEARTBEAT_STALE_MS }) {
  const result = { state: 'unobserved', healthy: false, observedAt: new Date(now).toISOString(), lastHeartbeatAt: null, heartbeatAgeMs: null,
    staleAfterMs, reason: null, process: { pid: status.pid ?? null, childPid: status.childPid ?? null, wrapperState: null, childState: null }, business: null };
  const finish = (state, reason) => ({ ...result, state, reason, healthy: state === 'healthy' });
  if (!status.installed) return finish('not-installed', 'service-not-installed');
  if (!status.running && status.startupState === 'blocked') return finish('setup-blocked', status.blocked?.code ?? 'service-configuration');
  if (!status.running && status.startupState === 'retrying') return finish('retrying', 'bounded-retry-scheduled');
  if (!status.running) return finish('stopped', 'service-is-not-running');
  if (runtime?.healthProtocol !== 1 || !RUN_ID.test(runtime.runId ?? '') || runtime.pid !== status.pid || runtime.childPid !== status.childPid) return finish('unobserved', 'runtime-heartbeat-identity-unavailable');
  if (runtime.owner?.pid !== status.pid || runtime.childOwner?.pid !== status.childPid) return finish('unobserved', 'process-start-identity-unavailable');
  result.process.wrapperState = ownerState(runtime.owner); result.process.childState = ownerState(runtime.childOwner);
  if (result.process.wrapperState === 'dead' || result.process.childState === 'dead') return finish('stalled', 'owned-process-exited');
  if (result.process.wrapperState !== 'alive' || result.process.childState !== 'alive') return finish('unobserved', 'process-start-identity-unverified');
  if (!heartbeat) {
    const started = Date.parse(runtime.startedAt);
    return Number.isFinite(started) && now >= started && now - started <= staleAfterMs ? finish('starting', 'awaiting-first-heartbeat') : finish('stalled', 'first-heartbeat-missing');
  }
  if (heartbeat.schemaVersion !== 1 || heartbeat.runId !== runtime.runId || heartbeat.pid !== status.pid || heartbeat.childPid !== status.childPid || !Number.isSafeInteger(heartbeat.sequence) || heartbeat.sequence < 1) return finish('unobserved', 'heartbeat-owner-mismatch');
  const received = Date.parse(heartbeat.receivedAt), started = Date.parse(runtime.startedAt);
  if (!Number.isFinite(received) || !Number.isFinite(started) || received < started || received > now + 1000) return finish('unobserved', 'heartbeat-time-invalid');
  result.lastHeartbeatAt = new Date(received).toISOString(); result.heartbeatAgeMs = Math.max(0, now - received);
  result.business = businessSnapshot(heartbeat.business);
  if (result.heartbeatAgeMs > staleAfterMs) return finish('stalled', 'runtime-heartbeat-expired');
  if (!status.ready) return finish('starting', 'awaiting-startup-ready');
  if (!result.business.available) return finish('degraded', 'business-snapshot-unavailable');
  if (!result.business.machineReady) return finish('degraded', 'runtime-preparation-unavailable');
  if (result.business.activeIncidents || result.business.modelWaits || result.business.sources.some(source => ['stale', 'degraded'].includes(source.state))) return finish('degraded', 'business-needs-attention');
  if (result.business.paused) return finish('paused', 'business-intentionally-paused');
  if (result.business.sources.some(source => source.state === 'starting')) return finish('starting', 'source-awaiting-first-success');
  return finish('healthy', null);
}

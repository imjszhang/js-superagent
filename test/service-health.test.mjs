import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeProjectConfig } from '../src/config.mjs';
import { createServiceManager } from '../src/service.mjs';
import { acceptServiceHeartbeat, evaluateServiceHealth, startServiceHeartbeat } from '../src/service-health.mjs';

const runId = 'f77c172b-b594-4138-a8f6-a6201fac31d3';
const now = 100000;
const status = { installed: true, running: true, ready: true, pid: 100, childPid: 101 };
const runtime = { healthProtocol: 1, runId, pid: 100, childPid: 101, owner: { pid: 100 }, childOwner: { pid: 101 }, startedAt: new Date(now - 1000).toISOString() };
const business = { available: true, observedAt: new Date(now).toISOString(), machineReady: true, paused: false, active: false, activeIncidents: 0, modelWaits: 0, sources: [{ id: 'github:explicit', state: 'healthy', lastSuccess: new Date(now).toISOString() }] };
const message = { type: 'js-superagent:heartbeat', runId, sequence: 1, business };
const heartbeat = acceptServiceHeartbeat(message, { runId, pid: 100, childPid: 101, now });
const health = patch => evaluateServiceHealth({ status, runtime, heartbeat, now, ownerState: () => 'alive', ...patch });

test('external health expires a heartbeat even while startup ready and both processes remain alive', () => {
  assert.equal(health().state, 'healthy');
  assert.equal(health({ now: now + 20001 }).state, 'stalled');
  assert.equal(health({ now: now + 20001 }).reason, 'runtime-heartbeat-expired');
  assert.equal(health({ heartbeat: null }).state, 'starting');
  assert.equal(health({ heartbeat: null, now: now + 20001 }).reason, 'first-heartbeat-missing');
  assert.equal(health({ status: { ...status, ready: false } }).state, 'starting');
});

test('process incarnation and run identity prevent stale receipts from proving current health', () => {
  assert.equal(health({ runtime: { ...runtime, healthProtocol: undefined } }).state, 'unobserved');
  assert.equal(health({ heartbeat: { ...heartbeat, runId: 'a-different-run' } }).reason, 'heartbeat-owner-mismatch');
  assert.equal(health({ runtime: { ...runtime, childOwner: { pid: 102 } } }).state, 'unobserved');
  assert.equal(health({ ownerState: () => 'unknown' }).state, 'unobserved');
  assert.equal(health({ ownerState: owner => owner.pid === 101 ? 'dead' : 'alive' }).state, 'stalled');
  assert.equal(health({ heartbeat: { ...heartbeat, receivedAt: new Date(now + 2000).toISOString() } }).state, 'unobserved');
});

test('a fresh heartbeat cannot turn missing or stale owner observations into healthy business', () => {
  const withObservedAt = observedAt => health({ heartbeat: { ...heartbeat, business: { ...business, observedAt } } });
  assert.equal(withObservedAt(null).reason, 'business-observation-pending');
  assert.equal(withObservedAt(new Date(now - 2000).toISOString()).reason, 'business-observation-pending');
  assert.equal(withObservedAt(new Date(now + 2000).toISOString()).reason, 'business-observation-stale');
  const stale = health({ now: now + 20001, heartbeat: { ...heartbeat, receivedAt: new Date(now + 20001).toISOString() } });
  assert.equal(stale.state, 'degraded'); assert.equal(stale.reason, 'business-observation-stale');
});

test('service diagnostics separate live connection and failed history without copying scope or error text', () => {
  const source = { id: 'feishu', state: 'degraded', lastSuccess: new Date(now).toISOString(), live: { state: 'ready', healthy: true },
    history: { state: 'degraded', healthy: false, issues: [{ code: 230027, scope: 'oc_PRIVATE', error: 'SECRET', container: { id: 'oc_PRIVATE' } }] } };
  const accepted = acceptServiceHeartbeat({ ...message, business: { ...business, sources: [source] } }, { runId, pid: 100, childPid: 101, now });
  const result = health({ heartbeat: accepted });
  assert.equal(result.state, 'degraded');
  assert.deepEqual(result.business.sources[0].live, { state: 'ready', healthy: true });
  assert.deepEqual(result.business.sources[0].history, { state: 'degraded', healthy: false, failedScopes: 1, codes: [230027] });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET/);
});

test('business pause, provider/source faults and stopped states remain distinct without a restart action', () => {
  const withBusiness = value => health({ heartbeat: { ...heartbeat, business: { ...business, ...value } } });
  assert.equal(withBusiness({ paused: true }).state, 'paused');
  assert.equal(withBusiness({ sources: [{ id: 'github:explicit', state: 'stale' }] }).state, 'degraded');
  assert.equal(withBusiness({ activeIncidents: 1 }).state, 'degraded');
  assert.equal(withBusiness({ machineReady: false }).reason, 'runtime-preparation-unavailable');
  assert.equal(withBusiness({ available: false }).reason, 'business-snapshot-unavailable');
  const stopped = { ...status, running: false, ready: false, startupState: 'stopped' };
  assert.equal(health({ status: stopped, ownerState: () => { throw new Error('must not probe stopped service'); } }).state, 'stopped');
  assert.equal(health({ status: { ...stopped, installed: false } }).state, 'not-installed');
  assert.equal(health({ status: { ...stopped, startupState: 'blocked', blocked: { code: 'SERVICE_CONFIGURATION' } } }).state, 'setup-blocked');
  assert.equal(health({ status: { ...stopped, startupState: 'retrying' } }).state, 'retrying');
});

test('wrapper only accepts fresh sequence from its run and persists a bounded diagnostic whitelist', () => {
  assert.equal(acceptServiceHeartbeat({ ...message, runId: 'other' }, { runId }), null);
  assert.equal(acceptServiceHeartbeat(message, { runId, sequence: 1 }), null);
  const accepted = acceptServiceHeartbeat({ ...message, token: 'SECRET', business: { ...business, error: 'SECRET', tasks: ['SECRET'], sources: [...business.sources, { id: 'x', state: 'bad', secret: 'SECRET' }] } }, { runId, pid: 100, childPid: 101, now });
  assert.equal(JSON.stringify(accepted).includes('SECRET'), false);
  assert.equal(accepted.business.sources.length, 1);
  assert.equal(accepted.receivedAt, new Date(now).toISOString());
});

test('CLI publisher reports actual runtime snapshots, disposes timer and is inert outside wrapper IPC', () => {
  let callback, cancelled = 0; const sent = [];
  const host = { env: { JS_SUPERAGENT_SERVICE_RUN_ID: runId }, connected: true, send: value => sent.push(value) };
  const execution = { status: () => ({ paused: true, active: false, machine: { ready: true }, lastError: 'SECRET' }), businessHealth: () => ({ at: business.observedAt, sources: business.sources, incidents: [], models: [] }) };
  const stop = startServiceHeartbeat(execution, { host, setInterval: fn => { callback = fn; return {}; }, clearInterval: () => { cancelled++; } });
  assert.equal(sent.length, 1); assert.equal(sent[0].business.paused, true); assert.equal(sent[0].business.observedAt, business.observedAt); assert.equal(JSON.stringify(sent).includes('SECRET'), false);
  callback(); assert.equal(sent[1].sequence, 2); stop(); stop(); callback(); assert.equal(sent.length, 2); assert.equal(cancelled, 1);
  startServiceHeartbeat(execution, { host: { env: {} }, setInterval: () => { throw new Error('must not schedule'); } })();
});

test('service manager health observes the actual wrapper heartbeat and does not start the service', { skip: process.platform !== 'darwin' }, t => {
  const base = mkdtempSync(join(tmpdir(), 'js-service-health-')), root = join(base, 'project'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home); t.after(() => rmSync(base, { recursive: true, force: true }));
  const codex = join(base, 'codex'), cliPath = join(base, 'healthy-cli.mjs'); writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  initializeProjectConfig(root, { execution: { driver: 'codex-app-server', executable: codex } });
  const helperUrl = new URL('../src/service-health.mjs', import.meta.url).href;
  writeFileSync(cliPath, `import {startServiceHeartbeat} from ${JSON.stringify(helperUrl)};const stop=startServiceHeartbeat({status:()=>({machine:{ready:true},paused:true}),businessHealth:()=>({at:new Date().toISOString(),sources:[],models:[],incidents:[]})});process.send({type:'js-superagent:ready'});setTimeout(()=>{stop();process.exit(0)},40);`);
  const calls = []; let loaded = null;
  const deps = { platform: 'darwin', uid: 501, coordinationDirectory: join(base, 'machine'), ownerState: () => 'alive', launchctl(args) { calls.push(args); if (args[0] === 'print') { if (!loaded) throw Object.assign(new Error('missing'), { stderr: 'Could not find service', status: 113 }); return `state = running\npid = ${loaded.pid}`; } return ''; } };
  const manager = createServiceManager({ projectRoot: root, homeDirectory: home, cliPath }, deps); manager.install();
  assert.equal(manager.health().state, 'stopped');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/service.mjs', import.meta.url)), 'run', root], { timeout: 5000, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const directory = join(stateDir(root), 'service'), recorded = JSON.parse(readFileSync(join(directory, 'runtime.json'))), pulse = JSON.parse(readFileSync(join(directory, 'heartbeat.json')));
  assert.equal(recorded.healthProtocol, 1); assert.equal(pulse.runId, recorded.runId); assert.equal(pulse.childPid, recorded.childPid); assert.equal(pulse.business.paused, true);
  loaded = recorded;
  writeFileSync(join(directory, 'startup.json'), JSON.stringify({ schemaVersion: 1, retryCount: 0, state: 'ready', pid: recorded.pid, childPid: recorded.childPid }));
  assert.equal(manager.health().state, 'paused');
  loaded = null; const before = calls.length;
  assert.equal(manager.health().state, 'stopped');
  assert.equal(calls.slice(before).some(args => ['enable','bootstrap','kickstart','bootout'].includes(args[0])), false);
});

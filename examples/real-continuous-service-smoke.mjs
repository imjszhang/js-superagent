// Opt-in real App polling + temporary launchd service. Never uses the production project/service.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
import { assertAppReceipt, finalizeAcceptance, readStoredTrigger } from './acceptance/github-evidence.mjs';
import { CONTINUOUS_POLL_MS, CONTINUOUS_INTAKE_MS, CONTINUOUS_EXTENSION_MS, assertContinuousObservation, assertServiceProcessOwnership, continuousDuplicateEvidence, assertContinuousDeduplication } from './acceptance/continuous-contract.mjs';
const { values, artifact } = parseAcceptanceArgs({ options: {
  write: { type: 'boolean' }, repository: { type: 'string' }, actor: { type: 'string' }, 'app-config': { type: 'string' },
  'observe-ms': { type: 'string', default: '1800000' }, 'min-successful-syncs': { type: 'string', default: '60' }, 'long-worker-ms': { type: 'string', default: '190000' },
  'codex-path': { type: 'string', default: 'codex' }, model: { type: 'string' },
} });
const observeMs = Number(values['observe-ms']), minSyncs = Number(values['min-successful-syncs']), longWorkerMs = Number(values['long-worker-ms']);
if (!values.write || !values['app-config'] || process.platform !== 'darwin' || !/^[a-z0-9-]+\/js-superagent-acceptance$/i.test(values.repository ?? '') || !/^[a-z0-9-]+$/i.test(values.actor ?? '')) throw new Error('Requires macOS, --write --repository owner/js-superagent-acceptance --actor --app-config and frozen-package flags');
if (!Number.isSafeInteger(observeMs) || observeMs < 1_800_000 || observeMs > 7_200_000 || !Number.isSafeInteger(minSyncs) || minSyncs < 60 || !Number.isSafeInteger(longWorkerMs) || longWorkerMs <= 180_000 || longWorkerMs > 300_000) throw new Error('Require observation 30–120 minutes, at least 60 successful syncs, and a real Worker held over 180 seconds (up to 300 seconds)');
const output = resolve(values.output), repository = values.repository.toLowerCase(), actor = values.actor.toLowerCase(), prefix = `repos/${repository}`, pollIntervalMs = CONTINUOUS_POLL_MS, intakeLimitMs = CONTINUOUS_INTAKE_MS;
if (existsSync(output)) throw new Error('Use a fresh evidence directory'); mkdirSync(output, { recursive: true, mode: 0o700 });
function run(file, args, cwd = output, input) { const result = spawnSync(file, args, { cwd, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }); if (result.error || result.status !== 0) throw new Error(`${file} failed (${result.status}): ${String(result.stderr).slice(-1500)}`); return result.stdout.trim(); }
async function api(method, path, body) {
  return new Promise((done, reject) => {
    const child = spawn('gh', ['api', '--hostname', 'github.com', '--method', method, path, ...(body === undefined ? [] : ['--input', '-'])], { cwd: output, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error; const timer = setTimeout(() => { error = new Error('Scoped GitHub request timed out'); child.kill('SIGKILL'); }, 60_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { error = new Error('Scoped GitHub response too large'); child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { if (stderr.length < 1500) stderr += chunk; }); child.on('error', value => { error = value; }); child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); if (error || code !== 0) return reject(error ?? new Error(`Scoped GitHub request failed (${code}): ${stderr}`)); try { done(JSON.parse(stdout)); } catch { reject(new Error('GitHub response was not JSON')); } });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const { createProjectAgent } = await importFrozenModule(artifact, 'src/index.mjs');
const { projectStateDirectory: stateDir } = await importFrozenModule(artifact, 'src/state-paths.mjs');
const { createGitHubAppRequest } = await importFrozenModule(artifact, 'src/channels/github-app.mjs');
const appFile = resolve(values['app-config']), configured = JSON.parse(readFileSync(appFile, 'utf8')).github;
assert.ok(configured?.app); const app = { ...configured.app, pullRequestComments: false }; // This harness only writes Issue conversation receipts.
if (app.privateKeyPath) app.privateKeyPath = resolve(join(appFile, '../..'), app.privateKeyPath);
const appRequest = createGitHubAppRequest({ repository, app }), appIdentity = await appRequest.identity(); await appRequest(`/repos/${repository}`);
assert.equal((await api('GET', 'user')).login.toLowerCase(), actor); assert.equal((await api('GET', prefix)).private, true);
const remoteMain = (await api('GET', `${prefix}/git/ref/heads/main`)).object.sha;
const project = join(output, 'plain-fixture'); mkdirSync(project);
const files = {
  'pricing.py': 'def total(price, quantity, discount=0):\n    return price + quantity * (1 - discount / 100)\n',
  'test_pricing.py': 'import unittest\nfrom pricing import total\nclass PricingTest(unittest.TestCase):\n    def test_basic(self): self.assertEqual(total(10, 3), 30)\n    def test_discount(self): self.assertEqual(total(20, 2, 25), 30)\nif __name__ == "__main__": unittest.main()\n',
  'slow_check.py': 'import os,time\nfrom pathlib import Path\nPath("worker.pid").write_text(str(os.getpid()))\nwhile not Path("release.flag").exists():\n Path("heartbeat.txt").write_text(str(time.time_ns()))\n time.sleep(0.1)\nprint("host released slow check")\n',
  'AGENTS.md': 'Isolated acceptance fixture: edit only pricing.py and test_pricing.py and explicitly requested result files inside this workspace. Run requested Python checks. Never change slow_check.py, release.flag, worker.pid, heartbeat.txt, .js-superagent, or files outside the workspace. No network, external messages, commits, pushes, or publishing. Only the trusted host releases the long-running check and communicates with GitHub.\n',
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
const git = (...args) => run('git', ['-C', project, ...args]); git('init', '-q'); git('config', 'user.name', 'js-superagent acceptance'); git('config', 'user.email', 'acceptance@example.invalid'); git('add', ...Object.keys(files)); git('commit', '-qm', 'isolated continuous-service fixture');
const originalHead = git('rev-parse', 'HEAD'), originalIndex = git('ls-files', '--stage'), cli = join(artifact.installed, 'bin/js-superagent.mjs');
const invoke = (...args) => JSON.parse(run(process.execPath, [cli, '--project', project, ...args])), service = action => invoke('service', action);
const tag = randomUUID(), command = `/js-superagent-continuous-${tag.slice(0, 8)}`, title = `[js-superagent continuous acceptance ${tag}]`, startedAt = new Date().toISOString();
const evidence = { schemaVersion: 1, status: 'running', phase: '18-continuous-service', startedAt, artifact: artifact.evidence.tarball, repository, authentication: { intake: 'github-app', receipt: appIdentity, commandActor: actor },
  observation: { requiredMs: observeMs, requiredSuccessfulSyncs: minSyncs, longWorkerMs, pollIntervalMs, intakeLimitMs, maximumMs: observeMs + CONTINUOUS_EXTENSION_MS }, successfulSyncs: [], errors: [], ingress: [], scenarios: [], checks: [], samples: [] };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
let observer, issue, workspace, ticketId, monitor, monitorError, serviceAttempted = false, observationStart, checksPassed = false, scenarioError, cleanupError;
const seenSyncs = new Set(), sourceComments = [];  let lastProgress = 0, lastSample = 0;
const log = text => console.log(`[continuous-service] ${text}`);
function sample() {
  if (!observer || !observationStart) return;
  const now = Date.now(), status = observer.githubStatus(), at = status.lastSync?.at;
  if (at && Date.parse(at) >= observationStart && !seenSyncs.has(at)) { seenSyncs.add(at); evidence.successfulSyncs.push({ at, observedAt: new Date(now).toISOString() }); }
  if (status.lastError && evidence.errors.at(-1)?.error !== status.lastError) evidence.errors.push({ at: new Date(now).toISOString(), error: status.lastError });
  if (now - lastSample >= 10_000) {
    lastSample = now; const pending = observer.notifications().filter(item => item.status === 'pending'), effects = observer.status().effects.filter(item => !item.cancelled);
    const domain = ticketId ? observer.getDomainTicket(ticketId) : null, queuedInputs = domain ? domain.inputs.filter(item => domain.undelivered.includes(item.id)) : [];
    const health = observer.businessHealth();
    evidence.samples.push({ at: new Date(now).toISOString(), paused: observer.isPaused(), ticketStatus: ticketId ? observer.get(ticketId).status : null,
      pendingReceipts: pending.length, pendingEffects: effects.length, oldestEffectOverdueMs: effects.length ? Math.max(0, ...effects.map(item => now - item.due)) : 0,
      queuedInputs: queuedInputs.length, oldestQueuedInputAgeMs: queuedInputs.length ? Math.max(0, ...queuedInputs.map(item => now - Date.parse(item.at))) : 0,
      sourceHealth: health.sources }); save();
  }
  if (now - lastProgress >= 30_000) { lastProgress = now; log(`${Math.floor((now - observationStart) / 1000)}s observed; ${seenSyncs.size} successful syncs; ${evidence.scenarios.length} scenarios verified`); }
}
async function until(predicate, label, timeout = 360_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (monitorError) throw monitorError; if (await predicate()) return; await delay(250); } throw new Error(`Timed out: ${label}`); }
async function hold(ms) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (monitorError) throw monitorError; await delay(Math.min(1000, deadline - Date.now())); } }
async function running(previousPid) { let value; await until(() => { value = service('status'); return value.running && value.pid > 1 && value.pid !== previousPid; }, 'isolated launchd process running', 60_000); return value; }
async function freshSyncs(since, label, minimum = 2) { await until(() => evidence.successfulSyncs.filter(item => Date.parse(item.at) > since).length >= minimum, label, intakeLimitMs); return evidence.successfulSyncs.filter(item => Date.parse(item.at) > since).length; }
function killOwnedService(state) {
  const manifest = JSON.parse(readFileSync(join(stateDir(project), 'service/manifest.json'), 'utf8'));
  const runtime = JSON.parse(readFileSync(join(stateDir(project), 'service/runtime.json'), 'utf8'));
  const ownership = assertServiceProcessOwnership({ manifest, project, installed: artifact.installed, status: state, runtime,
    wrapperCommand: run('ps', ['-ww', '-o', 'command=', '-p', String(state.pid)]),
    childCommand: run('ps', ['-ww', '-o', 'command=', '-p', String(state.childPid)]),
    childParentPid: Number(run('ps', ['-o', 'ppid=', '-p', String(state.childPid)])) });
  const current = service('status'); assert.equal(current.pid, state.pid); assert.equal(current.childPid, state.childPid); assert.equal(current.running, true);
  (evidence.ownedCrashTargets ??= []).push(ownership); save(); process.kill(state.pid, 'SIGKILL');
}
function alive(pid) { try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; } const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }); return result.status === 0 && !result.stdout.trim().startsWith('Z'); }
async function comment(name, text) { const marker = `[acceptance:${tag}:${name}]`, sentAt = Date.now(); const value = await api('POST', `${prefix}/issues/${issue.number}/comments`, { body: `${marker} ${text}` }); const item = { name, marker, id: value.id, url: value.html_url, sentAt }; sourceComments.push(item); return item; }
async function accepted(item, from = item.sentAt, allowance = intakeLimitMs) {
  await until(() => observer.get(ticketId).messages.some(message => message.text.includes(item.marker)), `${item.name} persisted`, allowance + 2000);
  const latencyMs = Date.now() - from; evidence.ingress.push({ ...item, latencyMs, measuredFrom: from, thresholdMs: allowance }); save(); assert.ok(latencyMs <= allowance, `Intake latency ${latencyMs}ms exceeded controlled threshold ${allowance}ms`);
}
async function completed(minReports) {
  await until(() => { const current = observer.get(ticketId); if (['failed', 'cancelled', 'interrupted'].includes(current.status)) throw new Error(`Unexpected Worker ${current.status}: ${current.reports.at(-1)?.summary}`); return current.status === 'completed' && current.reports.length >= minReports && observer.notifications().every(item => item.status !== 'pending'); }, 'real Worker completed');
  const actualReports = observer.get(ticketId).reports.length; (evidence.reportStages ??= []).push({ expected: minReports, actual: actualReports, runIds: observer.get(ticketId).reports.map(item => item.runId) }); save(); assert.equal(actualReports, minReports, 'Each explicitly requested stage must execute exactly its expected turns');
  assert.equal(run('python3', ['-m', 'unittest', '-v'], workspace.path).includes('FAILED'), false);
}
function sourceUnchanged() { for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(project, name), 'utf8'), content); assert.equal(git('rev-parse', 'HEAD'), originalHead); assert.equal(git('ls-files', '--stage'), originalIndex); }
save();
try {
  issue = await api('POST', `${prefix}/issues`, { title, body: `Dedicated bounded acceptance fixture ${tag}. Await a uniquely addressed command. Host owns all GitHub writes and will close this Issue; no remote code changes are authorized.` });
  assert.equal(issue.user.login.toLowerCase(), actor); evidence.issue = { number: issue.number, url: issue.html_url }; save();
  observer = createProjectAgent({ projectRoot: project }).init(); observer.upgradeRuntime();
  observer.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 600_000 }, github: { repository, app, allowedActors: [actor], issues: [issue.number], command, pollIntervalMs } });
  serviceAttempted = true; evidence.service = invoke('service', 'install', '--mode', 'poll');
  const installedManifest = JSON.parse(readFileSync(join(stateDir(project), 'service/manifest.json'), 'utf8'));
  assert.equal(installedManifest.cliPath, cli); assert.equal(installedManifest.modulePath, join(artifact.installed, 'src/service.mjs')); assert.equal(installedManifest.projectRoot, project);
  evidence.serviceOwnership = { label: installedManifest.label, cliPath: installedManifest.cliPath, modulePath: installedManifest.modulePath, projectRoot: installedManifest.projectRoot }; service('start'); const initial = await running(); evidence.initialPid = initial.pid;
  observationStart = Date.now(); evidence.observation.startedAt = new Date(observationStart).toISOString(); monitor = setInterval(() => { try { sample(); } catch (error) { monitorError = error; } }, 1000);
  const requestMarker = `[acceptance:${tag}:initial-command]`, requestAt = Date.now(), request = await api('POST', `${prefix}/issues/${issue.number}/comments`, { body: `${command} ${requestMarker} Fix pricing.total to compute price * quantity with percentage discount and run python3 -m unittest -v. Then run python3 slow_check.py and wait for the host to release it; do not create release.flag or change that script. This task includes subsequent pricing regression feedback and restart recovery checks. Do not access the network, commit, push or send messages.` });
  sourceComments.push({ name: 'initial-command', marker: requestMarker, id: request.id, url: request.html_url, sentAt: requestAt });
  await until(() => observer.list().length === 1, 'App accepted unique Issue command', intakeLimitMs + 2000); ticketId = observer.list()[0].id; evidence.ticketId = ticketId;
  const intakeMs = Date.now() - requestAt; assert.ok(intakeMs <= intakeLimitMs); evidence.ingress.push({ name: 'initial-command', id: request.id, url: request.html_url, latencyMs: intakeMs, thresholdMs: intakeLimitMs });
  await until(() => { workspace = observer.getWorkspace(ticketId); return workspace && existsSync(join(workspace.path, 'heartbeat.txt')); }, 'real long Worker heartbeat');
  const session = observer.getSession(ticketId), longStart = Date.now(), syncsBeforeLong = seenSyncs.size;
  evidence.workspace = workspace; evidence.session = session; const longPid = Number(readFileSync(join(workspace.path, 'worker.pid'), 'utf8')); assert.ok(alive(longPid));
  assert.match(run('ps', ['-o', 'command=', '-p', String(longPid)]), /python(?:3(?:\.\d+)?)? .*slow_check\.py/);
  const beforeFeedbackHeartbeat = readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8');
  const during = await comment('during-long-worker', 'Related pricing requirement: add named unittest test_fractional_discount asserting total(12.5, 2, 10) == 22.5, preserving behavior. Continue the host-controlled slow check.'); await accepted(during); assert.ok(alive(longPid)); const afterFeedbackHeartbeat = readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8'); assert.notEqual(afterFeedbackHeartbeat, beforeFeedbackHeartbeat);
  await hold(Math.max(0, longWorkerMs - (Date.now() - longStart))); assert.ok(alive(longPid)); assert.equal(observer.get(ticketId).status, 'running');
  assert.ok(seenSyncs.size - syncsBeforeLong >= 4, 'Ingress must continue while the real Worker runs over 180 seconds');
  evidence.scenarios.push({ name: 'long-worker-independent-ingress', durationMs: Date.now() - longStart, successfulSyncsDuring: seenSyncs.size - syncsBeforeLong, toolPid: longPid, heartbeatBeforeFeedback: beforeFeedbackHeartbeat, heartbeatAfterFeedback: afterFeedbackHeartbeat, heartbeatAtRelease: readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8') });
  assert.notEqual(evidence.scenarios.at(-1).heartbeatAtRelease, afterFeedbackHeartbeat);
  writeFileSync(join(workspace.path, 'release.flag'), 'Host releases the held check.\n'); await completed(2); assert.match(readFileSync(join(workspace.path, 'test_pricing.py'), 'utf8'), /def test_fractional_discount\(/);
  observer.pause('Acceptance business pause'); const beforePause = observer.get(ticketId).reports.length;
  const paused = await comment('business-paused', 'Related pricing requirement: add named unittest test_full_discount asserting total(10, 2, 100) == 0 and rerun tests.'); await accepted(paused); const pausedSyncs = await freshSyncs(Date.now(), 'two successful polls while business-paused'); assert.equal(observer.get(ticketId).reports.length, beforePause);
  const pausedBefore = service('status'); service('restart'); await running(pausedBefore.pid); assert.equal(observer.isPaused(), true); assert.equal(observer.get(ticketId).reports.length, beforePause);
  observer.resume(); await completed(beforePause + 1); evidence.scenarios.push({ name: 'business-pause-persists-ingress-and-restart', reportsHeld: beforePause, successfulSyncsWhilePaused: pausedSyncs });
  service('stop'); assert.equal(service('status').running, false); const beforeOffline = observer.get(ticketId).reports.length;
  const offline = await comment('while-stopped', 'Related pricing requirement: add named unittest test_zero_quantity asserting total(10, 0) == 0 and rerun tests.'); await hold(1000); assert.equal(observer.get(ticketId).messages.some(message => message.text.includes(offline.marker)), false);
  const restartAt = Date.now(); service('start'); await running(); await accepted(offline, restartAt); await completed(beforeOffline + 1); evidence.scenarios.push({ name: 'stopped-service-backfill', reportCount: observer.get(ticketId).reports.length });
  const beforeIdleCrash = service('status'), reportsBeforeIdleCrash = observer.get(ticketId).reports.length; const idleCrashAt = Date.now(); killOwnedService(beforeIdleCrash); const idleRecovered = await running(beforeIdleCrash.pid); await until(() => !alive(beforeIdleCrash.childPid), 'old owned idle service child exited', 60_000); const idleSyncs = await freshSyncs(idleCrashAt, 'two successful polls after idle crash');
  assert.equal(observer.get(ticketId).reports.length, reportsBeforeIdleCrash); evidence.scenarios.push({ name: 'idle-crash-no-replay', beforePid: beforeIdleCrash.pid, afterPid: idleRecovered.pid, successfulSyncsAfterCrash: idleSyncs });
  unlinkSync(join(workspace.path, 'release.flag')); const oldHeartbeat = readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8');
  const reportsBeforeActiveCrash = observer.get(ticketId).reports.length; const recovery = await comment('active-crash', 'Restart recovery requirement: run python3 slow_check.py again and wait for the host. Never create release.flag or alter the check, heartbeat or PID file. Only after it succeeds, write recovery.txt containing recovered and rerun python3 -m unittest -v.'); await accepted(recovery);
  await until(() => readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8') !== oldHeartbeat && observer.get(ticketId).status === 'running', 'new real child tool heartbeat');
  const toolPid = Number(readFileSync(join(workspace.path, 'worker.pid'), 'utf8')), busy = service('status'); assert.ok(alive(toolPid)); assert.match(run('ps', ['-o', 'command=', '-p', String(toolPid)]), /python(?:3(?:\.\d+)?)? .*slow_check\.py/);
  const activeCrashAt = Date.now(); killOwnedService(busy); const busyRecovered = await running(busy.pid); await until(() => observer.get(ticketId).status === 'interrupted' && !alive(toolPid) && !alive(busy.childPid), 'owned tool exited and ticket interrupted', 60_000);
  const stoppedHeartbeat = readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8'), interruptedReports = observer.get(ticketId).reports.length; (evidence.reportStages ??= []).push({ kind: 'expected-interruption', expected: reportsBeforeActiveCrash + 1, actual: interruptedReports }); save(); assert.equal(interruptedReports, reportsBeforeActiveCrash + 1); const activeSyncs = await freshSyncs(activeCrashAt, 'two successful polls while interrupted work remains stopped'); assert.equal(readFileSync(join(workspace.path, 'heartbeat.txt'), 'utf8'), stoppedHeartbeat); assert.equal(observer.get(ticketId).status, 'interrupted');
  writeFileSync(join(workspace.path, 'release.flag'), 'Host inspected the stopped tool and explicitly authorizes retry.\n'); invoke('retry', ticketId); await completed(interruptedReports + 1); assert.equal(readFileSync(join(workspace.path, 'recovery.txt'), 'utf8').trim(), 'recovered');
  assert.deepEqual(observer.getSession(ticketId), session); assert.equal(observer.getWorkspace(ticketId).path, workspace.path); const finalReports = observer.get(ticketId).reports.length; evidence.scenarios.push({ name: 'active-crash-owned-tool-stopped-explicit-retry', beforePid: busy.pid, afterPid: busyRecovered.pid, toolPid, childExited: true, retainedSession: true, successfulSyncsAfterCrash: activeSyncs }); save();
  log('Recovery scenarios passed; continuing the complete observation window.');
  while (Date.now() - observationStart < observeMs || seenSyncs.size < minSyncs) { if (Date.now() - observationStart > observeMs + CONTINUOUS_EXTENSION_MS) throw new Error('Successful sync quota not reached within observation extension'); await hold(1000); }
  sample(); evidence.observation.actualMs = Date.now() - observationStart; evidence.observation.successfulSyncs = seenSyncs.size;
  assert.ok(evidence.observation.actualMs >= observeMs); assert.ok(seenSyncs.size >= minSyncs); assert.equal(observer.list().length, 1); assert.equal(observer.get(ticketId).status, 'completed');
  assert.equal(observer.get(ticketId).reports.length, finalReports, 'No additional Worker report may appear during the idle observation window');
  assert.equal(observer.githubStatus().lastError, null); assert.ok(Date.now() - Date.parse(observer.githubStatus().lastSync.at) <= intakeLimitMs);
  evidence.incidents = observer.getIncidents({ includeResolved: true, limit: 100 });
  const comments = await api('GET', `${prefix}/issues/${issue.number}/comments?per_page=100`);
  evidence.receipts = observer.notifications().filter(value => value.channel.source === 'github').map(notification => assertAppReceipt({ notification, comments, projectId: observer.projectId, identity: appIdentity }));
  assert.ok(evidence.receipts.some(value => value.kind === 'reply')); assert.equal(observer.notifications().filter(value => value.status === 'pending').length, 0);
  const triggers = []; let cursor; do { const page = observer.readContext('triggers', { limit: 100, ...(cursor ? { cursor } : {}) }); for (const item of page.items) triggers.push(readStoredTrigger(observer, item.id)); cursor = page.nextCursor; } while (cursor);
  evidence.deduplication = continuousDuplicateEvidence({ repository, comments: sourceComments, triggers, domain: observer.getDomainTicket(ticketId), ticket: observer.get(ticketId), notifications: observer.notifications().filter(item => item.channel.source === 'github') }); save(); assertContinuousDeduplication(evidence.deduplication);
  evidence.effectiveDuplicateCount = evidence.deduplication.effectiveDuplicateCount;
  const longObservation = evidence.scenarios.find(item => item.name === 'long-worker-independent-ingress'); assertContinuousObservation({ pollIntervalMs, actualMs: evidence.observation.actualMs, successfulSyncs: seenSyncs.size, longWorkerMs: longObservation.durationMs, longWorkerSyncs: longObservation.successfulSyncsDuring }); assert.equal((await api('GET', `${prefix}/git/ref/heads/main`)).object.sha, remoteMain); sourceUnchanged();
  evidence.checks.push('>=30-minute wall-clock observation and >=60 distinct successful syncs', '>180-second real Worker with independently ingested feedback', 'controlled online feedback latency <= two poll cycles plus five seconds', 'persistent business pause and stopped-service backfill', 'idle and active process crash recovery without duplicate work', 'same ticket/session/workspace and explicit retry', 'App immutable identity receipts exactly once; no pending receipts', 'isolated source and remote main unchanged'); checksPassed = true;
} catch (error) { scenarioError = error; evidence.error = String(error.stack ?? error); save(); }
finally {
  clearInterval(monitor);
  cleanupError = await finalizeAcceptance({ evidence, checksPassed, save, cleanup: [
    { name: 'remove-owned-service', async run() { if (!serviceAttempted) return; const before = service('status'); if (before.installed) service('uninstall'); const after = service('status'); assert.equal(after.installed, false); assert.equal(after.running, false); evidence.temporaryServiceRemoved = true; } },
    { name: 'close-owned-issue', async run() { if (!issue) { const candidates = await api('GET', `${prefix}/issues?state=all&creator=${encodeURIComponent(actor)}&since=${encodeURIComponent(startedAt)}&per_page=100`); const matches = candidates.filter(value => value.title === title && value.body?.includes(tag) && value.user?.login?.toLowerCase() === actor); assert.ok(matches.length <= 1); issue = matches[0]; } if (issue) { const result = await api('PATCH', `${prefix}/issues/${issue.number}`, { state: 'closed' }); assert.equal(result.state, 'closed'); evidence.issue = { number: issue.number, url: issue.html_url }; evidence.issueClosed = true; } } },
    { name: 'close-local-observer', async run() { observer?.close(); } },
    { name: 'verify-source-boundaries', async run() { sourceUnchanged(); assert.equal((await api('GET', `${prefix}/git/ref/heads/main`)).object.sha, remoteMain); } },
  ] });
}
if (scenarioError) throw scenarioError;
if (cleanupError) throw cleanupError;
log(`Passed; ${evidence.observation.successfulSyncs} successful syncs over ${Math.round(evidence.observation.actualMs / 1000)} seconds.`);

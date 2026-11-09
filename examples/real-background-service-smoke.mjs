// Explicit opt-in: installs a temporary launchd job and calls the real Codex CLI.
// Default poll mode needs no public endpoint. Remote mode writes only a dedicated
// acceptance Issue/comments; --local-only never calls GitHub. Finally removes the
// job on normal/error completion; forced harness termination needs manual cleanup.
// Its fixture, package, logs, and evidence remain for inspection.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values, artifact } = parseArgs({ options: {
  output: { type: 'string' }, write: { type: 'boolean' }, 'local-only': { type: 'boolean' },
  mode: { type: 'string', default: 'poll' }, repository: { type: 'string' }, actor: { type: 'string' },
  'app-metadata': { type: 'string' }, 'app-id': { type: 'string' }, 'installation-id': { type: 'string' },
  'private-key-path': { type: 'string' }, 'gh-path': { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' },
} });
if (!values.write || !values.output || values.mode !== 'poll') throw new Error('Pass --write --output <new-directory> --mode poll and either --local-only or --repository <owner/repo> --actor <login> --app-metadata <file>. This installs a temporary login service, calls real Codex, and in remote mode creates one dedicated Issue. HTTPS/Webhook acceptance is separate.');
if (process.platform !== 'darwin') throw new Error('This acceptance harness requires a macOS login session with launchd.');
const localOnly = !!values['local-only'], output = resolve(values.output), packageRoot = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(output)) throw new Error('Use a new output directory to preserve earlier evidence');
const metadata = values['app-metadata'] ? JSON.parse(readFileSync(resolve(values['app-metadata']), 'utf8')) : {};
const repository = values.repository?.toLowerCase(), actor = values.actor?.toLowerCase();
const appId = String(values['app-id'] ?? metadata.id ?? metadata.appId ?? '');
const installationId = Number(values['installation-id'] ?? metadata.installationId);
const privateKeyPath = values['private-key-path'] ?? metadata.privateKeyPath;
if (!localOnly && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor ?? '') || !/^[1-9]\d*$/.test(appId) ||
    !Number.isSafeInteger(installationId) || installationId < 1 || !privateKeyPath || !existsSync(resolve(privateKeyPath)))) {
  throw new Error('Remote acceptance requires repository, actor, App ID, installation ID, and an existing private-key file reference');
}
const gh = values['gh-path'] ?? 'gh';
function run(executable, args, cwd = output, timeout = 120_000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`);
  return result.stdout;
}
function api(method, endpoint, body, paginate = false) {
  return new Promise((resolveResult, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
    if (paginate) args.push('--paginate', '--slurp');
    if (body !== undefined) args.push('--input', '-');
    const child = spawn(gh, args, { cwd: packageRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const timer = setTimeout(() => { failure = new Error('Acceptance GitHub request timed out'); child.kill('SIGKILL'); }, 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { failure = new Error('Acceptance response too large'); child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
    child.on('error', error => { failure = error; }); child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure ?? new Error(`Acceptance GitHub request failed (${code}): ${stderr}`)); return; }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('Acceptance GitHub response was not JSON')); }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
if (!localOnly) assert.equal((await api('GET', 'user')).login.toLowerCase(), actor);
mkdirSync(output, { recursive: true, mode: 0o700 });
const packed = artifact;
const consumer = join(output, 'consumer'); mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], consumer);
const installed = join(consumer, 'node_modules/js-superagent'), cli = join(installed, 'bin/js-superagent.mjs');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const appActor = localOnly ? null : await (await import(pathToFileURL(join(installed, 'src/channels/github-app.mjs'))))
  .createGitHubAppRequest({ repository, app: { appId, installationId, privateKeyPath: resolve(privateKeyPath) } }).identity();
const project = join(output, 'python-project'); mkdirSync(project);
const sourceFiles = {
  'pricing.py': 'def total(price, quantity, discount=0):\n    return price + quantity * (1 - discount / 100)\n',
  'test_pricing.py': 'import unittest\nfrom pricing import total\n\nclass PricingTest(unittest.TestCase):\n    def test_basic(self):\n        self.assertEqual(total(10, 3), 30)\n    def test_discount(self):\n        self.assertEqual(total(20, 2, 25), 30)\n    def test_zero(self):\n        self.assertEqual(total(10, 0), 0)\n\nif __name__ == "__main__":\n    unittest.main()\n',
  'slow_check.py': 'import os, time\nfrom pathlib import Path\nPath("worker.pid").write_text(str(os.getpid()))\nwhile not Path("release.flag").exists():\n    Path("heartbeat.txt").write_text(str(time.time_ns()))\n    time.sleep(0.1)\nprint("slow check passed")\n',
  'AGENTS.md': 'This is an isolated js-superagent background-service acceptance project. Work only inside the execution workspace. No network, GitHub commands, external messages, commits, merges, or writes outside this workspace. Do not modify .js-superagent. The host handles all GitHub communication. Run only the verification requested by the task and report actual results.\n',
};
for (const [name, text] of Object.entries(sourceFiles)) writeFileSync(join(project, name), text);
const git = (...args) => run('git', ['-C', project, ...args]).trim();
git('init', '-q'); git('config', 'user.name', 'js-superagent acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
git('add', ...Object.keys(sourceFiles)); git('commit', '-qm', 'isolated background-service acceptance baseline');
const sourceHead = git('rev-parse', 'HEAD'), sourceIndex = git('ls-files', '--stage');
function sourceUnchanged() {
  for (const [name, text] of Object.entries(sourceFiles)) assert.equal(readFileSync(join(project, name), 'utf8'), text);
  assert.equal(git('rev-parse', 'HEAD'), sourceHead); assert.equal(git('ls-files', '--stage'), sourceIndex);
}
function independentTests(path) {
  const result = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: path, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); return result.stderr;
}
const evidence = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  mode: 'poll', localOnly, publicWebhook: { tested: false, reason: 'Polling acceptance does not use or validate a public HTTPS endpoint.' },
  codex: run(values['codex-path'] ?? 'codex', ['--version']).trim(), package: packed.filename, sourceHead,
  status: 'running', checks: [], scenarios: [], ...(localOnly ? {} : { repository, appId, installationId, actor, appActor, periodicPollIntervalMs: 3000 }),
  implementationSha256: Object.fromEntries(['src/index.mjs', 'src/service.mjs', 'src/service-runner.mjs', 'src/drivers/codex-app-server.mjs', 'src/drivers/app-server-supervisor.mjs', 'bin/js-superagent.mjs']
    .filter(path => existsSync(join(installed, path))).map(path => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
};
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const log = text => console.log(`[real-background-service] ${text}`);
const invoke = (...args) => JSON.parse(run(process.execPath, [cli, '--project', project, ...args]));
let observer, serviceInstalled = false, issue;
const service = action => invoke('service', action);
async function until(predicate, label, timeoutMs = 360_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs; let nextProgress = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (Date.now() >= nextProgress) { log(`Still waiting: ${label}`); nextProgress = Date.now() + 30_000; }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; channel error: ${observer?.githubStatus().lastError ?? 'none'}`);
}
async function completed(id, count) {
  await until(() => {
    const ticket = observer.get(id);
    if (['failed', 'interrupted', 'cancelled'].includes(ticket.status)) throw new Error(`Unexpected ${ticket.status}: ${ticket.reports.at(-1)?.summary}`);
    return ticket.status === 'completed' && ticket.reports.length === count &&
      observer.notifications().every(receipt => receipt.status !== 'pending');
  }, `ticket ${id} completed turn ${count}`);
}
async function runningService(previousPid) {
  let state;
  await until(() => { state = service('status'); return state.running && Number.isSafeInteger(state.pid) && (!previousPid || state.pid !== previousPid); }, 'launchd running service', 60_000, 500);
  return state;
}
function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && !result.stdout.trim().startsWith('Z');
}
save();
try {
  if (!localOnly) {
    const runTag = randomUUID();
    issue = await api('POST', `repos/${repository}/issues`, {
      title: `[js-superagent background acceptance] persistent polling ${runTag.slice(0, 8)}`,
      body: `Dedicated background-service acceptance fixture ${runTag}. Awaiting an explicit task command in a new comment. No repository code changes, commits, merges, publishing, or edits outside the isolated local fixture are authorized.`,
    });
    assert.equal(issue.user.login.toLowerCase(), actor); assert.equal(issue.state, 'open');
    evidence.issueNumber = issue.number; evidence.issueUrl = issue.html_url; save();
  }
  observer = createProjectAgent({ projectRoot: project }).init();
  observer.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', timeoutMs: 300_000,
    ...(values['codex-path'] ? { executable: values['codex-path'].includes('/') ? resolve(values['codex-path']) : values['codex-path'] } : {}), ...(values.model ? { model: values.model } : {}) },
    ...(!localOnly ? { github: { repository, allowedActors: [actor], issues: [issue.number], pollIntervalMs: 3000,
      app: { appId, installationId, privateKeyPath: resolve(privateKeyPath) } } } : {}),
  });
  evidence.projectId = observer.projectId;
  evidence.install = invoke('service', 'install', '--mode', 'poll'); serviceInstalled = true;
  assert.equal(service('status').running, false, 'Install must not implicitly start the service');
  service('start'); const initialService = await runningService(); evidence.initialService = initialService;
  evidence.checks.push('packed-consumer-launchd-install-and-start'); save();
  const commentsPath = issue ? `repos/${repository}/issues/${issue.number}/comments` : undefined;
  const remoteComment = async body => {
    const comment = await api('POST', commentsPath, { body });
    return { id: comment.id, url: comment.html_url };
  };
  const command = 'Fix pricing.total to compute price * quantity with percentage discount. Run the three existing unit tests. For this first turn only fix the arithmetic; do not add input-validation policies or extra tests yet. This task includes later related pricing regression feedback. Keep changes in the isolated workspace. Do not access the network, commit, push, merge, publish, or change files outside the fixture.';
  let ticket;
  if (localOnly) ticket = invoke('submit', command);
  else {
    evidence.commandComment = await remoteComment(`/js-superagent ${command}`); save();
    await until(() => observer.list().length === 1, 'background App poll accepted the Issue command');
    ticket = observer.list()[0];
  }
  await completed(ticket.id, 1);
  const workspace = observer.getWorkspace(ticket.id), session = observer.getSession(ticket.id);
  assert.equal(workspace.mode, 'worktree'); assert.notEqual(workspace.path, project); assert.equal(session.driver, 'codex-app-server');
  evidence.ticketId = ticket.id; evidence.workspace = workspace; evidence.session = session;
  evidence.initialIndependentTests = independentTests(workspace.path); sourceUnchanged();
  evidence.checks.push(localOnly ? 'local-cli-background-intake' : 'real-app-poll-issue-intake', 'real-codex-modification-and-independent-tests'); save();
  log('Initial background turn passed; sending related feedback without restarting the service.');
  const feedback = 'Related acceptance feedback: add a named unittest test_fractional_discount asserting total(12.5, 2, 10) == 22.5. Preserve behavior and rerun python3 -m unittest -v in the existing workspace.';
  if (localOnly) invoke('reply', ticket.id, feedback);
  else evidence.feedbackComment = await remoteComment(feedback);
  await completed(ticket.id, 2);
  assert.match(readFileSync(join(workspace.path, 'test_pricing.py'), 'utf8'), /def test_fractional_discount\(/);
  evidence.continuousIndependentTests = independentTests(workspace.path);
  evidence.checks.push('continuous-follow-up-same-ticket'); save();

  log('Stopping the service, queuing new feedback, and checking automatic intake after start.');
  service('stop'); assert.equal(service('status').running, false);
  const offlineFeedback = 'Related acceptance feedback: add a named unittest test_full_discount asserting total(10, 2, 100) == 0. Preserve behavior and rerun python3 -m unittest -v in the existing workspace.';
  if (localOnly) invoke('reply', ticket.id, offlineFeedback);
  else evidence.offlineFeedbackComment = await remoteComment(offlineFeedback);
  await delay(1000); assert.equal(observer.get(ticket.id).reports.length, 2);
  service('start'); const restartedService = await runningService(initialService.pid);
  await completed(ticket.id, 3);
  assert.match(readFileSync(join(workspace.path, 'test_pricing.py'), 'utf8'), /def test_full_discount\(/);
  assert.deepEqual(observer.getSession(ticket.id), session); assert.equal(observer.getWorkspace(ticket.id).path, workspace.path);
  evidence.finalIndependentTests = independentTests(workspace.path); evidence.restartedService = restartedService;
  evidence.checks.push('new-feedback-while-stopped-consumed-after-start', 'session-workspace-and-ticket-survive-restart'); save();

  log('Killing the idle launchd job and checking automatic restart without duplicate work.');
  const idleBefore = service('status'); assert.ok(idleBefore.running && idleBefore.pid > 1);
  const idleCrashAt = Date.now();
  process.kill(idleBefore.pid, 'SIGKILL'); const idleAfter = await runningService(idleBefore.pid);
  if (!localOnly) await until(() => Date.parse(observer.githubStatus().lastSync?.at ?? '') > idleCrashAt,
    'successful automatic poll after crash', 120_000, 500);
  await delay(7000);
  assert.equal(observer.get(ticket.id).status, 'completed'); assert.equal(observer.get(ticket.id).reports.length, 3);
  evidence.scenarios.push({ name: 'idle-crash-auto-restart', beforePid: idleBefore.pid, afterPid: idleAfter.pid, reports: 3,
    ...(!localOnly ? { lastSync: observer.githubStatus().lastSync } : {}) });
  evidence.checks.push('launchd-auto-restart-after-sigkill', 'durable-poll-deduplication-after-crash'); save();

  log('Starting a real long-running tool, interrupting its owner, and requiring explicit retry.');
  const recovery = invoke('submit', 'Run python3 slow_check.py and wait for success. It waits for a release.flag controlled by the acceptance harness; never create or change that flag, slow_check.py, worker.pid, or heartbeat.txt yourself. Only after it succeeds, write recovery.txt containing recovered. Verify with python3 -c "from pathlib import Path; assert Path(\'recovery.txt\').read_text().strip() == \'recovered\'". If resumed, inspect existing files and rerun the check as necessary before completing. Do not run the unrelated pricing tests for this task.');
  let recoveryWorkspace;
  await until(() => {
    const current = observer.get(recovery.id);
    if (['completed', 'failed'].includes(current.status)) throw new Error(`Recovery worker exited before interruption checkpoint: ${current.status}`);
    recoveryWorkspace = observer.getWorkspace(recovery.id);
    return recoveryWorkspace && existsSync(join(recoveryWorkspace.path, 'heartbeat.txt'));
  }, 'real child-tool heartbeat');
  const toolPid = Number(readFileSync(join(recoveryWorkspace.path, 'worker.pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(toolPid) && toolPid > 1 && alive(toolPid));
  assert.equal(readFileSync(join(recoveryWorkspace.path, 'slow_check.py'), 'utf8'), sourceFiles['slow_check.py']);
  assert.match(run('ps', ['-o', 'command=', '-p', String(toolPid)]), /python(?:3(?:\.\d+)?)? .*slow_check\.py/);
  const recoverySession = observer.getSession(recovery.id), busyBefore = service('status');
  assert.equal(existsSync(join(recoveryWorkspace.path, 'recovery.txt')), false);
  process.kill(busyBefore.pid, 'SIGKILL'); const busyAfter = await runningService(busyBefore.pid);
  await until(() => observer.get(recovery.id).status === 'interrupted' && !alive(toolPid), 'interrupted ticket and stopped child tool', 60_000);
  const heartbeat = readFileSync(join(recoveryWorkspace.path, 'heartbeat.txt'), 'utf8');
  await delay(3000);
  assert.equal(readFileSync(join(recoveryWorkspace.path, 'heartbeat.txt'), 'utf8'), heartbeat);
  assert.equal(observer.get(recovery.id).status, 'interrupted');
  assert.equal(observer.get(recovery.id).reports.length, 1);
  assert.equal(existsSync(join(recoveryWorkspace.path, 'recovery.txt')), false);
  // Inspection above establishes the external tool has stopped. This is the only
  // explicit retry in the harness; the background service must never infer it.
  writeFileSync(join(recoveryWorkspace.path, 'release.flag'), 'Harness inspected the stopped tool and authorizes retry.\n');
  invoke('retry', recovery.id); await completed(recovery.id, 2);
  assert.deepEqual(observer.getSession(recovery.id), recoverySession);
  assert.equal(readFileSync(join(recoveryWorkspace.path, 'recovery.txt'), 'utf8').trim(), 'recovered');
  evidence.scenarios.push({ name: 'active-crash-explicit-retry', ticketId: recovery.id, beforePid: busyBefore.pid, afterPid: busyAfter.pid,
    toolPid, toolExited: true, heartbeatStopped: true, stoppedStatus: 'interrupted', session: recoverySession, reports: observer.get(recovery.id).reports });
  evidence.checks.push('active-worker-crash-stops-tool-tree', 'interrupted-work-needs-explicit-retry', 'explicit-retry-resumes-native-session');

  if (!localOnly) {
    const comments = (await api('GET', `${commentsPath}?per_page=100`, undefined, true)).flat();
    evidence.receipts = observer.notifications().filter(item => item.channel.source === 'github').map(receipt => {
      assert.equal(receipt.status, 'sent');
      const marker = `<!-- js-superagent:${observer.projectId}:${receipt.id} -->`;
      const matching = comments.filter(comment => comment.body.includes(marker)); assert.equal(matching.length, 1);
      assert.equal(matching[0].user.type, 'Bot'); assert.equal(receipt.delivery.url, matching[0].html_url);
      assert.equal(matching[0].user.login.toLowerCase(), appActor.login); assert.equal(String(matching[0].user.id), appActor.id);
      if (matching[0].performed_via_github_app != null) assert.equal(String(matching[0].performed_via_github_app.id), appId);
      return { id: receipt.id, kind: receipt.kind, status: receipt.status, commentId: matching[0].id, url: matching[0].html_url,
        actor: matching[0].user.login, actorId: matching[0].user.id, reportedAppId: matching[0].performed_via_github_app?.id ?? null };
    });
    assert.equal(evidence.receipts.length, 4);
    evidence.checks.push('registered-app-receipts-exactly-once');
  }
  sourceUnchanged(); assert.equal(observer.list().length, 2);
  evidence.reports = observer.get(ticket.id).reports;
  evidence.workspaceReview = observer.inspectWorkspace(ticket.id);
  evidence.checks.push('source-files-head-index-unchanged');
  evidence.status = 'passed'; log('Real polling/background/restart/retry acceptance passed. HTTPS was not exercised.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
} finally {
  const cleanupErrors = [];
  try {
    if (serviceInstalled) {
      evidence.finalService = service('status');
      service('uninstall');
      const removed = service('status'); assert.equal(removed.installed, false); assert.equal(removed.running, false);
      evidence.cleanup = { temporaryServiceRemoved: true };
    }
  } catch (error) { cleanupErrors.push(String(error.message ?? error)); }
  try {
    if (issue) {
      await api('PATCH', `repos/${repository}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      evidence.cleanup = { ...evidence.cleanup, dedicatedIssueClosed: true };
    }
  } catch (error) { cleanupErrors.push(String(error.message ?? error)); }
  try { observer?.close(); } catch (error) { cleanupErrors.push(String(error.message ?? error)); }
  if (cleanupErrors.length) { evidence.cleanupErrors = cleanupErrors; evidence.status = 'failed'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${join(output, 'acceptance.json')}`);
}

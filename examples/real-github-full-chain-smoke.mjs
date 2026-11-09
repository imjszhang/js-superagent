// Frozen installed runtime + real App intake/receipts + owned native-gh delivery + actual GitHub Actions.
// Only the caller's explicitly named acceptance repository and this run's Issue/PR are mutated.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
import { assertActionsEvidence, readStoredTrigger, assertPullFailureInTicket, assertAppReceipt, assertOwnedDraftPull, finalizeAcceptance } from './acceptance/github-evidence.mjs';
const { values, artifact } = parseAcceptanceArgs({ options: { write: { type: 'boolean' }, close: { type: 'boolean' }, repository: { type: 'string' }, actor: { type: 'string' }, source: { type: 'string' }, 'app-config': { type: 'string' }, 'app-pr-comments': { type: 'boolean' }, 'codex-path': { type: 'string', default: 'codex' }, model: { type: 'string' } } });
if (!values.write || !values.source || !values['app-config'] || !/^[a-z0-9-]+\/js-superagent-acceptance$/i.test(values.repository ?? '') || !/^[a-z0-9-]+$/i.test(values.actor ?? '')) throw new Error('Requires --write --source --repository owner/js-superagent-acceptance --actor --app-config plus the frozen package flags');
const output = resolve(values.output), repository = values.repository.toLowerCase(), actor = values.actor.toLowerCase(), source = resolve(values.source), prefix = `repos/${repository}`;
if (existsSync(output)) throw new Error('Use a fresh output directory'); mkdirSync(output, { recursive: true, mode: 0o700 });
function run(executable, args, cwd = output, input) { const r = spawnSync(executable, args, { cwd, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }); if (r.error || r.status !== 0) throw new Error(`${executable} failed (${r.status}): ${String(r.stderr).slice(-1000)}`); return r.stdout.trim(); }
function api(method, endpoint, body) { return JSON.parse(run('gh', ['api', '--method', method, endpoint, ...(body === undefined ? [] : ['--input', '-'])], output, body === undefined ? undefined : JSON.stringify(body))); }
const { createProjectAgent } = await importFrozenModule(artifact, 'src/index.mjs');
const { createGitHubAppRequest } = await importFrozenModule(artifact, 'src/channels/github-app.mjs');
const appFile = resolve(values['app-config']), configured = JSON.parse(readFileSync(appFile, 'utf8')).github;
assert.ok(configured?.app); const app = { ...configured.app, ...(values['app-pr-comments'] ? { pullRequestComments: true } : {}) };
if (app.privateKeyPath) app.privateKeyPath = resolve(join(appFile, '../..'), app.privateKeyPath);
assert.equal(api('GET', 'user').login.toLowerCase(), actor);
assert.equal(app.pullRequestComments, true, 'Full-chain App receipt acceptance requires explicit --app-pr-comments or matching App configuration');
const appRequest = createGitHubAppRequest({ repository, app });
const identity = await appRequest.identity();
await appRequest(`/repos/${repository}`); // Fail before external mutations if this App installation is unavailable; never switch identity.
assert.equal(api('GET', prefix).private, true, 'Full-chain fixture must be a private acceptance repository');
const baseline = api('GET', `${prefix}/git/ref/heads/main`).object.sha;
assert.equal(run('git', ['-C', source, 'rev-parse', 'HEAD']), baseline, 'The acceptance source must match the dedicated repository main');
const project = join(output, 'project'); run('git', ['clone', '--shared', source, project]); run('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`]);
const tag = randomUUID().slice(0, 8), command = `/js-superagent-chain-${tag}`, target = 'packages/js-superagent/examples/acceptance-target/diagnostic.mjs';
const evidence = { schemaVersion: 1, phase: '13-or-18-real-github-full-chain', status: 'running', startedAt: new Date().toISOString(), artifact: artifact.evidence.tarball,
  repository, baseline, authentication: { intake: 'github-app', receipt: identity.login, delivery: 'native-gh', deliveryActor: actor }, fixture: true, fixturePath: target, checks: [], actions: [], notifications: [] };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const log = text => console.log(`[full-chain] ${text}`);
async function actions(sha, expected) {
  const until = Date.now() + 600_000;
  while (Date.now() < until) {
    const checks = api('GET', `${prefix}/commits/${sha}/check-runs?filter=latest`).check_runs;
    const check = checks.filter(x => x.head_sha === sha && x.name === 'diagnostic-contract' && x.app?.slug === 'github-actions').sort((a,b) => b.id-a.id)[0];
    if (check?.status === 'completed') {
      const runs = api('GET', `${prefix}/actions/runs?head_sha=${sha}`).workflow_runs;
      if (!runs.some(run => run.check_suite_id === check.check_suite?.id && run.status === 'completed')) { await delay(5000); continue; }
      const result = assertActionsEvidence({ repository, headSha: sha, conclusion: expected, check, runs });
      evidence.actions.push(result); save(); return result;
    }
    await delay(5000);
  }
  throw new Error('Timed out waiting for an actual GitHub Actions check');
}
let runtime, scenarioError, cleanupError, checksPassed = false;
save();
try {
  const issue = api('POST', `${prefix}/issues`, { title: `[js-superagent frozen acceptance ${tag}] Diagnostic fixture`, body: `${command} This is an explicitly staged acceptance fixture. Update only ${target}: formatDiagnostic(input) must return an object whose text field trims whitespace from String(input). Preserve the exact case. Do not add other fields yet; a follow-up review will extend the diagnostic object. Do not modify scripts, workflow or AGENTS.md. Do not commit, push, open PRs or send messages. The host verifies with node scripts/host-verify.mjs and owns delivery. The later Actions/review requirements remain within this task.` });
  evidence.issue = { number: issue.number, url: issue.html_url }; save();
  runtime = createProjectAgent({ projectRoot: project }).init();
  runtime.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 300_000 }, github: { repository, app, command, allowedActors: [actor], issues: [issue.number], pollIntervalMs: 1000, ci: { checkApps: ['github-actions'] } } });
  runtime.configureDelivery({ mode: 'draft-pr', automatic: true, credentialMode: 'native-gh', repository, base: 'main', allowedPaths: [target], verify: { id: 'fixture-contract', version: '1', command: 'node', args: ['scripts/host-verify.mjs'], paths: [target], environment: 'host', allowHostExecution: true, timeoutMs: 60_000 } }, { expectedRevision: 0 });
  await runtime.syncGitHub(); assert.equal(runtime.list().length, 1);
  const ticketId = runtime.list()[0].id; evidence.ticketId = ticketId;
  log('Running first real Worker and owned draft-PR delivery.');
  const first = await runtime.runNext(), firstDetail = runtime.getDetailed(ticketId); save();
  if(firstDetail.delivery?.pullRequest)evidence.pull={number:firstDetail.delivery.pullRequest.number,url:firstDetail.delivery.pullRequest.url};
  evidence.first = { runId: first?.runId, status: first?.status, verification: firstDetail.verification?.status, delivery: firstDetail.delivery?.state }; save();
  assert.equal(first?.status, 'completed'); assert.equal(firstDetail.verification?.status, 'passed'); assert.equal(firstDetail.delivery?.state, 'delivered');
  const pull = firstDetail.delivery.pullRequest, session = runtime.getSession(ticketId), workspace = runtime.getWorkspace(ticketId), firstHead = firstDetail.delivery.commitSha;
  evidence.pull = { number: pull.number, url: pull.url }; evidence.firstHead = firstHead; evidence.session = session; evidence.workspace = { mode: workspace.mode, provisionId: workspace.provisionId, branch: workspace.branch, baseCommit: workspace.baseCommit }; save();
  assertOwnedDraftPull({ pull: api('GET', `${prefix}/pulls/${pull.number}`), repository, actor, headSha: firstHead });
  const failedAction = await actions(firstHead, 'failure');
  const review = api('POST', `${prefix}/pulls/${pull.number}/reviews`, { event: 'COMMENT', commit_id: firstHead, body: `Within this diagnostic fixture task, now add level: 'info' to the returned object while keeping trimmed text. Change only ${target}. The actual GitHub Actions diagnostic-contract failed because this field is missing; fix and verify the host contract.` });
  evidence.review = { id: review.id, url: review.html_url }; save();
  await delay(1200); await runtime.syncGitHub();
  assert.equal(runtime.list().length, 1);
  const failedTriggerId = `github:${repository}:check_run:${failedAction.checkId}:${firstHead}:completed:failure:pr:${pull.number}`;
  evidence.ciInput = assertPullFailureInTicket({ repository, pullNumber: pull.number, ticketId, action: failedAction,
    domain: runtime.getDomainTicket(ticketId), binding: runtime.githubStatus().trackedPullRequests.find(item => item.number === pull.number),
    trigger: readStoredTrigger(runtime, failedTriggerId) }); save();
  log('Running same-session CI and review repair.');
  const second = await runtime.runNext(), detail = runtime.getDetailed(ticketId);
  assert.equal(second?.id, ticketId); assert.equal(second?.status, 'completed'); assert.equal(detail.delivery?.state, 'delivered'); assert.equal(detail.delivery.pullRequest.number, pull.number);
  assert.notEqual(detail.delivery.commitSha, firstHead); assert.deepEqual(runtime.getSession(ticketId), session); assert.equal(runtime.getWorkspace(ticketId).path, workspace.path);
  assertOwnedDraftPull({ pull: api('GET', `${prefix}/pulls/${pull.number}`), repository, actor, headSha: detail.delivery.commitSha });
  evidence.second = { runId: second.runId, headSha: detail.delivery.commitSha, verification: detail.verification?.status, delivery: detail.delivery.state }; save();
  await actions(detail.delivery.commitSha, 'success');
  await delay(1200); await runtime.syncGitHub(); await runtime.flushNotifications();
  for (const notification of runtime.notifications().filter(x => x.channel.source === 'github')) {
    const address = notification.channel.address, number = Number(address.pullNumber ?? address.issueNumber), comments = api('GET', `${prefix}/issues/${number}/comments?per_page=100`);
    const receipt = assertAppReceipt({ notification, comments, projectId: runtime.projectId, identity });
    evidence.notifications.push({ ...receipt, number }); save();
  }
  assert.ok(evidence.notifications.some(x => x.number === issue.number && x.kind === 'reply')); assert.ok(evidence.notifications.some(x => x.number === pull.number && x.kind === 'reply'));
  assert.equal(api('GET', `${prefix}/git/ref/heads/main`).object.sha, baseline); assert.equal(api('GET', `${prefix}/pulls/${pull.number}`).merged, false);
  evidence.checks.push('frozen package App intake and Issue/PR bot receipts', 'real Worker fixture edit and owned native-gh draft PR', 'actual failing then passing GitHub Actions', 'same ticket/session/workspace repaired review and CI', 'no main change, no merge, no duplicate receipts');
  if (values.close) { api('PATCH', `${prefix}/pulls/${pull.number}`, { state: 'closed' }); await delay(1200); await runtime.syncGitHub(); assert.ok(runtime.getDomainTicket(ticketId).ended); api('PATCH', `${prefix}/issues/${issue.number}`, { state: 'closed' }); evidence.closed = true; }
  const count = runtime.get(ticketId).reports.length; runtime.close(); runtime = undefined; runtime = createProjectAgent({ projectRoot: project }).init(); await runtime.syncGitHub(); assert.equal(runtime.list().length,1); assert.equal(runtime.get(ticketId).reports.length,count);
  checksPassed = true;
} catch(error) {
  scenarioError = error; evidence.error = String(error.message ?? error); save();
} finally {
  cleanupError = await finalizeAcceptance({ evidence, checksPassed, save, cleanup: [
    { name: 'stop-local-runtime', async run() { if (runtime) { await runtime.stop(); runtime.close(); runtime = undefined; } } },
    { name: 'close-owned-pull', async run() { if (!values.close || !evidence.pull) return; const result = api('PATCH', `${prefix}/pulls/${evidence.pull.number}`, { state: 'closed' }); assert.equal(result.state, 'closed'); assert.equal(result.merged, false); evidence.pullClosed = true; } },
    { name: 'close-owned-issue', async run() { if (!values.close || !evidence.issue) return; const result = api('PATCH', `${prefix}/issues/${evidence.issue.number}`, { state: 'closed' }); assert.equal(result.state, 'closed'); evidence.issueClosed = true; } },
    { name: 'verify-cleanup-state', async run() { assert.equal(api('GET', `${prefix}/git/ref/heads/main`).object.sha, baseline); if (values.close) evidence.closed = (!evidence.pull || evidence.pullClosed === true) && (!evidence.issue || evidence.issueClosed === true); if (values.close) assert.equal(evidence.closed, true); } },
  ] });
}
if (scenarioError) throw scenarioError;
if (cleanupError) throw cleanupError;
log('Passed.');

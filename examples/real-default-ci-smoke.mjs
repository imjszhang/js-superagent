// Explicitly authorized failure injection only in the private owner/js-superagent-acceptance fixture.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
import { assertActionsEvidence, readStoredTrigger, assertDefaultFailureInTicket, assertOwnedDraftPull, finalizeAcceptance, updateOwnedMain } from './acceptance/github-evidence.mjs';
const { values, artifact } = parseAcceptanceArgs({ options: { write: { type: 'boolean' }, repository: { type: 'string' }, source: { type: 'string' }, actor: { type: 'string' }, 'app-config': { type: 'string' }, 'app-pr-comments': { type: 'boolean' }, 'native-gh': { type: 'boolean' }, 'codex-path': { type: 'string', default: 'codex' }, model: { type: 'string' } } });
if (!values.write || !values.source || (!values['app-config'] && !values['native-gh']) || !/^[a-z0-9-]+\/js-superagent-acceptance$/i.test(values.repository ?? '') || !/^[a-z0-9-]+$/i.test(values.actor ?? '')) throw new Error('Requires --write --source --repository owner/js-superagent-acceptance --actor, exactly one of --app-config/--native-gh, and frozen-package flags');
if (values['native-gh'] && values['app-config']) throw new Error('Select exactly one explicit intake identity: --native-gh or --app-config');
const output = resolve(values.output), source = resolve(values.source), repository = values.repository.toLowerCase(), actor = values.actor.toLowerCase(), prefix = `repos/${repository}`, target = 'packages/js-superagent/examples/acceptance-target/diagnostic.mjs';
if (existsSync(output)) throw new Error('Use a fresh evidence directory'); mkdirSync(output, { recursive: true, mode: 0o700 });
function run(file, args, cwd = output, input) { const result = spawnSync(file, args, { cwd, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }); if (result.error || result.status !== 0) throw new Error(`${file} failed (${result.status}): ${String(result.stderr).slice(-1000)}`); return result.stdout.trim(); }
function api(method, path, body) { return JSON.parse(run('gh', ['api', '--method', method, path, ...(body === undefined ? [] : ['--input', '-'])], output, body === undefined ? undefined : JSON.stringify(body))); }
const { createProjectAgent } = await importFrozenModule(artifact, 'src/index.mjs');
let app, appIdentity;
if (values['app-config']) {
  const appFile = resolve(values['app-config']), configured = JSON.parse(readFileSync(appFile, 'utf8')).github; assert.ok(configured?.app);
  app = { ...configured.app, ...(values['app-pr-comments'] ? { pullRequestComments: true } : {}) };
  if (app.privateKeyPath) app.privateKeyPath = resolve(join(appFile, '../..'), app.privateKeyPath);
  const { createGitHubAppRequest } = await importFrozenModule(artifact, 'src/channels/github-app.mjs');
  const request = createGitHubAppRequest({ repository, app, ci: { checkApps: ['github-actions'] } });
  appIdentity = await request.identity(); await request(`/repos/${repository}`); // No fallback to native-gh on failure.
}
assert.equal(api('GET', 'user').login.toLowerCase(), actor); assert.equal(api('GET', prefix).private, true);
const baseline = api('GET', `${prefix}/git/ref/heads/main`).object.sha; assert.equal(run('git', ['-C', source, 'rev-parse', 'HEAD']), baseline);
const baselineTree = api('GET', `${prefix}/git/commits/${baseline}`).tree.sha;
const original = Buffer.from(api('GET', `${prefix}/contents/${target}?ref=${baseline}`).content, 'base64').toString('utf8');
const project = join(output, 'project'); run('git', ['clone', '--shared', source, project]); run('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`]);
const evidence = { schemaVersion: 1, phase: '13-or-18-real-default-branch-ci', status: 'running', startedAt: new Date().toISOString(), artifact: artifact.evidence.tarball,
  authentication: { intake: app ? 'github-app' : 'native-gh', appIdentity: appIdentity ?? null, delivery: 'native-gh', deliveryActor: actor }, repository, baseline, fixture: true, fixturePath: target,
  checks: [], actions: [], injectionIntent: { path: target }, restoreIntent: { path: target } };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
async function check(sha, expected) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const item = api('GET', `${prefix}/commits/${sha}/check-runs?filter=latest`).check_runs.filter(value => value.head_sha === sha && value.name === 'diagnostic-contract' && value.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0];
    if (item?.status === 'completed') {
      const runs = api('GET', `${prefix}/actions/runs?head_sha=${sha}`).workflow_runs;
      if (runs.some(value => value.check_suite_id === item.check_suite?.id && value.status === 'completed')) {
        const result = assertActionsEvidence({ repository, headSha: sha, conclusion: expected, check: item, runs }); evidence.actions.push(result); save(); return result;
      }
    }
    await delay(5000);
  }
  throw new Error('Timed out waiting for real Actions');
}
let runtime, restored = false, scenarioError, cleanupError, checksPassed = false;
function restoreMain() {
  let head = api('GET', `${prefix}/git/ref/heads/main`).object.sha;
  if (head !== baseline && head !== evidence.restoreIntent.sha) {
    assert.equal(head, evidence.injectionIntent.sha, 'Unexpected main head; preserve external work and require manual inspection');
    head = updateOwnedMain({ api, prefix, expected: head, content: original, message: 'test: restore fixture after isolated acceptance', intent: evidence.restoreIntent, save });
  }
  assert.equal(api('GET', `${prefix}/git/commits/${head}`).tree.sha, baselineTree, 'Restored default branch must have the exact original tree');
  evidence.restoredHead = head; restored = true; save(); return head;
}
save();
try {
  runtime = createProjectAgent({ projectRoot: project }).init();
  runtime.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 300_000 }, github: { repository, ...(app ? { app } : {}), allowedActors: [actor], command: '/js-superagent-default-ci-acceptance', pollIntervalMs: 1000, ci: { checkApps: ['github-actions'] } } });
  runtime.configureCoordinator({ assessor: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 180_000 }, policy: { mode: 'auto', rules: [{ id: 'default-ci-fixture', enabled: true, instruction: `When GitHub Actions diagnostic-contract fails on main in ${repository}, accept one repair task scoped only to ${target}. formatDiagnostic(input) must return {text: String(input).trim(), level: 'info'}. This is an authorized isolated acceptance fixture. Do not change workflow, scripts or other files; host verifies and delivers a draft PR.` }], sourceRows: [{ id: 'acceptance-default-ci', source: 'github', scope: { repository, defaultBranch: 'main' }, actors: [], bots: ['github-actions[bot]'], admission: {} }] } }, { expectedRevision: 0 });
  runtime.configureRepositorySource({ enabled: true, observe: true, streams: { pulls: false, issues: false, comments: false, defaultBranchCI: true } }, { expectedRevision: 0 });
  runtime.configureDelivery({ mode: 'draft-pr', automatic: true, credentialMode: 'native-gh', repository, base: 'main', allowedPaths: [target], verify: { id: 'fixture-contract', version: '1', command: 'node', args: ['scripts/host-verify.mjs'], paths: [target], environment: 'host', allowHostExecution: true, timeoutMs: 60_000 } }, { expectedRevision: 0 });
  await check(baseline, 'success'); assert.equal(await runtime.runNext(), null); assert.equal(runtime.list().length, 0);
  assert.ok(runtime.sourceStatus().every(value => value.error === null), 'Source baseline must succeed under the explicitly selected identity');
  evidence.checks.push('real default-branch source baseline has no historical replay'); save();
  const failureHead = updateOwnedMain({ api, prefix, expected: baseline, content: "export function formatDiagnostic(input) { return { text: 'deliberate-ci-fixture-failure' }; }\n", message: 'test: inject isolated default-branch acceptance failure', intent: evidence.injectionIntent, save });
  evidence.failureHead = failureHead; save(); run('git', ['-C', project, 'fetch', 'origin', 'main']); run('git', ['-C', project, 'checkout', '--detach', failureHead]);
  const failedAction = await check(failureHead, 'failure'); await delay(1200);
  const ticket = await runtime.runNext(); assert.ok(ticket, 'Real failed check must create and execute a task'); assert.equal(runtime.list().length, 1);
  const detail = runtime.getDetailed(ticket.id), domain = runtime.getDomainTicket(ticket.id);
  if (detail.delivery?.pullRequest) evidence.pull = { number: detail.delivery.pullRequest.number, url: detail.delivery.pullRequest.url };
  evidence.ticketId = ticket.id; evidence.session = runtime.getSession(ticket.id); evidence.mandate = { strength: domain.mandate.strength, basis: domain.mandate.basis };
  evidence.ciInput = assertDefaultFailureInTicket({ repository, domain, action: failedAction, trigger: readStoredTrigger(runtime, `github:${repository}:branch_check:${failedAction.checkId}:failure`) }); save();
  assert.equal(ticket.status, 'completed'); assert.equal(detail.verification?.status, 'passed'); assert.equal(detail.delivery?.state, 'delivered');
  const workspace = runtime.getWorkspace(ticket.id); evidence.workspace = { baseCommit: workspace.baseCommit, branch: workspace.branch }; assert.equal(workspace.baseCommit, failureHead);
  evidence.repairedHead = detail.delivery.commitSha; save();
  assertOwnedDraftPull({ pull: api('GET', `${prefix}/pulls/${evidence.pull.number}`), repository, actor, headSha: detail.delivery.commitSha });
  await check(detail.delivery.commitSha, 'success'); await delay(1200); assert.equal(await runtime.runNext(), null, 'Successful CI must not trigger another execution'); await runtime.syncGitHub(); assert.equal(runtime.list().length, 1);
  evidence.checks.push('actual default-branch Actions failure accepted only by configured bot/rule', 'real coordinator and Worker repaired fixture into owned draft PR', 'actual PR-head Actions succeeded', 'repeated source polling does not duplicate the task');
  const restoredHead = restoreMain(); await check(restoredHead, 'success');
  const closed = api('PATCH', `${prefix}/pulls/${evidence.pull.number}`, { state: 'closed' }); assert.equal(closed.state, 'closed'); assert.equal(closed.merged, false);
  await delay(1200); await runtime.syncGitHub(); assert.ok(runtime.getDomainTicket(ticket.id).ended); assert.equal(await runtime.runNext(), null); assert.equal(runtime.list().length, 1);
  evidence.closed = true; evidence.checks.push('default branch restored by a non-forced new commit with identical original tree', 'owned acceptance PR closed without merge and domain work ended'); checksPassed = true;
} catch (error) { scenarioError = error; evidence.error = String(error.message ?? error); save(); }
finally {
  cleanupError = await finalizeAcceptance({ evidence, checksPassed, save, cleanup: [
    { name: 'stop-local-runtime', async run() { if (runtime) { await runtime.stop(); runtime.close(); runtime = undefined; } } },
    { name: 'restore-owned-main', async run() { restoreMain(); evidence.defaultBranchRestored = restored; } },
    { name: 'close-owned-pull', async run() { if (!evidence.pull) return; const result = api('PATCH', `${prefix}/pulls/${evidence.pull.number}`, { state: 'closed' }); assert.equal(result.state, 'closed'); assert.equal(result.merged, false); evidence.closed = true; } },
  ] });
}
if (scenarioError) throw scenarioError;
if (cleanupError) throw cleanupError;

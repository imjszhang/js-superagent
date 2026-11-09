// Opt-in acceptance against an installed tarball and dedicated remote Issue/PR.
// It never pushes the source/default branch or merges. --write authorizes only
// the resources created by this run; --close closes those resources after proof.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values, artifact } = parseArgs({ options: {
  tarball: { type: 'string' }, output: { type: 'string' }, source: { type: 'string' }, repository: { type: 'string' }, actor: { type: 'string' },
  baseline: { type: 'string', default: 'HEAD' }, base: { type: 'string', default: 'main' }, 'gh-path': { type: 'string', default: 'gh' },
  'codex-path': { type: 'string', default: 'codex' }, model: { type: 'string' }, write: { type: 'boolean' }, close: { type: 'boolean' },
} });
if (!values.write || !values.tarball || !values.output || !values.source || !values.repository || !values.actor) throw new Error('Pass --write --tarball <immutable-package.tgz> --output <new-dir> --source <local-repo> --repository <owner/repo> --actor <login> [--close]. Real model calls, a new Issue, draft PR, review, result comments, and optional closure will occur.');
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(values.repository) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(values.actor)) throw new Error('Invalid repository/actor');
const output = resolve(values.output), source = resolve(values.source), tarball = resolve(values.tarball), repository = values.repository.toLowerCase(), actor = values.actor.toLowerCase();
const gh = values['gh-path'], prefix = `repos/${repository}`, command = '/js-superagent-8';
const ciContext = 'js-superagent/host-package-identity';
if (existsSync(output)) throw new Error('Use a new output directory; previous acceptance evidence is preserved');
mkdirSync(output, { recursive: true, mode: 0o700 });
function run(executable, args, cwd = output, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: options.timeout ?? 180_000, maxBuffer: 16 * 1024 * 1024, ...(options.input === undefined ? {} : { input: options.input }) });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed (${result.error?.code ?? result.status}): ${String(result.stderr).slice(-3000)}`);
  return result.stdout.trimEnd();
}
function api(method, endpoint, body) {
  return JSON.parse(run(gh, ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint, ...(body === undefined ? [] : ['--input', '-'])], output, { input: body === undefined ? undefined : JSON.stringify(body) }));
}
const log = message => console.log(`[delivery-acceptance] ${message}`);
assert.equal(api('GET', 'user').login.toLowerCase(), actor, 'Explicit native gh identity must match acceptance actor');
const baseline = run('git', ['-C', source, 'rev-parse', '--verify', `${values.baseline}^{commit}`]);
const remoteBase = api('GET', `${prefix}/git/ref/heads/${values.base}`).object.sha;
assert.equal(baseline, remoteBase, 'Task baseline must be the current remote base, never unfinished source changes');
const consumer = join(output, 'consumer'); mkdirSync(consumer); writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], consumer);
const installed = join(consumer, 'node_modules', 'js-superagent');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const project = join(output, 'project');
run('git', ['clone', '--shared', '--no-checkout', source, project]);
run('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`]);
run('git', ['-C', project, 'sparse-checkout', 'init', '--cone']);
run('git', ['-C', project, 'sparse-checkout', 'set', 'packages/js-superagent']);
run('git', ['-C', project, 'checkout', '--detach', baseline]);
const packageDir = 'packages/js-superagent';
assert.equal(existsSync(join(project, packageDir, 'package.json')), true);
const evidence = { version: 1, startedAt: new Date().toISOString(), status: 'running', baseline, repository, actor,
  tarball: { name: tarball.split('/').at(-1), sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') },
  installedVersion: JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, node: process.version,
  command, project, checks: [], ci: { verified: false, provider: 'host-command-status', context: ciContext, runs: [], limitation: 'Actual host command results published as GitHub commit statuses; not GitHub Actions.' } };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
save();
let runtime;
try {
  log('Creating a dedicated Issue ignored by the existing daemon command.');
  const issue = api('POST', `${prefix}/issues`, { title: '[js-superagent delivery acceptance] Doctor package identity', body: `${command} Improve the doctor command package identity diagnostics in packages/js-superagent. First add only packageVersion to doctor JSON (additional identity fields will be requested in review), read from the installed js-superagent package manifest (never the target project manifest). Preserve current doctor exit codes and behavior. Add focused regression tests and a concise README explanation. Only edit files under packages/js-superagent. Do not commit, push, create PRs, or send messages: the host runtime performs these steps. The host has a trusted preparation and full npm run check verification profile including localhost listener tests. Run relevant focused tests inside your workspace; do not block solely because your execution sandbox cannot bind localhost, since host verification captures the full result after a completed turn. This is a dedicated acceptance task; follow-up package identity review feedback stays within scope.` });
  evidence.issue = { number: issue.number, url: issue.html_url }; save();
  runtime = createProjectAgent({ projectRoot: project }).init();
  runtime.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 600_000 },
    github: { repository, allowedActors: [actor], issues: [issue.number], command, executable: gh, pollIntervalMs: 1000, ci: { statusActors: [actor], statusContexts: [ciContext] } } });
  runtime.configureDelivery({ mode: 'draft-pr', automatic: true, credentialMode: 'native-gh', repository, base: values.base, allowedPaths: [packageDir],
    prepare: { id: 'package-prepare', version: '1', kind: 'prepare', command: process.execPath, args: ['-e', `const {execFileSync}=require('node:child_process'); execFileSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit'}); execFileSync('npm',['run','build'],{stdio:'inherit'});`], cwd: packageDir, paths: [packageDir], environment: 'host', allowHostExecution: true, timeoutMs: 300_000 },
    verify: { id: 'package-check', version: '1', command: 'npm', args: ['run', 'check'], cwd: packageDir, paths: [packageDir], environment: 'host', allowHostExecution: true, timeoutMs: 600_000, maxLogBytes: 4 * 1024 * 1024 },
  }, { expectedRevision: 0 });
  await runtime.syncGitHub();
  assert.equal(runtime.list().length, 1, 'Issue must create exactly one ticket');
  const ticketId = runtime.list()[0].id; evidence.ticketId = ticketId; evidence.projectId = runtime.projectId; save();
  log('Running real Codex, trusted host verification, and automatic draft PR delivery.');
  const first = await runtime.runNext();
  let detail = runtime.getDetailed(ticketId);
  evidence.first = { ticket: first, detail }; save();
  assert.equal(first?.status, 'completed', JSON.stringify(first));
  assert.equal(detail.verification?.kind, 'verify');
  assert.equal(detail.verification?.status, 'passed', JSON.stringify(first));
  assert.equal(detail.delivery?.state, 'delivered', JSON.stringify(first));
  assert.equal(detail.delivery?.runId, first.runId);
  const pullNumber = detail.delivery.pullRequest.number, firstHead = detail.delivery.commitSha;
  const initialSession = runtime.getSession(ticketId), workspace = runtime.getWorkspace(ticketId);
  evidence.pull = detail.delivery.pullRequest; evidence.session = initialSession; evidence.workspace = workspace; save();
  const sourceVersion = JSON.parse(readFileSync(join(workspace.path, packageDir, 'package.json'), 'utf8')).version;
  const probe = join(output, 'uninitialized-probe'); mkdirSync(probe); writeFileSync(join(probe, 'package.json'), '{"name":"spoofed","version":"999.0.0"}\n');
  function doctor() {
    const result = spawnSync(process.execPath, [join(workspace.path, packageDir, 'bin/js-superagent.mjs'), '--project', probe, 'doctor'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, 'Uninitialized doctor retains its existing failure exit status');
    const output = JSON.parse(result.stdout); assert.equal(output.packageVersion, sourceVersion); assert.equal(existsSync(join(probe, '.js-superagent')), false); return output;
  }
  doctor(); evidence.checks.push('Actual package doctor reports its installed version without initializing or trusting target metadata'); save();
  function hostIdentityCI(sha, expected) {
    const script = `const assert=require('node:assert/strict');const {spawnSync}=require('node:child_process');const {readFileSync}=require('node:fs');const [cli,probe,manifest]=process.argv.slice(1);const child=spawnSync(process.execPath,[cli,'--project',probe,'doctor'],{encoding:'utf8'});assert.equal(child.status,1);const actual=JSON.parse(child.stdout),pkg=JSON.parse(readFileSync(manifest,'utf8'));assert.equal(actual.packageVersion,pkg.version);assert.equal(actual.packageName,pkg.name,'doctor packageName must come from the installed package');console.log('doctor package identity contract passed');`;
    const result = spawnSync(process.execPath, ['-e', script, join(workspace.path, packageDir, 'bin/js-superagent.mjs'), probe, join(workspace.path, packageDir, 'package.json')], { encoding: 'utf8', timeout: 10_000 });
    const state = result.status === 0 && !result.error ? 'success' : 'failure';
    writeFileSync(join(output, `host-ci-${sha}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.equal(state, expected, 'The published status must come from the actual command result');
    const status = api('POST', `${prefix}/statuses/${sha}`, { state, context: ciContext,
      description: state === 'success' ? 'Host doctor package identity assertion passed' : 'Host doctor identity assertion failed: add installed packageName alongside packageVersion' });
    const entry = { commitSha: sha, context: ciContext, exitCode: result.status, state, statusId: status.id, log: `host-ci-${sha}.log` };
    evidence.ci.runs.push(entry); save(); return entry;
  }
  log('Running an actual failing host CI identity assertion and publishing its commit status.');
  hostIdentityCI(firstHead, 'failure');
  log('Posting an actual PR review and continuing the original ticket.');
  const review = api('POST', `${prefix}/pulls/${pullNumber}/reviews`, { event: 'COMMENT', commit_id: firstHead,
    body: 'Please extend these package identity diagnostics with packageName alongside packageVersion, also read from the installed package manifest. Add the focused assertion that an uninitialized target with a conflicting name/version cannot spoof either field, preserving doctor exit status and leaving the target unchanged; update the concise README explanation. The host will run full verification and update this same PR.' });
  evidence.review = { id: review.id, url: review.html_url }; save();
  await delay(1200); await runtime.syncGitHub();
  assert.equal(runtime.list().length, 1, 'Review must remain on the original ticket');
  const second = await runtime.runNext(); detail = runtime.getDetailed(ticketId);
  evidence.second = { ticket: second, detail }; save();
  assert.equal(second?.status, 'completed', JSON.stringify(second));
  assert.equal(detail.verification?.kind, 'verify');
  assert.equal(detail.verification?.status, 'passed', JSON.stringify(second)); assert.equal(detail.delivery?.state, 'delivered', JSON.stringify(second));
  assert.equal(detail.delivery?.runId, second.runId);
  assert.equal(detail.delivery.pullRequest.number, pullNumber); assert.notEqual(detail.delivery.commitSha, firstHead);
  assert.deepEqual(runtime.getSession(ticketId), initialSession); assert.equal(runtime.getWorkspace(ticketId).path, workspace.path);
  assert.equal(doctor().packageName, 'js-superagent');
  const remote = api('GET', `${prefix}/pulls/${pullNumber}`);
  assert.equal(remote.head.sha, detail.delivery.commitSha); assert.equal(remote.draft, true);
  assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), baseline);
  evidence.checks.push('Actual review returned to original ticket/session/workspace/PR and host advanced the owned head', 'Source baseline unchanged; no merge or default-branch push');
  assert.ok(second.messages.some(message => message.text.includes(ciContext)), 'Failing host CI status must be delivered into the original ticket');
  hostIdentityCI(detail.delivery.commitSha, 'success');
  await delay(1200); await runtime.syncGitHub();
  assert.ok(runtime.get(ticketId).pullRequests.some(binding => binding.number === pullNumber && binding.ci.some(check => check.name === ciContext && check.conclusion === 'success')), 'Successful new-head CI status must be retained on its binding');
  evidence.ci.verified = true; evidence.checks.push('Actual failing and passing host CI command statuses followed the owned PR head and original ticket'); save();
  if (values.close) {
    log('Closing only this run’s acceptance PR and verifying domain completion.');
    api('PATCH', `${prefix}/pulls/${pullNumber}`, { state: 'closed' });
    await delay(1200); await runtime.syncGitHub(); await runtime.flushNotifications();
    evidence.closedDomain = runtime.getDomainTicket(ticketId);
    assert.ok(evidence.closedDomain.ended, 'Closing the owned PR must finish the ticket');
    api('PATCH', `${prefix}/issues/${issue.number}`, { state: 'closed' });
    evidence.resourcesClosed = true; evidence.checks.push('Owned PR closure ended the original domain ticket');
  }
  evidence.status = 'passed'; evidence.finishedAt = new Date().toISOString(); save(); log(`Passed: ${join(output, 'acceptance.json')}`);
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error?.stack ?? error); evidence.finishedAt = new Date().toISOString(); save();
  console.error(`[delivery-acceptance] Failed; resources and journal preserved for inspection: ${join(output, 'acceptance.json')}`);
  throw error;
} finally { if (runtime) { await runtime.stop(); runtime.close(); } }

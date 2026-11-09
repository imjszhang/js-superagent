// Explicit acceptance: real Codex, a dedicated Issue/draft PR, and GitHub Actions.
// --write authorizes a review, runtime result comments, and publishing exactly the
// two fixture files to the named acceptance branch. No merge or Issue/PR closure.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values, artifact } = parseArgs({ options: {
  output: { type: 'string' }, repository: { type: 'string' }, issue: { type: 'string' },
  'pull-request': { type: 'string' }, actor: { type: 'string' }, branch: { type: 'string' },
  'gh-path': { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' },
  write: { type: 'boolean' },
} });
if (!values.write || !values.output || !values.repository || !values.issue || !values['pull-request'] || !values.actor || !values.branch) {
  throw new Error('Pass --write --output <new-directory> --repository <owner/repo> --issue <dedicated-issue> --pull-request <dedicated-draft-pr> --actor <login> --branch <codex/js-superagent-pr-...>. This makes real model calls, writes review/result comments, and publishes the two fixture files to that branch.');
}
const validNumber = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository) || !validNumber(values.issue) || !validNumber(values['pull-request'])) throw new Error('Invalid repository, Issue or PR number');
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(values.actor)) throw new Error('Invalid GitHub actor login');
if (!/^codex\/js-superagent-pr-[A-Za-z0-9-]+$/.test(values.branch)) throw new Error('Use a dedicated codex/js-superagent-pr-* acceptance branch');
const repository = values.repository.toLowerCase(), issueNumber = Number(values.issue), pullNumber = Number(values['pull-request']);
const actor = values.actor.toLowerCase(), branch = values.branch, gh = values['gh-path'] ?? 'gh';
const fixtureDirectory = 'acceptance/js-superagent-pr-ci';
const fixtureNames = ['pricing.py', 'test_pricing.py'];
const fixturePaths = fixtureNames.map(name => `${fixtureDirectory}/${name}`);
const workflowPath = '.github/workflows/js-superagent-pr-acceptance.yml';
const checkName = 'pricing-negative-quantity-contract';
const output = resolve(values.output), packageRoot = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(output)) throw new Error('Use a new output directory to preserve earlier evidence.');
function run(executable, args, cwd, { timeout = 120_000, input } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', input, timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function api(method, endpoint, body, paginate = false) {
  const args = ['api', '--hostname', 'github.com', '--method', method, endpoint,
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
  if (paginate) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');
  return JSON.parse(run(gh, args, packageRoot, { input: body === undefined ? undefined : JSON.stringify(body) }));
}
const prefix = `repos/${repository}`, issuePath = `${prefix}/issues/${issueNumber}`, pullPath = `${prefix}/pulls/${pullNumber}`;
const issue = api('GET', issuePath);
assert.equal(issue.state, 'open'); assert.equal(issue.pull_request, undefined);
assert.match(issue.title, /^\[js-superagent(?: PR)? acceptance\]/i);
assert.equal(issue.user.login.toLowerCase(), actor); assert.match(issue.body, /^\/js-superagent\s/); assert.match(issue.body, /pricing\.total/);
assert.equal(api('GET', 'user').login.toLowerCase(), actor);
function currentPull() {
  const pr = api('GET', pullPath);
  assert.equal(pr.state, 'open'); assert.equal(pr.draft, true); assert.equal(pr.merged, false);
  assert.match(pr.title, /^\[js-superagent(?: PR)? acceptance\]/i);
  assert.equal(pr.head.repo.full_name.toLowerCase(), repository); assert.equal(pr.base.repo.full_name.toLowerCase(), repository);
  assert.equal(pr.head.ref, branch); assert.notEqual(pr.base.ref, branch);
  return pr;
}
const pull = currentPull();
const changes = api('GET', `${pullPath}/files?per_page=100`, undefined, true).flat();
assert.ok(fixturePaths.every(path => changes.some(file => file.filename === path)), 'The dedicated PR must contain both acceptance fixture files');
assert.ok(changes.every(file => [...fixturePaths, workflowPath].includes(file.filename)), 'The dedicated PR contains unrelated changes');
const comments = number => api('GET', `${prefix}/issues/${number}/comments?per_page=100`, undefined, true).flat();
assert.equal(comments(issueNumber).length, 0, 'Use a fresh dedicated Issue');
assert.equal(comments(pullNumber).length, 0, 'Use a fresh dedicated PR without conversation comments');
assert.equal(api('GET', `${pullPath}/reviews?per_page=100`, undefined, true).flat().length, 0, 'Use a fresh dedicated PR without reviews');
function remoteFile(path, sha) {
  const file = api('GET', `${prefix}/contents/${path}?ref=${sha}`);
  assert.equal(file.type, 'file'); assert.equal(file.encoding, 'base64');
  return Buffer.from(file.content, 'base64').toString('utf8');
}
const baseline = Object.fromEntries(fixtureNames.map((name, index) => [name, remoteFile(fixturePaths[index], pull.head.sha)]));
assert.match(baseline['pricing.py'], /def total\(/);
assert.match(baseline['test_pricing.py'], /unittest/);
mkdirSync(output, { recursive: true, mode: 0o700 });
const packed = artifact;
const consumer = join(output, 'consumer'); mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], consumer);
const installed = join(consumer, 'node_modules/js-superagent');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const cli = join(installed, 'bin/js-superagent.mjs');
const project = join(output, 'python-project'); mkdirSync(project);
for (const name of fixtureNames) writeFileSync(join(project, name), baseline[name]);
writeFileSync(join(project, 'AGENTS.md'), 'This is an isolated js-superagent PR/CI engineering acceptance fixture. Work only inside the current execution workspace. No network, GitHub commands, external messages, commits, merges, or writes outside this workspace. The host runtime handles GitHub comments and publishing the two fixture files. Do not modify .js-superagent. Use python3 unittest and direct assertions. PR/CI feedback paths acceptance/js-superagent-pr-ci/pricing.py and test_pricing.py refer to the local pricing.py and test_pricing.py here.\n');
const git = (...args) => run('git', ['-C', project, ...args], output).trim();
git('init', '-q'); git('config', 'user.name', 'js-superagent acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
git('add', 'AGENTS.md', ...fixtureNames); git('commit', '-qm', 'isolated PR acceptance baseline');
const sourceHead = git('rev-parse', 'HEAD'), sourceIndex = git('ls-files', '--stage');
const invoke = (...args) => JSON.parse(run(process.execPath, [cli, '--project', project, ...args], output, { timeout: 360_000 }));
const init = ['init', '--workspace', 'worktree', '--driver', 'codex-app-server', '--timeout-ms', '300000',
  '--github-repo', repository, '--github-actor', actor, '--github-issue', String(issueNumber), '--github-poll-ms', '1000'];
if (values['gh-path']) init.push('--gh-path', values['gh-path']);
if (values['codex-path']) init.push('--codex-path', values['codex-path']);
if (values.model) init.push('--model', values.model);
invoke(...init);
const evidence = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  codex: run(values['codex-path'] ?? 'codex', ['--version'], output).trim(), gh: run(gh, ['--version'], output).split('\n')[0],
  package: packed.filename, repository, issueNumber, issueUrl: issue.html_url, pullNumber, pullUrl: pull.html_url,
  branch, fixturePaths, initialRemoteHead: pull.head.sha, sourceHead, status: 'running', checks: [], publishedCommits: [],
  implementationSha256: Object.fromEntries([
    'src/index.mjs', 'src/config.mjs', 'src/outbox.mjs', 'src/channels/github.mjs', 'src/github-intake.mjs', 'src/github-pull-intake.mjs',
    'src/workspaces.mjs', 'src/drivers/codex-app-server.mjs', 'bin/js-superagent.mjs',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
};
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
const log = message => console.log(`[real-github-pr] ${message}`);
const runtimes = new Set();
function open() { const runtime = createProjectAgent({ projectRoot: project }).init(); runtimes.add(runtime); return runtime; }
function close(runtime) { runtime.close(); runtimes.delete(runtime); }
function assertSourceUnchanged() {
  for (const name of fixtureNames) assert.equal(readFileSync(join(project, name), 'utf8'), baseline[name]);
  assert.equal(git('rev-parse', 'HEAD'), sourceHead); assert.equal(git('ls-files', '--stage'), sourceIndex);
}
function independentTests(path) {
  const result = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: path, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); return result.stderr;
}
function assertSameExecution(runtime, ticketId, session, workspace) {
  assert.equal(runtime.list().length, 1); assert.deepEqual(runtime.getSession(ticketId), session);
  assert.equal(runtime.getWorkspace(ticketId).path, workspace.path); assertSourceUnchanged();
}
function receipts(runtime) {
  const remote = new Map([[issueNumber, comments(issueNumber)], [pullNumber, comments(pullNumber)]]);
  return runtime.notifications().filter(receipt => receipt.channel.source === 'github').map(receipt => {
    assert.equal(receipt.status, 'sent', `Receipt ${receipt.id} must be sent`);
    const number = Number(receipt.channel.address.issueNumber ?? receipt.channel.address.pullNumber);
    assert.ok(remote.has(number), 'No receipt may target an unrelated thread');
    const marker = `<!-- js-superagent:${runtime.projectId}:${receipt.id} -->`;
    const matches = remote.get(number).filter(comment => comment.user.login.toLowerCase() === actor && comment.body.includes(marker));
    assert.equal(matches.length, 1, `Receipt ${receipt.id} must have exactly one remote comment`);
    assert.equal(receipt.delivery.url, matches[0].html_url);
    return { id: receipt.id, kind: receipt.kind, status: receipt.status, issueNumber: number, commentId: matches[0].id, url: matches[0].html_url };
  });
}
function assertSummaryOnBothThreads(summary) {
  const text = summary.split(project).join('[project]');
  for (const number of [issueNumber, pullNumber]) assert.ok(comments(number).some(comment => comment.body.includes(text)), `Missing actual execution summary in thread ${number}`);
}
function publishFixture(workspace, expectedHead, label) {
  const pr = currentPull(); assert.equal(pr.head.sha, expectedHead, 'Remote head changed unexpectedly; do not overwrite it');
  const commit = api('GET', `${prefix}/git/commits/${expectedHead}`);
  const tree = api('POST', `${prefix}/git/trees`, { base_tree: commit.tree.sha,
    tree: fixtureNames.map((name, index) => ({ path: fixturePaths[index], mode: '100644', type: 'blob', content: readFileSync(join(workspace, name), 'utf8') })) });
  const next = api('POST', `${prefix}/git/commits`, { message: `js-superagent acceptance: ${label}`, tree: tree.sha, parents: [expectedHead] });
  api('PATCH', `${prefix}/git/refs/heads/${branch}`, { sha: next.sha, force: false });
  assert.equal(currentPull().head.sha, next.sha);
  const comparison = api('GET', `${prefix}/compare/${expectedHead}...${next.sha}`);
  assert.ok(comparison.files.length > 0); assert.ok(comparison.files.every(file => fixturePaths.includes(file.filename)));
  const entry = { sha: next.sha, parent: expectedHead, changedPaths: comparison.files.map(file => file.filename), url: next.html_url };
  evidence.publishedCommits.push(entry); save(); return next.sha;
}
async function waitForCheck(sha, expected) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const pages = api('GET', `${prefix}/commits/${sha}/check-runs?per_page=100`, undefined, true);
    const checks = pages.flatMap(page => page.check_runs ?? []);
    const check = checks.filter(value => value.name === checkName && value.app?.slug === 'github-actions' && value.head_sha === sha)
      .sort((a, b) => b.id - a.id)[0];
    if (check?.status === 'completed') {
      assert.equal(check.conclusion, expected, `Expected ${expected} from real Actions check: ${JSON.stringify(check)}`);
      const annotations = api('GET', `${prefix}/check-runs/${check.id}/annotations?per_page=100`, undefined, true).flat();
      return { id: check.id, name: check.name, headSha: sha, app: check.app.slug, status: check.status,
        conclusion: check.conclusion, url: check.html_url, annotations, output: check.output };
    }
    await delay(3000);
  }
  throw new Error(`Timed out waiting for ${checkName} on ${sha}`);
}
save();
try {
  log('Accepting the Issue and completing its initial task with real Codex.');
  invoke('github', 'sync'); const first = invoke('run'); assert.equal(first.status, 'completed', JSON.stringify(first));
  let runtime = open(); const ticketId = first.id, session = runtime.getSession(ticketId), workspace = runtime.getWorkspace(ticketId);
  assert.equal(session.driver, 'codex-app-server'); assert.equal(workspace.mode, 'worktree'); assert.notEqual(workspace.path, project);
  evidence.ticketId = ticketId; evidence.projectId = runtime.projectId; evidence.session = session; evidence.workspace = workspace;
  evidence.initialIndependentTests = independentTests(workspace.path); assertSameExecution(runtime, ticketId, session, workspace);
  await runtime.linkGitHubPullRequest(ticketId, { number: pullNumber });
  assert.equal(runtime.githubStatus().trackedPullRequests.find(value => value.number === pullNumber).headSha, pull.head.sha);
  evidence.checks.push('issue-completed-with-real-codex-and-isolated-worktree', 'explicit-current-head-pr-binding');
  close(runtime); save();

  log('Writing a real PR review and resuming the original ticket/session.');
  const review = api('POST', `${pullPath}/reviews`, { commit_id: pull.head.sha, event: 'COMMENT',
    body: 'Acceptance review within the original pricing scope: please add a named unittest method test_fractional_discount that asserts total(12.5, 2, 10) == 22.5. Preserve the current behavior and rerun python3 -m unittest -v. The remote fixture paths acceptance/js-superagent-pr-ci/ map to the workspace root.' });
  evidence.review = { id: review.id, state: review.state, commitId: review.commit_id, url: review.html_url }; save();
  invoke('github', 'sync'); runtime = open();
  const reviewed = await runtime.runNext(); assert.equal(reviewed?.id, ticketId); assert.equal(reviewed.status, 'completed', JSON.stringify(reviewed));
  assertSameExecution(runtime, ticketId, session, workspace);
  assert.match(readFileSync(join(workspace.path, 'test_pricing.py'), 'utf8'), /def test_fractional_discount\(/);
  evidence.reviewIndependentTests = independentTests(workspace.path); assertSummaryOnBothThreads(reviewed.reports.at(-1).summary);
  evidence.checks.push('real-pr-review-resumes-original-ticket-session-worktree', 'review-result-returned-to-issue-and-pr');
  close(runtime); save();

  log('Publishing only the two review-fixed fixture files and waiting for real failing CI.');
  const failureHead = publishFixture(workspace.path, pull.head.sha, 'review regression');
  evidence.failedCheck = await waitForCheck(failureHead, 'failure');
  assert.match(JSON.stringify([evidence.failedCheck.output, evidence.failedCheck.annotations]), /quantity.*(?:negative|<\s*0)|negative.*quantity/i,
    'The real CI output must explain the negative quantity contract');
  runtime = open(); runtime.configure({ github: { ci: { checkApps: ['github-actions'] } } });
  await runtime.linkGitHubPullRequest(ticketId, { number: pullNumber });
  await runtime.syncGitHub();
  assert.ok(runtime.get(ticketId).messages.some(message => /quantity.*(?:negative|<\s*0)|negative.*quantity/i.test(message.text)), 'Actual check failure details must reach the worker');
  const repaired = await runtime.runNext(); assert.equal(repaired?.id, ticketId); assert.equal(repaired.status, 'completed', JSON.stringify(repaired));
  assertSameExecution(runtime, ticketId, session, workspace);
  evidence.ciIndependentTests = independentTests(workspace.path);
  run('python3', ['-c', 'from pricing import total\nassert total(12.5,2,10)==22.5\ntry: total(10,-1)\nexcept ValueError: pass\nelse: raise AssertionError("negative quantity must raise ValueError")'], workspace.path);
  assertSummaryOnBothThreads(repaired.reports.at(-1).summary);
  evidence.checks.push('real-actions-failure-resumes-original-ticket-session-worktree', 'ci-fix-independent-tests', 'ci-result-returned-to-issue-and-pr');
  close(runtime); save();

  log('Publishing only the CI-fixed fixture files and verifying real Actions turns green.');
  const greenHead = publishFixture(workspace.path, failureHead, 'negative quantity CI repair');
  evidence.greenCheck = await waitForCheck(greenHead, 'success');
  runtime = open(); await runtime.linkGitHubPullRequest(ticketId, { number: pullNumber });
  await runtime.syncGitHub();
  const binding = runtime.githubStatus().trackedPullRequests.find(value => value.number === pullNumber);
  assert.equal(binding.headSha, greenHead);
  assert.ok(binding.ci.some(value => value.name === checkName && value.conclusion === 'success' && value.headSha === greenHead));
  const reportCount = runtime.get(ticketId).reports.length;
  const commentCounts = [comments(issueNumber).length, comments(pullNumber).length];
  assert.equal(await runtime.runNext(), null, 'Green CI must not request another worker turn');
  await runtime.syncGitHub(); await runtime.syncGitHub();
  assert.equal(await runtime.runNext(), null); assert.equal(runtime.get(ticketId).reports.length, reportCount);
  assert.deepEqual([comments(issueNumber).length, comments(pullNumber).length], commentCounts);
  assert.equal(reportCount, 3); assertSameExecution(runtime, ticketId, session, workspace);
  for (let index = 0; index < fixtureNames.length; index++) assert.equal(remoteFile(fixturePaths[index], greenHead), readFileSync(join(workspace.path, fixtureNames[index]), 'utf8'));
  evidence.receipts = receipts(runtime); evidence.reports = runtime.get(ticketId).reports;
  evidence.binding = binding; evidence.workspaceReview = runtime.inspectWorkspace(ticketId); evidence.finalRemoteHead = greenHead;
  evidence.checks.push('only-two-fixture-files-published', 'real-actions-green-recorded-without-execution', 'repeat-poll-and-receipt-echo-deduplication', 'source-files-head-and-index-unchanged');
  evidence.status = 'passed'; close(runtime);
  log('PR review, CI repair, publication and real green Actions acceptance passed.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
} finally {
  for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${join(output, 'acceptance.json')}`);
}

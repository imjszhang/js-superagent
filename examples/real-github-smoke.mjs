// Explicit opt-in acceptance: uses real GitHub comments and real Codex execution.
// The caller supplies a dedicated existing Issue and --write to authorize its test replies.
// This script does not create/close Issues, publish source code, or change source project files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash } from 'node:crypto';

const { values, artifact } = parseArgs({ options: {
  output: { type: 'string' }, repository: { type: 'string' }, issue: { type: 'string' }, actor: { type: 'string' },
  'gh-path': { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' }, write: { type: 'boolean' },
} });
if (!values.write || !values.output || !values.repository || !values.issue || !values.actor) {
  throw new Error('Pass --write --output <new-directory> --repository <owner/repo> --issue <dedicated-issue-number> --actor <allowed-login>. This makes real model calls and writes test replies.');
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository) || !/^[1-9]\d*$/.test(values.issue) || !Number.isSafeInteger(Number(values.issue))) throw new Error('Invalid repository or Issue number');
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(values.actor)) throw new Error('Invalid GitHub actor login');
const repository = values.repository, issueNumber = Number(values.issue), actor = values.actor;
const gh = values['gh-path'] ?? 'gh';
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Use a new output directory so earlier evidence is preserved.');
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
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
const issuePath = `repos/${repository}/issues/${issueNumber}`;
const issue = api('GET', issuePath);
assert.equal(issue.state, 'open', 'The dedicated acceptance Issue must be open');
assert.equal(issue.pull_request, undefined, 'Use an Issue, not a pull request');
assert.match(issue.title, /^\[js-superagent acceptance\]/i);
assert.equal(issue.user.login.toLowerCase(), actor.toLowerCase());
assert.match(issue.body, /^\/js-superagent(?:\s|$)/);
assert.match(issue.body, /pricing\.total/);
assert.equal(api('GET', 'user').login.toLowerCase(), actor.toLowerCase(), 'The test responder must match the allowed native gh account');
const comments = () => api('GET', `${issuePath}/comments?per_page=100`, undefined, true).flat();
const beforeComments = comments();
assert.equal(beforeComments.length, 0, 'Use a fresh dedicated Issue with no comments to keep acceptance independent');
mkdirSync(output, { recursive: true, mode: 0o700 });
const packed = artifact;
const consumer = join(output, 'consumer'); mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], consumer);
const installed = join(consumer, 'node_modules/js-superagent');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const cli = join(installed, 'bin/js-superagent.mjs');
const project = join(output, 'python-project'); mkdirSync(project);
const source = 'def total(price, quantity, discount=0):\n    return price + quantity - discount\n';
const originalTests = `import unittest
from pricing import total
class PricingTest(unittest.TestCase):
    def test_basic(self): self.assertEqual(total(10, 3), 30)
    def test_discount(self): self.assertEqual(total(20, 2, 25), 30)
    def test_zero(self): self.assertEqual(total(12, 0), 0)
`;
writeFileSync(join(project, 'AGENTS.md'), 'This is an isolated js-superagent GitHub engineering acceptance fixture. Work only inside the execution workspace. No network, GitHub commands, external messages, commits, merges, or writes outside this workspace. The host runtime handles Issue replies. Do not modify .js-superagent. Verify with python3 unittest.\n');
writeFileSync(join(project, 'pricing.py'), source);
writeFileSync(join(project, 'test_pricing.py'), originalTests);
const invoke = (...args) => JSON.parse(run(process.execPath, [cli, '--project', project, ...args], output, { timeout: 360_000 }));
const init = ['init', '--workspace', 'copy', '--driver', 'codex-app-server', '--timeout-ms', '300000',
  '--github-repo', repository, '--github-actor', actor, '--github-issue', String(issueNumber), '--github-poll-ms', '1000'];
if (values['gh-path']) init.push('--gh-path', values['gh-path']);
if (values['codex-path']) init.push('--codex-path', values['codex-path']);
if (values.model) init.push('--model', values.model);
invoke(...init);
const evidence = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  codex: run(values['codex-path'] ?? 'codex', ['--version'], output).trim(),
  gh: run(gh, ['--version'], output).split('\n')[0], package: packed.filename,
  repository, issueNumber, issueUrl: issue.html_url, status: 'running', checks: [],
  implementationSha256: Object.fromEntries([
    'src/index.mjs', 'src/config.mjs', 'src/outbox.mjs', 'src/channels/github.mjs', 'src/github-intake.mjs',
    'src/workspaces.mjs', 'src/drivers/codex-app-server.mjs', 'bin/js-superagent.mjs',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
};
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
const log = message => console.log(`[real-github] ${message}`);
const runtimes = new Set();
function open() { const runtime = createProjectAgent({ projectRoot: project }).init(); runtimes.add(runtime); return runtime; }
function close(runtime) { runtime.close(); runtimes.delete(runtime); }
function assertSourceUnchanged() {
  assert.equal(readFileSync(join(project, 'pricing.py'), 'utf8'), source);
  assert.equal(readFileSync(join(project, 'test_pricing.py'), 'utf8'), originalTests);
}
function assertReceipts(runtime, remote) {
  const receipts = runtime.notifications().filter(value => value.channel.source === 'github');
  assert.ok(receipts.length > 0);
  for (const receipt of receipts) {
    assert.equal(receipt.status, 'sent', `Receipt ${receipt.id} was not delivered`);
    const marker = `<!-- js-superagent:${runtime.projectId}:${receipt.id} -->`;
    const matching = remote.filter(comment => comment.user.login.toLowerCase() === actor.toLowerCase() && comment.body.includes(marker));
    assert.equal(matching.length, 1, `Receipt ${receipt.id} must have one remote comment`);
  }
  return receipts.map(receipt => {
    const comment = remote.find(item => item.body.includes(`<!-- js-superagent:${runtime.projectId}:${receipt.id} -->`));
    return { id: receipt.id, kind: receipt.kind, status: receipt.status, commentId: comment.id, url: comment.html_url };
  });
}
save();
try {
  log('Pulling the dedicated Issue into the installed runtime.');
  invoke('github', 'sync');
  let runtime = open();
  const [ticket] = runtime.list(); assert.ok(ticket); assert.equal(runtime.list().length, 1);
  assert.equal(runtime.getDomainTicket(ticket.id).mandate.actor.source, 'github');
  const projectId = runtime.projectId;
  close(runtime);
  log('Running real Codex and returning its question to the Issue.');
  const waiting = invoke('run'); assert.equal(waiting.status, 'waiting', JSON.stringify(waiting));
  runtime = open();
  const session = runtime.getSession(ticket.id), workspace = runtime.getWorkspace(ticket.id);
  assert.equal(session.driver, 'codex-app-server'); assert.equal(workspace.mode, 'copy');
  assert.equal(readFileSync(join(workspace.path, 'pricing.py'), 'utf8'), source);
  const questionComments = comments();
  const questionReceipts = assertReceipts(runtime, questionComments);
  assert.ok(questionComments.some(comment => comment.body.includes(waiting.reports.at(-1).summary)));
  assertSourceUnchanged(); close(runtime);
  const answer = api('POST', `${issuePath}/comments`, {
    body: 'Acceptance answer: raise ValueError when discount is below 0 or above 100; accept both endpoints. Keep ordinary numeric arithmetic, no rounding required. Implement the fix, add tests, and run python3 -m unittest -v now.',
  });
  evidence.answerComment = { id: answer.id, url: answer.html_url }; save();
  invoke('github', 'sync');
  runtime = open();
  log('Resuming the associated ticket/session from the GitHub answer.');
  const completed = await runtime.runNext(); assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.id, ticket.id); assert.equal(runtime.list().length, 1);
  assert.deepEqual(runtime.getSession(ticket.id), session);
  assert.equal(runtime.getWorkspace(ticket.id).path, workspace.path);
  const check = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: workspace.path, encoding: 'utf8', timeout: 30_000 });
  assert.equal(check.status, 0, check.stderr);
  run('python3', ['-c', 'from pricing import total\nassert total(10,3)==30\nassert total(20,2,25)==30\nassert total(10,2,100)==0\nfor d in (-1,101):\n try: total(10,2,d)\n except ValueError: pass\n else: raise AssertionError("missing validation")'], workspace.path);
  const completedComments = comments();
  const completedReceipts = assertReceipts(runtime, completedComments);
  assert.ok(completedComments.some(comment => comment.body.includes(completed.reports.at(-1).summary.split(project).join('[project]'))), 'GitHub must contain the actual completion summary');
  assertSourceUnchanged(); close(runtime);
  log('Posting related feedback after completion and reusing the existing ticket.');
  const feedback = api('POST', `${issuePath}/comments`, {
    body: 'Acceptance follow-up within the original pricing scope: add a named unittest method test_fractional_discount for total(12.5, 2, 10) == 22.5. Preserve the existing behavior and rerun python3 -m unittest -v.',
  });
  evidence.feedbackComment = { id: feedback.id, url: feedback.html_url }; save();
  invoke('github', 'sync'); runtime = open();
  assert.equal(runtime.list().length, 1);
  const followup = await runtime.runNext(); assert.equal(followup.status, 'completed', JSON.stringify(followup));
  assert.equal(followup.id, ticket.id); assert.deepEqual(runtime.getSession(ticket.id), session);
  assert.equal(runtime.getWorkspace(ticket.id).path, workspace.path);
  assert.match(readFileSync(join(workspace.path, 'test_pricing.py'), 'utf8'), /def test_fractional_discount\(/);
  const finalCheck = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: workspace.path, encoding: 'utf8', timeout: 30_000 });
  assert.equal(finalCheck.status, 0, finalCheck.stderr);
  assertSourceUnchanged();
  const beforeRepeat = comments();
  const reportCount = runtime.get(ticket.id).reports.length;
  await runtime.syncGitHub(); await runtime.syncGitHub();
  assert.equal(await runtime.runNext(), null);
  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.get(ticket.id).reports.length, reportCount);
  const afterRepeat = comments(); assert.equal(afterRepeat.length, beforeRepeat.length);
  assert.ok(afterRepeat.some(comment => comment.body.includes(followup.reports.at(-1).summary.split(project).join('[project]'))), 'GitHub must contain the follow-up completion summary');
  evidence.receipts = assertReceipts(runtime, afterRepeat);
  evidence.ticketId = ticket.id; evidence.projectId = projectId; evidence.session = session; evidence.workspace = workspace;
  evidence.reports = runtime.get(ticket.id).reports; evidence.independentTests = finalCheck.stderr;
  evidence.review = runtime.inspectWorkspace(ticket.id);
  evidence.checks = [
    'issue-accepted-with-github-mandate', 'question-returned-to-issue', 'github-answer-resumes-same-ticket-and-session',
    'real-file-modification-and-independent-tests', 'completed-ticket-associated-feedback',
    'result-comments-verified-remotely', 'duplicate-poll-and-self-echo-suppression', 'source-project-unchanged',
  ];
  evidence.questionReceiptCount = questionReceipts.length; evidence.completedReceiptCount = completedReceipts.length;
  evidence.status = 'passed'; close(runtime);
  log('Real GitHub intake, feedback and result return passed.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
} finally {
  for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${join(output, 'acceptance.json')}`);
}

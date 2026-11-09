// Opt-in: installed immutable package, real GitHub PR intake, real Codex assessor/Worker,
// local worktree change and verification, and actual result receipt on that PR.
// The host creates one dedicated branch/PR; Worker changes are never pushed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values, artifact } = parseArgs({ options: {
  tarball: { type: 'string' }, output: { type: 'string' }, source: { type: 'string' }, repository: { type: 'string' }, actor: { type: 'string' },
  'app-config': { type: 'string' }, 'app-pr-comments': { type: 'boolean' }, 'fetch-pull-head': { type: 'boolean' }, base: { type: 'string', default: 'main' }, 'gh-path': { type: 'string', default: 'gh' },
  'codex-path': { type: 'string', default: 'codex' }, model: { type: 'string' }, write: { type: 'boolean' }, close: { type: 'boolean' },
} });
if (!values.write || !values.tarball || !values.output || !values.source || !values.repository || !values.actor) {
  throw new Error('Pass --write --tarball <immutable-package.tgz> --output <new-dir> --source <local-repo> --repository <owner/repo> --actor <login> [--app-config <project-config.json>] [--close]. This creates a dedicated remote branch/draft PR, makes real model calls, writes result comments, and optionally closes that PR.');
}
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(values.repository) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(values.actor)) throw new Error('Invalid repository or actor');
const output = resolve(values.output), source = resolve(values.source), tarball = resolve(values.tarball), repository = values.repository.toLowerCase(), actor = values.actor.toLowerCase();
if (existsSync(output)) throw new Error('Use a new output directory to preserve earlier evidence');
mkdirSync(output, { recursive: true, mode: 0o700 });
const gh = values['gh-path'], prefix = `repos/${repository}`, command = '/js-superagent-repository';
const tag = `${Date.now()}-${randomUUID().slice(0, 6)}`, branch = `codex/js-superagent-repository-${tag}`;
const fixture = `acceptance/js-superagent-repository-${tag}`, resultPath = `${fixture}/accepted.txt`, expected = 'js-superagent repository intake verified\n';
function run(executable, args, cwd = output, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: options.timeout ?? 180_000, maxBuffer: 16 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }) });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed (${result.error?.code ?? result.status}): ${String(result.stderr).slice(-2000)}`);
  return result.stdout.trimEnd();
}
function api(method, endpoint, body) {
  return JSON.parse(run(gh, ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint,
    ...(body === undefined ? [] : ['--input', '-'])], output, { input: body === undefined ? undefined : JSON.stringify(body) }));
}
const log = value => console.log(`[repository-intake-acceptance] ${value}`);
assert.equal(api('GET', 'user').login.toLowerCase(), actor, 'Native gh identity must match the actor that creates the acceptance PR');
const baseline = api('GET', `${prefix}/git/ref/heads/${values.base}`).object.sha;
run('git', ['-C', source, 'cat-file', '-e', `${baseline}^{commit}`]);
const consumer = join(output, 'consumer'); mkdirSync(consumer); writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], consumer);
const installed = join(consumer, 'node_modules/js-superagent');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const project = join(output, 'project');
run('git', ['clone', '--shared', '--no-checkout', source, project]);
run('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`]);
run('git', ['-C', project, 'sparse-checkout', 'init', '--cone']);
run('git', ['-C', project, 'sparse-checkout', 'set', fixture]);
run('git', ['-C', project, 'checkout', '--detach', baseline]);
let app;
if (values['app-config']) {
  const configFile = resolve(values['app-config']), configured = JSON.parse(readFileSync(configFile, 'utf8')).github;
  assert.equal(configured?.repository, repository); assert.ok(configured.app, 'Explicit app-config must contain GitHub App references');
  app = { ...configured.app, ...(values['app-pr-comments'] ? { pullRequestComments: true } : {}) };
  if (app.privateKeyPath) app.privateKeyPath = resolve(source, app.privateKeyPath);
}
const evidence = { schemaVersion: 1, phase: '11a-real-repository-intake', startedAt: new Date().toISOString(), status: 'running', repository, actor, baseline,
  branch, command, fixture, resultPath, authentication: app ? 'github-app' : 'native-gh', node: process.version,
  tarball: { name: tarball.split('/').at(-1), sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') },
  installedVersion: JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, checks: [] };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
save(); let runtime;
try {
  runtime = createProjectAgent({ projectRoot: project }).init();
  runtime.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 300_000 },
    github: { repository, allowedActors: [actor], command, executable: gh, pollIntervalMs: 1000, ...(app ? { app } : {}) } });
  runtime.configureCoordinator({ assessor: { driver: 'codex-app-server', executable: values['codex-path'], ...(values.model ? { model: values.model } : {}), timeoutMs: 180_000 },
    policy: { mode: 'off', rules: [], sourceRows: [] } }, { expectedRevision: 0 });
  runtime.configureRepositorySource({ enabled: true, observe: false, ...(values['fetch-pull-head'] ? { fetchPullHead: true } : {}), streams: { pulls: true, issues: false, comments: false, defaultBranchCI: false } }, { expectedRevision: 0 });
  log('Establishing a real repository baseline before creating the PR.');
  assert.equal(await runtime.runNext(), null); assert.equal(runtime.list().length, 0);
  evidence.baselineSources = runtime.sourceStatus(); assert.equal(evidence.baselineSources[0].error, null); save();

  const verification = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync(${JSON.stringify(resultPath)},'utf8'),${JSON.stringify(expected)});console.log('repository intake content verified');`;
  const commit = api('GET', `${prefix}/git/commits/${baseline}`);
  const tree = api('POST', `${prefix}/git/trees`, { base_tree: commit.tree.sha, tree: [
    { path: `${fixture}/README.md`, mode: '100644', type: 'blob', content: '# Repository intake acceptance\n\nThe runtime must create accepted.txt only in its isolated worktree, validate its exact contents, and report to this dedicated PR. Do not push Worker changes.\n' },
    { path: `${fixture}/verify.mjs`, mode: '100644', type: 'blob', content: verification + '\n' },
    { path: `${fixture}/AGENTS.md`, mode: '100644', type: 'blob', content: 'This directory is a bounded engineering acceptance fixture. Change only accepted.txt, run the adjacent verification script from the Git root, and report the result. No network, commits, pushes, PR operations, or other repository edits are authorized to the Worker. The host handles GitHub delivery.\n' },
  ] });
  const next = api('POST', `${prefix}/git/commits`, { message: 'test: prepare isolated js-superagent repository intake fixture', tree: tree.sha, parents: [baseline] });
  api('POST', `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: next.sha });
  evidence.fixtureHead = next.sha; save();
  const pull = api('POST', `${prefix}/pulls`, { title: '[js-superagent repository acceptance] Direct PR intake', head: branch, base: values.base, draft: true,
    body: `${command} In this PR, create only ${resultPath} with exactly the line "js-superagent repository intake verified" followed by one newline. Run node ${fixture}/verify.mjs and report its result. Work only in the runtime-provided worktree based on this PR head. Do not modify implementation or other files; do not commit, push, merge, or send messages. The host will independently verify the file and return your result to this PR. This is the entire authorized task.` });
  evidence.pull = { number: pull.number, url: pull.html_url, headSha: next.sha }; save();
  // This is the trusted host fetching the specifically created acceptance commit.
  if (!values['fetch-pull-head']) run('git', ['-C', project, 'fetch', '--no-tags', 'origin', branch]);
  else { const missing=spawnSync('git',['-C',project,'cat-file','-e',`${next.sha}^{commit}`],{encoding:'utf8'});assert.notEqual(missing.status,0,'Controlled-fetch acceptance requires a genuinely missing object'); }
  assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), baseline);
  runtime.configureDelivery({ mode: 'local', automatic: false, allowedPaths: [fixture], verify: { id: 'repository-intake-content', version: '1', command: process.execPath,
    args: [`${fixture}/verify.mjs`], paths: [fixture], environment: 'host', allowHostExecution: true, timeoutMs: 30_000 } }, { expectedRevision: 0 });
  log(`Receiving draft PR #${pull.number} through the actual repository source and real coordinator.`);
  let ticket;
  for (let attempt = 0; attempt < 8 && !ticket; attempt++) { await delay(1100); ticket = await runtime.runNext(); }
  assert.equal(ticket?.status, 'completed', JSON.stringify(ticket)); assert.equal(runtime.list().length, 1);
  evidence.ticketId = ticket.id; evidence.projectId = runtime.projectId;
  const workspace = runtime.getWorkspace(ticket.id); assert.equal(workspace.mode, 'worktree'); assert.equal(workspace.baseCommit, next.sha);
  assert.equal(readFileSync(join(workspace.path, resultPath), 'utf8'), expected);
  if(values['fetch-pull-head']) { assert.equal(run('git',['-C',project,'for-each-ref','--format=%(refname)','refs/js-superagent/fetch']), '');assert.equal(run('git',['-C',project,'rev-parse','HEAD']),baseline);evidence.checks.push('runtime fetched the missing authorized PR SHA without switching project HEAD and removed its private reference'); }
  assert.equal(existsSync(join(project, resultPath)), false);
  assert.equal(run('git', ['-C', workspace.path, 'diff', '--name-only']), '', 'No tracked source file may be changed');
  const untracked = run('git', ['-C', workspace.path, 'ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).js-superagent/workspace-owner.json']);
  assert.deepEqual(untracked.split('\n').filter(Boolean), [resultPath]);
  const verified = await runtime.verifyTicket(ticket.id); assert.equal(verified.status, 'passed');
  const binding = runtime.githubStatus().trackedPullRequests.find(value => value.number === pull.number);
  assert.equal(binding.ticketId, ticket.id); assert.equal(binding.own, false); assert.equal(runtime.githubStatus().trackedIssues.length, 0);
  const coordinatorDecisions = runtime.readContext('decisions', { limit: 20 });
  evidence.execution = { workspace, session: runtime.getSession(ticket.id), report: ticket.reports.at(-1), verification: verified, coordinatorDecisions };
  assert.equal(evidence.execution.session.driver, 'codex-app-server');
  const comments = api('GET', `${prefix}/issues/${pull.number}/comments?per_page=100`);
  const receipts = runtime.notifications().filter(message => message.channel.source === 'github');
  assert.ok(receipts.some(message => message.kind === 'reply'));
  evidence.receipts = receipts.map(message => {
    assert.equal(message.status, 'sent'); assert.equal(message.channel.address.pullNumber, String(pull.number));
    const marker = `<!-- js-superagent:${runtime.projectId}:${message.id} -->`, matches = comments.filter(comment => comment.body.includes(marker));
    assert.equal(matches.length, 1); assert.equal(matches[0].html_url, message.delivery.url);
    return { id: message.id, kind: message.kind, url: message.delivery.url, actor: matches[0].user.login, actorType: matches[0].user.type };
  });
  assert.equal(receipts.filter(message => message.kind === 'reply').length, 1, 'The PR must receive one result, not duplicate source/binding replies');
  assert.equal(api('GET', `${prefix}/pulls/${pull.number}`).head.sha, next.sha, 'Worker changes must remain local');
  assert.equal(api('GET', `${prefix}/git/ref/heads/${values.base}`).object.sha, baseline, 'Default branch must remain unchanged');
  evidence.checks.push('real repository baseline without history replay', 'new same-repository draft PR classified by real Codex', 'one task bound as non-owned PR',
    'real Worker edits only acceptance file in worktree pinned to PR head', 'independent host verification passed', 'exactly one actual PR result receipt', 'no Worker push or default-branch change');
  const ended = runtime.getDomainTicket(ticket.id).ended, reportCount = ticket.reports.length;
  runtime.close(); runtime = createProjectAgent({ projectRoot: project }).init(); await delay(1100); await runtime.runNext();
  assert.equal(runtime.list().length, 1); assert.equal(runtime.get(ticket.id).reports.length, reportCount); assert.equal(runtime.getRepositorySourceSettings().enabled, true);
  evidence.checks.push('reopened runtime restores repository settings and does not repeat the PR task');
  if (values.close) {
    api('PATCH', `${prefix}/pulls/${pull.number}`, { state: 'closed' }); await delay(1100); await runtime.syncGitHub();
    assert.deepEqual(runtime.getDomainTicket(ticket.id).ended, ended, 'Closing a non-owned PR must not rewrite the existing ticket outcome');
    assert.equal(runtime.githubStatus().trackedPullRequests.find(value => value.number === pull.number).lastObservedState, 'closed');
    evidence.closed = true; evidence.checks.push('real closed non-owned PR observed without rewriting ticket outcome');
  }
  evidence.status = 'passed'; evidence.completedAt = new Date().toISOString(); save(); log(`Passed: ${join(output, 'acceptance.json')}`);
} catch (error) {
  evidence.status = 'failed'; evidence.failedAt = new Date().toISOString(); evidence.error = String(error.message ?? error);
  if (values.close && evidence.pull?.number && !evidence.closed) {
    try { api('PATCH', `${prefix}/pulls/${evidence.pull.number}`, { state: 'closed' }); evidence.closed = true; }
    catch (cleanup) { evidence.cleanupError = String(cleanup.message ?? cleanup); }
  }
  save(); throw error;
}
finally { if (runtime) { await runtime.stop(); runtime.close(); } }

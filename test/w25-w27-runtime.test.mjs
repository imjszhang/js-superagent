import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { summarizeGitHubCi } from '../src/runtime/github-ci-observation.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/project', prefix = `/repos/${repository}`, head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
const actor = { login: 'alice', id: 10, type: 'User' }, ci = { checkApps: ['ci'] };
const sourceId = 'github-repository:fixture:project';
const check = (id, conclusion, at, name = 'unit', sha = head) => ({ id, name, app: { id: 5, slug: 'ci' }, head_sha: sha,
  status: conclusion === null ? 'in_progress' : 'completed', conclusion, started_at: at, ...(conclusion ? { completed_at: at } : {}) });
function inspect(root, fn) {
  const store = new Store(join(stateDir(root), 'state.sqlite'));
  try { return fn(store); } finally { store.close(); }
}

function ciFixture(t, { complete = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-w25-runtime-'))), runs = [], runtimes = new Set();
  let observation, runtime, clock = Date.now() - 60_000;
  const channel = {
    async getPullRequest() { return { repository, number: 9, id: '900', headSha: head, headRef: 'fix-parser', headRepository: repository,
      state: 'open', merged: false, title: 'Parser', url: `https://github.com/${repository}/pull/9` }; },
    async poll() { return { version: 1, repository, observedAt: new Date().toISOString(), events: [], errors: [], discovery: { complete: true },
      objects: [{ kind: 'issue', number: 7, status: 'ok' }, { kind: 'pull', number: 9, status: 'ok', headSha: head, state: 'open',
        ...(observation ? { observedAt: observation.observedAt, ciSnapshot: observation } : {}) }] }; },
    async deliver(message) { return { id: message.id, url: `https://github.com/${repository}/issues/7#issuecomment-1` }; },
  };
  const open = () => {
    runtime = createProjectAgent({ projectRoot: root, githubChannel: channel, github: { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 86_400_000, ci },
      driver: { async run(input) { runs.push(input); return { version: 2, state: complete ? 'ready' : 'waiting', summary: complete ? 'Verified change' : 'Waiting for selected CI observations', artifacts: [], attention: null }; } } }).init();
    runtimes.add(runtime); return runtime;
  };
  open();
  t.after(async () => { for (const item of runtimes) { await item.stop(); item.close(); } rmSync(root, { recursive: true, force: true }); });
  return { root, runs, get runtime() { return runtime; }, finish() { complete = true; },
    binding() { return runtime.githubStatus().trackedPullRequests.find(item => item.number === 9); },
    async reopen() { await runtime.stop(); runtime.close(); runtimes.delete(runtime); return open(); },
    snapshot(conclusion, { id = 1, name = 'unit', sha = head, missing = false, complete = true } = {}) {
      const at = new Date(clock += 1000).toISOString();
      observation = summarizeGitHubCi({ repository, target: 'pull:9', headSha: sha, config: ci, observedAt: at, complete,
        checks: missing ? [] : [check(id, conclusion, at, name, sha)] }); return observation;
    },
    async initial() {
      runtime.receiveGitHubEvent({ id: `github:${repository}:issue:700`, repository, issueNumber: 7, issueId: 700, kind: 'issue',
        text: '/js-superagent Fix the parser and follow its CI results', title: 'Parser', actor, createdAt: new Date().toISOString(),
        url: `https://github.com/${repository}/issues/7`, issueState: 'open' });
      const ticket = runtime.list()[0]; await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
      await runtime.runNext(); assert.equal(runs.length, 1); return ticket;
    },
  };
}

test('W25 active CI waiting receives running and recovery observations once and retains faults across restart', async t => {
  const f = ciFixture(t), ticket = await f.initial();
  f.snapshot('failure'); await f.runtime.syncGitHub();
  assert.equal(f.binding().ciSnapshot.state, 'failed'); assert.equal(await f.runtime.runNext(), null);
  assert.equal(f.runs.length, 1, 'The first complete CI read is a baseline, not replayed work');
  f.snapshot(null, { id: 2 }); await f.runtime.syncGitHub();
  assert.equal(f.binding().ciSnapshot.state, 'running'); assert.equal((await f.runtime.runNext()).id, ticket.id); assert.equal(f.runs.length, 2);
  const pending = f.binding().ciSnapshot.pendingFailureKeys; assert.equal(pending.length, 1);
  await f.reopen(); assert.deepEqual(f.binding().ciSnapshot.pendingFailureKeys, pending);
  f.finish(); f.snapshot('success', { id: 2 }); await f.runtime.syncGitHub();
  assert.equal(f.binding().ciSnapshot.state, 'passed'); assert.ok(f.binding().ciSnapshot.recoveredAt);
  assert.deepEqual(f.binding().ciSnapshot.pendingFailureKeys, []);
  assert.equal((await f.runtime.runNext()).id, ticket.id); assert.equal(f.runtime.get(ticket.id).status, 'completed');
  assert.equal(f.runs.length, 3); await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null); assert.equal(f.runs.length, 3);
  assert.ok(f.runtime.get(ticket.id).messages.some(message => message.text.includes('previously observed faults have recovered')));
});

test('W25 CI observations on an old head, missing checks or incomplete reads cannot declare recovery', async t => {
  const f = ciFixture(t); await f.initial(); f.snapshot('failure'); await f.runtime.syncGitHub();
  const original = f.binding().ciSnapshot;
  f.snapshot('success', { id: 2, sha: oldHead }); await f.runtime.syncGitHub();
  assert.deepEqual(f.binding().ciSnapshot, original); assert.equal(await f.runtime.runNext(), null);
  for (const options of [{ missing: true }, { name: 'other-check' }, { complete: false }]) {
    f.snapshot('success', { id: 2, ...options }); await f.runtime.syncGitHub();
    const snapshot = f.binding().ciSnapshot;
    assert.equal(snapshot.state, 'unknown'); assert.equal(snapshot.recoveredAt, undefined);
    assert.equal(snapshot.pendingFailureKeys.length, 1); await f.runtime.runNext();
  }
  f.snapshot('success', { id: 2 }); await f.runtime.syncGitHub();
  assert.equal(f.binding().ciSnapshot.state, 'passed'); assert.ok(f.binding().ciSnapshot.recoveredAt);
});

test('W25 selected CI recovery updates a completed ticket observation without reviving its worker', async t => {
  const f = ciFixture(t, { complete: true }), ticket = await f.initial();
  assert.equal(f.runtime.get(ticket.id).status, 'completed');
  f.snapshot('failure'); await f.runtime.syncGitHub();
  f.snapshot(null, { id: 2 }); await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  f.snapshot('success', { id: 2 }); await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  assert.equal(f.binding().ciSnapshot.state, 'passed'); assert.ok(f.binding().ciSnapshot.recoveredAt);
  assert.equal(f.runtime.get(ticket.id).status, 'completed'); assert.equal(f.runs.length, 1); assert.equal(f.runtime.list().length, 1);
});

function reviewFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-w27-runtime-'))), requests = [], reviews = [], runs = [];
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(root, 'README.md'), '# Fixture\n'); git('add', 'README.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  const sha = git('rev-parse', 'HEAD'), secret = 'w27-fixture-not-a-real-secret', secretPath = join(root, 'webhook-secret');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  const rawPull = { id: 900, number: 9, state: 'open', merged: false, title: 'Parser', body: '', user: actor,
    html_url: `https://github.com/${repository}/pull/9`, head: { sha, ref: 'fix-parser', repo: { full_name: repository } }, base: { sha, ref: 'main', repo: { full_name: repository } } };
  const request = async endpoint => {
    const path = endpoint.split('?')[0]; requests.push(path);
    if (path === '/user') return { login: 'agent-account', id: 99, type: 'User' };
    if (path === prefix) return { id: 1, full_name: repository, default_branch: 'main', has_issues: true };
    if (path === `${prefix}/issues` || path === `${prefix}/pulls`) return [];
    if (path === `${prefix}/pulls/9`) return structuredClone(rawPull);
    if (path === `${prefix}/pulls/comments` || path === `${prefix}/pulls/9/comments`) return structuredClone(reviews);
    if (path === `${prefix}/pulls/comments/91`) return structuredClone(reviews[0]);
    if (path === `${prefix}/pulls/9/reviews` || path === `${prefix}/issues/9/comments`) return [];
    throw new Error(`Unexpected fixture request ${endpoint}`);
  };
  const github = { repository, allowedActors: ['alice'], pollIntervalMs: 86_400_000, webhook: { secretPath, port: 0 } };
  const realChannel = createGitHubChannel(github, { request }), sent = [];
  const runtime = createProjectAgent({ projectRoot: root, repositoryRequest: request, github, workspace: { mode: 'worktree' },
    githubChannel: { ...realChannel, async deliver(message, context) { await context.authorizeSend(); sent.push(message); return { id: String(sent.length), url: `https://github.com/${repository}/pull/9#discussion_r91` }; } },
    driver: { async run(input) { runs.push(input); return { status: 'completed', summary: 'Canonical review request verified' }; } },
    assessor: { async assess() { return { kind: 'accept', title: 'Review task', scope: 'Fix canonical review request', reason: 'Explicit authorized review comment', rules: [] }; } } }).init();
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 0 });
  runtime.configureRepositorySource({ enabled: true, streams: { reviewComments: false } }, { expectedRevision: 0 });
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, runtime, requests, runs, reviews, sent,
    due() { inspect(root, store => { const key = `source:${sourceId}:state`; store.setMeta(key, { ...store.getMeta(key), lastAttempt: null }); store.db.exec('UPDATE effects SET due = 0'); }); },
    add() { const at = new Date().toISOString(); reviews.push({ id: 91, body: '/js-superagent Fix the canonical review request', user: actor, created_at: at, updated_at: at,
      html_url: `https://github.com/${repository}/pull/9#discussion_r91`, pull_request_url: `https://api.github.com${prefix}/pulls/9`, commit_id: sha,
      path: 'README.md', line: 1, side: 'RIGHT', diff_hunk: '@@ Fixture @@' }); },
    envelope() { const body = Buffer.from(JSON.stringify({ action: 'created', repository: { full_name: repository }, pull_request: { number: 9 },
      comment: { id: 91, body: 'UNTRUSTED WEBHOOK TEXT' }, sender: actor }));
      return { body, headers: { 'x-github-event': 'pull_request_review_comment', 'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } }; },
  };
}

test('W27 an unbound review requires opt-in, authoritative supplementation and one intake across webhook and poll', async t => {
  const f = reviewFixture(t);
  assert.equal(f.runtime.receiveGitHubWebhook(f.envelope()).status, 'ignored'); assert.equal(f.requests.length, 0);
  f.runtime.configureRepositorySource({ streams: { reviewComments: true } }, { expectedRevision: 1 });
  assert.equal(await f.runtime.runNext(), null); f.add();
  assert.equal(f.runtime.receiveGitHubWebhook(f.envelope()).status, 'accepted');
  assert.equal((await f.runtime.processGitHubWebhooks()).processed, 1);
  assert.ok(f.requests.includes(`${prefix}/pulls/comments/91`)); assert.equal(f.runs.length, 0);
  assert.doesNotMatch(inspect(f.root, store => JSON.stringify(store.listMeta('github:webhook:'))), /UNTRUSTED WEBHOOK TEXT/);
  f.due(); let ticket = await f.runtime.runNext();
  if (!ticket) { await f.runtime.syncGitHub(); f.due(); ticket = await f.runtime.runNext(); }
  assert.ok(f.requests.includes(`${prefix}/pulls/comments`), 'Repository discovery overlaps the already supplemented webhook event');
  assert.equal(f.runtime.list().length, 1); assert.equal(f.runs.length, 1); assert.equal(ticket.status, 'completed');
  assert.match(ticket.text, /canonical review request/); assert.doesNotMatch(ticket.text, /UNTRUSTED/);
  assert.equal(f.runtime.githubStatus().trackedPullRequests[0].ticketId, ticket.id);
  const exact = inspect(f.root, store => store.db.prepare('SELECT data FROM domain_triggers').all().map(row => JSON.parse(row.data)).filter(trigger => trigger.meta?.pullEvent?.reviewCommentId === 91));
  assert.equal(exact.length, 1, 'The shared canonical comment version enters the domain only once');
  await f.runtime.syncGitHub(); f.due(); assert.equal(await f.runtime.runNext(), null); assert.equal(f.runs.length, 1);
});

test('W27 disabling unbound review discovery revokes an accepted selector before any supplementary read', async t => {
  const f = reviewFixture(t);
  f.runtime.configureRepositorySource({ streams: { reviewComments: true } }, { expectedRevision: 1 }); f.add();
  assert.equal(f.runtime.receiveGitHubWebhook(f.envelope()).status, 'accepted');
  f.runtime.configureRepositorySource({ streams: { reviewComments: false } }, { expectedRevision: 2 });
  const result = await f.runtime.processGitHubWebhooks(); assert.equal(result.ignored, 1); assert.equal(result.processed, 0);
  // Only account and repository readiness checks may run; no review content is supplemented.
  assert.deepEqual(f.requests.filter(path => path !== '/user' && path !== prefix), []);
  assert.equal(f.runtime.list().length, 0); assert.equal(f.runtime.githubWebhookStatus().pending, 0);
});

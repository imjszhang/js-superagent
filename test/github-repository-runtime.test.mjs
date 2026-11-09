import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository = 'owner/repo', sourceId = 'github-repository:owner:repo';
const github = { repository, allowedActors: ['owner'], issues: [7], pollIntervalMs: 1000 };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-repository-runtime-')), runtimes = [], pulls = [], sent = [], runs = [], requests = [];
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']); writeFileSync(join(root, 'README.md'), '# Fixture\n'); git(['add', 'README.md']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']);
  const sha = git(['rev-parse', 'HEAD']);
  const metadata = () => ({ repository, number: 9, id: '99', title: 'Parser', headSha: options.head?.() ?? sha, headRef: 'fix-parser', headRepository: repository,
    state: 'open', merged: false, url: `https://github.com/${repository}/pull/9` });
  const request = async endpoint => {
    requests.push(endpoint); const path = endpoint.split('?')[0];
    if (path === `/repos/${repository}`) return { full_name: repository, default_branch: 'main' };
    if (path === `/repos/${repository}/pulls`) return structuredClone(pulls);
    if (path === `/repos/${repository}/pulls/9`) return structuredClone(pulls[0]);
    if (path === `/repos/${repository}/issues/comments`) return [];
    throw new Error(`Unexpected read ${endpoint}`);
  };
  const channel = { async poll() { return []; }, async getPullRequest() { return metadata(); },
    async deliver(message) {
      if (options.deliver) return options.deliver(message, sent);
      sent.push(message); return { id: String(sent.length), url: `https://github.com/${repository}/pull/9#issuecomment-${sent.length}` };
    } };
  const open = () => {
    const runtime = createProjectAgent({ projectRoot: root, repositoryRequest: request, githubChannel: channel,
      driver: { async run(input) { runs.push(input); return { status: options.fail ? 'failed' : 'completed', summary: options.fail ? 'Fixture failure' : 'Verified parser' }; } },
      assessor: { async assess() { return { kind: 'accept', title: 'Parser task', scope: 'Fix parser regression', reason: 'Explicit authorized request', rules: [] }; } } }).init();
    if (!runtime.coordinatorStatus().settings.assessor) runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:0});
    runtimes.push(runtime); return runtime;
  };
  const runtime = open(); runtime.configure({ github, workspace: { mode: 'worktree' } });
  t.after(async () => { for (const item of runtimes.reverse()) { await item.stop(); item.close(); } rmSync(root, { recursive: true, force: true }); });
  const due = () => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { const key = `source:${sourceId}:state`; store.setMeta(key, { ...store.getMeta(key), lastAttempt: null }); } finally { store.close(); } };
  const addPull = () => { const at = new Date().toISOString(); pulls.push({ id: 99, number: 9, state: 'open', merged: false, title: 'Parser', body: '/js-superagent Fix parser regression', user: { login: 'owner', id: 1, type: 'User' },
    created_at: at, updated_at: at, html_url: `https://github.com/${repository}/pull/9`, head: { sha, ref: 'fix-parser', repo: { full_name: repository } }, base: { repo: { full_name: repository } } }); due(); };
  return { root, runtime, open, pulls, sent, runs, requests, due, addPull, sha };
}

test('repository source settings persist, merge partially, and enforce revision and configuration boundaries', async t => {
  const f = fixture(t); assert.equal(f.runtime.getRepositorySourceSettings().enabled, false); assert.deepEqual(f.runtime.sourceStatus(), []);
  const first = f.runtime.configureRepositorySource({ enabled: true, streams: { comments: true } }, { expectedRevision: 0 });
  assert.equal(first.revision, 1); assert.equal(first.streams.pulls, true); assert.equal(f.runtime.sourceStatus()[0].id, sourceId);
  assert.throws(() => f.runtime.configureRepositorySource({ observe: true }, { expectedRevision: 0 }), /revision/);
  assert.throws(() => f.runtime.configureRepositorySource({ typo: true }, { expectedRevision: 1 }), /Unsupported control arguments/);
  assert.throws(() => f.runtime.configure({ github: null }), /Configure GitHub/);
  assert.equal(f.runtime.getConfig().github.repository, repository);
  f.runtime.close(); const reopened = f.open(); assert.equal(reopened.getRepositorySourceSettings().streams.comments, true); assert.equal(reopened.sourceStatus()[0].id, sourceId);
  const next = reopened.configureRepositorySource({ observe: true }, { expectedRevision: 1 }); assert.equal(next.streams.comments, true);
  reopened.configureRepositorySource({ enabled: false }, { expectedRevision: 2 }); assert.deepEqual(reopened.sourceStatus(), []);
});

test('new PR intake binds a non-owned PR, executes once, replies once, and survives restart without an Issue binding', async t => {
  const f = fixture(t); f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  assert.equal(await f.runtime.runNext(), null); f.addPull();
  const ticket = await f.runtime.runNext() ?? await runObserved(f); assert.equal(ticket.status, 'completed'); assert.equal(f.runs.length, 1);
  assert.equal(f.runtime.getWorkspace(ticket.id).baseCommit, f.sha);
  assert.equal(ticket.source.pullNumber, 9); assert.equal(ticket.source.issueNumber, 9);
  assert.equal(f.runtime.githubStatus().trackedIssues.length, 0);
  const binding = f.runtime.githubStatus().trackedPullRequests[0]; assert.equal(binding.own, false); assert.equal(binding.headSha, f.sha); assert.equal(binding.ticketId, ticket.id);
  assert.deepEqual(f.runtime.getDomainTicket(ticket.id).follows, [{thread:`github:${repository}#pr:9`,own:false}]);
  assert.equal(f.runtime.getDomainTicket(ticket.id).mandate.basis.scope.pullNumber, 9);
  const results = f.sent.filter(message => message.text.includes('Verified parser')); assert.equal(results.length, 1); assert.equal(results[0].channel.address.pullNumber, '9'); assert.equal(results[0].channel.address.headSha, f.sha);
  f.runtime.close(); const reopened = f.open(); f.due(); await reopened.runNext(); assert.equal(f.runs.length, 1); assert.equal(reopened.list().length, 1);
  assert.equal(reopened.githubStatus().trackedPullRequests[0].ticketId, ticket.id);
  const review = { id: `github:${repository}:review:100`, kind: 'review', repository, pullNumber: 9, headSha: f.sha, pullState: 'open',
    actor: { login: 'owner', id: '1', type: 'User' }, createdAt: new Date().toISOString(), text: 'Add the missing regression', state: 'COMMENTED', commitId: f.sha };
  assert.equal(reopened.receiveGitHubEvent(review).status, 'received');
  assert.equal((await reopened.runNext()).id, ticket.id); assert.equal(f.runs.length, 2);
  assert.equal(f.sent.filter(message => message.text.includes('Verified parser')).length, 2);
  assert.equal(reopened.getDomainTicket(ticket.id).ended, undefined);
  reopened.receiveGitHubEvent({ ...review, id: `github:${repository}:pull_request_state:9`, kind: 'pull_request_state', text: '', pullState: 'closed', merged: false });
  assert.equal(reopened.getDomainTicket(ticket.id).ended?.outcome, 'closed', 'a ready ticket with only followed PRs ends when all of them close');
});

test('initial PR execution rechecks its head after assessment and defers changed heads', async t => {
  const f = fixture(t, { head: () => 'b'.repeat(40) }); f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  await f.runtime.runNext(); f.addPull(); assert.equal(await f.runtime.runNext() ?? await runObserved(f), null); assert.equal(f.runs.length, 0);
  assert.equal(f.runtime.githubStatus().trackedPullRequests[0].blockedReason, 'head-changed');
  assert.equal(f.runtime.list().length, 1);
});

test('failed initial PR work returns one notice to the bound PR and preserves its head', async t => {
  const f = fixture(t, { fail: true }); f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  await f.runtime.runNext(); f.addPull(); const ticket = await f.runtime.runNext() ?? await runObserved(f); assert.equal(ticket.status, 'failed');
  const failures = f.sent.filter(message => message.kind === 'notice'); assert.equal(failures.length, 1); assert.equal(failures[0].channel.address.pullNumber, '9'); assert.equal(failures[0].channel.address.headSha, f.sha);
});

test('PR intake in copy mode records the task but refuses execution in the wrong project snapshot', async t => {
  const f = fixture(t); f.runtime.configure({ workspace: { mode: 'copy' } }); f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  await f.runtime.runNext(); f.addPull(); const ticket = await f.runtime.runNext() ?? await runObserved(f);
  assert.equal(ticket.status, 'failed'); assert.equal(f.runs.length, 0); assert.match(ticket.reports.at(-1).summary, /requires worktree mode/);
});

test('missing local PR commit fails explicitly without falling back to project HEAD', async t => {
  const missing = 'c'.repeat(40), f = fixture(t, { head: () => missing }); f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  await f.runtime.runNext(); f.addPull(); f.pulls[0].head.sha = missing;
  const ticket = await f.runtime.runNext() ?? await runObserved(f); assert.equal(ticket.status, 'failed'); assert.equal(f.runs.length, 0);
  assert.match(ticket.reports.at(-1).summary, /trusted operator must fetch/); assert.equal(f.runtime.getWorkspace(ticket.id), null);
});

function inlineFeedback(f, comment, root = comment) {
  return { id: `github:${repository}:review_comment:${comment}`, kind: 'review_comment', repository, pullNumber: 9,
    reviewCommentId: comment, reviewRootId: root, ...(comment !== root ? { inReplyToId: root } : {}),
    headSha: f.sha, commitId: f.sha, pullState: 'open', path: 'README.md', line: 1, side: 'RIGHT',
    actor: { login: 'owner', id: '1', type: 'User' }, createdAt: new Date().toISOString(),
    text: `Resolve review thread ${root}`, url: `https://github.com/${repository}/pull/9#discussion_r${comment}` };
}

async function runObserved(f) {
  // Discovery creates a binding; a full channel read establishes freshness before work.
  await f.runtime.syncGitHub();
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  try { store.db.prepare("UPDATE effects SET due = 0 WHERE kind IN ('launch','delivery') AND cancelled = 0").run(); }
  finally { store.close(); }
  return f.runtime.runNext();
}

test('finding dispositions reserve inline replies and keep generic results in the original PR conversation', async t => {
  const f=fixture(t);
  f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  await f.runtime.runNext(); f.addPull(); const ticket = await f.runtime.runNext() ?? await runObserved(f);
  const before = f.sent.length;
  for (const event of [inlineFeedback(f, 201), inlineFeedback(f, 202, 201), inlineFeedback(f, 301)])
    assert.equal(f.runtime.receiveGitHubEvent(event).status, 'received');
  assert.equal((await runObserved(f)).id, ticket.id);
  const results = f.sent.slice(before).filter(message => message.text.includes('Verified parser'));
  assert.equal(results.length,1);assert.equal(results[0].channel.address.reviewRootId,undefined);
  assert.equal(f.runtime.notifications().filter(message=>message.channel.address.reviewRootId&&message.text.includes('Verified parser')).length,0);
  assert.equal(f.runs.length,2);
});

test('W19 host migrates only proven pending destinations before ordering and preserves sent receipts', async t => {
  const f = fixture(t); f.runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  await f.runtime.runNext(); f.addPull(); const ticket = await f.runtime.runNext() ?? await runObserved(f);
  for (const number of [201, 301]) f.runtime.receiveGitHubEvent(inlineFeedback(f, number));
  const domain = f.runtime.getDomainTicket(ticket.id), store = new Store(join(stateDir(f.root), 'state.sqlite'));
  const channel = { source: 'github', thread: `${repository}#pr:9`, address: { repository, pullNumber: '9', headSha: f.sha } };
  const ids = {}, sentOriginal = { id: 'already-sent-legacy', kind: 'reply', ticketId: domain.id, channel, text: 'Already delivered' };
  try {
    store.atomic(() => {
      for (const number of [201, 301]) {
        const input = domain.inputs.find(item => store.triggers.get(item.triggerId)?.meta?.pullEvent?.reviewCommentId === number);
        const id = createHash('sha256').update(JSON.stringify(['ack', input.triggerId])).digest('hex').slice(0, 32); ids[number] = id;
        const message = { id, kind: 'acknowledgement', ticketId: domain.id, channel, text: `Accepted ${number}` };
        store.db.prepare('INSERT INTO receipts(id,data,status) VALUES(?,?,?)').run(id, JSON.stringify(message), 'pending');
        store.db.prepare("INSERT INTO effects(kind,key,payload,due) VALUES('reply',?,'{}',?)").run(id, number === 201 ? Date.now() + 60_000 : 0);
      }
      store.db.prepare('INSERT INTO receipts(id,data,status) VALUES(?,?,?)').run(sentOriginal.id, JSON.stringify(sentOriginal), 'sent');
      const unproven = { id: 'unproven-legacy', kind: 'reply', ticketId: domain.id, channel, text: 'No source association' };
      store.db.prepare('INSERT INTO receipts(id,data,status) VALUES(?,?,?)').run(unproven.id, JSON.stringify(unproven), 'pending');
      store.db.prepare("INSERT INTO effects(kind,key,payload,due) VALUES('reply',?,'{}',0)").run(unproven.id);
    });
    await f.runtime.flushNotifications();
    const messages = f.runtime.notifications();
    assert.equal(messages.find(message => message.id === ids[201]).status, 'pending');
    assert.equal(messages.find(message => message.id === ids[201]).channel.address.reviewRootId, '201');
    assert.equal(messages.find(message => message.id === ids[301]).status, 'sent');
    assert.equal(messages.find(message => message.id === ids[301]).channel.address.reviewRootId, '301');
    assert.equal(messages.find(message => message.id === 'unproven-legacy').channel.address.reviewRootId, undefined);
    assert.equal(messages.find(message => message.id === 'unproven-legacy').status, 'sent');
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT data FROM receipts WHERE id = ?').get(sentOriginal.id).data), sentOriginal);
  } finally { store.close(); }
  assert.equal(f.runs.length, 1, 'Only delivery is exercised after inserting legacy pending fixtures');
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { normalizePullEvent } from '../src/github-pull-intake.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/relink', first = 'a'.repeat(40), second = 'b'.repeat(40), third = 'c'.repeat(40);
const actor = { login: 'alice', id: 10, type: 'User' };

async function fixture(t, { observer = true, kind = 'pr_comment' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-pr-redelivery-'))), calls = [];
  let head = first, comments = [], runtime, clock = Date.now() + 100_000;
  const github = { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 86_400_000 };
  const channel = createGitHubChannel(github, { async request(endpoint) {
    calls.push(endpoint);
    if (endpoint === '/user') return { login: 'agent', id: 11, type: 'User' };
    if (endpoint === `/repos/${repository}`) return { full_name: repository, id: 99, has_issues: true };
    if (endpoint === `/repos/${repository}/issues/7`) return { number: 7, pull_request: {} };
    if (endpoint === `/repos/${repository}/pulls/9`) return { number: 9, id: 900, title: 'Related change', head: { sha: head, ref: 'change', repo: { full_name: repository } },
      base: { repo: { full_name: repository } }, state: 'open', merged: false, user: actor,
      updated_at: new Date(clock).toISOString(), html_url: `https://github.com/${repository}/pull/9` };
    if (endpoint.startsWith(`/repos/${repository}/issues/9/comments?`)) return kind === 'pr_comment' ? comments : [];
    if (endpoint.startsWith(`/repos/${repository}/pulls/9/reviews?`)) return kind === 'review' ? comments : [];
    if (endpoint.startsWith(`/repos/${repository}/pulls/9/comments?`)) return kind === 'review_comment' ? comments : [];
    throw new Error(`Unexpected GitHub request: ${endpoint}`);
  } });
  const options = { projectRoot: root, github, githubChannel: channel, driver: { async run() {
    return { version: 2, state: 'waiting', summary: 'Waiting for feedback', artifacts: [], attention: null };
  } } };
  const open = () => runtime = createProjectAgent(options).init();
  open();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = runtime.submit({ text: 'Own the implementation' }); await runtime.runNext();
  let watcher;
  if (observer) { watcher = runtime.submit({ text: 'Observe the related discussion' }); await runtime.runNext(); runtime.followForContext(watcher.id, { source: 'github', id: `${repository}#pr:9` }); }
  await runtime.linkGitHubPullRequest(owner.id, { number: 9 });
  const inspect = fn => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return fn(store); } finally { store.close(); } };
  return { get runtime() { return runtime; }, owner, watcher, calls, inspect,
    setHead(value) { head = value; },
    comment(text = 'Please fix the regression', rest = {}) {
      const at = new Date(clock += 1000).toISOString();
      comments = [{ id: 42, user: actor, body: text, created_at: at, updated_at: at,
        ...(kind === 'review' ? { submitted_at: at, state: 'COMMENTED', commit_id: head } : {}),
        ...(kind === 'review_comment' ? { commit_id: head, path: 'src/main.mjs', line: 1, side: 'RIGHT', pull_request_url: `https://api.github.com/repos/${repository}/pulls/9`, pull_request_review_id: 51 } : {}),
        html_url: `https://github.com/${repository}/pull/9${kind === 'review' ? '#pullrequestreview-42' : kind === 'review_comment' ? '#discussion_r42' : '#issuecomment-42'}`, ...rest }];
      return comments[0];
    },
    async sync() { return runtime.syncGitHub({ flush: false }); },
    async relink() { return runtime.linkGitHubPullRequest(owner.id, { number: 9 }); },
    inputs() { return runtime.getDomainTicket(owner.id).inputs.filter(input => input.kind === 'trigger' && input.triggerId.startsWith(`github:${repository}:${kind}:42`)); },
    notices() { return watcher ? inspect(store => store.listMeta(`context-notice:${runtime.getDomainTicket(watcher.id).id}:`).map(row => row.value)) : []; },
    pending() { return inspect(store => store.listMeta('github:pull-feedback:').map(row => row.value)); },
    async reopen() { await runtime.stop(); runtime.close(); open(); },
  };
}

for (const kind of ['pr_comment', 'review', 'review_comment']) test(`relinked ${kind} reaches its original owner once after fresh GitHub sync, including reopen`, async t => {
  const f = await fixture(t, { kind }); f.setHead(second); f.comment();
  await f.sync();
  assert.equal(f.inputs().length, 0); assert.equal(f.notices().length, 1);
  assert.equal(f.pending()[0].status, 'pending');
  await f.reopen(); await f.relink();
  assert.equal(f.inputs().length, 0, 'relink does not blindly replay cached comment text');
  await f.sync();
  assert.equal(f.inputs().length, 1); assert.equal(f.notices().length, 1);
  assert.equal(f.pending()[0].status, 'delivered');
  const source = f.inspect(store => store.triggers.get(f.inputs()[0].triggerId));
  assert.equal(source.meta.contextOnly, undefined);
  assert.deepEqual(source.threads, [{ source: 'github', id: `${repository}#pr:9:${f.runtime.getDomainTicket(f.owner.id).id}` }]);
  const receipt = f.inspect(store => store.getMeta(`github:event:${source.id}`));
  assert.equal(receipt.redelivery.ticketId, f.owner.id); assert.deepEqual(receipt.contextTicketIds, [f.watcher.id]);
  await f.sync(); await f.reopen(); await f.sync();
  assert.equal(f.inputs().length, 1); assert.equal(f.notices().length, 1);
  assert.ok(f.calls.filter(path => path.includes(kind === 'pr_comment' ? '/issues/9/comments?' : kind === 'review' ? '/pulls/9/reviews?' : '/pulls/9/comments?')).length >= 4);
});

test('new-head feedback needs explicit relink even across repeated syncs', async t => {
  const f = await fixture(t); f.setHead(second); f.comment();
  await f.sync(); await f.sync(); await f.reopen(); await f.sync();
  assert.equal(f.inputs().length, 0); assert.equal(f.pending()[0].status, 'pending'); assert.equal(f.notices().length, 1);
});

test('relink makes the next regular runtime turn refresh feedback without waiting for the old poll deadline', async t => {
  const f = await fixture(t); f.setHead(second); f.comment(); await f.sync();
  const before = f.calls.filter(path => path.includes('/issues/9/comments?')).length;
  await f.relink(); await f.runtime.runNext();
  assert.equal(f.inputs().length, 1);
  assert.ok(f.calls.filter(path => path.includes('/issues/9/comments?')).length > before);
});

test('unlinking and assigning the PR to another ticket cannot inherit the old owner delivery', async t => {
  const f = await fixture(t); f.setHead(second); f.comment(); await f.sync();
  f.runtime.unlinkGitHubPullRequest(9);
  await f.runtime.linkGitHubPullRequest(f.watcher.id, { number: 9 }); await f.sync();
  assert.equal(f.inputs().length, 0);
  assert.equal(f.runtime.getDomainTicket(f.watcher.id).inputs.filter(input => input.triggerId?.startsWith(`github:${repository}:pr_comment:42`)).length, 0);
  assert.equal(f.pending()[0].reason, 'association-removed');
});

test('business pause keeps deferred owner feedback pending until a fresh post-resume sync', async t => {
  const f = await fixture(t); f.setHead(second); f.comment(); await f.sync(); await f.relink();
  f.runtime.pause(); await f.sync(); assert.equal(f.inputs().length, 0); assert.equal(f.pending()[0].status, 'pending');
  f.runtime.resume(); await f.sync(); assert.equal(f.inputs().length, 1); assert.equal(f.notices().length, 1);
});

test('the latest edited revision is delivered and the older observed question is never replayed', async t => {
  const f = await fixture(t); f.setHead(second); const original = f.comment('Old request'); await f.sync();
  f.comment('Corrected request', { created_at: original.created_at }); await f.relink(); await f.sync();
  assert.equal(f.inputs().length, 1);
  const trigger = f.inspect(store => store.triggers.get(f.inputs()[0].triggerId));
  assert.match(trigger.text, /Corrected request/); assert.doesNotMatch(trigger.text, /Old request/);
  const stale = normalizePullEvent({ id: `github:${repository}:pr_comment:42`, repository, pullNumber: 9, headSha: second,
    kind: 'pr_comment', pullState: 'open', text: original.body, actor, createdAt: original.created_at, updatedAt: original.updated_at, url: original.html_url });
  assert.equal(f.runtime.receiveGitHubEvent(stale).status, 'duplicate'); assert.equal(f.inputs().length, 1);
  assert.equal(f.pending()[0].reason, 'source-revision-retired');
});

test('a later head is not implicitly adopted or used to relabel previously deferred feedback', async t => {
  const f = await fixture(t); f.setHead(second); f.comment(); await f.sync(); await f.relink();
  f.setHead(third); await f.sync(); assert.equal(f.inputs().length, 0);
  await f.relink(); await f.sync(); assert.equal(f.inputs().length, 0);
  assert.equal(f.pending()[0].headSha, second);
});

for (const change of ['revoke', 'unlink', 'handback', 'cancel']) test(`deferred feedback does not bypass ${change}`, async t => {
  const f = await fixture(t); f.setHead(second); f.comment(); await f.sync();
  if (change === 'revoke') f.runtime.configureCoordinator({ policy: { sourceRows: [{ id: 'github', source: 'github', scope: { repository }, actors: [], bots: ['alice'] }] } }, { expectedRevision: 0 });
  if (change === 'unlink') f.runtime.unlinkGitHubPullRequest(9);
  if (change === 'handback') f.inspect(store => { const pending = f.pending()[0], disposition = store.triggers.disposition(pending.triggerId);
    store.triggers.saveDisposition(pending.triggerId, { ...disposition, handbacks: [{ ticketId: f.runtime.getDomainTicket(f.owner.id).id, reason: 'Returned by the operator', at: new Date().toISOString() }] }); });
  if (change === 'cancel') f.runtime.cancel(f.owner.id);
  if (change === 'cancel') await assert.rejects(f.relink(), /authorized/); else await f.relink();
  await f.sync(); assert.equal(f.inputs().length, 0); assert.equal(f.notices().length, 1);
  if (change !== 'cancel') assert.equal(f.pending()[0].status, 'retired');
});

test('a replay cannot replace the original author behind the same revision ID', async t => {
  const f = await fixture(t); f.setHead(second); f.comment(); await f.sync(); await f.relink();
  const original = f.inspect(store => store.triggers.get(f.pending()[0].triggerId).meta.pullEvent);
  assert.equal(f.runtime.receiveGitHubEvent({ ...original, actor: { ...actor, id: 11 } }).status, 'duplicate');
  assert.equal(f.inputs().length, 0); assert.equal(f.pending()[0].reason, 'source-facts-changed');
});

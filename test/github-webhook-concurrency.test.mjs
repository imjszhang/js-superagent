import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository = 'owner/project', secret = 'concurrency-fixture-secret';
const actor = { login: 'alice', id: 1, type: 'User' };
const issue = { id: `github:${repository}:issue:1`, kind: 'issue', repository, issueNumber: 1, issueId: 1,
  text: '/js-superagent Fix the authorized remote task', title: 'Remote task', actor,
  createdAt: '2026-11-01T00:00:00.000Z', url: `https://github.com/${repository}/issues/1`, issueState: 'open' };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function delivery() {
  const body = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 456 } }));
  return { body, headers: { 'x-github-event': 'installation', 'x-github-delivery': randomUUID(),
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for automatic continuation');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-webhook-concurrency-')));
  writeFileSync(join(root, 'secret'), secret);
  let hold, failure = false;
  const calls = [], runtimes = [], barriers = [];
  const channel = { async poll() {
    const barrier = hold;
    if (barrier) { barrier.entered.resolve(); await barrier.release.promise; }
    if (failure) throw new Error('GitHub App API request failed (HTTP 403)');
    return [structuredClone(issue)];
  }, async deliver() { return { id: '1', url: `https://github.com/${repository}/issues/1#issuecomment-1` }; } };
  const driver = { async run(input) { calls.push(input.ticket.id); return { status: 'completed', summary: 'Verified fixture task' }; } };
  const open = () => {
    const runtime = createProjectAgent({ projectRoot: root, githubChannel: channel, driver }).init();
    runtimes.push(runtime); return runtime;
  };
  const runtime = open();
  runtime.configure({ github: { repository, allowedActors: ['alice'], issues: [1], pollIntervalMs: 86_400_000,
    app: { appId: '123', installationId: 456, privateKeyPath: join(root, 'unused-key.pem') }, webhook: { secretPath: join(root, 'secret') } } });
  t.after(async () => {
    for (const barrier of barriers) barrier.release.resolve();
    for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, open, channel, calls, fail(value) { failure = value; },
    hold() { hold = { entered: deferred(), release: deferred() }; barriers.push(hold); return hold; },
    release() { hold?.release.resolve(); hold = undefined; },
    makeDue() { const store = new Store(join(stateDir(root), 'state.sqlite')); try { store.db.exec('UPDATE effects SET due = 0'); } finally { store.close(); } },
  };
}

test('another runtime cannot execute remote work during App removal revalidation but local work continues', { timeout: 15_000 }, async t => {
  const f = fixture(t), a = f.runtime; await a.syncGitHub(); const remote = a.list()[0], b = f.open();
  a.receiveGitHubWebhook(delivery()); f.fail(true);
  const barrier = f.hold(), processing = a.processGitHubWebhooks(); await barrier.entered.promise;
  const local = b.submit({ text: 'Run the independent local task' });
  await assert.rejects(b.runNext(), { code: 'PROJECT_LEASE_BUSY' });
  f.release(); await processing;
  assert.match(a.githubWebhookStatus().lastError, /HTTP 403/);
  assert.equal((await b.runNext()).id, local.id); assert.deepEqual(f.calls, [local.id]);
  assert.equal(b.get(remote.id).status, 'queued'); assert.equal(a.githubWebhookStatus().pending, 1);
  f.fail(false); f.makeDue(); assert.equal((await a.processGitHubWebhooks()).processed, 1);
  b.start({ intervalMs: 10 }); await until(() => b.get(remote.id).status === 'completed'); await b.stop();
  assert.deepEqual(f.calls, [local.id, remote.id]); assert.equal(a.githubWebhookStatus().pending, 0);
});

test('an ordinary sync held by another runtime also blocks remote execution until reconciliation finishes', { timeout: 15_000 }, async t => {
  const f = fixture(t), a = f.runtime; await a.syncGitHub(); const remote = a.list()[0], b = f.open();
  const barrier = f.hold(), syncing = a.syncGitHub(); await barrier.entered.promise;
  assert.equal(a.githubWebhookStatus().pending, 0);
  const local = a.submit({ text: 'Continue local work while GitHub is loading' });
  await assert.rejects(b.runNext(), { code: 'PROJECT_LEASE_BUSY' });
  assert.equal((await a.runNext()).id, local.id); assert.deepEqual(f.calls, [local.id]);
  assert.equal(a.get(remote.id).status, 'queued');
  f.release(); await syncing;
  b.start({ intervalMs: 10 }); await until(() => b.get(remote.id).status === 'completed'); await b.stop();
  assert.deepEqual(f.calls, [local.id, remote.id]);
});

test('a pending delivery in retry backoff blocks remote work even after a separate successful poll clears its error', { timeout: 15_000 }, async t => {
  const f = fixture(t), a = f.runtime; await a.syncGitHub(); const remote = a.list()[0], b = f.open();
  a.receiveGitHubWebhook(delivery()); f.fail(true); await a.processGitHubWebhooks();
  f.fail(false); await a.syncGitHub();
  assert.equal(a.githubStatus().lastError, null); assert.equal(a.githubWebhookStatus().pending, 1);
  const local = b.submit({ text: 'Continue another local task' });
  assert.equal((await b.runNext()).id, local.id); assert.deepEqual(f.calls, [local.id]);
  assert.equal(b.get(remote.id).status, 'queued');
  b.start({ intervalMs: 10 }); await until(() => b.get(remote.id).status === 'completed'); await b.stop();
  assert.equal(a.githubWebhookStatus().pending, 0); assert.deepEqual(f.calls, [local.id, remote.id]);
});

test('a webhook arriving during awaited PR validation is checked again before atomic turn startup', { timeout: 15_000 }, async t => {
  const f = fixture(t), a = f.runtime, headSha = 'a'.repeat(40);
  await a.syncGitHub(); const remote = await a.runNext(); assert.equal(remote.status, 'completed');
  const pull = { repository, number: 9, id: 90, headSha, headRef: 'codex/fixture', headRepository: repository,
    state: 'open', merged: false, url: `https://github.com/${repository}/pull/9`, title: 'Fixture pull request' };
  f.channel.getPullRequest = async () => structuredClone(pull);
  await a.linkGitHubPullRequest(remote.id, { number: 9 });
  a.receiveGitHubEvent({ id: `github:${repository}:review:2`, kind: 'review', repository, pullNumber: 9, headSha,
    pullState: 'open', actor, createdAt: '2026-11-01T00:01:00.000Z', text: 'Verify the reviewed edge case',
    url: `https://github.com/${repository}/pull/9#pullrequestreview-2`, state: 'COMMENTED', commitId: headSha });
  const b = f.open(), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.channel.getPullRequest = async () => { entered.resolve(); await release.promise; return structuredClone(pull); };
  const work = a.runNext(); await entered.promise;
  b.receiveGitHubWebhook(delivery()); release.resolve();
  assert.equal(await work, null); assert.deepEqual(f.calls, [remote.id]); assert.equal(a.get(remote.id).status, 'queued');
  f.channel.getPullRequest = async () => structuredClone(pull);
  assert.equal((await b.processGitHubWebhooks()).processed, 1);
  a.start({ intervalMs: 10 }); await until(() => a.get(remote.id).status === 'completed'); await a.stop();
  assert.deepEqual(f.calls, [remote.id, remote.id]);
});

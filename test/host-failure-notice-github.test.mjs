import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { HOST_FAILURE_NOTICE_TEXT, WORKER_INPUT_UNREAD_CODE } from '../src/runtime/host-failure-notice.mjs';
import { pullReplyChannel } from '../src/runtime/github-review-delivery.mjs';

const repository = 'fixture/project', head = 'a'.repeat(40), when = '2026-11-01T00:00:00.000Z';
const github = { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 1000 };
const actor = { login: 'alice', id: '10', type: 'User' };
const options = { timeout: 15_000 };
const issue = () => ({ id: `github:${repository}:issue:700`, repository, issueNumber: 7, issueId: 700,
  kind: 'issue', text: '/js-superagent Inspect the fictional project', title: 'Fixture task', actor,
  createdAt: when, url: `https://github.com/${repository}/issues/7`, issueState: 'open' });
const note = () => ({ ...issue(), id: `github:${repository}:comment:701`, kind: 'comment', text: 'FICTIONAL_PRIVATE_SUPPLEMENT' });
const pullState = () => ({ id: `github:${repository}:pull_request_state:9:${head}:open`, repository, pullNumber: 9,
  kind: 'pull_request_state', headSha: head, pullState: 'open', merged: false, actor, createdAt: when, text: '',
  url: `https://github.com/${repository}/pull/9` });
const pullNote = () => ({ ...pullState(), id: `github:${repository}:pr_comment:901`,
  kind: 'pr_comment', text: 'FICTIONAL_PRIVATE_PR_SUPPLEMENT' });

function fixture(t, { pause = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-failure-github-'))), events = [issue()], requests = [], posts = [];
  const state = { pause, runs: 0, reviewMissing: false, onLookup: null };
  const comments = new Map();
  const request = async (endpoint, init = {}) => {
    const path = endpoint.split('?')[0], method = init.method ?? 'GET';
    requests.push({ endpoint, method });
    if (method === 'GET') await state.onLookup?.(path);
    if (method === 'GET' && path === '/user') return { ...actor, id: 10 };
    if (method === 'GET' && path === `/repos/${repository}`) return { full_name: repository, id: 99, has_issues: true, permissions: { pull: true, push: true } };
    if (method === 'GET' && path === `/repos/${repository}/pulls/9`) return {
      id: 900, number: 9, title: 'Fixture pull', state: 'open', merged: false,
      html_url: `https://github.com/${repository}/pull/9`,
      base: { repo: { full_name: repository } }, head: { sha: head, ref: 'codex/fixture', repo: { full_name: repository } },
    };
    if (method === 'GET' && path === `/repos/${repository}/pulls/comments/201`) {
      if (state.reviewMissing) throw Object.assign(new Error('Fixture review target disappeared'), { status: 404 });
      return { id: 201, pull_request_url: `https://api.github.com/repos/${repository}/pulls/9`,
        html_url: `https://github.com/${repository}/pull/9#discussion_r201` };
    }
    if (method === 'GET' && [`/repos/${repository}/issues/7/comments`, `/repos/${repository}/issues/9/comments`, `/repos/${repository}/pulls/9/comments`].includes(path))
      return structuredClone(comments.get(path) ?? []);
    if (method === 'POST' && [`/repos/${repository}/issues/7/comments`, `/repos/${repository}/issues/9/comments`, `/repos/${repository}/pulls/9/comments/201/replies`].includes(path)) {
      const id = 1000 + posts.length, review = path.includes('/replies'), number = path.includes('/issues/7/') ? 7 : 9;
      const posted = { id, body: init.body.body, user: { ...actor, id: 10 },
        html_url: `https://github.com/${repository}/${number === 7 ? 'issues' : 'pull'}/${number}#${review ? 'discussion_r' : 'issuecomment-'}${id}`,
        ...(review ? { in_reply_to_id: 201 } : {}) };
      posts.push({ path, body: init.body.body });
      const listPath = review ? `/repos/${repository}/pulls/9/comments` : path;
      comments.set(listPath, [...(comments.get(listPath) ?? []), posted]);
      return structuredClone(posted);
    }
    throw new Error(`Unexpected fixture-only GitHub request: ${method} ${path}`);
  };
  // Keep real channel delivery/reconciliation/authorization. Only poll discovery
  // and HTTP are fixture ports; neither gh nor the network can be reached.
  const channel = createGitHubChannel(github, { request });
  channel.poll = async () => structuredClone(events);
  let runtime;
  const driver = { capabilities: { boundedContextVersion: 1, sessionResume: true }, async run(input) {
    state.runs++; input.checkpoint({ driver: 'fixture', id: 'github-host-notice-session' });
    if (state.pause) runtime.pause('Hold the host notice before any network write');
    return { version: 2, state: 'ready', summary: 'FICTIONAL_PRIVATE_REJECTED_RESULT', artifacts: [], attention: null };
  } };
  runtime = createProjectAgent({ projectRoot: root, github, githubChannel: channel, driver }).init();
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { store.close(); await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  return { get runtime() { return runtime; }, store, state, events, requests, posts,
    notices: () => runtime.notifications().filter(message => message.id.startsWith('host-failure-notice-')),
    noticePosts: () => posts.filter(post => post.body.includes(HOST_FAILURE_NOTICE_TEXT)),
    async start({ reviewOrigin = false } = {}) {
      await runtime.syncGitHub(); const ticket = runtime.list()[0]; assert.ok(ticket);
      await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
      events.push(note(), pullState(), pullNote()); await runtime.syncGitHub();
      const inputs = runtime.getDomainTicket(ticket.id).inputs;
      assert.ok(inputs.some(input => store.triggers.get(input.triggerId)?.meta?.pullEvent?.kind === 'pr_comment'),
        `the real intake must attach PR feedback for the fanout regression: ${JSON.stringify(inputs)}`);
      if (reviewOrigin) {
        // Start after a review source was authorized and attached. This isolated
        // persisted fixture tests original-route delivery, not review admission.
        const domain = runtime.getDomainTicket(ticket.id), original = store.triggers.get(domain.origin.triggerId);
        const channel = pullReplyChannel({ repository, pullNumber: 9, headSha: head, reviewRootId: 201, reviewCommentId: 201 });
        store.triggers.save({ ...original, channel });
        domain.channels = [channel]; store.tickets.save(domain);
      }
      return ticket;
    },
    async flush() { store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run(); await runtime.flushNotifications(); },
    async reopenWithGitHub(config) {
      await runtime.stop(); runtime.close();
      runtime = createProjectAgent({ projectRoot: root, github: config, githubChannel: channel, driver }).init();
      await runtime.prepareExecution();
    },
  };
}

test('GitHub host unread failure sends one fixed origin notice without legacy issue or PR fanout', options, async t => {
  const f = fixture(t), ticket = await f.start(); await f.runtime.runNext(); await f.flush();
  assert.equal(f.runtime.getDetailed(ticket.id).failure.code, WORKER_INPUT_UNREAD_CODE);
  assert.equal(f.runtime.getDomainTicket(ticket.id).assignments.at(-1).report.state, 'blocked');
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].status, 'sent', JSON.stringify(f.store.db.prepare('SELECT * FROM effects').all()));
  assert.equal(f.noticePosts().length, 1); assert.equal(f.noticePosts()[0].path, `/repos/${repository}/issues/7/comments`);
  assert.doesNotMatch(f.noticePosts()[0].body, /FICTIONAL_PRIVATE/);
  assert.equal(f.runtime.notifications().some(message => /^(?:failure-|pr-)/.test(message.id)), false);
  assert.equal(f.posts.some(post => post.path.includes('/issues/9/')), false);
  await f.flush(); await f.runtime.syncGitHub(); await f.flush();
  assert.equal(f.notices().length, 1); assert.equal(f.noticePosts().length, 1); assert.equal(f.state.runs, 1);
});

test('GitHub missing original review thread withdraws a pending host notice without PR conversation fallback', options, async t => {
  const f = fixture(t, { pause: true }); await f.start({ reviewOrigin: true }); await f.runtime.runNext();
  assert.equal(f.notices().length, 1); const original = f.notices()[0]; assert.equal(original.status, 'pending');
  f.state.reviewMissing = true; f.runtime.resume(); await f.flush();
  assert.ok(f.requests.some(request => request.endpoint.endsWith('/pulls/comments/201')), 'actual adapter must inspect the original review target');
  assert.equal(f.notices()[0].id, original.id); assert.equal(f.notices()[0].status, 'dropped');
  assert.deepEqual(f.notices()[0].channel, original.channel); assert.equal(f.noticePosts().length, 0);
  assert.equal(f.posts.some(post => post.path.includes('/issues/9/')), false);
  assert.equal(f.store.getMeta(`host-failure-notice-attempt:${original.id}`), undefined);
  assert.equal(f.runtime.notifications().some(message => /^(?:failure-|pr-|material-notice:)/.test(message.id)), false);
});

test('GitHub revoked source mandate rejects a queued host notice without rerouting', options, async t => {
  const f = fixture(t, { pause: true }); await f.start(); await f.runtime.runNext();
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].status, 'pending');
  await f.reopenWithGitHub({ ...github, allowedActors: ['other'] });
  f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.noticePosts().length, 0);
  assert.equal(f.store.getMeta(`host-failure-notice-attempt:${f.notices()[0].id}`), undefined);
  assert.equal(f.runtime.notifications().some(message => /^(?:failure-|pr-|material-notice:)/.test(message.id)), false);
});

test('GitHub checks host notice authorization again after lookup and before the actual write', options, async t => {
  const f = fixture(t, { pause: true }), ticket = await f.start(); await f.runtime.runNext();
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].status, 'pending');
  f.state.onLookup = async path => {
    if (path !== `/repos/${repository}/issues/7/comments`) return;
    f.state.onLookup = null;
    f.runtime.cancel(ticket.id);
  };
  f.runtime.resume(); await f.flush();
  assert.equal(f.state.onLookup, null, 'human stop happens between lookup and send authorization');
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended.by, 'human');
  assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.noticePosts().length, 0);
  assert.equal(f.store.getMeta(`host-failure-notice-attempt:${f.notices()[0].id}`), undefined);
  assert.equal(f.runtime.notifications().some(message => /^(?:failure-|pr-|material-notice:)/.test(message.id)), false);
});

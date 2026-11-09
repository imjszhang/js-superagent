import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { createGitHubRepositorySource } from '../src/channels/github-repository.mjs';
import { GitHubRequestError } from '../src/channels/github-errors.mjs';
import { normalizePullEvent, pullEventText } from '../src/github-pull-intake.mjs';

const repository = 'owner/repo', prefix = `/repos/${repository}`, head = 'a'.repeat(40);
const user = { id: 17, login: 'owner', type: 'User' }, at = '2026-11-02T00:00:00.000Z';
const options = { repository, allowedActors: ['owner'] };
const issue = number => ({ id: 100 + number, number, state: 'open', title: 'Task', body: '/js-superagent fix', user,
  html_url: `https://github.com/${repository}/issues/${number}`, created_at: at, updated_at: at });
const pull = number => ({ ...issue(number), merged: false, html_url: `https://github.com/${repository}/pull/${number}`,
  base: { repo: { full_name: repository } }, head: { sha: head, ref: 'fix', repo: { full_name: repository } } });
const inline = (id, parent) => ({ id, body: parent ? 'Here too, as above' : 'Handle empty values', user,
  pull_request_url: `https://api.github.com${prefix}/pulls/7`, html_url: `https://github.com/${repository}/pull/7#discussion_r${id}`,
  commit_id: head, path: 'parser.js', line: 9, side: 'RIGHT', original_line: 7, diff_hunk: '@@ -7 +9 @@\n+ parse(input)',
  created_at: at, updated_at: at, ...(parent ? { in_reply_to_id: parent } : {}) });
const message = id => ({ id, ticketId: 'ticket', kind: 'reply', text: 'Fixed and verified', channel: { source: 'github',
  thread: `${repository}#pr:7`, address: { repository, pullNumber: '7', headSha: head, reviewRootId: '31', reviewCommentId: '32' } } });
const context = { projectId: 'project', pullRequests: [{ number: 7, headSha: head, ticketId: 'ticket' }] };

test('W15 a missing or malformed object does not discard healthy events; skipped objects gain no observation', async () => {
  const calls = [], channel = createGitHubChannel({ ...options, issues: [1, 2, 3] }, { request: async endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('/comments?')) return [];
    const n = Number(endpoint.split('/').at(-1));
    if (n === 2) throw new GitHubRequestError(404);
    return { ...issue(n), ...(n === 3 ? { user: null } : {}) };
  } });
  const result = await channel.poll();
  assert.deepEqual(result.events.map(event => event.issueNumber), [1]);
  assert.deepEqual(result.objects.map(object => [object.number, object.status]), [[1, 'ok'], [2, 'failed'], [3, 'failed']]);
  assert.equal(result.objects[1].error.category, 'not-found'); assert.equal(result.errors.length, 0);
  calls.length = 0;
  const skipped = await channel.poll({ skipObjects: [{ kind: 'issue', number: 2 }] });
  assert.equal(skipped.objects.some(object => object.number === 2), false);
  assert.equal(calls.includes(`${prefix}/issues/2`), false);
});

test('W15 repository authentication and discovery failures are distinct from an object failure', async () => {
  let status = 401;
  const channel = createGitHubChannel(options, { request: async endpoint => {
    if (endpoint.includes('/issues?')) throw new GitHubRequestError(status);
    if (endpoint.includes('/comments?')) return [];
    return issue(1);
  } });
  const auth = await channel.poll({ trackedIssues: [1] });
  assert.equal(auth.errors[0].scope, 'repository'); assert.equal(auth.objects[0].status, 'ok');
  status = 503;
  const discovery = await channel.poll({ trackedIssues: [1] });
  assert.equal(discovery.errors[0].scope, 'discovery'); assert.equal(discovery.discovery.complete, false);
  assert.equal(discovery.events.length, 1);
});

test('W15 discovery saves failed object retries beyond the stream cursor and keeps malformed anonymous pages unadvanced', async () => {
  let now = Date.parse(at), fail = true, listed = true;
  const source = createGitHubRepositorySource(options, { streams: { pulls: false, issues: true }, now: () => now, request: async endpoint => {
    if (endpoint === prefix) return { full_name: repository, default_branch: 'main' };
    if (endpoint.includes('/issues?')) return listed ? [issue(1), { ...issue(2), body: fail ? 3 : 'fixed' }] : [];
    if (endpoint === `${prefix}/issues/2`) return { ...issue(2), body: fail ? 3 : '/js-superagent fixed' };
    throw new Error('Unexpected fixture endpoint');
  } });
  const baseline = await source.poll(); now += 5000;
  const first = await source.poll({ cursor: baseline.cursor });
  assert.equal(first.events.length, 1); assert.equal(first.cursor.streams.issues.retries[0].number, 2);
  assert.notEqual(first.cursor.streams.issues.since, baseline.cursor.streams.issues.since);
  now += 5000; listed = false; fail = false;
  const recovered = await source.poll({ cursor: first.cursor });
  assert.deepEqual(recovered.events.map(event => event.number), [2]); assert.equal(recovered.cursor.streams.issues.retries, undefined);
  const malformed = createGitHubRepositorySource(options, { streams: { pulls: false, issues: true }, now: () => now, request: async () => [issue(1), { id: null }] });
  const unknown = await malformed.poll({ cursor: first.cursor });
  assert.equal(unknown.cursor.streams.issues.since, first.cursor.streams.issues.since);
  assert.equal(unknown.events.some(event => event.number === 1), true);
});

test('W15 default-branch CI isolates checks and statuses, holds unknown identities and retries known ids beyond the cursor', async () => {
  let now = Date.parse(at), phase = 0;
  const check = (id, name = 'tests') => ({ id, name, head_sha: head, status: 'completed', conclusion: 'failure', completed_at: at,
    app: { id: 5, slug: 'checks' }, output: { summary: 'A regression failed' } });
  const status = (id, creator = user) => ({ id, context: 'ci/tests', state: 'failure', created_at: at, creator, description: 'Tests failed' });
  const calls = [], source = createGitHubRepositorySource({ ...options,
    ci: { checkApps: ['checks'], statusContexts: ['ci/tests'], statusActors: ['owner'] } }, {
    streams: { pulls: false, defaultBranchCI: true }, observe: true, now: () => now,
    request: async endpoint => {
      calls.push(endpoint);
      if (endpoint === prefix) return { id: 1, full_name: repository, default_branch: 'main' };
      if (endpoint === `${prefix}/commits/main` || endpoint.startsWith(`${prefix}/commits/main?`)) return { sha: head };
      if (endpoint.includes('/check-runs?')) return { check_runs: phase === 3 ? [] : [check(31), check(32, 7), ...(phase === 1 ? [{ id: null }] : [])] };
      if (endpoint.includes('/statuses')) return phase === 3 ? [status(42, user)] : [status(41), status(42, null)];
      if (endpoint === `${prefix}/check-runs/32`) return check(32, phase === 3 ? 'fixed tests' : 7);
      throw new Error('Unexpected CI fixture read');
    },
  });
  const baseline = await source.poll(); now += 5000; phase = 1;
  const mixed = await source.poll({ cursor: baseline.cursor });
  assert.deepEqual(mixed.events.map(event => event.id), [`github:${repository}:branch_check:31:failure`, `github:${repository}:branch_status:41`]);
  assert.equal(mixed.cursor.streams.defaultBranchCI.since, baseline.cursor.streams.defaultBranchCI.since);
  assert.deepEqual(mixed.cursor.streams.defaultBranchCI.retries.map(item => [item.kind, item.id]), [['check', 32], ['status', 42]]);
  now += 1000; phase = 2;
  const identified = await source.poll({ cursor: mixed.cursor });
  assert.deepEqual(identified.events.map(event => event.id), mixed.events.map(event => event.id), 'Healthy re-observations retain their dedupe identities');
  assert.notEqual(identified.cursor.streams.defaultBranchCI.since, mixed.cursor.streams.defaultBranchCI.since);
  now += 5000; phase = 3;
  const recovered = await source.poll({ cursor: identified.cursor });
  assert.deepEqual(recovered.events.map(event => event.id).filter(id => !id.includes(':branch_ci:')), [`github:${repository}:branch_check:32:failure`, `github:${repository}:branch_status:42`]);
  assert.equal(recovered.cursor.streams.defaultBranchCI.retries, undefined);
  assert.ok(calls.some(endpoint => endpoint === `${prefix}/check-runs/32`));
  assert.ok(calls.some(endpoint => endpoint.includes(`/commits/${head}/statuses?`)));
});

test('W19 inline feedback retains root, parent, diff and original position as bounded source context', async () => {
  const channel = createGitHubChannel(options, { request: async endpoint => {
    if (endpoint.includes('/issues?')) return [];
    if (endpoint === `${prefix}/pulls/7`) return pull(7);
    if (endpoint.includes('/pulls/7/comments?')) return [inline(31), inline(32, 31)];
    return [];
  } });
  const result = await channel.poll({ trackedPullRequests: context.pullRequests });
  assert.equal(result.objects[0].status, 'ok');
  const event = normalizePullEvent(result.events.find(item => item.reviewCommentId === 32));
  assert.equal(event.reviewRootId, 31); assert.equal(event.inReplyToId, 31); assert.equal(event.originalLine, 7);
  assert.equal(event.reviewContext[0].commentId, 31); assert.match(pullEventText(event), /Handle empty values/);
  assert.throws(() => normalizePullEvent({ ...event, reviewRootId: -1 }), /reviewRootId/);
});

test('W19 inline response loss reconciles in the original thread before a blocked new-send gate', async () => {
  const replies = []; let posts = 0, checks = 0;
  const channel = createGitHubChannel(options, { request: async (endpoint, init) => {
    if (endpoint === '/user') return user;
    if (endpoint.includes('/pulls/7/comments?')) return replies;
    if (endpoint.includes('/issues/7/comments?')) return [];
    if (endpoint === `${prefix}/pulls/comments/32`) return inline(32, 31);
    if (endpoint === `${prefix}/pulls/comments/31`) return inline(31);
    if (endpoint === `${prefix}/pulls/7/comments/31/replies`) {
      posts++; replies.push({ ...inline(90, 31), body: init.body.body }); throw new Error('accepted response lost');
    }
    throw new Error('Unexpected fixture endpoint');
  } });
  await assert.rejects(channel.deliver(message('one'), { ...context, authorizeSend: () => { checks++; } }), /response lost/);
  const receipt = await channel.deliver(message('one'), { ...context, authorizeSend: () => { throw new Error('No new writes'); } });
  assert.equal(receipt.url, `https://github.com/${repository}/pull/7#discussion_r90`);
  assert.equal(receipt.destination.reviewRootId, '31'); assert.equal(posts, 1); assert.equal(checks, 1);
  const wrong = message('wrong-root'); wrong.channel.address.reviewRootId = '99';
  await assert.rejects(channel.deliver(wrong, context), /root does not match/); assert.equal(posts, 1);
});

test('W19 missing review target falls back only after accessible parent verification and deduplicates the fallback', async () => {
  const comments = []; let posts = 0, parentReads = 0;
  const channel = createGitHubChannel(options, { request: async (endpoint, init) => {
    if (endpoint === '/user') return user;
    if (endpoint.includes('/pulls/7/comments?')) return [];
    if (endpoint.includes('/issues/7/comments?')) return comments;
    if (endpoint.includes('/pulls/comments/')) throw new GitHubRequestError(404);
    if (endpoint === `${prefix}/pulls/7`) { parentReads++; return pull(7); }
    if (endpoint === `${prefix}/issues/7/comments`) {
      posts++; comments.push({ id: 91, user, body: init.body.body, html_url: `https://github.com/${repository}/pull/7#issuecomment-91` });
      throw new Error('fallback response lost');
    }
    throw new Error('Unexpected fixture endpoint');
  } });
  await assert.rejects(channel.deliver(message('two'), context), /response lost/);
  const receipt = await channel.deliver(message('two'), context);
  assert.equal(receipt.destination.kind, 'conversation'); assert.equal(receipt.destination.fallbackReason, 'review-target-missing');
  assert.equal(parentReads, 1); assert.equal(posts, 1);
});

test('W16 only typed gone/locked results settle; ordinary 404 and forbidden remain retryable', async () => {
  for (const [status, text, gone] of [[410, '', 'deleted'], [403, 'Issue is locked', 'locked'], [404, '', null], [403, 'Forbidden', null]]) {
    const channel = createGitHubChannel(options, { request: async endpoint => {
      if (endpoint === '/user') return user;
      throw new GitHubRequestError(status, { message: text });
    } });
    const request = { ...message('three'), channel: { source: 'github', thread: `${repository}#1`, address: { repository, issueNumber: '1' } } };
    if (gone) assert.deepEqual(await channel.deliver(request, context), { status: 'gone', reason: gone });
    else await assert.rejects(channel.deliver(request, context), new RegExp(`HTTP ${status}`));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { createGitHubRepositorySource } from '../src/channels/github-repository.mjs';
import { normalizeRepositorySourceSettings } from '../src/runtime/repository-source.mjs';
import { summarizeGitHubCi, observeGitHubCi } from '../src/runtime/github-ci-observation.mjs';
import { webhookRoute } from '../src/github-webhook-inbox.mjs';
import { createRuntimePolicy } from '../src/policy.mjs';

const repository = 'fixture/followup', prefix = `/repos/${repository}`, head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
const user = { id: 1, login: 'alice', type: 'User' }, bot = { id: 2, login: 'reviewer[bot]', type: 'Bot' };
const config = { repository, issues: [1], allowedActors: ['alice'], ci: { checkApps: ['ci'], statusContexts: ['test'], statusActors: ['alice'] } };
const start = Date.parse('2026-11-02T10:00:00Z');
const at = offset => new Date(start + offset).toISOString();
const pull = (state = 'open') => ({ id: 107, number: 7, state, merged: state === 'closed', title: 'Original PR', user,
  created_at: at(0), updated_at: at(1000), html_url: `https://github.com/${repository}/pull/7`,
  head: { sha: head, ref: 'original', repo: { full_name: repository } }, base: { sha: oldHead, ref: 'main', repo: { full_name: repository } } });
const review = (id = 91, actor = user) => ({ id, body: '/js-superagent Explain this earlier line', user: actor,
  created_at: at(2000), updated_at: at(2000), html_url: `https://github.com/${repository}/pull/7#discussion_r${id}`,
  pull_request_url: `https://api.github.com${prefix}/pulls/7`, path: 'src/example.mjs', line: null, side: 'RIGHT', original_line: 8, original_side: 'RIGHT',
  commit_id: oldHead, diff_hunk: '@@ old context @@' });
const check = (id, conclusion, offset = 2000) => ({ id, name: 'unit', app: { id: 10, slug: 'ci' }, head_sha: head,
  status: conclusion === null ? 'in_progress' : 'completed', conclusion, started_at: at(offset), ...(conclusion ? { completed_at: at(offset + 10) } : {}), output: {} });
const status = (id, state, offset = 2000, actor = user) => ({ id, context: 'test', state, creator: actor, created_at: at(offset), description: state });

function transport({ state = 'open', comments = [], reviews = [], checks = [], statuses = [] } = {}) {
  const calls = [];
  const request = async (endpoint, options = {}) => {
    const path = endpoint.split('?')[0]; calls.push({ path, method: options.method ?? 'GET' });
    if (path === '/user') return user;
    if (path === prefix) return { full_name: repository, default_branch: 'main' };
    if (path === `${prefix}/commits/main`) return { sha: head };
    if (path === `${prefix}/issues/1`) return { id: 101, number: 1, state: 'closed', title: 'Old issue', body: '', user,
      created_at: at(0), html_url: `https://github.com/${repository}/issues/1` };
    if (path === `${prefix}/issues/1/comments`) return [];
    if (path === `${prefix}/pulls/7`) return pull(state);
    if (path === `${prefix}/pulls/7/reviews`) return [];
    if (path === `${prefix}/pulls/7/comments` || path === `${prefix}/pulls/comments`) return reviews;
    if (/\/pulls\/comments\/\d+$/.test(path)) return reviews.find(item => item.id === Number(path.split('/').at(-1)));
    if (path === `${prefix}/issues/7/comments`) {
      if (options.method === 'POST') return { id: 201, body: options.body.body, user, html_url: `https://github.com/${repository}/pull/7#issuecomment-201` };
      return comments;
    }
    if (path.endsWith('/check-runs')) return { total_count: checks.length, check_runs: checks };
    if (/\/check-runs\/\d+\/annotations$/.test(path)) return [];
    if (path.endsWith('/statuses')) return statuses;
    throw new Error(`Unexpected fixture read ${path}`);
  };
  return { request, calls };
}

test('W24 closed discussions stay readable and replyable without enabling CI or writing old heads', async () => {
  const comment = { id: 90, body: 'One follow-up question', user, created_at: at(2000), updated_at: at(2000), html_url: `https://github.com/${repository}/pull/7#issuecomment-90` };
  const f = transport({ state: 'closed', comments: [comment], reviews: [review()] });
  const channel = createGitHubChannel(config, f);
  const result = await channel.poll({ trackedPullRequests: [{ number: 7, headSha: oldHead }] });
  assert.equal(result.errors.length, 0); assert.equal(result.objects.find(row => row.kind === 'pull').status, 'ok');
  assert.ok(result.events.some(event => event.kind === 'pr_comment' && event.pullState === 'closed'));
  const inline = result.events.find(event => event.kind === 'review_comment');
  assert.equal(inline.commitId, oldHead); assert.equal(inline.historicalPosition, true); assert.equal(inline.pullRequest.baseRef, 'main');
  assert.equal(f.calls.some(call => call.path.includes('/check-runs')), false);
  let authorized = false;
  const reply = await channel.deliver({ id: 'reply1', ticketId: 'ticket1', kind: 'reply', text: 'Here is the answer',
    channel: { source: 'github', thread: `${repository}#pr:7`, address: { repository, pullNumber: '7', headSha: oldHead } } },
    { projectId: 'project1', pullRequests: [{ number: 7, headSha: oldHead, ticketId: 'ticket1' }], authorizeSend() { authorized = true; } });
  assert.equal(authorized, true); assert.equal(reply.id, '201');
  const open = createGitHubChannel(config, transport());
  const stale = await open.poll({ trackedPullRequests: [{ number: 7, headSha: oldHead }] });
  assert.deepEqual(stale.events.filter(event => event.pullNumber === 7).map(event => event.kind), ['pull_request_state']);
});

test('W27 opt-in discovery and signed unbound review hints preserve one canonical comment and its historical root', async () => {
  let now = start; const reviews = [], f = transport({ reviews });
  const settings = normalizeRepositorySourceSettings({ enabled: true, streams: { pulls: false, reviewComments: true } });
  const source = createGitHubRepositorySource(config, { ...f, streams: settings.streams, now: () => now });
  const baseline = await source.poll(); assert.equal(baseline.events.length, 0);
  now += 5000; reviews.push(review(91), { ...review(92), in_reply_to_id: 91 });
  const listed = await source.poll({ cursor: baseline.cursor }); assert.deepEqual(listed.errors, []);
  const trigger = source.normalize(listed.events.find(event => event.reviewCommentId === 92));
  assert.equal(trigger.channel.address.reviewRootId, '91'); assert.equal(trigger.meta.pullEvent.commitId, oldHead);
  const hint = { event: 'pull_request_review_comment', payload: { action: 'created', repository: { full_name: repository }, pull_request: { number: 7 }, comment: { id: 92 } } };
  assert.equal(webhookRoute(hint, config, []).accepted, false);
  const routed = webhookRoute(hint, config, [], settings);
  assert.deepEqual(routed.selector, { kind: 'pull', number: 7, reviewCommentId: 92 });
  const polled = await createGitHubChannel(config, f).poll({ candidateReviewComments: [{ number: 7, commentId: 92 }] });
  const event = polled.events.find(item => item.reviewCommentId === 92);
  const fromWebhook = source.normalize({ ...event, number: 7, at: event.updatedAt, title: event.pullRequest.title });
  assert.equal(fromWebhook.id, trigger.id); assert.equal(fromWebhook.channel.address.reviewRootId, '91');
  assert.equal(polled.events.filter(item => item.pullNumber === 7).length, 1, 'a hint never replays the entire unbound PR');
  assert.equal(normalizeRepositorySourceSettings().streams.reviewComments, false);
});

test('W26 discovery keeps actor facts while current Policy retains default denial and inferred bot boundaries', () => {
  const source = createGitHubRepositorySource(config, { ...transport(), streams: { pulls: false, reviewComments: true } });
  const pr = { repository, number: 7, headRepository: repository, headSha: head };
  const event = { ...review(), repository, kind: 'review_comment', id: `github:${repository}:review_comment:91`, number: 7, pullNumber: 7, at: at(2000),
    text: '/js-superagent Inspect this', actor: { ...bot, id: String(bot.id) }, pullRequest: pr, reviewRootId: 91, headSha: head };
  const trigger = source.normalize(event);
  assert.equal(trigger.human, false); assert.equal(trigger.actor.id, bot.login);
  assert.equal(createRuntimePolicy().gate(trigger).admissible, false);
  const policy = createRuntimePolicy({ config: { mode: 'auto', rules: [{ id: 'r', enabled: true, instruction: 'Inspect configured review feedback' }],
    sourceRows: [{ id: 'g', source: 'github', scope: { repository }, bots: [bot.login] }] } });
  assert.equal(policy.gate(trigger).strength, 'inferred');
  const stranger = source.normalize({ ...event, actor: { login: 'stranger', id: '3', type: 'User' } });
  assert.ok(stranger); assert.equal(createRuntimePolicy().gate(stranger).admissible, false);
});

test('W25 snapshots distinguish selected recovery, incomplete reads, rerun ambiguity and older observations', () => {
  const snapshot = (checks, statuses, offset, complete = true) => summarizeGitHubCi({ repository, target: 'pull:7', headSha: head,
    config: config.ci, checks, statuses, complete, observedAt: at(offset) });
  const failed = observeGitHubCi(null, snapshot([check(1, 'failure')], [status(10, 'success')], 3000));
  assert.equal(failed.baseline, true);
  const missing = observeGitHubCi(failed.snapshot, snapshot([{ ...check(5, 'success', 4000), name: 'different check' }], [status(10, 'success')], 5000));
  assert.equal(missing.snapshot.state, 'unknown'); assert.equal(missing.recovered, false);
  const running = observeGitHubCi(failed.snapshot, snapshot([check(2, null, 4000)], [status(10, 'success')], 5000));
  assert.equal(running.snapshot.state, 'running'); assert.equal(running.recovered, false);
  const incomplete = observeGitHubCi(running.snapshot, snapshot([check(2, 'success', 4000)], [status(10, 'success')], 6000, false));
  assert.equal(incomplete.recovered, false); assert.equal(incomplete.snapshot.state, 'unknown');
  const recovered = observeGitHubCi(incomplete.snapshot, snapshot([check(2, 'success', 4000)], [status(10, 'success')], 7000));
  assert.equal(recovered.recovered, true); assert.equal(recovered.snapshot.scope, 'selected-observations');
  assert.equal(observeGitHubCi(recovered.snapshot, { ...recovered.snapshot, observedAt: at(8000) }).changed, false);
  assert.equal(observeGitHubCi(recovered.snapshot, failed.snapshot).ignored, 'older-observation');
  const ambiguous = snapshot([check(3, 'success', 8000), check(4, 'failure', 8000)], [status(10, 'success')], 9000);
  assert.equal(ambiguous.ambiguous.length, 1); assert.notEqual(ambiguous.state, 'passed');
  assert.equal(snapshot([], [], 9000).state, 'unknown');
});

test('W25 default branch baseline retains faults and emits one context-only recovery without claiming required checks', async () => {
  let now = start + 3000; const checks = [check(1, 'failure')], statuses = [status(10, 'success')], f = transport({ checks, statuses });
  const source = createGitHubRepositorySource(config, { ...f, observe: true, streams: { pulls: false, defaultBranchCI: true }, now: () => now });
  const baseline = await source.poll(); assert.deepEqual(baseline.errors, []); assert.equal(baseline.events.length, 0);
  now += 5000;
  const unchanged = await source.poll({ cursor: baseline.cursor }); assert.equal(unchanged.events.length, 0);
  checks.splice(0, 1, check(2, 'success', 9000)); now += 5000;
  const result = await source.poll({ cursor: unchanged.cursor }); assert.deepEqual(result.errors, []);
  const transitions = result.events.filter(event => event.kind === 'ci_state'); assert.equal(transitions.length, 1);
  assert.equal(transitions[0].ciTransition.recovered, true);
  const trigger = source.normalize(transitions[0]); assert.equal(trigger.meta.contextOnly, true); assert.equal(trigger.human, false);
  assert.match(trigger.text, /not all required checks/);
  now += 5000; const duplicate = await source.poll({ cursor: result.cursor }); assert.equal(duplicate.events.length, 0);
});

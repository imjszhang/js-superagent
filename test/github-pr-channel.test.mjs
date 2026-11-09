import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubChannel } from '../src/channels/github.mjs';

const repository = 'owner/repo', head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const user = { login: 'Operator', id: 42, type: 'User' };
const options = { repository, allowedActors: ['operator'] };
const ci = { checkApps: ['github-actions'], statusContexts: ['legacy-ci'], statusActors: ['operator'] };
const trackedPullRequests = [{ number: 7, headSha: head, ticketId: 'ticket-1' }];
function pull(rest = {}) {
  return { id: 1007, number: 7, title: 'Fix pricing', html_url: `https://github.com/${repository}/pull/7`,
    head: { sha: head, ref: 'fix/pricing', repo: { full_name: repository } }, base: { repo: { full_name: repository } },
    state: 'open', merged: false, user, updated_at: '2026-11-01T00:00:00Z', ...rest };
}
function conversation(id = 11, rest = {}) {
  return { id, user, body: 'Please cover negative quantities', created_at: '2026-11-01T00:01:00Z',
    html_url: `https://github.com/${repository}/pull/7#issuecomment-${id}`, ...rest };
}
function review(id = 21, rest = {}) {
  return { id, user, body: 'Reject invalid quantities', state: 'CHANGES_REQUESTED', commit_id: head,
    submitted_at: '2026-11-01T00:02:00Z', html_url: `https://github.com/${repository}/pull/7#pullrequestreview-${id}`, ...rest };
}
function inline(id = 31, rest = {}) {
  return { id, user, body: 'Validate before multiplying', commit_id: head, path: 'pricing.py', line: 8, side: 'RIGHT',
    created_at: '2026-11-01T00:03:00Z', html_url: `https://github.com/${repository}/pull/7#discussion_r${id}`, ...rest };
}
function check(id = 41, rest = {}) {
  return { id, name: 'pricing-contract', head_sha: head, status: 'completed', conclusion: 'failure',
    started_at: '2026-11-01T00:04:00Z', completed_at: '2026-11-01T00:05:00Z', app: { id: 15368, slug: 'github-actions' },
    output: { title: 'Contract failed', summary: 'ValueError was not raised', text: 'negative quantity', annotations_count: 1 }, ...rest };
}
function status(id = 51, rest = {}) {
  return { id, creator: user, context: 'legacy-ci', state: 'failure', description: 'Quantity must be non-negative',
    created_at: '2026-11-01T00:06:00Z', ...rest };
}
function fixture(rest = {}) {
  const calls = [];
  const request = async (endpoint, init) => {
    calls.push([endpoint, init]);
    if (rest.request) {
      const value = await rest.request(endpoint, init);
      if (value !== undefined) return value;
    }
    if (endpoint === '/user') return user;
    if (endpoint === '/repos/owner/repo/pulls/7') return rest.pull ?? pull();
    if (endpoint.startsWith('/repos/owner/repo/issues?')) return [];
    if (endpoint.includes('/issues/7/comments?')) return rest.comments ?? [];
    if (endpoint.includes('/pulls/7/reviews?')) return rest.reviews ?? [];
    if (endpoint.includes('/pulls/7/comments?')) return rest.inline ?? [];
    if (endpoint.includes('/check-runs?')) return { total_count: rest.checks?.length ?? 0, check_runs: rest.checks ?? [] };
    if (endpoint.includes('/annotations?')) return rest.annotations ?? [{ path: 'pricing.py', start_line: 8, title: 'Pricing contract', message: 'pricing.total must raise ValueError when quantity < 0' }];
    if (endpoint.includes('/statuses?')) return rest.statuses ?? [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  return { calls, channel: createGitHubChannel({ ...options, ...rest.options }, { request }) };
}

test('PR metadata verifies repository, non-fork head, full SHA and resource URL', async () => {
  const { channel, calls } = fixture();
  assert.deepEqual(await channel.getPullRequest(7), { repository, number: 7, id: 1007, headSha: head,
    headRef: 'fix/pricing', headRepository: repository, state: 'open', merged: false,
    url: `https://github.com/${repository}/pull/7`, title: 'Fix pricing' });
  assert.equal(calls.length, 1);
  for (const [value, error] of [
    [pull({ head: { sha: head, ref: 'fork', repo: { full_name: 'other/repo' } } }), /Fork pull requests/],
    [pull({ base: { repo: { full_name: 'other/repo' } } }), /different pull request/],
    [pull({ head: { sha: 'main', ref: 'branch', repo: { full_name: repository } } }), /full 40-character/],
    [pull({ html_url: 'https://example.com/owner/repo/pull/7' }), /does not match/],
  ]) await assert.rejects(fixture({ pull: value }).channel.getPullRequest(7), error);
  await assert.rejects(channel.getPullRequest(-1), /positive integer/);
});

test('only explicit PR bindings are polled; CI endpoints stay disabled by default', async () => {
  const { channel, calls } = fixture({ comments: [conversation()], reviews: [review()], inline: [inline()] });
  assert.deepEqual((await channel.poll()).events, []);
  assert.equal(calls.some(([endpoint]) => endpoint.includes('/pulls/')), false);
  const { events } = await channel.poll({ trackedPullRequests });
  assert.deepEqual(events.map(event => event.kind), ['pull_request_state', 'pr_comment', 'review', 'review_comment']);
  assert.deepEqual(events[0], { repository, pullNumber: 7, headSha: head, pullState: 'open', merged: false,
    pullRequest: { repository, number: 7, id: 1007, headSha: head, headRef: 'fix/pricing', headRepository: repository, state: 'open', merged: false, url: `https://github.com/${repository}/pull/7`, title: 'Fix pricing' },
    kind: 'pull_request_state', id: `github:${repository}:pull_request_state:7:${head}:open`, text: '',
    actor: { login: 'operator', id: '42', type: 'User' }, createdAt: '2026-11-01T00:00:00.000Z', url: `https://github.com/${repository}/pull/7` });
  assert.equal(events[1].id, `github:${repository}:pr_comment:11`);
  assert.equal(events[2].commitId, head);
  assert.equal(events[2].state, 'CHANGES_REQUESTED');
  assert.equal(events[3].path, 'pricing.py'); assert.equal(events[3].line, 8);
  assert.equal(calls.some(([endpoint]) => /check-runs|statuses/.test(endpoint)), false);
  const before = calls.length;
  await assert.rejects(channel.poll({ trackedPullRequests: [...trackedPullRequests, ...trackedPullRequests] }), /duplicate bindings/);
  assert.equal(calls.length, before);
});

test('changed head, closed and merged PRs emit only current state without fetching stale feedback', async () => {
  for (const value of [pull({ head: { sha: otherHead, ref: 'fix/pricing', repo: { full_name: repository } } }),
    pull({ state: 'closed' }), pull({ state: 'closed', merged: true })]) {
    const { channel, calls } = fixture({ pull: value, comments: [conversation()], options: { ci } });
    const { events } = await channel.poll({ trackedPullRequests });
    assert.equal(events.filter(event => event.kind === 'pull_request_state').length, 1);
    assert.equal(events.find(event => event.kind === 'pull_request_state').headSha, value.head.sha);
    assert.equal(events.find(event => event.kind === 'pull_request_state').merged, value.merged);
    // A changed open head stops before feedback; closed discussions stay readable without CI reads.
    if (value.state === 'open') assert.equal(events.length, 1);
    else assert.deepEqual(events.map(event => event.kind), ['pull_request_state', 'pr_comment']);
    assert.equal(calls.some(([endpoint]) => /check-runs|statuses/.test(endpoint)), false);
  }
});

test('review history retains old commits, inline feedback stays on current commit, and pending reviews never consume native IDs', async () => {
  const { channel } = fixture({ reviews: [review(), review(22, { commit_id: otherHead }), review(23, { state: 'PENDING', submitted_at: null }), review(24, { body: '', state: 'APPROVED' })],
    inline: [inline(), inline(32, { commit_id: otherHead }), inline(33, { line: null }),
      inline(34, { subject_type: 'file', line: null, side: null, html_url: `https://github.com/${repository}/pull/7#discussion-diff-1` })] });
  const { events } = await channel.poll({ trackedPullRequests });
  assert.deepEqual(events.filter(event => event.kind === 'review').map(event => event.id), [`github:${repository}:review:21`, `github:${repository}:review:22`, `github:${repository}:review:24`]);
  assert.equal(events.find(event => event.id === `github:${repository}:review:22`).commitId, otherHead);
  assert.deepEqual(events.filter(event => event.kind === 'review_comment').map(event => event.id), [`github:${repository}:review_comment:31`, `github:${repository}:review_comment:33`, `github:${repository}:review_comment:34`]);
  assert.equal(events.find(event => event.id.endsWith(':33')).line, null);
  assert.equal(events.find(event => event.id.endsWith(':34')).side, null);
});

test('PR reviews and object-wrapped checks complete pagination before returning events', async () => {
  const reviews = Array.from({ length: 101 }, (_, index) => review(1000 + index));
  const checks = Array.from({ length: 101 }, (_, index) => check(2000 + index, { name: `check-${index}`, conclusion: 'success' }));
  const { channel, calls } = fixture({ options: { ci: { checkApps: ['github-actions'] } }, request: endpoint => {
    const page = Number(new URL(`https://api.github.com${endpoint}`).searchParams.get('page'));
    if (endpoint.includes('/reviews?')) return reviews.slice((page - 1) * 100, page * 100);
    if (endpoint.includes('/check-runs?')) return { total_count: 101, check_runs: checks.slice((page - 1) * 100, page * 100) };
  } });
  const { events } = await channel.poll({ trackedPullRequests });
  assert.equal(events.filter(event => event.kind === 'review').length, 101);
  assert.equal(events.filter(event => event.kind === 'check_run').length, 101);
  assert.equal(calls.filter(([endpoint]) => endpoint.endsWith('page=2')).length, 2);
  const incomplete = fixture({ options: { ci: { checkApps: ['github-actions'] } }, request: endpoint => endpoint.includes('/check-runs?') ? { total_count: 2, check_runs: [check(41, { conclusion: 'success' })] } : undefined });
  assert.equal((await incomplete.channel.poll({ trackedPullRequests })).objects[0].status, 'failed');
});

test('CI selects latest attempt by app and name, latest status per context, and keeps producer identity', async () => {
  const { channel, calls } = fixture({ options: { ci }, checks: [check(), check(42, { conclusion: 'success', started_at: '2026-11-01T00:07:00Z' }),
    check(43, { name: 'newly-queued', status: 'completed', conclusion: 'failure' }),
    check(44, { name: 'newly-queued', status: 'queued', conclusion: null, started_at: null, completed_at: null }),
    check(45, { app: { id: 999, slug: 'external-check' }, conclusion: 'success' }), check(46, { head_sha: otherHead })],
    statuses: [status(), status(52, { state: 'success', created_at: '2026-11-01T00:07:00Z' }), status(53, { context: 'another-ci', state: 'pending' })] });
  const { events } = await channel.poll({ trackedPullRequests });
  const checks = events.filter(event => event.kind === 'check_run'), statuses = events.filter(event => event.kind === 'commit_status');
  assert.deepEqual(checks.map(event => event.id.split(':')[3]).sort(), ['42', '44']);
  assert.equal(checks.find(event => event.ci.name === 'newly-queued').ci.conclusion, null);
  assert.deepEqual(checks.find(event => event.ci.app === 'github-actions').actor, { login: 'github-actions', id: '15368', type: 'Bot' });
  assert.deepEqual(statuses.map(event => event.id).sort(), [`github:${repository}:commit_status:52`]);
  assert.equal(statuses.find(event => event.ci.name === 'legacy-ci').ci.conclusion, 'success');
  assert.equal(calls.some(([endpoint]) => endpoint.includes('/annotations?')), false, 'Superseded failures must not fetch annotations or generate repair events');
});

test('failed checks include bounded annotations; state transitions use distinct stable event IDs', async () => {
  let value = check(41, { status: 'in_progress', conclusion: null, completed_at: null });
  const annotations = Array.from({ length: 20 }, (_, index) => ({ path: 'pricing.py', start_line: index + 1, title: 'Pricing contract', message: 'pricing.total must raise ValueError when quantity < 0 ' + 'x'.repeat(8000) }));
  const { channel, calls } = fixture({ options: { ci: { checkApps: ['github-actions'] } }, annotations, request: endpoint => endpoint.includes('/check-runs?') ? { total_count: 1, check_runs: [value] } : undefined });
  const first = (await channel.poll({ trackedPullRequests })).events.find(event => event.kind === 'check_run');
  value = check(41, { output: { summary: 'x'.repeat(400_000), annotations_count: 1000 } });
  const second = (await channel.poll({ trackedPullRequests })).events.find(event => event.kind === 'check_run');
  const third = (await channel.poll({ trackedPullRequests })).events.find(event => event.kind === 'check_run');
  assert.notEqual(first.id, second.id); assert.equal(second.id, third.id);
  assert.match(first.id, /:in_progress:none$/); assert.match(second.id, /:completed:failure$/);
  assert.match(second.text, /must raise ValueError/); assert.match(second.text, /first 20 check annotations/); assert.match(second.text, /\[truncated\]/);
  assert.ok(Buffer.byteLength(second.text) < 256 * 1024);
  assert.equal(calls.filter(([endpoint]) => endpoint.includes('/annotations?')).length, 2);
  assert.equal(calls.filter(([endpoint]) => endpoint.includes('/annotations?')).every(([endpoint]) => endpoint.endsWith('per_page=20&page=1')), true);
});

test('PR network and resource failures isolate their object without publishing its partial events', async () => {
  const broken = fixture({ comments: [conversation()], request: endpoint => {
    if (endpoint.includes('/reviews?')) throw new Error('review endpoint unavailable');
  } });
  assert.deepEqual((await broken.channel.poll({ trackedPullRequests })).events, []);
  assert.equal((await broken.channel.poll({ trackedPullRequests })).objects[0].status, 'failed');
  const foreign = fixture({ comments: [conversation(11, { html_url: 'https://github.com/owner/other/pull/7#issuecomment-11' })] });
  assert.deepEqual((await foreign.channel.poll({ trackedPullRequests })).events, []);
  assert.equal((await foreign.channel.poll({ trackedPullRequests })).objects[0].status, 'failed');
  const malformed = fixture({ options: { ci }, checks: [check(41, { app: { slug: 'github-actions' } })] });
  assert.deepEqual((await malformed.channel.poll({ trackedPullRequests })).events, []);
  assert.equal((await malformed.channel.poll({ trackedPullRequests })).objects[0].status, 'failed');
});

test('PR delivery requires explicit ticket and head authorization and ignores the Issue number allowlist', async () => {
  const comments = []; let posts = 0;
  const message = { id: 'message-1', ticketId: 'ticket-1', kind: 'reply', text: 'Verified /local/project/pricing.py',
    channel: { source: 'github', thread: `${repository}#pr:7`, address: { repository, pullNumber: '7', headSha: head } } };
  const { channel, calls } = fixture({ options: { issues: [1] }, request: (endpoint, init) => {
    if (endpoint.includes('/issues/7/comments?')) return comments;
    if (endpoint === '/repos/owner/repo/issues/7/comments' && init.method === 'POST') {
      posts++; comments.push(conversation(71, { body: init.body.body })); throw new Error('accepted but response lost');
    }
  } });
  const context = { projectId: 'project-1', sourceProjectRoot: '/local/project', pullRequests: trackedPullRequests };
  await assert.rejects(channel.deliver(message, { projectId: 'project-1' }), /authorized ticket\/head/);
  await assert.rejects(channel.deliver(message, { ...context, pullRequests: [{ ...trackedPullRequests[0], headSha: otherHead }] }), /authorized ticket\/head/);
  await assert.rejects(channel.deliver(message, { ...context, pullRequests: [{ ...trackedPullRequests[0], ticketId: 'different-ticket' }] }), /authorized ticket\/head/);
  assert.equal(calls.length, 0, 'Authorization is validated before remote access');
  await assert.rejects(channel.deliver(message, context), /accepted but response lost/);
  const receipt = await channel.deliver(message, { ...context, pullRequests: [...trackedPullRequests, { number: 7, headSha: otherHead, ticketId: 'ticket-1' }] });
  assert.equal(posts, 1); assert.deepEqual(receipt, { id: '71', url: `https://github.com/${repository}/pull/7#issuecomment-71` });
  assert.match(comments[0].body, new RegExp(`Head: .${head}.`));
  assert.match(comments[0].body, /\[project\]\/pricing.py/);
  assert.equal(calls.some(([endpoint]) => endpoint.includes('/pulls/')), false, 'Explicitly authorized historical-head receipts do not depend on the current head');
});

test('CI configuration rejects incomplete status authority and preserves case-sensitive contexts', () => {
  assert.throws(() => createGitHubChannel({ ...options, ci: {} }), /must enable/);
  assert.throws(() => createGitHubChannel({ ...options, ci: { statusContexts: ['build'] } }), /configured together/);
  assert.throws(() => createGitHubChannel({ ...options, ci: { checkApps: ['github-actions/path'] } }), /app slugs/);
  assert.throws(() => createGitHubChannel({ ...options, ci: { checkApps: ['-github-actions'] } }), /app slugs/);
  assert.throws(() => createGitHubChannel({ ...options, ci: { ...ci, token: 'do-not-accept' } }), /unsupported setting/);
  assert.throws(() => createGitHubChannel({ ...options, ci: { ...ci, statusContexts: ['Build\tPython'] } }), /printable characters/);
  const channel = createGitHubChannel({ ...options, ci: { checkApps: ['GitHub-Actions'], statusActors: ['Build[bot]'], statusContexts: ['Build / Python'] } });
  assert.deepEqual(channel.options.ci, { checkApps: ['github-actions'], statusActors: ['build[bot]'], statusContexts: ['Build / Python'] });
});

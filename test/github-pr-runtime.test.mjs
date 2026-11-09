import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

const repository = 'fixture/project';
const head = 'a'.repeat(40), nextHead = 'b'.repeat(40);
const github = { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 1000,
  ci: { checkApps: ['github-actions'], statusContexts: ['fixture/tests'], statusActors: ['build-bot[bot]'] } };
const options = { timeout: 15_000 };
const actor = { login: 'alice', id: '10', type: 'User' };
const when = '2026-11-01T00:00:00.000Z';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function issue() {
  return { id: `github:${repository}:issue:700`, repository, issueNumber: 7, issueId: 700,
    kind: 'issue', text: '/js-superagent Fix pricing and address related reviews and CI failures', title: 'Pricing task',
    actor, createdAt: when, url: `https://github.com/${repository}/issues/7`, issueState: 'open' };
}
function pull(rest = {}) {
  return { repository, number: 9, id: '900', headSha: head, headRef: 'codex/fixture', headRepository: repository,
    state: 'open', merged: false, url: `https://github.com/${repository}/pull/9`, title: 'Pricing changes', ...rest };
}
function prEvent(kind, id, text, rest = {}) {
  return { id: `github:${repository}:${kind}:${id}`, repository, pullNumber: 9, kind, headSha: head,
    pullState: 'open', actor, createdAt: when, text, url: `https://github.com/${repository}/pull/9`, ...rest };
}
function state(pr) {
  return prEvent('pull_request_state', `${pr.number}:${pr.headSha}:${pr.merged ? 'merged' : pr.state}`, '',
    { pullNumber: pr.number, repository: pr.repository, headSha: pr.headSha, pullState: pr.state, merged: pr.merged });
}
function review(id = 101, rest = {}) {
  return prEvent('review', id, 'Add the missing fractional-discount regression', { state: 'COMMENTED', commitId: head, ...rest });
}
function inline(id = 201, rest = {}) {
  return prEvent('review_comment', id, 'Assert that zero quantity remains zero',
    { path: 'test_pricing.py', line: 8, side: 'RIGHT', commitId: head, ...rest });
}
function check(id = 301, rest = {}) {
  const { ci: supplied, ...other } = rest;
  const ci = { name: 'pricing-contract', app: 'github-actions', status: 'completed', conclusion: 'failure', headSha: head, ...supplied };
  return prEvent('check_run', `${id}:${ci.headSha}:${ci.status}:${ci.conclusion ?? 'none'}`,
    'pricing.total must raise ValueError when quantity is negative', {
      actor: { login: 'github-actions', id: '15368', type: 'Bot' }, ci, ...other,
    });
}
function status(id = 401, rest = {}) {
  const { ci: supplied, ...other } = rest;
  return prEvent('commit_status', id, 'fixture/tests: negative quantity must raise ValueError', {
    actor: { login: 'build-bot[bot]', id: '42', type: 'Bot' },
    ci: { name: 'fixture/tests', status: 'completed', conclusion: 'failure', headSha: head, ...supplied }, ...other,
  });
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-github-pr-')));
  const runtimes = new Set(), events = [], sent = new Map(), polls = [];
  let snapshot = pull();
  const channel = {
    async getPullRequest(number) { assert.equal(number, snapshot.number); return structuredClone(snapshot); },
    async poll(input) { polls.push(structuredClone(input)); return [issue(), state(snapshot), ...structuredClone(events)]; },
    async deliver(message) {
      if (!sent.has(message.id)) sent.set(message.id, structuredClone(message));
      const number = Number(message.channel.address.issueNumber ?? message.channel.address.pullNumber);
      return { id: String(1000 + [...sent.keys()].indexOf(message.id)), url: `https://github.com/${repository}/issues/${number}#issuecomment-${1000 + [...sent.keys()].indexOf(message.id)}` };
    },
  };
  t.after(async () => {
    for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, events, sent, polls, channel,
    get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; },
    close(runtime) { runtime.close(); runtimes.delete(runtime); },
    open(driver, overrides = {}) {
      const runtime = createProjectAgent({ projectRoot: root, github, githubChannel: channel, driver, ...overrides }).init();
      runtimes.add(runtime); return runtime;
    },
  };
}
async function completedFixture(t, driver = { async run() { return { status: 'completed', summary: 'Verified initial work' }; } }, overrides = {}) {
  const f = fixture(t), runtime = f.open(driver, overrides);
  await runtime.syncGitHub(); const ticket = runtime.list()[0]; await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'completed');
  return { ...f, fixture: f, runtime, ticket };
}
function binding(runtime) { return runtime.githubStatus().trackedPullRequests.find(value => value.number === 9); }
function destinations(messages) { return new Set(messages.map(message => Number(message.channel.address.issueNumber ?? message.channel.address.pullNumber))); }

test('explicit PR binding persists the head and reuses the original ticket after restart', options, async t => {
  const f = await completedFixture(t), { runtime, ticket } = f;
  assert.equal(runtime.githubStatus().trackedPullRequests.length, 0);
  await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
  await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
  assert.equal(binding(runtime).ticketId, ticket.id); assert.equal(binding(runtime).headSha, head);
  assert.equal(runtime.get(ticket.id).pullRequests.length, 1);
  f.close(runtime);
  const reopened = f.open({ async run() { throw new Error('Linking does not execute a worker'); } });
  assert.equal(binding(reopened).headSha, head);
  await reopened.syncGitHub(); assert.equal(await reopened.runNext(), null);
  assert.ok(f.polls.at(-1).trackedPullRequests.some(value => value.number === 9 && value.headSha === head));
  assert.equal(reopened.list().length, 1);
});

test('PR review and inline feedback preserve the original workspace and native session and return results to both threads', options, async t => {
  let calls = 0, path; const session = { driver: 'fixture', id: 'one-pr-session' };
  const f = await completedFixture(t, { async run(input) {
    calls++;
    if (calls === 1) { path = input.projectRoot; input.checkpoint(session); }
    else {
      assert.equal(input.projectRoot, path); assert.deepEqual(input.session, session);
      assert.match(input.ticket.messages.at(-1).text, calls === 2 ? /fractional-discount/ : /zero quantity/);
      writeFileSync(join(path, 'repair.txt'), `turn-${calls}`);
    }
    return { status: 'completed', summary: `Verified PR turn ${calls}`, artifacts: ['repair.txt'] };
  } }, { workspace: { mode: 'copy' } });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  for (const event of [review(), inline()]) {
    f.events.push(event); await f.runtime.syncGitHub();
    const result = await f.runtime.runNext(); assert.equal(result.id, f.ticket.id); assert.equal(result.status, 'completed');
  }
  assert.equal(calls, 3); assert.equal(f.runtime.list().length, 1);
  assert.equal(existsSync(join(f.root, 'repair.txt')), false);
  for (const turn of [2, 3]) {
    const replies = [...f.sent.values()].filter(message => message.text.includes(`Verified PR turn ${turn}`));
    assert.deepEqual(destinations(replies), new Set([7, 9]));
  }
});

test('unlinked, foreign, stale-head and unauthorized PR feedback cannot grant or resume work', options, async t => {
  let calls = 0;
  const f = await completedFixture(t, { async run() { calls++; return { status: 'completed', summary: 'Verified' }; } });
  f.events.push(review(1)); await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  f.events.length = 0; // Historical current-head feedback becomes admissible after explicit linking.
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(
    review(2, { pullNumber: 10 }),
    review(3, { repository: 'other/project', id: 'github:other/project:review:3' }),
    review(4, { headSha: nextHead, commitId: nextHead }),
    review(5, { actor: { login: 'outsider', id: '99', type: 'User' } }),
    review(6, { actor: { ...actor, type: 'Bot' } }),
    inline(7, { headSha: nextHead, commitId: nextHead }),
  );
  await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  assert.equal(calls, 1); assert.equal(f.runtime.list().length, 1);
});

test('empty comment reviews are observations while current-head review decisions continue the ticket', options, async t => {
  const f = await completedFixture(t); await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(review(2, { text: '  ' }));
  await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  assert.equal(f.runtime.get(f.ticket.id).reports.length, 1);
  f.events.push(review(1, { state: 'APPROVED', text: 'Looks good' }), review(3, { state: 'DISMISSED' }));
  await f.runtime.syncGitHub(); assert.equal((await f.runtime.runNext()).id, f.ticket.id);
  assert.equal(f.runtime.get(f.ticket.id).reports.length, 2);
  f.events.push(review(4, { state: 'CHANGES_REQUESTED', text: 'Add the fractional-discount test' }));
  await f.runtime.syncGitHub(); assert.equal((await f.runtime.runNext()).id, f.ticket.id);
});

test('only configured CI apps or exact status context and producer pairs can request repair', options, async t => {
  let calls = 0;
  const f = await completedFixture(t, { async run() { calls++; return { status: 'completed', summary: `CI repair ${calls}` }; } });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(check(1, { ci: { app: 'unknown-app' } }), status(2, { ci: { name: 'unapproved/context' } }),
    status(3, { actor: { login: 'outsider', id: '99', type: 'User' } }), check(4, { headSha: nextHead, ci: { headSha: nextHead } }));
  await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null); assert.equal(calls, 1);
  f.events.push(check(5)); await f.runtime.syncGitHub(); assert.equal((await f.runtime.runNext()).id, f.ticket.id);
  f.events.push(status(6)); await f.runtime.syncGitHub(); assert.equal((await f.runtime.runNext()).id, f.ticket.id);
  assert.equal(calls, 3);
});

test('successful and pending CI states are recorded without restarting a completed ticket', options, async t => {
  const f = await completedFixture(t); await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(check(1, { ci: { conclusion: 'success' } }), status(2, { ci: { name: 'fixture/tests', conclusion: 'success' } }),
    check(3, { ci: { name: 'pending-check', status: 'in_progress', conclusion: null } }));
  await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  assert.ok(binding(f.runtime).ci.some(value => value.name === 'pricing-contract' && value.conclusion === 'success'));
  assert.ok(binding(f.runtime).ci.some(value => value.name === 'fixture/tests' && value.conclusion === 'success'));
  assert.equal(f.runtime.get(f.ticket.id).reports.length, 1);
});

test('a newer successful check supersedes its queued failure before a repair worker starts', options, async t => {
  let calls = 0;
  const f = await completedFixture(t, { async run(input) {
    calls++;
    if (calls === 2) assert.doesNotMatch(JSON.stringify(input.ticket.messages), /quantity is negative/);
    return { status: 'completed', summary: 'Verified' };
  } });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(check(1)); await f.runtime.syncGitHub();
  f.events.push(check(2, { createdAt: '2026-11-01T00:01:00.000Z', ci: { conclusion: 'success' } }));
  await f.runtime.syncGitHub();
  assert.equal(await f.runtime.runNext(), null); assert.equal(calls, 1);
  assert.equal(f.runtime.get(f.ticket.id).reports.length, 1);
  assert.ok(binding(f.runtime).ci.some(value => value.name === 'pricing-contract' && value.conclusion === 'success'));
  f.events.push(review(10, { text: 'Please verify a separate fractional-discount regression' }));
  await f.runtime.syncGitHub(); assert.equal((await f.runtime.runNext())?.status, 'completed');
  assert.equal(calls, 2);
  const obsolete = f.runtime.getDomainTicket(f.ticket.id).inputs.find(input => input.triggerId === `${check(1).id}:pr:9`);
  assert.ok(obsolete); assert.ok(!obsolete.readAt, 'Superseded CI must not be claimed as read by the worker');
});

test('new remote head blocks repair until explicit relinking and never applies old-head feedback', options, async t => {
  let calls = 0;
  const f = await completedFixture(t, { async run() { calls++; return { status: 'completed', summary: 'Verified' }; } });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.fixture.snapshot = pull({ headSha: nextHead });
  f.events.push(review(1, { headSha: nextHead, commitId: nextHead }));
  await f.runtime.syncGitHub(); assert.equal(binding(f.runtime).blockedReason, 'head-changed');
  assert.equal(await f.runtime.runNext(), null); assert.equal(calls, 1);
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  assert.equal(binding(f.runtime).headSha, nextHead); assert.ok(!binding(f.runtime).blockedReason);
  f.events.push(review(2, { headSha: nextHead, commitId: nextHead, text: 'Fix the current-head fractional regression' }));
  await f.runtime.syncGitHub(); assert.equal((await f.runtime.runNext()).id, f.ticket.id); assert.equal(calls, 2);
});

test('a fresh PR lookup before repair detects head changes that occur between polling and worker launch', options, async t => {
  let calls = 0;
  const f = await completedFixture(t, { async run() { calls++; return { status: 'completed', summary: 'Verified' }; } });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(review()); await f.runtime.syncGitHub();
  f.fixture.snapshot = pull({ headSha: nextHead });
  assert.equal(await f.runtime.runNext(), null); assert.equal(calls, 1);
  assert.equal(binding(f.runtime).blockedReason, 'head-changed');
});

test('explicit relinking retires queued old-head feedback so new-head feedback can execute', options, async t => {
  let calls = 0;
  const f = await completedFixture(t, { async run(input) {
    calls++;
    if (calls === 2) {
      assert.match(input.ticket.messages.at(-1).text, /current-head repair/);
      assert.doesNotMatch(JSON.stringify(input.ticket.messages), /Obsolete old-head repair/);
    }
    return { status: 'completed', summary: 'Verified' };
  } });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(review(1, { text: 'Obsolete old-head repair' })); await f.runtime.syncGitHub();
  f.fixture.snapshot = pull({ headSha: nextHead });
  await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(review(2, { headSha: nextHead, commitId: nextHead, text: 'Apply the current-head repair only' }));
  await f.runtime.syncGitHub(); const result = await f.runtime.runNext();
  assert.equal(result?.id, f.ticket.id); assert.equal(result.status, 'completed'); assert.equal(calls, 2);
  assert.ok(f.runtime.get(f.ticket.id).messages.some(message => /Obsolete old-head repair/.test(message.text)), 'Public history preserves the superseded feedback for audit');
  const obsolete = f.runtime.getDomainTicket(f.ticket.id).inputs.find(input => input.triggerId === review(1).id);
  assert.ok(obsolete); assert.ok(!obsolete.readAt, 'Old-head feedback was never read by the worker');
});

test('closed PRs and explicit unlinking stop subsequent feedback without creating another ticket', options, async t => {
  const f = await completedFixture(t); await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.fixture.snapshot = pull({ state: 'closed' }); f.events.push(review(1, { pullState: 'closed' }));
  await f.runtime.syncGitHub(); assert.equal(binding(f.runtime).blockedReason, 'pull-request-closed');
  // W24: human feedback on a closed PR gets read-only continuation inspection, never a code turn on the old target.
  const inspected = await f.runtime.runNext();
  assert.equal(inspected.id, f.ticket.id);
  assert.match(inspected.reports.at(-1).summary, /read-only continuation inspection/);
  await f.runtime.unlinkGitHubPullRequest(9); assert.equal(f.runtime.githubStatus().trackedPullRequests.length, 0);
  f.fixture.snapshot = pull(); f.events.push(review(2));
  await f.runtime.syncGitHub(); assert.equal(await f.runtime.runNext(), null);
  assert.equal(f.runtime.list().length, 1);
});

test('repeat polls and process reopening cannot rerun the same review or failed CI event', options, async t => {
  let calls = 0; const driver = { async run() { calls++; return { status: 'completed', summary: `Verified ${calls}` }; } };
  const f = await completedFixture(t, driver); await f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  f.events.push(review()); await f.runtime.syncGitHub(); await f.runtime.runNext();
  f.events.push(check()); await f.runtime.syncGitHub(); await f.runtime.runNext();
  const sent = f.sent.size; f.close(f.runtime);
  const reopened = f.open(driver); await reopened.syncGitHub(); await reopened.syncGitHub();
  assert.equal(await reopened.runNext(), null); assert.equal(calls, 3); assert.equal(f.sent.size, sent);
  assert.equal(reopened.list().length, 1);
});

test('revoking a CI producer after intake prevents its queued repair from executing', options, async t => {
  let calls = 0;
  const f = fixture(t), runtime = f.open({ async run() { calls++; return { status: 'completed', summary: 'Verified' }; } }, { github: undefined });
  runtime.configure({ github });
  await runtime.syncGitHub(); const ticket = runtime.list()[0]; await runtime.runNext();
  await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
  f.events.push(check()); await runtime.syncGitHub();
  runtime.configure({ github: { ci: null } });
  assert.equal(await runtime.runNext(), null); assert.equal(calls, 1);
  assert.equal(runtime.get(ticket.id).reports.length, 1);
});

test('binding verifies the live PR repository and state before persisting an association', options, async t => {
  const f = await completedFixture(t);
  f.fixture.snapshot = pull({ repository: 'other/project' });
  await assert.rejects(f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 }), /repository|scope|match/i);
  f.fixture.snapshot = pull({ state: 'closed' });
  await assert.rejects(f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 }), /open|closed/i);
  assert.equal(f.runtime.githubStatus().trackedPullRequests.length, 0);
});

test('stop waits for an in-flight PR lookup without committing its association', options, async t => {
  const f = await completedFixture(t), entered = deferred(), release = deferred();
  f.channel.getPullRequest = async () => { entered.resolve(); await release.promise; return pull(); };
  const linking = f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 });
  const rejected = assert.rejects(linking, /stopped/i);
  await entered.promise;
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; }, () => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false, 'stop must wait for the in-flight lookup');
  release.resolve(); await rejected; await stopping;
  assert.equal(stopped, true); assert.equal(f.runtime.githubStatus().trackedPullRequests.length, 0);
});

test('a second runtime cannot claim a PR association while another instance owns its lookup', options, async t => {
  const f = await completedFixture(t), entered = deferred(), release = deferred(); let lookups = 0;
  f.channel.getPullRequest = async () => { lookups++; entered.resolve(); await release.promise; return pull(); };
  const linking = f.runtime.linkGitHubPullRequest(f.ticket.id, { number: 9 }); await entered.promise;
  const other = f.open();
  await assert.rejects(other.linkGitHubPullRequest(f.ticket.id, { number: 9 }), /activity|association|execution/i);
  assert.equal(lookups, 1);
  release.resolve(); await linking;
  assert.equal(binding(other).ticketId, f.ticket.id); assert.equal(binding(other).headSha, head);
});

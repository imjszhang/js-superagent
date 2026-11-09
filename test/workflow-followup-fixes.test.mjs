import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { normalizeGitHubEvent } from '../src/github-intake.mjs';

const repository = 'fixture/project', head = 'a'.repeat(40), adapter = 'followup-fixes';
const ready = { version: 2, state: 'ready', summary: 'Scoped changes are ready for review', artifacts: [], attention: null };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-followup-fixes-')));
  let sequence = 0, runs = 0, onEvent = () => ({ summary: 'No coordination action needed', actions: [] });
  const calls = [];
  let pull = { repository, number: 9, id: 900, headSha: head, headRef: 'feature', headRepository: repository,
    state: 'open', merged: false, title: 'Original work', url: `https://github.com/${repository}/pull/9` };
  const harnessRegistry = createHarnessRegistry({ adapters: [{ id: adapter, version: '1', roles: ['worker', 'coordinator'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, async run() { runs++; return structuredClone(ready); } }),
    createAssessor: () => ({
      async assess() { return { kind: 'ignore', reason: 'No unrelated new work', rules: [] }; },
      async handleEvent(input) { calls.push(structuredClone(input.event)); return onEvent(input); },
    }),
  }] });
  const runtime = createProjectAgent({ projectRoot: root, harnessRegistry, execution: { driver: adapter }, workspace: { mode: 'copy' },
    githubChannel: {
      async poll() { return []; }, async getPullRequest() { return structuredClone(pull); },
      async deliver() { return { id: '1', url: `https://github.com/${repository}/issues/7#issuecomment-1` }; },
    } }).init();
  runtime.configure({ github: { repository, allowedActors: ['alice', 'robot'], issues: [7] } });
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  function event(kind, login = 'alice', text = 'Please address this review finding', extra = {}) {
    const nativeId = kind === 'issue' ? 700 : 1000 + ++sequence;
    return { id: `github:${repository}:${kind}:${nativeId}`, repository, kind, text,
      actor: { login, id: login === 'robot' ? '20' : '10', type: 'User' }, createdAt: new Date().toISOString(),
      url: `https://github.com/${repository}/issues/7`,
      ...(kind === 'issue' || kind === 'comment' ? { issueNumber: 7, issueId: 700, issueState: 'open', title: 'Original work' }
        : { pullNumber: 9, headSha: head, pullState: pull.state, ...(kind === 'review' ? { state: 'CHANGES_REQUESTED', commitId: head } : {}),
          ...(kind === 'review_comment' ? { reviewId: nativeId, reviewCommentId: nativeId, reviewRootId: nativeId, path: 'input.txt', line: 1, side: 'RIGHT', commitId: head } : {}) }), ...extra };
  }
  function policy({ continuous = false, mode = 'observe' } = {}) {
    runtime.configureCoordinator({ assessor: { driver: adapter }, workflowMode: continuous ? 'continuous' : 'candidates',
      policy: { mode, rules: [{ id: 'review', enabled: true, instruction: 'Assess review feedback within the original ticket scope' }],
        sourceRows: [{ id: 'repository', source: 'github', scope: { repository }, actors: ['alice'], bots: ['robot'], admission: {} }] },
    }, { expectedRevision: runtime.coordinatorStatus().settings.revision });
  }
  async function initial({ linked = true, continuous = false } = {}) {
    const accepted = runtime.receiveGitHubEvent(event('issue', 'alice', '/js-superagent Implement the change and address related review feedback'));
    const ticket = runtime.get(accepted.ticketId);
    if (linked) await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
    await runtime.runNext(); assert.equal(runs, 1);
    policy({ continuous }); return ticket;
  }
  function closePull() {
    pull = { ...pull, state: 'closed', merged: true };
    runtime.receiveGitHubEvent(event('pull_request_state', 'alice', '', { merged: true }));
  }
  return { runtime, event, policy, initial, closePull, calls, runs: () => runs, handle: callback => { onEvent = callback; } };
}

for (const kind of ['review_comment', 'review']) test(`A policy-approved bot can continue a ready but still open PR through ${kind}`, async t => {
  const f = fixture(t), ticket = await f.initial();
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended, undefined);
  assert.equal(f.runtime.get(ticket.id).awaitingReview, true);
  const feedback = f.event(kind, 'robot');
  assert.equal(f.runtime.receiveGitHubEvent(feedback).status, 'received');
  assert.equal(f.runtime.receiveGitHubEvent(feedback).status, 'duplicate');
  await f.runtime.runNext();
  assert.equal(f.runs(), 2); assert.equal(f.runtime.list().length, 1);
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended, undefined);
});

for (const linked of [false, true]) test(`A bot cannot revive genuinely completed ${linked ? 'closed PR' : 'non-PR'} work`, async t => {
  const f = fixture(t), ticket = await f.initial({ linked });
  if (linked) f.closePull();
  assert.ok(f.runtime.getDomainTicket(ticket.id).ended);
  assert.equal(f.runtime.receiveGitHubEvent(f.event(linked ? 'pr_comment' : 'comment', 'robot')).status, 'ignored');
  await f.runtime.runNext(); assert.equal(f.runs(), 1);
});

test('Current review policy still gates bots on an open ready PR', async t => {
  const f = fixture(t), ticket = await f.initial();
  f.policy({ mode: 'off' });
  assert.equal(f.runtime.receiveGitHubEvent(f.event('review', 'robot')).status, 'ignored');
  await f.runtime.runNext(); assert.equal(f.runs(), 1); assert.equal(f.runtime.getDomainTicket(ticket.id).ended, undefined);
});

for (const kind of ['comment', 'pr_comment', 'review_comment']) test(`An explicit human cancel in ${kind} uses host cancellation; a configured User bot cannot`, async t => {
  const f = fixture(t), ticket = await f.initial();
  assert.equal(f.runtime.receiveGitHubEvent(f.event(kind, 'robot', '/js-superagent cancel')).status, 'ignored');
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
  if (kind === 'review_comment') f.runtime.pause();
  const stop = f.event(kind, 'alice', '/js-superagent cancel');
  assert.equal(f.runtime.receiveGitHubEvent(stop).status, 'received');
  assert.equal(f.runtime.get(ticket.id).status, 'cancelled');
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended.by, 'human');
  assert.equal(f.runtime.receiveGitHubEvent(stop).status, 'duplicate');
  await f.runtime.runNext(); assert.equal(f.runs(), 1);
});

for (const kind of ['comment', 'pr_comment']) test(`A human natural-language stop in ${kind} retains its trigger and cancels only its original ticket`, async t => {
  const f = fixture(t), ticket = await f.initial({ continuous: kind !== 'comment' });
  f.handle(input => input.event.kind === 'follow_up'
    ? { summary: 'The author explicitly asks to stop the current work', actions: [{ kind: 'stop', ticketId: input.event.ticketId, text: 'Stop as requested by this human follow-up' }] }
    : { summary: 'Already handled', actions: [] });
  const stop = f.event(kind, 'alice', '先停一下，不用继续了');
  assert.equal(f.runtime.receiveGitHubEvent(stop).status, 'received');
  assert.equal(f.runtime.receiveGitHubEvent(stop).status, 'duplicate');
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).status, 'cancelled');
  assert.equal(f.runs(), 1);
  const calls = f.calls.filter(event => event.kind === 'follow_up');
  assert.equal(calls.length, 1); assert.equal(calls[0].ticketId, ticket.id);
  assert.equal(calls[0].references.triggerId, stop.id); assert.match(calls[0].text, /先停一下/);
  await f.runtime.runNext(); assert.equal(f.calls.filter(event => event.kind === 'follow_up').length, 1);
});

test('External stop interpretation cannot retarget another ticket or expand into a local management action', async t => {
  const f = fixture(t), ticket = await f.initial({ continuous: true });
  const other = f.runtime.submit({ text: 'Independent authorized work' });
  f.handle(input => input.event.kind === 'follow_up'
    ? { summary: 'Maliciously retargeted stop', actions: [{ kind: 'stop', ticketId: other.id, text: 'Do not trust this unrelated target' }] }
    : { summary: 'No action', actions: [] });
  f.runtime.receiveGitHubEvent(f.event('comment', 'alice', '先停一下，不用继续了'));
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false); assert.equal(f.runtime.get(other.id).cancelRequested, false);
  assert.notEqual(f.runtime.coordinationStatus().events.find(event => event.kind === 'follow_up').status, 'completed');
  f.handle(input => input.event.kind === 'follow_up'
    ? { summary: 'Do not extend external authority', actions: [{ kind: 'note', ticketId: ticket.id, text: 'Change this ticket scope through a follow-up' }] }
    : { summary: 'No action', actions: [] });
  f.runtime.receiveGitHubEvent(f.event('comment', 'alice', '只停止当前工作，不要改变范围'));
  const before = f.runtime.getDomainTicket(ticket.id).inputs.length;
  await f.runtime.runNext();
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.length, before);
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
});

test('A queued natural stop is revalidated after the source author loses authority', async t => {
  const f = fixture(t), ticket = await f.initial({ continuous: true });
  f.handle(input => input.event.kind === 'follow_up'
    ? { summary: 'Stop the original work', actions: [{ kind: 'stop', ticketId: ticket.id, text: 'Formerly authorized stop' }] }
    : { summary: 'No action', actions: [] });
  f.runtime.receiveGitHubEvent(f.event('comment', 'alice', '先停一下，不用继续了'));
  f.runtime.configure({ github: { allowedActors: ['bob'] } });
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
  assert.notEqual(f.runtime.coordinationStatus().events.find(event => event.kind === 'follow_up').status, 'completed');
});

test('Ordinary human feedback with no coordinator action continues the ticket without cancelling it', async t => {
  const f = fixture(t), ticket = await f.initial();
  f.handle(() => ({ summary: 'Ordinary review feedback needs no management action', actions: [] }));
  const feedback = f.event('comment', 'alice', 'Please include an empty-input example in the existing change');
  assert.equal(f.runtime.receiveGitHubEvent(feedback).status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
  assert.equal(f.runs(), 2);
  assert.equal(f.calls.filter(event => event.kind === 'follow_up').length, 1);
  assert.equal(f.runtime.coordinationStatus().events.find(event => event.kind === 'follow_up').status, 'completed');
});

test('Editing a stop request during assessment invalidates the decision for its old revision', async t => {
  const f = fixture(t), ticket = await f.initial();
  const stop = f.event('comment', 'alice', '先停一下，不用继续了', { updatedAt: '2026-11-02T00:00:01.000Z' });
  const correction = { ...stop, text: '改正：继续处理这个问题，不要停止', updatedAt: '2026-11-02T00:00:02.000Z' };
  const oldId = normalizeGitHubEvent(stop).id, replacementId = normalizeGitHubEvent(correction).id;
  f.handle(input => {
    if (input.event.kind !== 'follow_up' || input.event.references.triggerId !== oldId) return { summary: 'Continue normally', actions: [] };
    assert.equal(f.runtime.receiveGitHubEvent(correction).status, 'received');
    return { summary: 'Stale interpretation must be rejected', actions: [{ kind: 'stop', ticketId: ticket.id, text: 'Old text requested a stop' }] };
  });
  assert.equal(f.runtime.receiveGitHubEvent(stop).status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
  assert.equal(f.runtime.get(ticket.id).messages.find(message => message.triggerId === oldId).superseded.replacementId, replacementId);
  const oldEvent = f.runtime.coordinationStatus().events.find(event => event.kind === 'follow_up' && event.references.triggerId === oldId);
  assert.notEqual(oldEvent.status, 'completed');
});

test('Retrying an already delivered stop revision after an edit cannot cancel its ticket', async t => {
  const f = fixture(t), ticket = await f.initial();
  const stop = f.event('comment', 'alice', '先停一下，不用继续了', { updatedAt: '2026-11-02T00:00:01.000Z' });
  const oldId = normalizeGitHubEvent(stop).id;
  f.handle(() => { throw new Error('Coordinator temporarily unavailable'); });
  assert.equal(f.runtime.receiveGitHubEvent(stop).status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runs(), 2);
  const delivered = f.runtime.getDomainTicket(ticket.id).inputs.find(input => input.triggerId === oldId);
  assert.ok(delivered.readAt || delivered.deliveredTo);
  const oldEvent = f.runtime.coordinationStatus().events.find(event => event.kind === 'follow_up' && event.references.triggerId === oldId);
  assert.equal(oldEvent.status, 'failed');
  const correction = { ...stop, text: '改正：请继续处理，不要停止', updatedAt: '2026-11-02T00:00:02.000Z' };
  assert.equal(f.runtime.receiveGitHubEvent(correction).status, 'received');
  // Delivered inputs remain historical facts; the current comment revision must gate old stop decisions.
  assert.equal(f.runtime.get(ticket.id).messages.find(message => message.triggerId === oldId).superseded, undefined);
  f.handle(input => input.event.references?.triggerId === oldId
    ? { summary: 'Stale delivered text asks to stop', actions: [{ kind: 'stop', ticketId: ticket.id, text: 'Do not honor this withdrawn request' }] }
    : { summary: 'Continue normally', actions: [] });
  f.runtime.retryCoordination(oldEvent.id);
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
  const retried = f.runtime.coordinationStatus().events.find(event => event.id === oldEvent.id);
  assert.equal(retried.status, 'failed');
  assert.match(retried.error, /no longer authorized/);
});

test('An oversized follow-up keeps its final negation and is not truncated into a stop decision', async t => {
  const f = fixture(t), ticket = await f.initial();
  f.handle(input => ({ summary: 'Unsafe inference from truncated text', actions: [{ kind: 'stop', ticketId: input.event.ticketId, text: 'Would stop if given only the prefix' }] }));
  const ending = '最终要求：不要停止，请继续完成原工单。';
  const feedback = f.event('comment', 'alice', `讨论过先停一下。${'背景内容。'.repeat(3400)}${ending}`);
  assert.ok(feedback.text.length > 16000);
  assert.equal(f.runtime.receiveGitHubEvent(feedback).status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
  assert.equal(f.calls.filter(event => event.kind === 'follow_up').length, 0);
  assert.equal(f.runs(), 2);
  assert.ok(f.runtime.get(ticket.id).messages.find(message => message.triggerId === feedback.id).text.endsWith(ending));
});

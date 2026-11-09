import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';

const repository = 'fixture/project', head = 'a'.repeat(40), adapter = 'w26-runtime';
const actor = login => ({ login, id: login === 'robot' ? '20' : '10', type: 'User' });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-w26-runtime-')));
  let sequence = 0, runs = 0;
  const pull = { repository, number: 9, id: 900, headSha: head, headRef: 'feature', headRepository: repository,
    state: 'open', merged: false, title: 'Original work', url: `https://github.com/${repository}/pull/9` };
  const harnessRegistry = createHarnessRegistry({ adapters: [{ id: adapter, version: '1', roles: ['worker', 'coordinator'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, async run() { runs++; return { version: 2, state: 'ready', summary: 'Completed scoped work', artifacts: [], attention: null }; } }),
    createAssessor: () => ({ async assess() { return { kind: 'ignore', reason: 'No unrelated request', rules: [] }; } }),
  }] });
  const runtime = createProjectAgent({ projectRoot: root, harnessRegistry, execution: { driver: adapter }, workspace: { mode: 'copy' },
    github: { repository, allowedActors: ['alice', 'robot'], issues: [7] }, githubChannel: {
      async poll() { return []; }, async getPullRequest() { return structuredClone(pull); },
      async deliver() { return { id: '1', url: `https://github.com/${repository}/issues/7#issuecomment-1` }; },
    } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  function event(kind, login = 'alice', text = 'Please address the related follow-up', extra = {}) {
    return { id: `github:${repository}:${kind}:${kind === 'issue' ? 700 : 1000 + ++sequence}`, repository, kind, text, actor: actor(login),
      createdAt: new Date().toISOString(), url: `https://github.com/${repository}/issues/7`,
      ...(kind === 'issue' || kind === 'comment' ? { issueNumber: 7, issueId: 700, issueState: 'open', title: 'Original work' }
        : { pullNumber: 9, headSha: head, pullState: 'open' }), ...extra };
  }
  function policy(mode = 'observe') {
    runtime.configureCoordinator({ assessor: { driver: adapter }, policy: { mode,
      rules: [{ id: 'review', enabled: true, instruction: 'Handle review feedback within the existing scope' }],
      sourceRows: [{ id: 'repository', source: 'github', scope: { repository }, actors: ['alice', 'bob'], bots: ['robot'], admission: {} }],
    } }, { expectedRevision: runtime.coordinatorStatus().settings.revision });
  }
  async function initial() {
    const accepted = runtime.receiveGitHubEvent(event('issue', 'alice', '/js-superagent Implement the change and address related review feedback'));
    const ticket = runtime.get(accepted.ticketId);
    await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
    await runtime.runNext(); assert.equal(runtime.get(ticket.id).status, 'completed');
    assert.equal(runtime.getDomainTicket(ticket.id).ended, undefined);
    policy(); return ticket;
  }
  return { runtime, event, initial, policy, runs: () => runs };
}

for (const kind of ['comment', 'pr_comment']) for (const ended of [false, true]) {
  test(`W26 configured User bot ${ended ? 'cannot resume ended' : 'can follow up ready open-PR'} work through ${kind}`, async t => {
    const f = fixture(t), ticket = await f.initial();
    if (ended) f.runtime.receiveGitHubEvent(f.event('pull_request_state', 'alice', '', { pullState: 'closed', merged: true }));
    const before = f.runtime.getDomainTicket(ticket.id), messages = f.runtime.get(ticket.id).messages.length;
    assert.equal(!!before.ended, ended);
    const received = f.runtime.receiveGitHubEvent(f.event(kind, 'robot', 'Continue and change more code'));
    // W31: a bot PR comment with no verifiable bot run is an observation, never a free fix round.
    const unattributedBotRun = !ended && kind === 'pr_comment';
    assert.equal(received.status, ended || unattributedBotRun ? 'ignored' : 'received');
    if (unattributedBotRun) {
      assert.equal(received.reason, 'bot-review-run-unknown');
      assert.equal(f.runtime.get(ticket.id).messages.length, messages);
      await f.runtime.runNext(); assert.equal(f.runs(), 1);
      return;
    }
    if (ended) {
      assert.equal(f.runtime.get(ticket.id).status, 'completed');
      assert.equal(f.runtime.get(ticket.id).messages.length, messages);
      assert.deepEqual(f.runtime.getDomainTicket(ticket.id).assignments, before.assignments);
    } else assert.equal(f.runtime.get(ticket.id).messages.length, messages + 1);
    await f.runtime.runNext(); assert.equal(f.runs(), ended ? 1 : 2);
  });
}

for (const kind of ['comment', 'pr_comment']) test(`W26 observe mode preserves policy-listed human follow-up on ${kind}`, async t => {
  const f = fixture(t), ticket = await f.initial();
  const received = f.runtime.receiveGitHubEvent(f.event(kind, 'bob', 'Please finish the related validation under the original scope'));
  assert.equal(received.status, 'received'); assert.equal(received.ticketId, ticket.id);
  await f.runtime.runNext(); assert.equal(f.runs(), 2); assert.equal(f.runtime.list().length, 1);
});

test('W26 a configured User bot cannot use the Issue cancel command', async t => {
  const f = fixture(t), ticket = await f.initial();
  const received = f.runtime.receiveGitHubEvent(f.event('comment', 'robot', '/js-superagent cancel'));
  assert.equal(received.reason, 'cancel-actor-not-authorized');
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended, undefined); assert.equal(f.runtime.get(ticket.id).cancelRequested, false);
});

test('W27 historical inline position remains context on the currently authorized head', async t => {
  const f = fixture(t), ticket = await f.initial();
  const received = f.runtime.receiveGitHubEvent(f.event('review_comment', 'bob', 'Apply this related correction to the current implementation', {
    path: 'input.txt', line: null, side: null, originalLine: 3, originalSide: 'RIGHT', commitId: 'b'.repeat(40), reviewRootId: 15,
  }));
  assert.equal(received.status, 'received'); assert.equal(received.ticketId, ticket.id);
  assert.match(f.runtime.get(ticket.id).messages.at(-1).text, /original line 3/);
  await f.runtime.runNext(); assert.equal(f.runs(), 2);
});


test('W26 paused bound feedback survives and is rechecked once processing resumes', async t => {
  const f = fixture(t), ticket = await f.initial();
  f.runtime.pause();
  const event = f.event('comment');
  assert.equal(f.runtime.receiveGitHubEvent(event).reason, 'paused-feedback-pending');
  assert.equal(f.runtime.receiveGitHubEvent(event).status, 'duplicate');
  assert.equal(await f.runtime.runNext(), null);
  assert.equal(f.runs(), 1);
  f.runtime.resume();
  await f.runtime.runNext();
  assert.equal(f.runs(), 2);
  assert.equal(f.runtime.list().length, 1);
  assert.equal(f.runtime.get(ticket.id).messages.filter(message => message.triggerId === event.id).length, 1);
});

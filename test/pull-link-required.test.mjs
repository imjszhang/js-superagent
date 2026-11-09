import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/pull-link', head = 'a'.repeat(40);
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-pull-link-'))), runs = [], assessed = [];
  let domainId;
  const runtime = createProjectAgent({
    projectRoot: root,
    github: { repository, allowedActors: ['alice'], issues: [1], pollIntervalMs: 86_400_000 },
    githubChannel: {
      async poll() { return []; },
      async deliver(message) { return { id: message.id, url: `https://github.com/${repository}/issues/1#issuecomment-1` }; },
      async getPullRequest(number) {
        return { repository, number, id: '900', headSha: head, headRef: 'fix', headRepository: repository, state: 'open', merged: false, title: 'Fix', url: `https://github.com/${repository}/pull/${number}` };
      },
    },
    driver: { async run(input) { runs.push(input.ticket.id); return { version: 2, state: 'waiting', summary: 'Waiting', artifacts: [], attention: null }; } },
    assessor: { async assess({ candidate }) {
      assessed.push(candidate.triggers.map(trigger => trigger.id));
      return { kind: 'attach', ticketId: domainId, triggerId: candidate.triggers[0].id, reason: 'Continue the referenced work', note: 'Same task' };
    } },
  }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const inspect = fn => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return fn(store); } finally { store.close(); } };
  const issue = (text, id) => runtime.receiveGitHubEvent({ kind: 'comment', id: `github:${repository}:comment:${id}`, repository, issueNumber: 1, issueId: 1, issueState: 'open', title: 'Parser',
    actor: { login: 'alice', id: 10, type: 'User' }, text, createdAt: new Date().toISOString() });
  const pull = () => ({ kind: 'review_comment', id: `github:${repository}:review_comment:91`, repository, pullNumber: 9, headSha: head, pullState: 'open',
    text: '/js-superagent Continue the parser work in #1', actor: { login: 'alice', id: '10', type: 'User' }, createdAt: new Date().toISOString(),
    reviewCommentId: 91, reviewRootId: 90, path: 'README.md', line: 1, side: 'RIGHT',
    pullRequest: { repository, number: 9, id: '900', headSha: head, headRef: 'fix', headRepository: repository, state: 'open', merged: false, title: 'Fix' } });
  return { runtime, runs, assessed, inspect, issue, pull, set domainId(value) { domainId = value; }, get domainId() { return domainId; } };
}

test('a PR reference waits for an explicit link and does not block later Issue work', async t => {
  const f = fixture(t);
  const opened = f.issue('/js-superagent Fix the parser', 11);
  assert.equal(opened.status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runs.length, 1);
  const ticket = f.runtime.get(opened.ticketId);
  f.domainId = f.runtime.getDomainTicket(ticket.id).id;
  f.runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 0 });
  f.runtime.configureRepositorySource({ enabled: true, streams: { reviewComments: true } }, { expectedRevision: 0 });
  const event = f.pull();
  const received = f.runtime.receiveGitHubEvent(event);
  assert.deepEqual({ status: received.status, reason: received.reason, ticketId: received.ticketId ?? null }, { status: 'received', reason: 'queued-for-assessment', ticketId: null });
  await f.runtime.runNext();
  assert.equal(f.assessed.length, 1);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.some(input => input.triggerId === event.id), false);
  const hold = f.inspect(store => store.getMeta(`pull-link-required:${event.id}`));
  assert.equal(hold.status, 'pending');
  assert.equal(hold.ticketId, ticket.id);
  assert.equal(hold.pullNumber, 9);
  assert.equal(f.runtime.getDetailed(ticket.id).pullLinks[0].headSha, head);
  const follow = f.issue('/js-superagent Also cover the empty input', 12);
  assert.equal(follow.status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs.at(-1), ticket.id);
  await f.runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
  const attached = f.runtime.receiveGitHubEvent(event);
  assert.equal(attached.reason, 'pull-link-attached');
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.some(input => input.triggerId === event.id), true);
  assert.equal(f.inspect(store => store.getMeta(`pull-link-required:${event.id}`)).status, 'attached');
  await f.runtime.runNext();
  assert.equal(f.runs.length, 3);
});

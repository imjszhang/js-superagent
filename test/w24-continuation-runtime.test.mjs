import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/project';
const actor = { login: 'alice', id: '10', type: 'User' };
const adapter = 'w24-fixture';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function withStore(root, inspect) {
  const store = new Store(join(stateDir(root), 'state.sqlite'));
  try { return inspect(store); } finally { store.close(); }
}
function fixture(t, decision = { kind: 'work', summary: 'Implement the requested follow-up', question: null, base: 'target' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-w24-runtime-')));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'input.txt'), 'original committed content\n');
  git(root, 'add', 'input.txt'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD'), runs = [], inspections = [], sent = [];
  let sequence = 0, snapshot = { repository, number: 9, id: '900', headSha: base, headRef: 'codex/fixture', headRepository: repository,
    baseRef: 'main', baseSha: base, state: 'open', merged: false, url: `https://github.com/${repository}/pull/9`, title: 'Initial change' };
  const channel = {
    async poll() { return []; },
    async getPullRequest(number) { assert.equal(number, snapshot.number); return structuredClone(snapshot); },
    async deliver(message, context) {
      await context.authorizeSend(); sent.push(structuredClone(message));
      return { id: String(sent.length), url: `https://github.com/${repository}/issues/7#issuecomment-${sent.length}` };
    },
  };
  const harnessRegistry = createHarnessRegistry({ adapters: [{
    id: adapter, version: '1', roles: ['worker', 'coordinator'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, capabilities: { sessionResume: true }, async run(input) {
      runs.push({ runId: input.runId, root: input.projectRoot, session: structuredClone(input.session ?? null), ticketId: input.ticket.id });
      input.checkpoint(input.session ?? { driver: adapter, id: `session-${runs.length}` });
      if (runs.length > 1) writeFileSync(join(input.projectRoot, 'followup.txt'), 'follow-up implementation\n');
      return { version: 2, state: 'ready', summary: `Verified worker turn ${runs.length}`, artifacts: [], attention: null };
    } }),
    createAssessor: () => ({
      async assess() { return { kind: 'ignore', reason: 'No new unrelated work', rules: [] }; },
      async inspectContinuation(input) { inspections.push(structuredClone(input.facts)); return structuredClone(decision); },
    }),
  }] });
  const runtime = createProjectAgent({ projectRoot: root, harnessRegistry, execution: { driver: adapter }, workspace: { mode: 'worktree' },
    github: { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 1000 }, githubChannel: channel }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const next = () => ++sequence;
  function issueEvent(kind, text, issueState = 'open') {
    return { id: `github:${repository}:${kind}:${kind === 'issue' ? 700 : 700 + next()}`, repository, issueNumber: 7, issueId: 700, kind, text,
      title: 'Bounded implementation', actor, createdAt: new Date().toISOString(), url: `https://github.com/${repository}/issues/7`, issueState };
  }
  function pullEvent(kind, text = '') {
    return { id: `github:${repository}:${kind}:${900 + next()}`, repository, pullNumber: 9, kind, text,
      headSha: snapshot.headSha, pullState: snapshot.state, merged: snapshot.merged, actor, createdAt: new Date().toISOString(),
      url: `https://github.com/${repository}/pull/9#issuecomment-${sequence}` };
  }
  return { root, base, runtime, runs, inspections, sent, issueEvent, pullEvent,
    closePull(merged, observe = true) { snapshot = { ...snapshot, state: 'closed', merged }; return observe ? runtime.receiveGitHubEvent(pullEvent('pull_request_state')) : null; },
    openPull(number) { snapshot = { ...snapshot, number, id: String(number * 100), state: 'open', merged: false, url: `https://github.com/${repository}/pull/${number}` }; },
    async initial({ linkPull = true, seedInput = false } = {}) {
      runtime.receiveGitHubEvent(issueEvent('issue', '/js-superagent Implement this change and address related feedback'));
      const ticket = runtime.list()[0]; assert.ok(ticket);
      if (linkPull) await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
      if (seedInput) runtime.receiveGitHubEvent(issueEvent('comment', 'Include the related validation in this first implementation'));
      await runtime.runNext(); assert.equal(runtime.get(ticket.id).status, 'completed', JSON.stringify(runtime.getDetailed(ticket.id)));
      assert.equal(runs.length, 1);
      runtime.configureCoordinator({ assessor: { driver: adapter } }, { expectedRevision: 0 });
      return { ticket, workspace: runtime.getWorkspace(ticket.id), session: runtime.getSession(ticket.id) };
    },
  };
}

test('W24 an authorized comment on a closed Issue resumes the existing ticket, workspace and session', async t => {
  const f = fixture(t), { ticket, workspace, session } = await f.initial({ linkPull: false });
  const received = f.runtime.receiveGitHubEvent(f.issueEvent('comment', 'Please add the related follow-up in the agreed scope', 'closed'));
  assert.equal(received.ticketId, ticket.id); assert.equal(received.status, 'received');
  await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1); assert.equal(f.runs.length, 2); assert.equal(f.inspections.length, 0);
  assert.deepEqual(f.runtime.getWorkspace(ticket.id), workspace); assert.deepEqual(f.runs[1].session, session);
  assert.equal(f.runs[1].root, workspace.path);
  assert.equal(readFileSync(join(workspace.path, 'followup.txt'), 'utf8'), 'follow-up implementation\n');
  assert.equal(existsSync(join(f.root, 'followup.txt')), false);
});

for (const merged of [false, true]) test(`W24 a ${merged ? 'merged' : 'closed'} PR explanation uses read-only inspection without a new workspace or worker session`, async t => {
  const summary = 'The recorded implementation was verified before this PR closed';
  const f = fixture(t, { kind: 'reply', summary, question: null, base: null }), { ticket, workspace, session } = await f.initial();
  f.closePull(merged);
  const received = f.runtime.receiveGitHubEvent(f.pullEvent('pr_comment', 'What did the previous verification establish?'));
  assert.equal(received.ticketId, ticket.id); assert.equal(received.status, 'received');
  await f.runtime.runNext(); await f.runtime.flushNotifications();
  assert.equal(f.inspections.length, 1); assert.equal(f.inspections[0].source.merged, merged);
  assert.equal(f.runs.length, 1); assert.deepEqual(f.runtime.getWorkspace(ticket.id), workspace); assert.deepEqual(f.runtime.getSession(ticket.id), session);
  assert.equal(f.runtime.getDetailed(ticket.id).continuation, null); assert.equal(f.runtime.list().length, 1);
  assert.ok(f.sent.some(message => message.text.includes(summary) && Number(message.channel.address.pullNumber ?? message.channel.address.issueNumber) === 9));
  assert.equal(git(workspace.path, 'status', '--porcelain', '--', '.', ':!.js-superagent'), '');
});

test('W24 code work after merge keeps the public ticket while pinning a new workspace and fresh native session', async t => {
  const f = fixture(t), { ticket, workspace, session } = await f.initial();
  const oldOwnership = readFileSync(join(stateDir(f.root), 'workspaces/.records', `${ticket.id}.json`));
  const oldBinding = f.runtime.sessionStatus(ticket.id).harnessBinding;
  // GitHub closed the PR before any state event reached this host. An Issue follow-up still refreshes the current execution target.
  f.closePull(true, false);
  f.runtime.receiveGitHubEvent(f.issueEvent('comment', 'Implement the related follow-up from the current main branch'));
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).status, 'completed', JSON.stringify(f.runtime.getDetailed(ticket.id)));
  assert.equal(f.runtime.list().length, 1); assert.equal(f.runs.length, 2); assert.equal(f.inspections.length, 1);
  const next = f.runtime.getWorkspace(ticket.id), detailed = f.runtime.getDetailed(ticket.id), history = f.runtime.sessionStatus(ticket.id).history;
  assert.equal(next.ticketId, ticket.id); assert.equal(next.generation, 1); assert.notEqual(next.path, workspace.path); assert.notEqual(next.provisionId, workspace.provisionId);
  assert.equal(next.baseCommit, f.base); assert.notEqual(next.branch, 'main'); assert.notEqual(next.branch, workspace.branch);
  assert.equal(f.runs[1].session, null); assert.equal(f.runs[1].root, next.path); assert.notEqual(f.runtime.getSession(ticket.id).id, session.id);
  assert.deepEqual(history.at(-1).session, session); assert.deepEqual(history.at(-1).workspace, workspace); assert.deepEqual(history.at(-1).binding, oldBinding);
  assert.equal(detailed.continuationHistory.length, 1); assert.equal(detailed.continuation.generation, 1);
  assert.equal(detailed.continuation.target.baseCommit, f.base);
  assert.deepEqual(readFileSync(join(stateDir(f.root), 'workspaces/.records', `${ticket.id}.json`)), oldOwnership);
  assert.equal(existsSync(join(workspace.path, 'followup.txt')), false); assert.equal(existsSync(join(f.root, 'followup.txt')), false);
  assert.equal(readFileSync(join(next.path, 'followup.txt'), 'utf8'), 'follow-up implementation\n');
  assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), f.base); assert.equal(git(f.root, 'rev-parse', 'main'), f.base);
  f.openPull(10);
  assert.equal((await f.runtime.linkGitHubPullRequest(ticket.id, { number: 10 })).generation, 1);
  assert.equal((await f.runtime.linkGitHubPullRequest(ticket.id, { number: 10 })).generation, 1);
  assert.equal(f.runtime.githubStatus().trackedPullRequests.find(pull => pull.number === 9).generation ?? 0, 0);
});

test('W24 an unmerged closed PR can ask for the continuation target without changing the old workspace', async t => {
  const f = fixture(t, { kind: 'clarify', summary: 'The old PR was closed without merging', question: 'Continue from main or the previous PR head?', base: null });
  const { ticket, workspace, session } = await f.initial(); f.closePull(false);
  f.runtime.receiveGitHubEvent(f.pullEvent('pr_comment', 'Please finish the related implementation'));
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).status, 'waiting'); assert.equal(f.runs.length, 1); assert.equal(f.inspections.length, 1);
  assert.deepEqual(f.runtime.getWorkspace(ticket.id), workspace); assert.deepEqual(f.runtime.getSession(ticket.id), session);
  assert.equal(f.runtime.getDetailed(ticket.id).continuation, null);
});

test('W24 a human-cancelled ticket cannot be restarted by a closed PR comment', async t => {
  const f = fixture(t), { ticket, workspace } = await f.initial();
  f.runtime.cancel(ticket.id); f.closePull(true);
  const received = f.runtime.receiveGitHubEvent(f.pullEvent('pr_comment', 'Continue the implementation'));
  assert.equal(received.reason, 'cancelled'); await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).status, 'cancelled'); assert.equal(f.runs.length, 1); assert.equal(f.inspections.length, 0);
  assert.deepEqual(f.runtime.getWorkspace(ticket.id), workspace);
});

for (const hazard of ['dirty', 'unknown-input']) test(`W24 ${hazard} predecessor evidence prevents automatic code continuation and remains available for inspection`, async t => {
  const f = fixture(t), { ticket, workspace, session } = await f.initial({ seedInput: hazard === 'unknown-input' }); f.closePull(true);
  if (hazard === 'dirty') writeFileSync(join(workspace.path, 'input.txt'), 'preserve this unfinished edit\n');
  else withStore(f.root, store => {
    const meta = store.getMeta(`ticket:${ticket.id}`), domain = store.tickets.get(meta.domainId), input = domain.inputs[0];
    assert.ok(input); input.readAt = null; store.tickets.save(domain);
    store.setMeta(`live-input:${f.runs[0].runId}:${input.id}`, { runId: f.runs[0].runId, inputId: input.id,
      status: 'accepted', sessionId: session.id, messageId: 'unsettled-native-message' });
  });
  f.runtime.receiveGitHubEvent(f.pullEvent('pr_comment', 'Implement the follow-up from main'));
  await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).status, 'waiting', JSON.stringify(f.runtime.getDetailed(ticket.id)));
  assert.equal(f.runs.length, 1); assert.deepEqual(f.runtime.getWorkspace(ticket.id), workspace); assert.deepEqual(f.runtime.getSession(ticket.id), session);
  assert.equal(f.runtime.getDetailed(ticket.id).continuation, null);
  withStore(f.root, store => {
    assert.equal(store.getMeta(`ticket:${ticket.id}`).continuationInspection.reason,
      hazard === 'dirty' ? 'previous-workspace-dirty' : 'previous-input-outcome-unknown');
    if (hazard === 'unknown-input') assert.equal(store.listMeta('live-input:')[0].value.status, 'accepted');
  });
  if (hazard === 'dirty') assert.equal(readFileSync(join(workspace.path, 'input.txt'), 'utf8'), 'preserve this unfinished edit\n');
  assert.equal(existsSync(join(workspace.path, 'followup.txt')), false); assert.equal(git(f.root, 'rev-parse', 'main'), f.base);
});

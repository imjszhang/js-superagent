import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { githubExecutionRefs, hasVerifiedContinuation } from '../src/runtime/github-execution-refs.mjs';
import { GitHubSyncState } from '../src/runtime/github-sync-state.mjs';
import { Store } from '../src/store.mjs';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';

const repository = 'fixture/history', actor = { login: 'alice', id: '10', type: 'User' };
const channel = (kind, number) => ({ source: 'github', thread: `${repository}#${kind === 'pull' ? 'pr:' : ''}${number}`,
  address: { repository, [kind === 'pull' ? 'pullNumber' : 'issueNumber']: String(number) } });
function facts() {
  const workspace = { ticketId: 'ticket-1', state: 'ready', generation: 1, provisionId: 'new-owned-workspace', continuationId: 'continuation-1', path: '/fixture/g1' };
  const meta = { id: 'ticket-1', github: { issueNumber: 7 }, githubPull: { pullNumber: 9 }, workspace,
    continuation: { version: 1, status: 'ready', id: 'continuation-1', ticketId: 'ticket-1', generation: 1, workspace: { ...workspace } } };
  return { meta, domain: { channels: [channel('issue', 7), channel('pull', 9), channel('pull', 10)] },
    bindings: [{ ticketId: meta.id, number: 9, generation: 0 }, { ticketId: meta.id, number: 10, generation: 1 }] };
}

test('execution dependencies retire committed history while retaining real current inputs and uncertain lineage', () => {
  const input = facts();
  assert.equal(hasVerifiedContinuation(input.meta), true);
  assert.deepEqual(githubExecutionRefs(input), [{ kind: 'pull', number: 10 }]);
  assert.deepEqual(githubExecutionRefs({ ...input, bindings: [] }), [], 'no historical remote object replaces a not-yet-created current PR');
  assert.deepEqual(githubExecutionRefs({ ...input, pendingTriggers: [{ source: 'local', channel: channel('issue', 7) }] }), [{ kind: 'pull', number: 10 }]);
  const refs = githubExecutionRefs({ ...input, pendingTriggers: [{ source: 'github', channel: channel('issue', 7) },
    { source: 'github', meta: { pullEvent: { pullNumber: 9 } }, channel: channel('pull', 9) }] });
  assert.deepEqual(refs, [{ kind: 'pull', number: 10 }, { kind: 'issue', number: 7 }, { kind: 'pull', number: 9 }]);
  input.meta.continuation.workspace.provisionId = 'wrong-owner';
  assert.equal(hasVerifiedContinuation(input.meta), false);
  assert.deepEqual(githubExecutionRefs(input), [{ kind: 'issue', number: 7 }, { kind: 'pull', number: 9 }, { kind: 'pull', number: 10 }]);
});

test('historical object failures remain visible; current failure and repository authorization still block execution', t => {
  const root = mkdtempSync(join(tmpdir(), 'js-history-state-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const state = new GitHubSyncState(store, { repository, allowedActors: ['alice'], pollIntervalMs: 1000 });
  const objects = [{ kind: 'issue', number: 7, status: 'failed', error: { category: 'gone' } },
    { kind: 'pull', number: 9, status: 'failed', error: { category: 'gone' } }, { kind: 'pull', number: 10, status: 'ok' }];
  const save = errors => state.save({ repositoryVerified: !errors.length, objects, errors, discovery: { complete: true } });
  save([]);
  assert.equal(state.status().state, 'degraded');
  assert.equal(state.blocked(githubExecutionRefs(facts())), false);
  assert.equal(state.blocked([{ kind: 'pull', number: 9 }]), true, 'historical outbox destination still has its own health gate');
  objects[2].status = 'failed'; save([]);
  assert.equal(state.blocked(githubExecutionRefs(facts())), true);
  objects[2].status = 'ok'; save([{ scope: 'repository', error: { category: 'auth', message: 'Access revoked' } }]);
  assert.equal(state.blocked(githubExecutionRefs(facts())), true);
});

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
for (const scenario of ['current-pr', 'repository-revoked']) test(`continuation health isolation: ${scenario}`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-history-runtime-'))), sent = [], runs = [], pulls = new Map(), failed = new Set();
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'input.txt'), 'base\n'); git(root, 'add', 'input.txt'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  const pull = number => ({ repository, number, id: String(number * 100), headSha: base, headRef: `feature-${number}`, headRepository: repository,
    baseRef: 'main', baseSha: base, state: 'open', merged: false, title: 'Scoped task', url: `https://github.com/${repository}/pull/${number}` });
  pulls.set(9, pull(9));
  let sequence = 1000, revoked = false;
  const event = (number, kind, text) => ({ id: `github:${repository}:${kind}:${++sequence}`, repository, pullNumber: number,
    kind, text, headSha: base, pullState: pulls.get(number).state, merged: pulls.get(number).merged, actor,
    createdAt: new Date().toISOString(), url: `https://github.com/${repository}/pull/${number}#issuecomment-${sequence}` });
  const githubChannel = {
    async poll({ trackedIssues, trackedPullRequests }) {
      const refs = [...trackedIssues.map(number => ({ kind: 'issue', number })), ...trackedPullRequests.map(item => ({ kind: 'pull', number: item.number }))];
      return { version: 1, repository, repositoryVerified: !revoked, events: [], objects: refs.map(ref => ({ ...ref,
        status: failed.has(`${ref.kind}:${ref.number}`) ? 'failed' : 'ok', ...(failed.has(`${ref.kind}:${ref.number}`) ? { error: { category: 'gone', message: 'Old discussion unavailable' } } : {}) })), errors: revoked ? [{ scope: 'repository', error: { category: 'auth', message: 'Installation access revoked' } }] : [], discovery: { complete: true } };
    },
    async getPullRequest(number) { if (failed.has(`pull:${number}`)) throw new Error('Unavailable PR'); return structuredClone(pulls.get(number)); },
    async deliver(message, context) { await context.authorizeSend(); sent.push(message); return { id: message.id, url: `https://github.com/${repository}/issues/7#issuecomment-1` }; },
  };
  const adapter = 'history-fixture', harnessRegistry = createHarnessRegistry({ adapters: [{ id: adapter, version: '1', roles: ['worker', 'coordinator'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, async run(input) { runs.push(input.projectRoot); input.checkpoint(input.session ?? { driver: adapter, id: `session-${runs.length}` });
      return { version: 2, state: 'ready', summary: `Scoped result ${runs.length}`, artifacts: [], attention: null }; } }),
    createAssessor: () => ({ async assess() { return { kind: 'ignore', reason: 'No unrelated work', rules: [] }; },
      async inspectContinuation() { return { kind: 'work', summary: 'Continue on verified main', question: null, base: 'target' }; } }),
  }] });
  const runtime = createProjectAgent({ projectRoot: root, harnessRegistry, execution: { driver: adapter }, workspace: { mode: 'worktree' },
    github: { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 1000 }, githubChannel }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const issue = { id: `github:${repository}:issue:700`, repository, kind: 'issue', issueNumber: 7, issueId: 700,
    title: 'Scoped implementation', text: '/js-superagent Implement and address related feedback', actor, createdAt: new Date().toISOString(), issueState: 'open' };
  const received = runtime.receiveGitHubEvent(issue), ticket = runtime.get(received.ticketId);
  await runtime.linkGitHubPullRequest(ticket.id, { number: 9 }); await runtime.runNext(); assert.equal(runs.length, 1);
  runtime.configureCoordinator({ assessor: { driver: adapter } }, { expectedRevision: 0 });
  pulls.set(9, { ...pulls.get(9), state: 'closed', merged: true });
  runtime.receiveGitHubEvent(event(9, 'pull_request_state', ''));
  runtime.receiveGitHubEvent(event(9, 'pr_comment', 'Implement the next scoped change on main'));
  await runtime.runNext(); assert.equal(runs.length, 2); assert.equal(runtime.getWorkspace(ticket.id).generation, 1);
  if (scenario === 'repository-revoked') {
    revoked = true;
    runtime.reply(ticket.id, 'Continue the scoped change before creating its new PR');
    await runtime.syncGitHub({ flush: false });
    await runtime.runNext();
    assert.equal(runs.length, 2, 'GitHub continuation without a current PR still requires repository authority');
    assert.equal(runtime.githubStatus().synchronization.state, 'unavailable');
    const local = runtime.submit({ text: 'Independent local task' });
    await runtime.runNext();
    assert.equal(runs.length, 3, 'repository failure does not block a genuinely local ticket');
    assert.equal(runs[2], runtime.getWorkspace(local.id).path);
    return;
  }
  pulls.set(10, pull(10)); await runtime.linkGitHubPullRequest(ticket.id, { number: 10 });
  failed.add('issue:7'); failed.add('pull:9');
  runtime.receiveGitHubEvent(event(10, 'pr_comment', 'Address the related current-head finding'));
  await runtime.syncGitHub({ flush: false });
  await runtime.runNext(); assert.equal(runs.length, 3); assert.equal(runs[2], runs[1]);
  assert.equal(runtime.githubStatus().synchronization.state, 'degraded');
  assert.ok(sent.some(message => Number(message.channel.address.pullNumber) === 10 && message.text.includes('Scoped result 3')));
  assert.ok(runtime.notifications().some(message => Number(message.channel.address.issueNumber) === 7 && message.text.includes('Scoped result 3') && message.status === 'pending'));
  failed.add('pull:10');
  runtime.receiveGitHubEvent(event(10, 'pr_comment', 'Another current-head request'));
  await runtime.syncGitHub({ flush: false });
  await runtime.runNext(); assert.equal(runs.length, 3, 'current PR failure remains an execution gate');
});

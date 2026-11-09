import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareWorkspace, prepareContinuationWorkspace, inspectContinuationWorkspace, validateWorkspace } from '../src/workspaces.mjs';
import { createDeliveryService, deliveryJournalKey } from '../src/delivery.mjs';
import { runVerification } from '../src/verification.mjs';
import { inspectContinuationPreconditions, createContinuationRecord, completeContinuationRecord } from '../src/runtime/github-continuation.mjs';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fixture(t) {
  const outer = mkdtempSync(join(tmpdir(), 'js-superagent-w24-workspace-')), root = join(outer, 'project');
  mkdirSync(root); t.after(() => rmSync(outer, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  git(root, 'add', 'value.mjs'); git(root, 'commit', '-m', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const workspace = prepareWorkspace({ projectRoot: root, ticketId: 'same-ticket', config: { mode: 'worktree' }, persist() {} });
  return { root, outer, baseCommit, workspace };
}
function intent(f, sourceHead = f.baseCommit) {
  return createContinuationRecord({ ticketId: f.workspace.ticketId, triggerIds: ['github:test/project:pr_comment:20'],
    source: { repository: 'test/project', number: 4, state: 'closed', merged: true, headSha: sourceHead },
    previousWorkspace: f.workspace, previousSession: { driver: 'dsh-sdk', id: 'old-session' },
    target: { repository: 'test/project', base: 'main', baseCommit: f.baseCommit, strategy: 'target-branch' } });
}
function next(f, plan, values = {}) {
  return prepareContinuationWorkspace({ projectRoot: f.root, ticketId: f.workspace.ticketId, previousWorkspace: f.workspace,
    baseCommit: plan.target.baseCommit, generation: plan.generation, continuationId: plan.id, persist() {}, ...values });
}

test('W24 clean continuation keeps the ticket, old files and ownership, with an independent pinned generation', t => {
  const f = fixture(t), plan = intent(f), oldRecord = readFileSync(join(stateDir(f.root), 'workspaces/.records/same-ticket.json'));
  const workspace = next(f, plan);
  assert.equal(workspace.ticketId, f.workspace.ticketId);
  assert.equal(workspace.generation, 1); assert.equal(workspace.previousProvisionId, f.workspace.provisionId);
  assert.notEqual(workspace.path, f.workspace.path); assert.notEqual(workspace.provisionId, f.workspace.provisionId);
  assert.equal(workspace.branch, 'js-superagent-continuation/same-ticket/g1');
  assert.equal(completeContinuationRecord(plan, workspace).previousSession.id, 'old-session');
  writeFileSync(join(workspace.path, 'value.mjs'), 'export const value = 2;\n');
  assert.equal(readFileSync(join(f.workspace.path, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.deepEqual(readFileSync(join(stateDir(f.root), 'workspaces/.records/same-ticket.json')), oldRecord);
  assert.deepEqual(validateWorkspace({ projectRoot: f.root, workspace: f.workspace }), f.workspace);
  assert.deepEqual(prepareWorkspace({ projectRoot: f.root, ticketId: workspace.ticketId, config: { mode: 'worktree' }, existing: workspace, persist() {} }), workspace);
  assert.throws(() => next(f, { ...plan, target: { ...plan.target, baseCommit: 'a'.repeat(40) } }, { existing: workspace }), /unavailable|available|changed/);
});

test('W24 dirty, uncertain and ambiguous predecessors require inspection without changing their files', t => {
  const f = fixture(t), plan = intent(f);
  const initial = inspectContinuationWorkspace({ projectRoot: f.root, workspace: f.workspace });
  assert.equal(initial.status, 'ready');
  const source = plan.source;
  const facts = { closedPulls: [source], workspaceInspection: initial };
  assert.equal(inspectContinuationPreconditions(facts).status, 'ready');
  for (const [key, reason] of [['pendingInputIds', 'previous-input-outcome-unknown'], ['pendingOperationIds', 'previous-operation-outcome-unknown'],
    ['activeJobIds', 'previous-jobs-unsettled'], ['activeOwnerIds', 'previous-owner-active']]) {
    assert.equal(inspectContinuationPreconditions({ ...facts, [key]: ['held'] }).reason, reason);
  }
  assert.equal(inspectContinuationPreconditions({ ...facts, closedPulls: [source, { ...source, number: 5 }] }).reason, 'closed-target-ambiguous');
  writeFileSync(join(f.workspace.path, 'value.mjs'), 'keep this unsaved edit\n');
  assert.equal(inspectContinuationWorkspace({ projectRoot: f.root, workspace: f.workspace }).reason, 'previous-workspace-dirty');
  assert.throws(() => next(f, plan), /previous-workspace-dirty/);
  assert.equal(readFileSync(join(f.workspace.path, 'value.mjs'), 'utf8'), 'keep this unsaved edit\n');
  assert.throws(() => createContinuationRecord({ ticketId: f.workspace.ticketId, triggerIds: ['trigger'], source,
    previousWorkspace: f.workspace, target: { ...plan.target, strategy: 'previous-head' } }), /explicit verified target/);
});

test('W24 new generation delivers a new draft and refuses old closed PR writes before commit or push', async t => {
  const f = fixture(t), journal = new Map(), pulls = [], remote = join(f.outer, 'remote.git');
  mkdirSync(remote); git(remote, 'init', '--bare');
  const pushed = [];
  const transport = {
    repository: 'test/project',
    async readHead(branch) {
      const result = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    async push({ cwd, branch, commitSha, expectedHead }) {
      assert.equal(await this.readHead(branch), expectedHead); git(cwd, 'push', remote, `${commitSha}:refs/heads/${branch}`); pushed.push(branch);
      for (const pull of pulls.filter(item => item.head.ref === branch)) pull.head.sha = commitSha;
    },
    async request(endpoint, options = {}) {
      if (/\/pulls\/\d+$/.test(endpoint)) return structuredClone(pulls.find(item => endpoint.endsWith(`/${item.number}`)));
      if (options.method !== 'POST') {
        const branch = new URL(`https://example.invalid${endpoint}`).searchParams.get('head').slice('test:'.length);
        return structuredClone(pulls.filter(item => item.head.ref === branch));
      }
      const number = pulls.length + 1, body = options.body;
      const pull = { number, html_url: `https://github.com/test/project/pull/${number}`, state: 'open', draft: true, title: body.title, body: body.body,
        head: { sha: await this.readHead(body.head), ref: body.head, repo: { full_name: 'test/project' } },
        base: { ref: body.base, repo: { full_name: 'test/project' } } };
      pulls.push(pull); return structuredClone(pull);
    },
  };
  const service = createDeliveryService({ projectRoot: f.root, projectId: 'project', transport, load: key => structuredClone(journal.get(key)),
    save: (key, value) => journal.set(key, structuredClone(value)), withLock: async (_key, work) => work() });
  async function deliver(workspace, runId) {
    const verification = await runVerification({ projectRoot: f.root, workspace,
      profile: { id: 'syntax', version: '1', command: process.execPath, args: ['--check', 'value.mjs'], paths: ['value.mjs'], environment: 'host', allowHostExecution: true }, persist() {} });
    return service.deliver({ workspace, verification, runId, mode: 'draft-pr', repository: 'test/project', base: 'main', title: 'Follow up', allowedPaths: ['value.mjs'] });
  }
  writeFileSync(join(f.workspace.path, 'value.mjs'), 'export const value = 2;\n');
  const first = await deliver(f.workspace, 'same-run');
  pulls[0].state = 'closed'; pulls[0].merged_at = new Date().toISOString();
  const plan = intent(f, first.commitSha), workspace = next(f, plan, { expectedPreviousHead: first.commitSha });
  writeFileSync(join(workspace.path, 'value.mjs'), 'export const value = 3;\n');
  const second = await deliver(workspace, 'same-run');
  assert.equal(second.ticketId, first.ticketId); assert.equal(second.generation, 1);
  assert.equal(second.pullRequest.number, 2); assert.equal(pulls[0].head.sha, first.commitSha);
  assert.notEqual(first.marker, second.marker);
  assert.notEqual(deliveryJournalKey({ projectId: 'project', workspace: f.workspace, runId: 'same-run' }), deliveryJournalKey({ projectId: 'project', workspace, runId: 'same-run' }));
  writeFileSync(join(f.workspace.path, 'value.mjs'), 'export const value = 4;\n');
  await assert.rejects(deliver(f.workspace, 'old-target-run'), /Owned PR is closed/);
  assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), first.commitSha);
  assert.deepEqual(pushed, [f.workspace.branch, workspace.branch]);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.baseCommit);
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareWorkspace, validateWorkspace, inspectWorkspace } from '../src/workspaces.mjs';

function fixture(t) {
  const outer = mkdtempSync(join(tmpdir(), 'js-superagent-workspaces-'));
  const root = join(outer, 'project'); mkdirSync(root);
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  return { root, outer };
}
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repository(root) {
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Workspace Test'); git(root, 'config', 'user.email', 'workspace@example.invalid');
  writeFileSync(join(root, 'calc.py'), 'value = 1\n');
  writeFileSync(join(root, 'README.md'), 'committed baseline\n');
  git(root, 'add', 'calc.py', 'README.md'); git(root, 'commit', '-m', 'baseline');
}
function create(root, ticketId = 'ticket-1', config = { mode: 'copy' }) {
  let current; const states = [];
  const workspace = prepareWorkspace({ projectRoot: root, ticketId, config, persist(value) { current = structuredClone(value); states.push(value.state); } });
  return { workspace, states, current };
}

test('copy snapshots independently, excludes credentials/state/dependencies and never follows symlinks', t => {
  const { root, outer } = fixture(t);
  writeFileSync(join(root, 'calc.py'), 'value = 1\n');
  writeFileSync(join(root, '.env'), 'secret');
  writeFileSync(join(root, '.env.production'), 'secret');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'hidden'), 'dep');
  mkdirSync(join(root, 'private')); writeFileSync(join(root, 'private', 'custom'), 'private');
  writeFileSync(join(outer, 'outside'), 'do not copy'); symlinkSync(join(outer, 'outside'), join(root, 'escape'));
  const { workspace, states } = create(root, 'copy-1', { mode: 'copy', exclude: ['private'] });
  assert.deepEqual(states, ['preparing', 'ready']);
  assert.equal(readFileSync(join(workspace.path, 'calc.py'), 'utf8'), 'value = 1\n');
  assert.notEqual(lstatSync(join(workspace.path, 'calc.py')).ino, lstatSync(join(root, 'calc.py')).ino);
  for (const path of ['.env', '.env.production', 'node_modules', 'escape', 'private']) assert.equal(existsSync(join(workspace.path, path)), false);
  writeFileSync(join(workspace.path, 'calc.py'), 'value = 2\n');
  writeFileSync(join(workspace.path, 'result.txt'), 'finished');
  assert.equal(readFileSync(join(root, 'calc.py'), 'utf8'), 'value = 1\n');
  assert.equal(workspace.excludedPaths.find(row => row.path === 'escape').reason, 'symlink-not-copied');
  assert.deepEqual(inspectWorkspace({ projectRoot: root, workspace }).changes, [{ path: 'calc.py', status: 'modified' }, { path: 'result.txt', status: 'added' }]);
});

test('copy baseline and ticket workspace remain pinned across source edits, retries and config changes', t => {
  const { root } = fixture(t); writeFileSync(join(root, 'calc.py'), 'baseline');
  const { workspace } = create(root);
  writeFileSync(join(root, 'calc.py'), 'new unrelated source edit');
  const second = create(root, 'ticket-2').workspace;
  assert.equal(readFileSync(join(second.path, 'calc.py'), 'utf8'), 'new unrelated source edit');
  assert.notEqual(second.path, workspace.path);
  const reused = prepareWorkspace({ projectRoot: root, ticketId: 'ticket-1', config: { mode: 'in-place' }, existing: workspace, persist() { throw new Error('Ready workspace must not be rewritten'); } });
  assert.equal(reused.path, workspace.path);
  assert.equal(readFileSync(join(workspace.path, 'calc.py'), 'utf8'), 'baseline');
  assert.deepEqual(inspectWorkspace({ projectRoot: root, workspace }).changes, []);
  rmSync(join(workspace.path, 'calc.py'));
  assert.deepEqual(inspectWorkspace({ projectRoot: root, workspace }).changes, [{ path: 'calc.py', status: 'deleted' }]);
});

test('legal prototype-named filenames are preserved and reviewed', t => {
  const { root } = fixture(t);
  for (const name of ['__proto__', 'constructor', 'toString']) writeFileSync(join(root, name), 'baseline');
  const { workspace } = create(root);
  for (const name of ['__proto__', 'constructor', 'toString']) assert.equal(readFileSync(join(workspace.path, name), 'utf8'), 'baseline');
  rmSync(join(workspace.path, 'constructor')); writeFileSync(join(workspace.path, '__proto__'), 'changed');
  assert.deepEqual(inspectWorkspace({ projectRoot: root, workspace }).changes, [{ path: '__proto__', status: 'modified' }, { path: 'constructor', status: 'deleted' }]);
});

test('Git worktrees pin committed baseline and keep dirty source index, branch and files untouched', t => {
  const { root } = fixture(t); repository(root);
  const commit = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), 'staged source edit\n'); git(root, 'add', 'README.md');
  writeFileSync(join(root, 'untracked.txt'), 'source only');
  const indexBefore = git(root, 'diff', '--cached');
  const { workspace } = create(root, 'git-1', { mode: 'auto' });
  assert.equal(workspace.mode, 'worktree'); assert.equal(workspace.baseCommit, commit); assert.equal(workspace.sourceDirty, true);
  assert.equal(git(workspace.path, 'branch', '--show-current'), 'js-superagent/git-1');
  assert.equal(readFileSync(join(workspace.path, 'README.md'), 'utf8'), 'committed baseline\n');
  assert.equal(existsSync(join(workspace.path, 'untracked.txt')), false);
  writeFileSync(join(workspace.path, 'calc.py'), 'value = 2\n'); writeFileSync(join(workspace.path, 'added.py'), 'new');
  const second = create(root, 'git-2', { mode: 'worktree' }).workspace;
  assert.equal(readFileSync(join(second.path, 'calc.py'), 'utf8'), 'value = 1\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), commit); assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.equal(git(root, 'diff', '--cached'), indexBefore);
  assert.equal(readFileSync(join(root, 'calc.py'), 'utf8'), 'value = 1\n');
  assert.deepEqual(inspectWorkspace({ projectRoot: root, workspace }).changes, [{ path: 'added.py', status: 'added' }, { path: 'calc.py', status: 'modified' }]);
  assert.equal(validateWorkspace({ projectRoot: root, workspace }).path, workspace.path);
});

test('auto scopes nested projects to copy; explicit worktree and unborn repositories fail clearly', t => {
  const { root } = fixture(t); repository(root);
  const nested = join(root, 'nested'); mkdirSync(nested); writeFileSync(join(nested, 'only.py'), 'nested');
  const copied = create(nested, 'nested', { mode: 'auto' }).workspace;
  assert.equal(copied.mode, 'copy'); assert.equal(copied.fallbackReason, 'nested-project');
  assert.equal(existsSync(join(copied.path, 'calc.py')), false);
  assert.throws(() => create(nested, 'explicit', { mode: 'worktree' }), /exact Git project root/);
  const unborn = join(root, 'unborn'); mkdirSync(unborn); git(unborn, 'init', '-b', 'main');
  assert.throws(() => create(unborn, 'unborn', { mode: 'auto' }), /existing base commit/);
  assert.equal(create(unborn, 'copy-unborn', { mode: 'copy' }).workspace.mode, 'copy');
});

test('saved ready workspaces are never recreated or silently switched after deletion/tampering', t => {
  const { root, outer } = fixture(t); writeFileSync(join(root, 'calc.py'), 'value = 1');
  const { workspace } = create(root);
  const moved = join(outer, 'moved'); renameSync(workspace.path, moved);
  assert.throws(() => prepareWorkspace({ projectRoot: root, ticketId: workspace.ticketId, existing: workspace, config: { mode: 'copy' }, persist() {} }), /missing or unsafe/);
  symlinkSync(moved, workspace.path);
  assert.throws(() => validateWorkspace({ projectRoot: root, workspace }), /missing or unsafe/);
  rmSync(workspace.path); renameSync(moved, workspace.path);
  writeFileSync(workspace.manifestPath, '{}');
  assert.throws(() => validateWorkspace({ projectRoot: root, workspace }), /manifest changed/);
});

test('worktree identity and source state directory symlinks cannot redirect execution', t => {
  const { root, outer } = fixture(t); repository(root);
  const { workspace } = create(root, 'git', { mode: 'worktree' });
  git(workspace.path, 'checkout', '--detach', 'HEAD');
  assert.throws(() => validateWorkspace({ projectRoot: root, workspace }), /Git workspace operation failed|identity changed/);
  const other = join(outer, 'other'); mkdirSync(other); symlinkSync(stateDir(root), stateDir(other));
  assert.throws(() => create(other), /symlink/);
  assert.throws(() => create(root, '../escape'), /Invalid workspace ticket ID/);
  assert.throws(() => create(root, 'badexclude', { mode: 'copy', exclude: ['../outside'] }), /relative paths/);
});

test('failed ready persistence recovers completed owned workspace without recopying changed source', t => {
  const { root } = fixture(t); writeFileSync(join(root, 'calc.py'), 'baseline');
  let saved;
  assert.throws(() => prepareWorkspace({ projectRoot: root, ticketId: 'recover', config: { mode: 'copy' }, persist(value) {
    if (value.state === 'ready') throw new Error('simulated database failure');
    saved = value;
  } }), /database failure/);
  writeFileSync(join(root, 'calc.py'), 'later change');
  const resumed = prepareWorkspace({ projectRoot: root, ticketId: 'recover', config: { mode: 'copy' }, existing: saved, persist(value) { saved = value; } });
  assert.equal(resumed.state, 'ready'); assert.equal(saved.state, 'ready');
  assert.equal(readFileSync(join(resumed.path, 'calc.py'), 'utf8'), 'baseline');
});

test('prepared copy journal resumes safely before or after the atomic directory publish', t => {
  const { root } = fixture(t); writeFileSync(join(root, 'calc.py'), 'baseline');
  for (const published of [false, true]) {
    const ticketId = published ? 'published' : 'staged';
    const { workspace } = create(root, ticketId);
    const stagingPath = `${workspace.path}.staging-11111111-1111-4111-8111-111111111111`;
    if (!published) renameSync(workspace.path, stagingPath);
    const record = join(stateDir(root), 'workspaces', '.records', `${ticketId}.json`);
    writeFileSync(record, JSON.stringify({ ...workspace, state: 'preparing', stagingPath, prepared: workspace }));
    const resumed = prepareWorkspace({ projectRoot: root, ticketId, existing: { ...workspace, state: 'preparing' }, persist() {} });
    assert.equal(resumed.state, 'ready');
    assert.equal(readFileSync(join(resumed.path, 'calc.py'), 'utf8'), 'baseline');
    assert.equal(existsSync(stagingPath), false);
  }
});

test('dangling destination links and unknown directories are preserved rather than overwritten', t => {
  const { root, outer } = fixture(t); create(root, 'seed');
  const path = join(stateDir(root), 'workspaces', 'conflict');
  symlinkSync(join(outer, 'missing'), path);
  assert.throws(() => create(root, 'conflict'), /already exists/);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  rmSync(path); mkdirSync(path); writeFileSync(join(path, 'user-file'), 'preserve');
  assert.throws(() => create(root, 'conflict'), /already exists/);
  assert.equal(readFileSync(join(path, 'user-file'), 'utf8'), 'preserve');
});

test('branch conflicts preserve existing branch and persist a reviewable provisioning intent', t => {
  const { root } = fixture(t); repository(root); git(root, 'branch', 'js-superagent/conflict');
  const commit = git(root, 'rev-parse', 'js-superagent/conflict');
  let saved;
  assert.throws(() => prepareWorkspace({ projectRoot: root, ticketId: 'conflict', config: { mode: 'worktree' }, persist(value) { saved = value; } }), /already exists/);
  assert.equal(saved.state, 'preparing'); assert.equal(existsSync(saved.path), false);
  assert.equal(git(root, 'rev-parse', 'js-superagent/conflict'), commit);
});

test('in-place remains compatible and explicitly reports lack of isolation', t => {
  const { root } = fixture(t); const { workspace } = create(root, 'legacy', { mode: 'in-place' });
  assert.equal(workspace.path, realpathSync(root));
  assert.equal(inspectWorkspace({ projectRoot: root, workspace }).isolation, false);
  assert.equal(existsSync(join(stateDir(root), 'workspaces')), false);
});

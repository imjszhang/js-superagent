import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { projectStateDirectory, projectStateKey, stateHome, assertStateMigrated } from '../src/state-paths.mjs';
import { initializeProjectConfig, readProjectConfig } from '../src/config.mjs';
import { ensureProjectIdentity } from '../src/project-identity.mjs';
import { prepareWorkspace, validateWorkspace } from '../src/workspaces.mjs';
import { migrateProjectState } from '../src/project-maintenance.mjs';
import { Store } from '../src/store.mjs';

function project(t, name = 'my.project') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-state-paths-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, name); mkdirSync(root);
  return { base, root };
}
function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('state lives under the per-user home, keyed like Claude Code projects', t => {
  const { base, root } = project(t);
  assert.equal(projectStateKey(root), root.replace(/[^A-Za-z0-9]/g, '-'));
  assert.equal(projectStateDirectory(root), join(stateHome(), 'projects', projectStateKey(root)));
  const alias = join(base, 'alias'); symlinkSync(root, alias);
  assert.equal(projectStateDirectory(alias), projectStateDirectory(root));
  const deep = join(base, 'x'.repeat(240)); mkdirSync(deep);
  assert.ok(projectStateKey(deep).length <= 200);
  assert.notEqual(projectStateKey(deep), projectStateKey(join(base, 'x'.repeat(239))));
  assert.equal(stateHome({ JS_SUPERAGENT_HOME: join(base, 'home') }), join(base, 'home'));
  assert.throws(() => stateHome({ JS_SUPERAGENT_HOME: 'relative' }), /absolute/);
});

test('initialization writes nothing inside the project directory', t => {
  const { root } = project(t);
  const config = initializeProjectConfig(root);
  ensureProjectIdentity(root, config.projectId);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(readProjectConfig(root).projectId, config.projectId);
  assert.equal(existsSync(join(projectStateDirectory(root), 'instance.json')), true);
});

test('old in-project state must be migrated before anything opens the project', t => {
  const { root } = project(t);
  mkdirSync(join(root, '.js-superagent')); writeFileSync(join(root, '.js-superagent', 'config.json'), '{}');
  assert.throws(() => initializeProjectConfig(root), { code: 'PROJECT_STATE_MIGRATION_REQUIRED' });
  mkdirSync(join(root, 'workspace-only', '.js-superagent'), { recursive: true });
  writeFileSync(join(root, 'workspace-only', '.js-superagent', 'workspace-owner.json'), '{}');
  assert.doesNotThrow(() => assertStateMigrated(join(root, 'workspace-only')));
});

// Builds the pre-migration layout: state in <project>/.js-superagent with absolute paths pointing there.
function legacyProject(t) {
  const f = project(t);
  git(f.root, 'init', '-b', 'main'); git(f.root, 'config', 'user.name', 'State Test'); git(f.root, 'config', 'user.email', 'state@example.invalid');
  writeFileSync(join(f.root, 'README.md'), 'baseline\n'); git(f.root, 'add', 'README.md'); git(f.root, 'commit', '-m', 'baseline');
  const config = initializeProjectConfig(f.root, { workspace: 'worktree' });
  ensureProjectIdentity(f.root, config.projectId);
  const workspace = prepareWorkspace({ projectRoot: f.root, ticketId: 't1', config: { mode: 'worktree' }, persist() {} });
  const store = new Store(join(projectStateDirectory(f.root), 'state.sqlite'));
  store.setMeta('ticket:t1', { id: 't1', domainId: 'domain-1', driverSession: { driver: 'fixture', id: 'native-1' }, workspace });
  store.db.prepare('INSERT INTO domain_tickets(id,data) VALUES(?,?)').run('domain-1', JSON.stringify({ id: 'domain-1', assignments: [] }));
  store.close();
  const current = projectStateDirectory(f.root), legacy = join(f.root, '.js-superagent');
  renameSync(current, legacy);
  const records = join(legacy, 'workspaces/.records');
  for (const name of readdirSync(records)) writeFileSync(join(records, name), readFileSync(join(records, name), 'utf8').replaceAll(current, legacy));
  const db = new DatabaseSync(join(legacy, 'state.sqlite'));
  db.prepare('UPDATE kv SET data=replace(data,?,?)').run(current, legacy); db.close();
  git(f.root, 'worktree', 'repair', join(legacy, 'workspaces', 't1'));
  return { ...f, legacy, current, workspace };
}

test('migrate-state moves old state, repairs worktrees and rewrites saved paths', t => {
  const f = legacyProject(t);
  assert.throws(() => readProjectConfig(f.root), { code: 'PROJECT_STATE_MIGRATION_REQUIRED' });
  const plan = migrateProjectState({ projectRoot: f.root });
  assert.equal(plan.applied, false); assert.deepEqual(plan.blockers, []); assert.equal(existsSync(f.legacy), true);
  const result = migrateProjectState({ projectRoot: f.root, apply: true });
  assert.equal(result.phase, 'completed');
  assert.deepEqual(result.repairedWorktrees, [join(f.current, 'workspaces', 't1')]);
  assert.deepEqual(result.requiresInspection, ['t1']);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(readProjectConfig(f.root).workspace.mode, 'worktree');
  const store = new Store(join(f.current, 'state.sqlite'));
  const meta = store.getMeta('ticket:t1'); store.close();
  assert.equal(meta.workspace.path, f.workspace.path);
  assert.equal(meta.relocationInspection.reason, 'native-session-cwd-changed');
  assert.doesNotThrow(() => validateWorkspace({ projectRoot: f.root, workspace: meta.workspace }));
  assert.match(git(f.root, 'worktree', 'list'), new RegExp(f.workspace.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => migrateProjectState({ projectRoot: f.root }), { code: 'PROJECT_STATE_NOT_LEGACY' });
});

test('migrate-state refuses while a background service is still installed', t => {
  const f = legacyProject(t);
  mkdirSync(join(f.legacy, 'service')); writeFileSync(join(f.legacy, 'service', 'manifest.json'), '{}');
  assert.ok(migrateProjectState({ projectRoot: f.root }).blockers.some(item => item.code === 'PROJECT_SERVICE_INSTALLED'));
  assert.throws(() => migrateProjectState({ projectRoot: f.root, apply: true }), { code: 'PROJECT_MAINTENANCE_BLOCKED' });
  assert.equal(existsSync(join(f.legacy, 'config.json')), true);
});

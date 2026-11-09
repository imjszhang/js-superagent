import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { initializeProjectConfig, readProjectConfig } from '../src/config.mjs';
import { ensureProjectIdentity, inspectProjectIdentity } from '../src/project-identity.mjs';
import { createMachineCoordinator } from '../src/machine-coordination.mjs';
import { Store } from '../src/store.mjs';
import { prepareWorkspace, validateWorkspace } from '../src/workspaces.mjs';
import { inspectProject, reinitializeProject, relocateProject } from '../src/project-maintenance.mjs';

function fixture(t, { ticket = true, nestedSource = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'js-project-maintenance-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const from = join(directory, ...(nestedSource ? ['source', 'from'] : ['from'])), to = join(directory, 'to'), deps = { directory: join(directory, 'machine') };
  mkdirSync(from, { recursive: true }); mkdirSync(to);
  const config = initializeProjectConfig(from, { workspace: 'in-place', github: { repository: 'owner/repo', allowedActors: ['owner'] } });
  const identity = ensureProjectIdentity(from, config.projectId);
  const machine = createMachineCoordinator({ projectRoot: from, projectId: config.projectId }, deps); machine.register(); machine.claimRepository({ repository: 'owner/repo', repositoryId: 77 });
  const store = new Store(join(stateDir(from), 'state.sqlite'));
  store.setMeta('instance:identity', { instanceId: identity.instanceId, stateId: identity.stateId });
  if (ticket) {
    store.setMeta('ticket:t1', { id: 't1', domainId: 'domain-1', driverSession: { id: 'native-session', driver: 'dsh-sdk' }, workspace: { mode: 'in-place', state: 'ready', projectRoot: from, path: from, ticketId: 't1' } });
    store.db.prepare('INSERT INTO domain_tickets(id,data) VALUES(?,?)').run('domain-1', JSON.stringify({ id: 'domain-1', assignments: [] }));
    store.setMeta('coordinator:session:1', { id: 'coordinator-native' });
  }
  store.db.exec('PRAGMA user_version=9'); store.close();
  const copy = () => cpSync(stateDir(from), stateDir(to), { recursive: true });
  const meta = (root, key) => { const db = new DatabaseSync(join(stateDir(root), 'state.sqlite'), { readOnly: true }); try { const row = db.prepare('SELECT data FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.data) : undefined; } finally { db.close(); } };
  return { directory, from, to, deps, config, identity, machine, copy, meta };
}

test('inspection and dry-run plans do not create maintenance files or change identities', async t => {
  const f = fixture(t); f.copy();
  const before = readFileSync(join(stateDir(f.to), 'config.json'), 'utf8');
  const inspect = inspectProject(f.to, f.deps); assert.equal(inspect.identity.matches, false);
  const plan = await reinitializeProject({ projectRoot: f.to }, f.deps); assert.equal(plan.applied, false);
  const move = await relocateProject({ projectRoot: f.to, fromRoot: f.from }, f.deps); assert.deepEqual(move.blockers, []);
  assert.equal(readFileSync(join(stateDir(f.to), 'config.json'), 'utf8'), before);
  assert.equal(existsSync(join(stateDir(f.to), 'maintenance')), false);
});

test('reinitializing a copied project archives history without releasing the original runtime or repository', async t => {
  const f = fixture(t); f.copy(); const lease = f.machine.acquireLease();
  const result = await reinitializeProject({ projectRoot: f.to, apply: true }, f.deps);
  assert.equal(result.phase, 'completed'); assert.notEqual(result.identity.projectId, f.identity.projectId);
  assert.notEqual(result.identity.instanceId, f.identity.instanceId); assert.notEqual(result.identity.stateId, f.identity.stateId);
  assert.equal(readProjectConfig(f.to).github, undefined); assert.equal(f.meta(f.to, 'ticket:t1'), undefined);
  assert.equal(f.meta(f.from, 'ticket:t1').driverSession.id, 'native-session');
  assert.ok(existsSync(join(result.archive, 'state.sqlite')));
  assert.equal(f.machine.repositoryBinding({ repository: 'owner/repo' })[0].instanceId, f.identity.instanceId);
  assert.equal(f.machine.assertLease(lease).token, lease.token); f.machine.releaseLease(lease);
  assert.equal(existsSync(join(stateDir(f.to), 'state.sqlite.maintenance-lock')), false);
});

test('reinitialization resumes after archiving even though the active config is temporarily absent', async t => {
  const f = fixture(t); f.copy();
  await assert.rejects(reinitializeProject({ projectRoot: f.to, apply: true }, { ...f.deps, afterStep: phase => { if (phase === 'archived') throw new Error('injected interruption'); } }), /injected/);
  assert.equal(existsSync(join(stateDir(f.to), 'config.json')), false);
  assert.equal(existsSync(join(stateDir(f.to), 'state.sqlite.maintenance-lock')), true);
  assert.equal(inspectProject(f.to, f.deps).maintenance.phase, 'archived');
  const result = await reinitializeProject({ projectRoot: f.to, apply: true }, f.deps);
  assert.equal(result.phase, 'completed'); assert.equal(readProjectConfig(f.to).projectId, result.identity.projectId);
});

test('relocation preserves ticket and repository identity, pauses work and requires native session inspection', async t => {
  const f = fixture(t); f.copy();
  const result = await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, f.deps);
  assert.equal(result.phase, 'completed'); assert.equal(result.identity.instanceId, f.identity.instanceId);
  const ticket = f.meta(f.to, 'ticket:t1'); assert.equal(ticket.driverSession.id, 'native-session');
  assert.equal(ticket.workspace.path, f.to); assert.equal(ticket.relocationInspection.fromRoot, f.from);
  assert.equal(f.meta(f.to, 'runtime:pause').paused, true); assert.equal(f.meta(f.to, 'coordinator:session:1'), undefined);
  assert.equal(f.meta(f.to, `project:relocation:${ticket.relocationInspection.id}:coordinator-sessions`)[0].value.id, 'coordinator-native');
  assert.equal(f.machine.repositoryBinding({ repository: 'owner/repo' })[0].projectRoot, f.to);
  assert.throws(() => f.machine.register(), /another path|another/);
  assert.equal(existsSync(join(stateDir(f.from), 'state.sqlite.maintenance-lock')), false);
});

test('interrupted relocation remains fenced and can resume or roll back without deleting the original', async t => {
  const f = fixture(t); f.copy();
  await assert.rejects(relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, { ...f.deps, afterStep: phase => { if (phase === 'rewritten') throw new Error('injected interruption'); } }), /injected/);
  assert.throws(() => new Store(join(stateDir(f.to), 'state.sqlite')), /maintenance/);
  const result = await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, f.deps);
  assert.equal(result.phase, 'completed');
  const restored = await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true, mode: 'rollback' }, f.deps);
  assert.equal(restored.phase, 'rolled-back'); assert.ok(existsSync(f.from));
  assert.equal(f.machine.repositoryBinding({ repository: 'owner/repo' })[0].projectRoot, f.from);
  assert.equal(f.meta(f.to, 'ticket:t1').workspace.path, f.from);
  assert.equal(inspectProjectIdentity(f.to, f.config.projectId).matches, false);
});

test('relocation resume and rollback reject an active old-root parent before restoring state', async t => {
  const f = fixture(t, { nestedSource: true }); f.copy();
  await assert.rejects(relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, { ...f.deps, afterStep(phase) { if (phase === 'relocated') throw new Error('injected after identity rewrite'); } }), /injected/);
  const parent = createMachineCoordinator({ projectRoot: join(f.directory, 'source'), projectId: 'parent' }, f.deps); parent.register();
  for (const mode of ['resume', 'rollback']) {
    const lease = parent.acquireLease(), before = readFileSync(join(stateDir(f.to), 'state.sqlite'));
    let stepped = false;
    await assert.rejects(relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true, mode }, { ...f.deps, afterStep() { stepped = true; } }), { code: 'PROJECT_ROOT_OVERLAP' });
    assert.equal(stepped, false); assert.deepEqual(readFileSync(join(stateDir(f.to), 'state.sqlite')), before);
    assert.equal(f.meta(f.to, 'ticket:t1').workspace.path, f.to);
    parent.releaseLease(lease);
    const result = await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true, mode }, f.deps);
    assert.equal(result.phase, mode === 'resume' ? 'completed' : 'rolled-back');
  }
});

test('relocation refuses divergent copied state and unrepaired worktrees', async t => {
  const f = fixture(t); f.copy();
  const changed = new Store(join(stateDir(f.to), 'state.sqlite')); changed.setMeta('different', true); changed.close();
  const plan = await relocateProject({ projectRoot: f.to, fromRoot: f.from }, f.deps);
  assert.ok(plan.blockers.some(item => item.code === 'PROJECT_RELOCATION_DIVERGED'));
  await assert.rejects(relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, f.deps), /blockers/);
  const records = join(stateDir(f.to), 'workspaces/.records'); mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(join(records, 't1.json'), JSON.stringify({ mode: 'worktree', state: 'ready', projectRoot: f.from, path: join(stateDir(f.from), 'workspaces/t1'), ticketId: 't1' }));
  const active = new Store(join(stateDir(f.to), 'state.sqlite'));
  const meta = active.getMeta('ticket:t1'); meta.workspace = JSON.parse(readFileSync(join(records, 't1.json'), 'utf8')); active.setMeta('ticket:t1', meta); active.close();
  const unsafe = await relocateProject({ projectRoot: f.to, fromRoot: f.from }, f.deps);
  assert.ok(unsafe.blockers.some(item => item.code === 'PROJECT_WORKTREE_REPAIR_REQUIRED'));
});

test('relocation can adopt a physically moved directory using the registered instance proof', async t => {
  const f = fixture(t); rmSync(f.to, { recursive: true }); renameSync(f.from, f.to);
  const plan = await relocateProject({ projectRoot: f.to, fromRoot: f.from }, f.deps);
  assert.deepEqual(plan.stateMove, { from: stateDir(f.from), to: stateDir(f.to) }); assert.equal(existsSync(stateDir(f.to)), false);
  const result = await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, f.deps);
  assert.equal(result.phase, 'completed'); assert.equal(result.identity.stateId, f.identity.stateId);
  assert.equal(result.identity.projectRoot, f.to);
  assert.equal(existsSync(stateDir(f.from)), false); assert.equal(existsSync(join(stateDir(f.to), 'config.json')), true);
});


test('reinitializing an original stopped project releases only its old registration', async t => {
  const f = fixture(t);
  const result = await reinitializeProject({ projectRoot: f.from, apply: true }, f.deps);
  assert.notEqual(result.identity.projectId, f.config.projectId);
  const projects = createMachineCoordinator({}, f.deps).listProjects();
  assert.equal(projects.length, 1); assert.equal(projects[0].instanceId, result.identity.instanceId);
  assert.deepEqual(createMachineCoordinator({}, f.deps).repositoryBinding(), []);
});

test('copy workspaces relocate only known ownership fields and preserve their baseline', async t => {
  const f = fixture(t); writeFileSync(join(f.from, 'example.txt'), 'sample');
  const workspace = prepareWorkspace({ projectRoot: f.from, ticketId: 't1', config: { mode: 'copy' }, persist() {} });
  const store = new Store(join(stateDir(f.from), 'state.sqlite'));
  const meta = store.getMeta('ticket:t1'); meta.workspace = workspace; store.setMeta('ticket:t1', meta); store.close(); f.copy();
  await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, f.deps);
  const moved = f.meta(f.to, 'ticket:t1').workspace;
  assert.equal(moved.manifestSha256, workspace.manifestSha256);
  assert.equal(validateWorkspace({ projectRoot: f.to, workspace: moved }).path, join(stateDir(f.to), 'workspaces/t1'));
  assert.equal(readFileSync(join(moved.path, 'example.txt'), 'utf8'), 'sample');
});

test('relocated service is retired by original identity and reinstalled disabled with its credential reference', async t => {
  const f = fixture(t), directory = join(stateDir(f.from), 'service'); mkdirSync(directory, { mode: 0o700 });
  const manifest = { projectId: f.config.projectId, projectRoot: f.from, mode: 'poll', nodeExecutable: process.execPath, cliPath: '/fixed/js-superagent.mjs', homeDirectory: f.directory, logMaxBytes: 1024, environmentFile: join(directory, 'credentials.env') };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(manifest.environmentFile, 'EXAMPLE_KEY=local-fixture', { mode: 0o600 }); f.copy();
  const calls = [];
  const result = await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, { ...f.deps,
    retireRelocatedService(options) { calls.push(['retire', options]); return { retired: true }; },
    installService(options, dependencies) { calls.push(['install', options]); assert.ok(dependencies.maintenanceToken); return { installed: true, loaded: false, running: false }; },
  });
  assert.deepEqual(calls[0], ['retire', { projectRoot: f.to, fromRoot: f.from }]);
  assert.equal(calls[1][1].projectRoot, f.to);
  assert.ok(calls[1][1].environmentFile.startsWith(result.backup.directory));
  assert.equal(result.service.running, false); assert.equal(result.service.loaded, false);
});


test('an active original lease blocks relocation before backup and a later changed original is not silently discarded', async t => {
  const f = fixture(t); f.copy(); const lease = f.machine.acquireLease();
  await assert.rejects(relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, f.deps), /active|unverifiable/);
  assert.equal(existsSync(join(stateDir(f.to), 'state.sqlite.maintenance-lock')), false);
  f.machine.releaseLease(lease);
  const original = new Store(join(stateDir(f.from), 'state.sqlite')); original.setMeta('new-original-input', true); original.close();
  const plan = await relocateProject({ projectRoot: f.to, fromRoot: f.from }, f.deps);
  assert.ok(plan.blockers.some(item => item.code === 'PROJECT_RELOCATION_DIVERGED'));
});

test('both copies are fenced before backup is exposed and rollback refuses new post-relocation writes', async t => {
  const f = fixture(t); f.copy(); let checked = false;
  await relocateProject({ projectRoot: f.to, fromRoot: f.from, apply: true }, { ...f.deps, afterStep(phase) {
    if (phase !== 'backed-up') return; checked = true;
    for (const root of [f.from, f.to]) assert.throws(() => new Store(join(stateDir(root), 'state.sqlite')), /maintenance/);
  } });
  assert.equal(checked, true);
  const store = new Store(join(stateDir(f.to), 'state.sqlite')); store.setMeta('new-input-after-relocation', true); store.close();
  await assert.rejects(relocateProject({ projectRoot: f.to, fromRoot: f.from, mode: 'rollback', apply: true }, f.deps), /changed after relocation/);
});


test('maintenance drains an existing writer before copying config as well as the database', async t => {
  const f = fixture(t), ready = join(f.directory, 'writer-ready');
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
    import { join } from 'node:path';
    const [state, ready] = process.argv.slice(1);
    const db = new DatabaseSync(join(state, 'state.sqlite'));
    db.exec('BEGIN IMMEDIATE');
    writeFileSync(ready, 'ready');
    const deadline = Date.now() + 3000;
    while (!existsSync(join(state, 'state.sqlite.maintenance-lock'))) {
      if (Date.now() > deadline) process.exit(2);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const path = join(state, 'config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
    config.workspace.mode = 'copy';
    writeFileSync(path + '.writer', JSON.stringify(config), { mode: 0o600 });
    renameSync(path + '.writer', path);
    db.prepare('INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)').run('config-writer-revision', '2');
    db.exec('COMMIT'); db.close();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateDir(f.from), ready], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  const deadline = Date.now() + 3000;
  while (!existsSync(ready)) { if (Date.now() > deadline) assert.fail('writer did not acquire the transaction'); await new Promise(resolve => setTimeout(resolve, 5)); }
  const result = await reinitializeProject({ projectRoot: f.from, apply: true }, f.deps);
  assert.equal(await exited, 0);
  assert.equal(JSON.parse(readFileSync(join(result.backup.directory, 'config.json'), 'utf8')).workspace.mode, 'copy');
  const backup = new DatabaseSync(result.backup.database, { readOnly: true });
  try { assert.equal(backup.prepare('SELECT data FROM kv WHERE key=?').get('config-writer-revision').data, '2'); } finally { backup.close(); }
  assert.equal(readProjectConfig(f.from).workspace.mode, 'copy');
});

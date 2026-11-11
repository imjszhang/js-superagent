import { existsSync, mkdirSync, chmodSync, lstatSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readProjectConfig, normalizeProjectConfig } from './config.mjs';
import { inspectProjectIdentity, ensureProjectIdentity, writeRelocatedProjectIdentity, coordinationError } from './project-identity.mjs';
import { createMachineCoordinator, currentProcessIdentity, inspectProcessOwner, sameBoot } from './machine-coordination.mjs';
import { inspectDatabase, databaseMaintenanceLockPath } from './database-maintenance.mjs';
import { Store } from './store.mjs';
import { projectStateDirectory, legacyStateDirectory, hasLegacyState } from './state-paths.mjs';

const activeLocks = new Set();
const fail = (code, message, details) => { throw coordinationError(code, message, details); };
const statePath = root => projectStateDirectory(root);
const dbPath = root => join(statePath(root), 'state.sqlite');
const journalPath = root => join(statePath(root), 'maintenance/project-operation.json');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const contained = (root, path) => { const value = relative(root, path); return value !== '..' && !value.startsWith('../') && !isAbsolute(value); };
function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) fail('PROJECT_MAINTENANCE_UNSAFE', 'Maintenance directories must be private real directories');
}
function json(path, limit = 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('PROJECT_MAINTENANCE_UNSAFE', 'Maintenance metadata must be a bounded regular file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function put(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
function journal(root) {
  const path = journalPath(root);
  if (!existsSync(path)) return null;
  const value = json(path);
  if (value.schemaVersion !== 1 || !/^[a-f\d-]{36}$/.test(value.id ?? '') || !['reinitialize', 'relocate'].includes(value.operation) || value.projectRoot !== root) fail('PROJECT_MAINTENANCE_JOURNAL', 'Unrecognized project maintenance journal');
  return value;
}
function checkpoint(root, entry, phase, dependencies) {
  entry.phase = phase; entry.updatedAt = new Date().toISOString(); delete entry.errorCode;
  put(journalPath(root), entry); dependencies.afterStep?.(phase, structuredClone(entry));
}
function acquireFileLock(root, operationId, dependencies) { return acquireDatabaseLock(dbPath(root), operationId, dependencies); }
function acquireDatabaseLock(database, operationId, dependencies) {
  const path = databaseMaintenanceLockPath(database), owner = typeof dependencies.processIdentity === 'function' ? dependencies.processIdentity() : dependencies.processIdentity ?? currentProcessIdentity(), token = randomUUID();
  if (existsSync(path)) {
    const previous = json(path);
    const sameProcess = previous.owner?.pid === owner.pid && previous.owner?.birth === owner.birth && sameBoot(previous.owner?.bootId, owner.bootId);
    if (previous.operationId !== operationId || activeLocks.has(previous.token) || !sameProcess && (dependencies.ownerState ?? inspectProcessOwner)(previous.owner) !== 'dead') fail('PROJECT_MAINTENANCE_BUSY', 'Another operation owns the project maintenance lock');
    unlinkSync(path);
  }
  writeFileSync(path, JSON.stringify({ token, operationId, owner }) + '\n', { mode: 0o600, flag: 'wx' }); activeLocks.add(token);
  return { path, token, release(remove) { activeLocks.delete(token); if (remove && existsSync(path) && json(path).token === token) unlinkSync(path); } };
}
function table(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function rows(db, prefix = '') { return table(db, 'kv') ? db.prepare('SELECT key,data FROM kv WHERE key LIKE ? ORDER BY key').all(`${prefix}%`).map(row => ({ key: row.key, value: JSON.parse(row.data) })) : []; }
function readDb(path, action) { if (!existsSync(path)) return action(null); const db = new DatabaseSync(path, { readOnly: true }); try { return action(db); } finally { db.close(); } }
function fingerprint(path) {
  if (!existsSync(path)) return null;
  return readDb(path, db => {
    const digest = createHash('sha256'); digest.update(String(db.prepare('PRAGMA user_version').get().user_version));
    for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      if (!/^[a-z_]+$/.test(row.name)) fail('PROJECT_MAINTENANCE_SCHEMA', 'Unsupported state table');
      digest.update(row.name); digest.update(row.sql); for (const value of db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()) digest.update(JSON.stringify(value));
    }
    return digest.digest('hex');
  });
}
function stoppedFacts(root) { return stoppedDatabaseFacts(dbPath(root)); }
function stoppedDatabaseFacts(database) {
  if (!existsSync(database)) return { owners: [], blockers: [] };
  const facts = inspectDatabase(database), blockers = facts.owners.filter(owner => owner.state !== 'dead').map(owner => ({ code: 'PROJECT_EXECUTION_ACTIVE', resource: owner.name }));
  if (facts.schemaVersion > 15) blockers.push({ code: 'PROJECT_MAINTENANCE_SCHEMA', resource: database });
  readDb(database, db => {
    for (const row of rows(db, 'managed-job:')) if (['pending', 'running'].includes(row.value.status)) blockers.push({ code: 'PROJECT_JOB_UNSETTLED', resource: row.key });
    if (table(db, 'receipts')) for (const row of db.prepare("SELECT id,data,status FROM receipts WHERE status<>'sent'").all()) {
      const receipt = JSON.parse(row.data); if (receipt.channel?.source === 'github') blockers.push({ code: 'PROJECT_DELIVERY_UNSETTLED', resource: row.id });
    }
  });
  return { ...facts, blockers };
}
function writeBarrier(root) { writeDatabaseBarrier(dbPath(root)); }
function writeDatabaseBarrier(database) {
  if (!existsSync(database)) return;
  const db = new DatabaseSync(database);
  try { db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; COMMIT;'); } finally { db.close(); }
}
function snapshot(root, directory) {
  // The file fence already exists. Drain pre-fence writers before copying even
  // config/identity files: a runtime.configure transaction may still rename them.
  writeBarrier(root);
  const facts = stoppedFacts(root);
  if (facts.blockers.length) fail('PROJECT_MAINTENANCE_BLOCKED', 'Resolve live execution and pending remote effects before maintenance', facts.blockers);
  privateDirectory(directory);
  const config = join(statePath(root), 'config.json');
  if (!existsSync(join(directory, 'config.json'))) { copyFileSync(config, join(directory, 'config.json')); }
  const identity = join(statePath(root), 'instance.json');
  if (existsSync(identity) && !existsSync(join(directory, 'instance.json'))) copyFileSync(identity, join(directory, 'instance.json'));
  const source = dbPath(root), target = join(directory, 'state.sqlite');
  if (existsSync(source) && !existsSync(target)) {
    const db = new DatabaseSync(source);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.prepare('VACUUM INTO ?').run(target); chmodSync(target, 0o600);
    } finally { db.close(); }
  }
  const result = { directory, configSha256: hash(join(directory, 'config.json')), ...(existsSync(target) ? { database: target, databaseSha256: hash(target) } : {}) };
  put(join(directory, 'backup.json'), result); return result;
}
function validateBackup(backup) {
  if (!backup || hash(join(backup.directory, 'config.json')) !== backup.configSha256 || backup.database && hash(backup.database) !== backup.databaseSha256) fail('PROJECT_MAINTENANCE_BACKUP', 'Maintenance backup changed or is unavailable');
}
function relocatePath(path, from, to) {
  if (typeof path !== 'string' || !isAbsolute(path)) return path;
  for (const [source, target] of [[statePath(from), statePath(to)], [from, to]]) if (contained(source, path)) return join(target, relative(source, path));
  return path;
}
function workspaceRecords(root) {
  const directory = join(statePath(root), 'workspaces/.records');
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) fail('PROJECT_MAINTENANCE_UNSAFE', 'Workspace records cannot be symlinked');
  return readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('.baseline.json')).map(name => ({ file: join(directory, name), value: json(join(directory, name)) }));
}
function relocatedWorkspace(workspace, from, root) {
  if (!workspace || workspace.projectRoot !== from && workspace.projectRoot !== root || !['copy', 'in-place', 'worktree'].includes(workspace.mode) || workspace.state !== 'ready') fail('PROJECT_WORKSPACE_INSPECTION', 'Unfinished or foreign workspace must be inspected before relocation');
  const next = { ...workspace, projectRoot: root };
  for (const key of ['path', 'manifestPath', 'gitDir', 'commonDir']) if (next[key]) next[key] = relocatePath(next[key], from, root);
  if (!contained(next.mode === 'in-place' ? root : statePath(root), next.path)) fail('PROJECT_WORKSPACE_INSPECTION', 'Workspace is outside the relocated project');
  if (workspace.mode === 'worktree') {
    try {
      const output = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', next.path, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n');
      const top = realpathSync(output[0]), gitDir = realpathSync(resolve(next.path, output[1])), commonDir = realpathSync(resolve(next.path, output[2]));
      const expected = realpathSync(resolve(root, execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()));
      if (top !== next.path || commonDir !== expected || !contained(commonDir, gitDir)) throw new Error('Worktree still points to the old checkout');
      next.gitDir = gitDir; next.commonDir = commonDir;
    } catch { fail('PROJECT_WORKTREE_REPAIR_REQUIRED', 'Repair and verify Git worktrees at the new location before applying relocation', { path: next.path }); }
  }
  return next;
}
function workspacePlan(root, from) {
  const blockers = [], updates = [];
  const activePaths = readDb(dbPath(root), db => {
    if (!db) return null;
    return new Set(rows(db, 'ticket:').filter(row => {
      const domain = row.value.domainId && table(db, 'domain_tickets') ? db.prepare('SELECT data FROM domain_tickets WHERE id=?').get(row.value.domainId) : null;
      return !domain || !JSON.parse(domain.data).ended;
    }).map(row => row.value.workspace?.path).filter(Boolean));
  });
  for (const row of workspaceRecords(root)) {
    if (activePaths && row.value.state === 'ready' && !activePaths.has(row.value.path)) continue; // Ended workspace paths remain historical facts.
    try { updates.push({ file: row.file, previous: row.value, next: relocatedWorkspace(row.value, from, root) }); }
    catch (error) { blockers.push({ code: error.code ?? 'PROJECT_WORKSPACE_INSPECTION', resource: row.file, ...(error.details ?? {}) }); }
  }
  return { blockers, updates };
}
function cleanIdentity(value) { const { initialized, matches, currentRoot, legacyState, conflict, ...identity } = value; return identity; }
function publicEntry(entry) { if (!entry) return null; const { originalConfig, ...value } = entry; return value; }
export function inspectProject(projectRoot, dependencies = {}) {
  const root = realpathSync(projectRoot), pending = journal(root);
  const config = existsSync(join(statePath(root), 'config.json')) ? readProjectConfig(root) : pending?.originalConfig;
  if (!config) fail('PROJECT_NOT_INITIALIZED', 'Project configuration is unavailable');
  const identity = inspectProjectIdentity(root, config.projectId);
  return { projectRoot: root, projectId: config.projectId, identity, database: existsSync(dbPath(root)) ? stoppedFacts(root) : null,
    maintenance: publicEntry(journal(root)), serviceInstalled: existsSync(join(statePath(root), 'service/manifest.json')),
    machine: createMachineCoordinator({}, dependencies).listProjects().filter(project => project.instanceId === identity.instanceId || project.projectRoot === root) };
}
async function service(root, dependencies) {
  if (dependencies.serviceManager) return dependencies.serviceManager(root, dependencies);
  const { createServiceManager } = await import('./service.mjs'); return createServiceManager({ projectRoot: root }, dependencies);
}
async function retireService(root, from, entry, dependencies) {
  const manifest = join(statePath(root), 'service/manifest.json');
  if (!existsSync(manifest)) return;
  entry.serviceManifest ??= json(manifest);
  if (entry.operation === 'reinitialize' && entry.identity?.projectRoot !== root) return; // A copied service still belongs to the original project.
  if (root === from) { const manager = await service(root, dependencies); manager.uninstall(); }
  else {
    const retire = dependencies.retireRelocatedService ?? (await import('./service.mjs')).retireRelocatedService;
    retire({ projectRoot: root, fromRoot: from }, dependencies);
  }
}
function freshConfig(config, root, originalRoot, projectId) {
  const next = { ...config, projectId }; delete next.github;
  if (next.execution?.executable && isAbsolute(next.execution.executable) && contained(originalRoot, next.execution.executable)) { next.execution = { ...next.execution }; delete next.execution.executable; }
  return normalizeProjectConfig(next);
}

/** Archive this local copy and start a new identity. Never release the source project's ownership. */
export async function reinitializeProject({ projectRoot, apply = false } = {}, dependencies = {}) {
  const root = realpathSync(projectRoot), saved = journal(root);
  const config = existsSync(join(statePath(root), 'config.json')) ? readProjectConfig(root) : saved?.originalConfig;
  if (!config) fail('PROJECT_NOT_INITIALIZED', 'Project configuration is unavailable');
  const facts = inspectProject(root, dependencies);
  const continuing = saved?.operation === 'reinitialize' && !['completed', 'rolled-back'].includes(saved.phase);
  const copy = facts.identity.initialized && facts.identity.projectRoot !== root;
  const blockers = copy ? [] : facts.database?.blockers ?? [];
  const plan = { operation: 'reinitialize', projectRoot: root, applied: false, phase: 'planned', identity: facts.identity, blockers,
    actions: ['Archive existing local state and service references', 'Create new project, instance and state identities', 'Keep non-secret execution/workspace configuration', 'Disable GitHub intake and leave background uninstalled'] };
  if (!apply) return plan;
  if (blockers.length && !continuing) fail('PROJECT_MAINTENANCE_BLOCKED', 'Resolve active work before reinitializing this project', blockers);
  privateDirectory(join(statePath(root), 'maintenance'));
  const entry = continuing ? saved : { schemaVersion: 1, id: randomUUID(), operation: 'reinitialize', projectRoot: root, phase: 'planned', identity: cleanIdentity(facts.identity), originalConfig: config, newProjectId: randomUUID(), createdAt: new Date().toISOString() };
  put(journalPath(root), entry);
  const lock = acquireFileLock(root, entry.id, dependencies); let coordinator, lease, complete = false, mutated = false;
  try {
    if (!copy && ['planned', 'backed-up'].includes(entry.phase)) { coordinator = createMachineCoordinator({ projectRoot: root, projectId: entry.originalConfig.projectId }, dependencies); coordinator.register({ adoptLegacy: true }); lease = coordinator.acquireMaintenance(); }
    if (entry.phase === 'planned') {
      entry.backup = snapshot(root, join(statePath(root), 'maintenance', entry.id)); entry.originalConfig = readProjectConfig(root); mutated = true;
      checkpoint(root, entry, 'backed-up', dependencies);
    }
    validateBackup(entry.backup);
    if (entry.phase === 'backed-up') {
      await retireService(root, root, entry, { ...dependencies, ...(lease ? { maintenanceToken: lease.token } : {}) });
      if (coordinator && lease) { coordinator.unregister({ maintenanceLease: lease, assertSafe: () => stoppedFacts(root).blockers.length === 0 }); lease = null; }
      checkpoint(root, entry, 'service-retired', dependencies);
    }
    if (entry.phase === 'service-retired') {
      const archive = join(entry.backup.directory, 'archive'); privateDirectory(archive);
      for (const name of readdirSync(statePath(root))) {
        if (name === 'maintenance' || name.endsWith('.maintenance-lock')) continue;
        const source = join(statePath(root), name), target = join(archive, name);
        if (existsSync(target)) fail('PROJECT_MAINTENANCE_CONFLICT', 'Both active and archived state exist; inspect before resuming');
        renameSync(source, target);
      }
      entry.archive = archive; checkpoint(root, entry, 'archived', dependencies);
    }
    if (entry.phase === 'archived') {
      const next = freshConfig(entry.originalConfig, root, entry.identity.projectRoot ?? root, entry.newProjectId);
      put(join(statePath(root), 'config.json'), next);
      const identity = ensureProjectIdentity(root, next.projectId);
      const temporary = join(entry.backup.directory, 'new-state.sqlite');
      if (!existsSync(dbPath(root))) {
        const store = new Store(temporary);
        try { store.setMeta('instance:identity', { instanceId: identity.instanceId, stateId: identity.stateId }); store.setMeta('runtime:minimum-version', '0.15.0-alpha.0'); store.db.exec('PRAGMA user_version=15'); } finally { store.close(); }
        renameSync(temporary, dbPath(root));
      }
      createMachineCoordinator({ projectRoot: root, projectId: next.projectId }, dependencies).register();
      entry.newIdentity = identity; checkpoint(root, entry, 'completed', dependencies);
    }
    complete = true; return { ...plan, applied: true, phase: entry.phase, identity: entry.newIdentity, backup: entry.backup, archive: entry.archive, service: { installed: false, running: false } };
  } catch (error) { entry.errorCode = error.code ?? 'PROJECT_MAINTENANCE_INTERRUPTED'; put(journalPath(root), entry); throw error; }
  finally { if (lease) coordinator.releaseLease(lease); lock.release(complete || !mutated && entry.phase === 'planned'); }
}

function rewriteState(root, from, entry, workspaceUpdates) {
  for (const update of workspaceUpdates) {
    const backup = join(entry.backup.directory, `workspace-${createHash('sha256').update(update.file).digest('hex')}.json`);
    if (!existsSync(backup)) put(backup, update.previous);
    entry.workspaceBackups ??= []; if (!entry.workspaceBackups.some(item => item.path === update.file)) entry.workspaceBackups.push({ path: update.file, backup });
    put(journalPath(root), entry);
    put(update.file, update.next);
    const ownerPath = join(update.next.path, '.js-superagent/workspace-owner.json');
    if (existsSync(ownerPath)) {
      const owner = json(ownerPath);
      if (owner.provisionId !== update.next.provisionId || owner.ticketId !== update.next.ticketId || ![from, root].includes(owner.projectRoot)) fail('PROJECT_WORKSPACE_INSPECTION', 'Workspace owner changed during relocation');
      const ownerBackup = `${backup}.owner`; if (!existsSync(ownerBackup)) put(ownerBackup, owner);
      if (!entry.workspaceBackups.some(item => item.path === ownerPath)) entry.workspaceBackups.push({ path: ownerPath, backup: ownerBackup });
      put(journalPath(root), entry);
      put(ownerPath, { ...owner, projectRoot: root });
    }
  }
  const config = { ...entry.originalConfig };
  if (config.execution?.executable) config.execution = { ...config.execution, executable: relocatePath(config.execution.executable, from, root) };
  if (config.github) {
    config.github = { ...config.github };
    if (config.github.executable) config.github.executable = relocatePath(config.github.executable, from, root);
    if (config.github.app?.privateKeyPath) config.github.app = { ...config.github.app, privateKeyPath: relocatePath(config.github.app.privateKeyPath, from, root) };
    if (config.github.webhook?.secretPath) config.github.webhook = { ...config.github.webhook, secretPath: relocatePath(config.github.webhook.secretPath, from, root) };
  }
  put(join(statePath(root), 'config.json'), normalizeProjectConfig(config));
  if (!existsSync(dbPath(root))) return [];
  const db = new DatabaseSync(dbPath(root)), inspections = [];
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const save = db.prepare('INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)'), sessions = [];
    for (const row of rows(db)) {
      if (row.key.startsWith('coordinator:session:')) { sessions.push(row); db.prepare('DELETE FROM kv WHERE key=?').run(row.key); }
      if (!row.key.startsWith('ticket:') || !row.value.domainId) continue;
      const domainRow = table(db, 'domain_tickets') ? db.prepare('SELECT data FROM domain_tickets WHERE id=?').get(row.value.domainId) : null;
      const ended = domainRow && JSON.parse(domainRow.data).ended;
      if (ended) continue;
      const meta = row.value;
      if (meta.workspace) meta.workspace = relocatedWorkspace(meta.workspace, from, root);
      if (meta.driverSession) { meta.relocationInspection = { id: entry.id, fromRoot: from, toRoot: root, reason: 'native-session-cwd-changed' }; inspections.push(meta.id); }
      save.run(row.key, JSON.stringify(meta));
    }
    const archiveKey = `project:relocation:${entry.id}:coordinator-sessions`;
    if (!db.prepare('SELECT 1 FROM kv WHERE key=?').get(archiveKey)) save.run(archiveKey, JSON.stringify(sessions));
    save.run('project:relocation', JSON.stringify({ id: entry.id, fromRoot: from, toRoot: root, requiresInspection: inspections.length > 0, tickets: inspections, at: new Date().toISOString() }));
    save.run('runtime:pause', JSON.stringify({ paused: true, reason: 'project-relocated-inspect-before-resuming', at: new Date().toISOString() }));
    // Relocation changes identity/path facts, never downgrades the source schema
    // or its minimum writer version. Material grants remain bound to the old root.
    db.exec('COMMIT');
    return inspections;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
}
async function installRelocatedService(root, from, entry, dependencies) {
  if (!entry.serviceManifest) return { installed: false, running: false };
  const oldDirectory = join(statePath(root), 'service'), archive = join(entry.backup.directory, 'service');
  if (existsSync(oldDirectory) && !existsSync(archive)) renameSync(oldDirectory, archive);
  const manifest = entry.serviceManifest, options = { projectRoot: root, mode: manifest.mode, nodeExecutable: manifest.nodeExecutable, cliPath: relocatePath(manifest.cliPath, from, root), homeDirectory: manifest.homeDirectory, logMaxBytes: manifest.logMaxBytes,
    ...(manifest.environmentFile ? { environmentFile: relocatePath(manifest.environmentFile, from, root) } : {}) };
  if (options.environmentFile && contained(oldDirectory, options.environmentFile)) options.environmentFile = join(archive, relative(oldDirectory, options.environmentFile));
  const manager = dependencies.installService ? await dependencies.installService(options, dependencies) : (await import('./service.mjs')).createServiceManager(options, dependencies).install();
  return manager;
}

async function restoreSourceService(entry, dependencies) {
  if (!entry.serviceManifest) return { installed: false, running: false };
  const root = entry.fromRoot, original = entry.serviceManifest, directory = join(statePath(root), 'service');
  const archive = join(statePath(root), 'maintenance', `rollback-${entry.id}`, 'service');
  if (existsSync(join(directory, 'manifest.json')) && !existsSync(archive)) {
    if (JSON.stringify(json(join(directory, 'manifest.json'))) !== JSON.stringify(original) || existsSync(original.plistPath)) fail('PROJECT_SERVICE_RECONCILE_REQUIRED', 'Original service metadata or plist changed after retirement');
    privateDirectory(dirname(archive)); renameSync(directory, archive);
  }
  const options = { projectRoot: root, mode: original.mode, nodeExecutable: original.nodeExecutable, cliPath: original.cliPath, homeDirectory: original.homeDirectory, logMaxBytes: original.logMaxBytes,
    ...(original.environmentFile ? { environmentFile: contained(directory, original.environmentFile) ? join(archive, relative(directory, original.environmentFile)) : original.environmentFile } : {}) };
  return dependencies.installService ? dependencies.installService(options, dependencies) : (await import('./service.mjs')).createServiceManager(options, dependencies).install();
}

// State lives under a per-user key derived from the project path, so a moved checkout leaves it under the old key.
function pendingStateMove(root, from) {
  const source = statePath(from), target = statePath(root);
  if (existsSync(join(target, 'config.json')) || !existsSync(join(source, 'config.json'))) return null;
  const identity = existsSync(join(source, 'instance.json')) ? json(join(source, 'instance.json'), 16384) : null;
  if (identity?.projectRoot !== from) fail('PROJECT_IDENTITY_CONFLICT', 'State under the original path belongs to another project root', { originalRoot: identity?.projectRoot ?? null });
  const blockers = [...stoppedFacts(from).blockers];
  if (existsSync(target) && readdirSync(target).length) blockers.push({ code: 'PROJECT_STATE_CONFLICT', resource: target });
  return { source, target, blockers };
}

/** Adopt a directory the operator has already copied/moved; Git worktree repair stays explicit. */
export async function relocateProject({ projectRoot, fromRoot, apply = false, mode = 'resume' } = {}, dependencies = {}) {
  if (!['resume', 'rollback'].includes(mode) || typeof fromRoot !== 'string' || !isAbsolute(fromRoot)) throw new Error('Relocation requires an absolute original root and resume/rollback mode');
  const root = realpathSync(projectRoot), from = existsSync(fromRoot) ? realpathSync(fromRoot) : resolve(fromRoot);
  if (root === from || contained(root, from) || contained(from, root)) fail('PROJECT_RELOCATION_SCOPE', 'Relocation requires separate non-nested project roots');
  const move = pendingStateMove(root, from);
  if (move) {
    if (mode === 'rollback') move.blockers.push({ code: 'PROJECT_ROLLBACK_ORIGIN_REQUIRED', resource: from });
    const actions = [`Move local state from ${move.source} to ${move.target}`, 'Repair any reported Git worktrees, then run relocate --apply again to rewrite paths'];
    if (!apply) return { operation: 'relocate', projectRoot: root, fromRoot: from, applied: false, phase: 'planned', blockers: move.blockers, actions, stateMove: { from: move.source, to: move.target } };
    if (move.blockers.length) fail('PROJECT_MAINTENANCE_BLOCKED', 'Resolve relocation blockers before applying', move.blockers);
    writeBarrier(from);
    mkdirSync(dirname(move.target), { recursive: true, mode: 0o700 });
    if (existsSync(move.target)) rmdirSync(move.target);
    renameSync(move.source, move.target);
  }
  const config = readProjectConfig(root), facts = inspectProject(root, dependencies), saved = journal(root);
  if (saved?.operation === 'relocate' && saved.fromRoot === from && saved.phase === 'completed' && mode === 'resume' && facts.identity.matches) return { operation: 'relocate', projectRoot: root, fromRoot: from, applied: apply, phase: 'completed', identity: facts.identity, blockers: [], actions: [], backup: saved.backup, requiresInspection: saved.requiresInspection ?? [], service: saved.service };
  if (saved?.phase === 'rolling-back' && mode !== 'rollback') fail('PROJECT_ROLLBACK_PENDING', 'Continue the interrupted rollback with mode rollback');
  const continuing = saved?.operation === 'relocate' && saved.fromRoot === from && (mode === 'rollback' || !['completed', 'rolled-back'].includes(saved.phase));
  const identity = continuing ? saved.identity : cleanIdentity(facts.identity);
  const blockers = [...(facts.database?.blockers ?? [])];
  if (!facts.identity.initialized || ![from, ...(continuing ? [root] : [])].includes(facts.identity.projectRoot)) blockers.push({ code: 'PROJECT_RELOCATION_IDENTITY', resource: 'instance.json' });
  const workspaces = workspacePlan(root, from); blockers.push(...workspaces.blockers);
  if (existsSync(join(statePath(from), 'config.json')) && (!continuing || saved.phase === 'planned')) {
    const original = inspectProjectIdentity(from, config.projectId);
    if (!original.initialized || original.instanceId !== identity.instanceId || original.stateId !== identity.stateId || fingerprint(dbPath(from)) !== fingerprint(dbPath(root))) blockers.push({ code: 'PROJECT_RELOCATION_DIVERGED', resource: from });
  }
  if (mode === 'rollback' && (!continuing || !existsSync(join(statePath(from), 'config.json')))) blockers.push({ code: 'PROJECT_ROLLBACK_ORIGIN_REQUIRED', resource: from });
  const plan = { operation: 'relocate', projectRoot: root, fromRoot: from, applied: false, phase: saved?.phase ?? 'planned', identity, blockers,
    actions: ['Fence both locations and verify execution is stopped', 'Back up state before changing known host paths', 'Preserve ticket history and repository ownership', 'Require native-session replacement when cwd changes', 'Reinstall background disabled and keep processing paused'] };
  if (!apply) return plan;
  if (blockers.length) fail('PROJECT_MAINTENANCE_BLOCKED', 'Resolve relocation blockers before applying', blockers);
  privateDirectory(join(statePath(root), 'maintenance'));
  const entry = continuing ? saved : { schemaVersion: 1, id: randomUUID(), operation: 'relocate', projectRoot: root, fromRoot: from, identity, originalConfig: config, phase: 'planned', createdAt: new Date().toISOString() };
  put(journalPath(root), entry);
  const locks = [acquireFileLock(root, entry.id, dependencies)]; let coordinator, lease, complete = false, mutated = entry.phase !== 'planned';
  try {
    if (existsSync(statePath(from))) locks.push(acquireFileLock(from, entry.id, dependencies));
    coordinator = createMachineCoordinator({ projectRoot: root, projectId: identity.projectId }, dependencies);
    if (facts.identity.projectRoot === root) { coordinator.register(); lease = coordinator.acquireMaintenance({ roots: [from] }); }
    else lease = coordinator.acquireRelocation({ fromRoot: from, recoveryId: entry.id });
    writeBarrier(root); if (existsSync(statePath(from))) writeBarrier(from);
    if (entry.phase === 'planned' && existsSync(dbPath(from)) && fingerprint(dbPath(from)) !== fingerprint(dbPath(root))) fail('PROJECT_RELOCATION_DIVERGED', 'The original changed before the maintenance fence; refresh the copy before relocating');
    const serviceDependencies = { ...dependencies, maintenanceToken: lease.token };
    if (mode === 'rollback') {
      validateBackup(entry.backup);
      if (entry.phase === 'completed' && fingerprint(dbPath(root)) !== entry.completedFingerprint) fail('PROJECT_ROLLBACK_CHANGED', 'Project state changed after relocation; reconcile it before rollback');
      checkpoint(root, entry, 'rolling-back', dependencies);
      if (existsSync(join(statePath(root), 'service/manifest.json')) && facts.identity.projectRoot === root) (await service(root, serviceDependencies)).uninstall();
      if (entry.backup.database) { for (const suffix of ['-wal', '-shm']) if (existsSync(`${dbPath(root)}${suffix}`)) unlinkSync(`${dbPath(root)}${suffix}`); copyFileSync(entry.backup.database, dbPath(root)); }
      copyFileSync(join(entry.backup.directory, 'config.json'), join(statePath(root), 'config.json'));
      for (const item of entry.workspaceBackups ?? []) copyFileSync(item.backup, item.path);
      coordinator.relocate({ toRoot: from, maintenanceLease: lease });
      put(join(statePath(root), 'instance.json'), entry.identity);
      entry.service = await restoreSourceService(entry, serviceDependencies);
      checkpoint(root, entry, 'rolled-back', dependencies); complete = true;
      return { ...plan, applied: true, phase: entry.phase, service: entry.service, backup: entry.backup };
    }
    if (entry.phase === 'planned') { entry.backup = snapshot(root, join(statePath(root), 'maintenance', entry.id)); entry.originalConfig = readProjectConfig(root); mutated = true; checkpoint(root, entry, 'backed-up', dependencies); }
    validateBackup(entry.backup);
    if (entry.phase === 'backed-up') { await retireService(root, from, entry, serviceDependencies); checkpoint(root, entry, 'service-retired', dependencies); }
    if (entry.phase === 'service-retired') {
      // Persist file-backup references before the next potentially interrupted mutation.
      entry.requiresInspection = rewriteState(root, from, entry, workspaces.updates); checkpoint(root, entry, 'rewritten', dependencies);
    }
    if (entry.phase === 'rewritten') { coordinator.relocate({ toRoot: root, maintenanceLease: lease }); writeRelocatedProjectIdentity(root, entry.identity, { fromRoot: from }); checkpoint(root, entry, 'relocated', dependencies); }
    if (entry.phase === 'relocated') {
      entry.service = await installRelocatedService(root, from, entry, serviceDependencies);
      entry.completedFingerprint = fingerprint(dbPath(root)); checkpoint(root, entry, 'completed', dependencies);
    }
    complete = true; return { ...plan, applied: true, phase: entry.phase, identity: inspectProjectIdentity(root, config.projectId), requiresInspection: entry.requiresInspection ?? [], backup: entry.backup, service: entry.service };
  } catch (error) { entry.errorCode = error.code ?? 'PROJECT_MAINTENANCE_INTERRUPTED'; put(journalPath(root), entry); throw error; }
  finally { try { if (lease) coordinator.releaseLease(lease); } finally { for (const lock of locks) lock.release(complete || !mutated); } }
}

const MIGRATION_JOURNAL = 'maintenance/state-migration.json';
function rewritePrefixes(value, pairs) {
  if (typeof value === 'string') { for (const [from, to] of pairs) if (value === from || value.startsWith(`${from}/`)) return to + value.slice(from.length); return value; }
  if (Array.isArray(value)) return value.map(item => rewritePrefixes(item, pairs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePrefixes(item, pairs)]));
  return value;
}
function rewriteJsonFile(file, pairs) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return false;
  const text = readFileSync(file, 'utf8');
  if (!pairs.some(([from]) => text.includes(from))) return false;
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  const next = rewritePrefixes(value, pairs);
  if (JSON.stringify(next) === JSON.stringify(value)) return false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: stat.mode & 0o777 });
  renameSync(temporary, file);
  return true;
}
function migrationPlan(root) {
  const legacy = legacyStateDirectory(root), target = statePath(root), blockers = [], worktrees = [];
  if (existsSync(target) && readdirSync(target).length) blockers.push({ code: 'PROJECT_STATE_CONFLICT', resource: target });
  blockers.push(...stoppedDatabaseFacts(join(legacy, 'state.sqlite')).blockers);
  if (existsSync(join(legacy, 'service/manifest.json'))) blockers.push({ code: 'PROJECT_SERVICE_INSTALLED', resource: join(legacy, 'service/manifest.json') });
  const operation = join(legacy, 'maintenance/project-operation.json');
  if (existsSync(operation) && !['completed', 'rolled-back'].includes(json(operation).phase)) blockers.push({ code: 'PROJECT_MAINTENANCE_PENDING', resource: operation });
  const records = join(legacy, 'workspaces/.records');
  if (existsSync(records)) for (const name of readdirSync(records).filter(item => item.endsWith('.json') && !item.endsWith('.baseline.json'))) {
    const value = json(join(records, name));
    if (value.state !== 'ready') blockers.push({ code: 'PROJECT_WORKSPACE_INSPECTION', resource: join(records, name) });
    if (value.mode === 'worktree') worktrees.push(value.path);
  }
  let ancestor = target; while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  // Worktrees and SQLite files must move atomically; a cross-device copy is not attempted.
  if (statSync(legacy).dev !== statSync(ancestor).dev) blockers.push({ code: 'PROJECT_STATE_CROSS_DEVICE', resource: target });
  return { legacy, target, blockers, worktrees };
}
function repairMovedWorktrees(root) {
  const paths = workspaceRecords(root).filter(row => row.value.mode === 'worktree' && existsSync(row.value.path)).map(row => row.value.path);
  if (!paths.length) return [];
  const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { git(root, ['worktree', 'repair', ...paths]); }
  catch { fail('PROJECT_WORKTREE_REPAIR_REQUIRED', 'Git could not repair the moved worktrees; repair them, then run migrate-state --apply again', { paths }); }
  for (const path of paths) {
    let top;
    try { top = realpathSync(git(path, ['rev-parse', '--show-toplevel'])); } catch { top = null; }
    if (top !== path) fail('PROJECT_WORKTREE_REPAIR_REQUIRED', 'A moved worktree still points elsewhere; repair it, then run migrate-state --apply again', { path });
  }
  return paths;
}
function rewriteDatabasePaths(database, entry) {
  if (!existsSync(database)) return { rows: 0, tickets: [] };
  const db = new DatabaseSync(database), pairs = entry.pairs.map(([from, to]) => [JSON.stringify(`${from}/`).slice(1, -1), JSON.stringify(`${to}/`).slice(1, -1)]);
  let changed = 0; const tickets = [];
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (!/^[a-z_]+$/.test(name)) fail('PROJECT_MAINTENANCE_SCHEMA', 'Unsupported state table');
      for (const { name: column } of db.prepare(`PRAGMA table_info(${name})`).all()) {
        if (!/^[a-z_]+$/i.test(column)) continue;
        for (const [from, to] of pairs) changed += Number(db.prepare(`UPDATE ${name} SET ${column}=replace(${column},?,?) WHERE typeof(${column})='text' AND instr(${column},?)>0`).run(from, to, from).changes);
      }
    }
    const save = db.prepare('INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)');
    for (const row of rows(db, 'ticket:')) {
      const meta = row.value, path = meta.workspace?.path;
      // Native sessions remember their cwd; an isolated workspace moved with the state, an in-place one did not.
      if (!meta.driverSession || meta.workspace?.mode === 'in-place' || typeof path !== 'string' || !contained(entry.to, path)) continue;
      const domain = meta.domainId && table(db, 'domain_tickets') ? db.prepare('SELECT data FROM domain_tickets WHERE id=?').get(meta.domainId) : null;
      if (domain && JSON.parse(domain.data).ended) continue;
      meta.relocationInspection = { id: entry.id, fromRoot: entry.from, toRoot: entry.to, reason: 'native-session-cwd-changed' };
      save.run(row.key, JSON.stringify(meta)); tickets.push(meta.id);
    }
    if (tickets.length) {
      save.run('project:relocation', JSON.stringify({ id: entry.id, fromRoot: entry.from, toRoot: entry.to, requiresInspection: true, tickets, at: new Date().toISOString() }));
      save.run('runtime:pause', JSON.stringify({ paused: true, reason: 'project-relocated-inspect-before-resuming', at: new Date().toISOString() }));
    }
    db.exec('COMMIT');
    return { rows: changed, tickets };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
}

/** Move state from <project>/.js-superagent to the per-user state directory. The project must be stopped. */
export function migrateProjectState({ projectRoot, apply = false } = {}) {
  const root = realpathSync(projectRoot), target = statePath(root), journalFile = join(target, MIGRATION_JOURNAL);
  let entry = existsSync(journalFile) ? json(journalFile) : null;
  if (entry?.phase === 'completed') entry = null;
  if (!entry && !hasLegacyState(root)) fail('PROJECT_STATE_NOT_LEGACY', `Project state is not inside the project directory; it is kept in ${target}`);
  if (!entry) {
    const plan = migrationPlan(root);
    const result = { operation: 'migrate-state', projectRoot: root, from: plan.legacy, to: plan.target, applied: false, phase: 'planned', blockers: plan.blockers, worktrees: plan.worktrees,
      actions: ['Verify the project is stopped and its background service is uninstalled', `Move ${plan.legacy} to ${plan.target}`, 'Repair moved Git worktrees and rewrite saved state paths', 'Require native-session replacement for unfinished tickets whose isolated workspace moved'] };
    if (!apply) return result;
    if (plan.blockers.length) fail('PROJECT_MAINTENANCE_BLOCKED', 'Resolve migration blockers before applying', plan.blockers);
    writeDatabaseBarrier(join(plan.legacy, 'state.sqlite'));
    const identityFile = join(plan.legacy, 'instance.json'), identity = existsSync(identityFile) ? json(identityFile, 16384) : null;
    const pairs = [[plan.legacy, target]];
    if (typeof identity?.projectRoot === 'string' && identity.projectRoot !== root) pairs.push([join(identity.projectRoot, '.js-superagent'), target]);
    entry = { schemaVersion: 1, id: randomUUID(), operation: 'migrate-state', projectRoot: root, from: plan.legacy, to: target, pairs, phase: 'planned', createdAt: new Date().toISOString() };
    privateDirectory(join(plan.legacy, 'maintenance')); put(join(plan.legacy, MIGRATION_JOURNAL), entry);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) rmdirSync(target);
    renameSync(plan.legacy, target);
    entry.phase = 'moved'; put(journalFile, entry);
  }
  const records = join(target, 'workspaces/.records');
  const files = [...readdirSync(target).filter(name => name.endsWith('.json')).map(name => join(target, name)),
    ...(existsSync(records) ? readdirSync(records).filter(name => name.endsWith('.json')).map(name => join(records, name)) : [])];
  const rewrittenFiles = files.filter(file => rewriteJsonFile(file, entry.pairs)).length;
  const repairedWorktrees = repairMovedWorktrees(root);
  const database = rewriteDatabasePaths(dbPath(root), entry);
  entry.phase = 'completed'; entry.completedAt = new Date().toISOString(); entry.requiresInspection = database.tickets; put(journalFile, entry);
  return { operation: 'migrate-state', projectRoot: root, from: entry.from, to: target, applied: true, phase: 'completed', blockers: [],
    rewrittenFiles, rewrittenRows: database.rows, repairedWorktrees, requiresInspection: database.tickets };
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, lstatSync, chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve, sep, dirname, basename, isAbsolute } from 'node:path';
import { ensureProjectIdentity, assertProjectIdentity, inspectProjectIdentity, bindProjectMachineIdentity, coordinationError } from './project-identity.mjs';
import { projectStateDirectory } from './state-paths.mjs';

const PROTOCOL = 1;
const fail = (code, message, details) => { throw coordinationError(code, message, details); };
const json = value => JSON.stringify(value);
const parse = value => value ? JSON.parse(value) : null;
const positive = value => Number.isSafeInteger(value) && value > 0;
const containsRoot = (parent, child) => parent === child || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
const rootsOverlap = (left, right) => containsRoot(left, right) || containsRoot(right, left);
function canonicalMaintenanceRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Maintenance roots must be absolute local paths');
  let ancestor = resolve(value); const missing = [];
  while (!existsSync(ancestor)) { missing.unshift(basename(ancestor)); const parent = dirname(ancestor); if (parent === ancestor) throw new Error('Cannot resolve maintenance root'); ancestor = parent; }
  return join(realpathSync(ancestor), ...missing);
}
export const defaultMachineDirectory = () => process.env.JS_SUPERAGENT_MACHINE_DIRECTORY || (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/js-superagent') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'js-superagent'));

let cachedBirth, cachedBoot;
function birth(pid) {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 }).trim();
    if (!value || value.startsWith('Z')) return null;
    return value.split(/\s+/).slice(1).join(' ');
  } catch (error) { if (error.status === 1) return null; return undefined; }
}
function boot() {
  if (cachedBoot) return cachedBoot;
  try {
    cachedBoot = process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      : execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 }).trim();
  } catch { cachedBoot = null; }
  return cachedBoot;
}
const DARWIN_BOOT = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*\d+\s*\}/;
// macOS shifts kern.boottime when the wall clock is corrected (observed: a 0.1 s usec change on
// one running boot), so an exact string comparison declares live owners dead. The owner's exact
// process start time is still required, which distinguishes processes across real reboots.
const BOOT_DRIFT_SECONDS = 60;
export function sameBoot(recorded, current) {
  if (typeof recorded !== 'string' || typeof current !== 'string' || !recorded || !current) return false;
  if (recorded === current) return true;
  const a = DARWIN_BOOT.exec(recorded), b = DARWIN_BOOT.exec(current);
  return !!a && !!b && Math.abs(Number(a[1]) - Number(b[1])) <= BOOT_DRIFT_SECONDS;
}
export function currentProcessIdentity() {
  cachedBirth ??= birth(process.pid);
  const bootId = boot();
  if (!cachedBirth || !bootId) fail('PROCESS_IDENTITY_UNKNOWN', 'Cannot verify this process start identity');
  return { host: hostname(), pid: process.pid, birth: cachedBirth, bootId };
}
export function captureProcessIdentity(pid) {
  if (!positive(pid)) throw new Error('Expected a process ID');
  const started = birth(pid), bootId = boot();
  if (started === null) return null;
  if (started === undefined || !bootId) return undefined;
  return { host: hostname(), pid, birth: started, bootId };
}
export function inspectProcessOwner(owner) {
  if (!owner || typeof owner.host !== 'string' || !positive(owner.pid)) return 'unknown';
  // Without a configured HostName, macOS reports a network-derived hostname that changes with the
  // network (a service recorded as "Mac" was later seen as "<name>.local"). A record from another
  // host name is accepted only when it carries this machine's current boot identity.
  const local = owner.host === hostname();
  if (!local && (typeof owner.bootId !== 'string' || !sameBoot(owner.bootId, boot()))) return 'unknown';
  const actual = birth(owner.pid);
  if (actual === null) return 'dead';
  if (typeof owner.birth !== 'string' || typeof owner.bootId !== 'string') return 'unknown';
  const bootId = boot();
  if (!bootId) return 'unknown';
  if (!sameBoot(owner.bootId, bootId)) return 'dead';
  return actual === undefined ? 'unknown' : actual !== owner.birth ? 'dead' : 'alive';
}
function repositoryName(repository) {
  if (typeof repository !== 'string' || !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repository) || ['.', '..'].includes(repository.split('/')[1])) throw new Error('Expected owner/repository');
  return repository.toLowerCase();
}
function checkedHost(host = 'github.com') { if (host !== 'github.com') throw new Error('Unsupported GitHub host'); return host; }
function portAddress(host) {
  if (typeof host !== 'string' || !host || /[\0\r\n]/.test(host)) throw new Error('Invalid listen host');
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}
const ipv4 = host => /^\d+\.\d+\.\d+\.\d+$/.test(host);
export function listenAddressesOverlap(left, right) {
  left = portAddress(left); right = portAddress(right);
  if (left === right || left === '::' || right === '::') return true;
  if (left === '0.0.0.0' && (ipv4(right) || right === 'localhost') || right === '0.0.0.0' && (ipv4(left) || left === 'localhost')) return true;
  const loopback = new Set(['localhost', '127.0.0.1', '::1']);
  if (loopback.has(left) && loopback.has(right)) return true;
  // A DNS name can resolve to either address family; reserve conservatively.
  return !ipv4(left) && !left.includes(':') || !ipv4(right) && !right.includes(':');
}

/** Per-user metadata only. Construction/inspection never initializes disk state. */
export function createMachineCoordinator(options = {}, dependencies = {}) {
  const projectRoot = options.projectRoot ? realpathSync(options.projectRoot) : null, projectId = options.projectId;
  const directory = resolve(dependencies.directory ?? defaultMachineDirectory()), path = join(directory, 'coordination.sqlite'), registryPath = join(directory, 'registry.json');
  const now = dependencies.now ?? Date.now, ownerState = dependencies.ownerState ?? inspectProcessOwner;
  const processIdentity = () => typeof dependencies.processIdentity === 'function' ? dependencies.processIdentity() : dependencies.processIdentity ?? currentProcessIdentity();
  const ownerToken = randomUUID(); let identity, maintenanceContext;
  function safeFile(file, directoryOnly = false) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (directoryOnly ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || typeof process.getuid === 'function' && stat.uid !== process.getuid() || stat.mode & 0o077) fail('MACHINE_STORAGE_UNSAFE', 'Machine coordination storage must be private and owned by the current user');
  }
  function database(write, action) {
    if (!existsSync(path) && !existsSync(registryPath) && !write) return action(null);
    if (write && !existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    safeFile(directory, true);
    let createdRegistry = false;
    if (!existsSync(registryPath)) {
      if (existsSync(path) || !write) fail('MACHINE_REGISTRY_CHANGED', 'Machine registry identity file is missing; inspect stopped owners before repair');
      try { writeFileSync(registryPath, json({ schemaVersion: 1, id: randomUUID(), createdAt: Date.now(), phase: 'initializing', creator: { ...processIdentity(), token: ownerToken } }), { flag: 'wx', mode: 0o600 }); createdRegistry = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    safeFile(registryPath);
    if (lstatSync(registryPath).size > 4096) fail('MACHINE_REGISTRY_CHANGED', 'Machine registry identity is invalid');
    let registry;
    try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); } catch { fail('MACHINE_REGISTRY_CHANGED', 'Machine registry identity is invalid'); }
    if (registry.schemaVersion !== 1 || typeof registry.id !== 'string' || !registry.id || !Number.isSafeInteger(registry.createdAt) || !['initializing', 'ready'].includes(registry.phase)) fail('MACHINE_REGISTRY_CHANGED', 'Machine registry identity is invalid');
    // Only the call that exclusively created the sentinel may create a database.
    // Interrupted initialization requires inspection; elapsed time grants no rights.
    if (!createdRegistry && registry.phase === 'initializing') fail('MACHINE_REGISTRY_INITIALIZING', 'Machine registry initialization is unfinished; retry after its creator finishes or inspect the stopped creator');
    if (!createdRegistry && !existsSync(path)) fail('MACHINE_REGISTRY_MISSING', 'Machine coordination database is missing; the existing identity forbids silent recreation');
    if (existsSync(path)) safeFile(path);
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: !write });
      if (write) chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout=5000');
      let version = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (version !== PROTOCOL && !(write && createdRegistry && version === 0)) fail('MACHINE_PROTOCOL_UNSUPPORTED', 'Unsupported machine coordination protocol; do not delete the registry to bypass it', { version });
      if (write) {
        db.exec('BEGIN IMMEDIATE');
        version = Number(db.prepare('PRAGMA user_version').get().user_version);
        if (version !== PROTOCOL && !(createdRegistry && version === 0)) fail('MACHINE_PROTOCOL_UNSUPPORTED', 'Unsupported machine coordination protocol', { version });
        if (version === 0) {
          if (db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count) fail('MACHINE_PROTOCOL_UNSUPPORTED', 'Unrecognized coordination database');
          db.exec(`CREATE TABLE projects(instance_id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE,root TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,registered_at INTEGER NOT NULL);
            CREATE TABLE leases(instance_id TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,epoch INTEGER NOT NULL,owner TEXT NOT NULL,guardians TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(instance_id,kind));
            CREATE TABLE epochs(resource TEXT PRIMARY KEY,value INTEGER NOT NULL);
            CREATE TABLE repositories(host TEXT NOT NULL,name TEXT NOT NULL,repository_id TEXT,instance_id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(host,name));
            CREATE INDEX repositories_ids ON repositories(host,repository_id) WHERE repository_id IS NOT NULL;
            CREATE TABLE ports(instance_id TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,PRIMARY KEY(instance_id,host,port));
            CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,instance_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
            CREATE TABLE slots(instance_id TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,owner TEXT NOT NULL,guardians TEXT NOT NULL,active INTEGER NOT NULL,suspended INTEGER NOT NULL DEFAULT 0,requested_at INTEGER NOT NULL,granted_at INTEGER,PRIMARY KEY(instance_id,key));
            PRAGMA user_version=1;`);
          db.prepare('INSERT INTO settings VALUES(?,?)').run('registry-id', json(registry.id));
        }
      }
      if (parse(db.prepare('SELECT value FROM settings WHERE key=?').get('registry-id')?.value) !== registry.id) fail('MACHINE_REGISTRY_CHANGED', 'Machine database and identity file do not match');
      const result = action(db);
      if (result?.then) throw new Error('Coordination transactions must be synchronous');
      if (write) db.exec('COMMIT');
      if (createdRegistry) {
        const latest = JSON.parse(readFileSync(registryPath, 'utf8'));
        if (latest.id !== registry.id || latest.creator?.token !== ownerToken) fail('MACHINE_REGISTRY_CHANGED', 'Machine initialization ownership changed before publication');
        const temporary = `${registryPath}.${randomUUID()}.tmp`;
        try { writeFileSync(temporary, json({ ...registry, phase: 'ready' }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, registryPath); }
        finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      }
      return result;
    } catch (error) { try { if (write) db?.exec('ROLLBACK'); } catch {} throw error; }
    finally { db?.close(); }
  }
  function local() {
    if (!projectRoot || !projectId) throw new Error('Project root and projectId are required');
    if (maintenanceContext) return identity;
    const current = assertProjectIdentity(projectRoot, projectId);
    if (identity && (current.instanceId !== identity.instanceId || current.stateId !== identity.stateId)) fail('PROJECT_IDENTITY_CONFLICT', 'Local instance identity changed during runtime');
    identity = current; return identity;
  }
  function registered(db) {
    const current = local(), row = db?.prepare('SELECT * FROM projects WHERE instance_id=?').get(current.instanceId);
    if (!row || row.root !== (maintenanceContext?.registeredRoot ?? projectRoot) || row.project_id !== projectId || parse(row.identity).stateId !== current.stateId) fail('PROJECT_NOT_REGISTERED', 'Project instance must be registered before execution');
    return current;
  }
  function leaseRow(db, kind = 'runtime') { return db?.prepare('SELECT * FROM leases WHERE instance_id=? AND kind=?').get(local().instanceId, kind); }
  const ownerExited = row => ownerState(parse(row.owner)) === 'dead' && parse(row.guardians).every(owner => ownerState(owner) === 'dead');
  const guardiansExited = row => parse(row.guardians).every(owner => ownerState(owner) === 'dead');
  function executionRoots(extra = []) { return [...new Set([projectRoot, maintenanceContext?.registeredRoot, maintenanceContext?.originalRoot, ...extra].filter(Boolean))]; }
  function overlappingProjects(db, roots = executionRoots(), instanceId) {
    if (!db || !projectRoot) return [];
    const overlaps = [];
    for (const project of db.prepare('SELECT * FROM projects ORDER BY root').all()) {
      if (project.instance_id === instanceId) continue;
      const leases = db.prepare('SELECT * FROM leases WHERE instance_id=?').all(project.instance_id);
      // Maintenance keeps both the old and new roots fenced until completion.
      const relevant = row => roots.some(root => [project.root, ...(parse(row.owner).projectRoots ?? [])].some(other => typeof other === 'string' && rootsOverlap(root, other)));
      const registeredOverlap = roots.some(root => rootsOverlap(root, project.root));
      const facts = row => ({ kind: row.kind, ...(row.key ? { key: row.key } : {}), ownerState: ownerState(parse(row.owner)), guardianStates: parse(row.guardians).map(ownerState) });
      const leaseOwners = leases.filter(relevant).filter(row => !ownerExited(row)).map(facts);
      const slotOwners = (registeredOverlap ? db.prepare('SELECT * FROM slots WHERE instance_id=?').all(project.instance_id) : []).filter(row => !ownerExited(row)).map(facts);
      if (!registeredOverlap && !leaseOwners.length) continue;
      overlaps.push({ instanceId: project.instance_id, projectId: project.project_id, projectRoot: project.root,
        active: leaseOwners.length + slotOwners.length > 0, leases: leaseOwners, slots: slotOwners });
    }
    return overlaps;
  }
  function assertNoOverlap(db, current, roots = executionRoots()) {
    const overlaps = overlappingProjects(db, roots, current.instanceId).filter(row => row.active);
    if (overlaps.length) fail('PROJECT_ROOT_OVERLAP', 'An overlapping project directory has active or unverifiable execution; stop that runtime and its managed processes before continuing', { overlaps });
  }
  function assertMaintenance(db, token) {
    const row = leaseRow(db, 'maintenance');
    if (row && row.token !== token) fail('PROJECT_MAINTENANCE', 'Project maintenance is in progress; writes are paused');
  }
  function publicLease(row) { return { instanceId: row.instance_id, kind: row.kind, token: row.token, epoch: row.epoch, owner: parse(row.owner), guardians: parse(row.guardians), at: row.at }; }
  function assertLeaseIn(db, lease) {
    // A held maintenance capability remains releasable after the original directory
    // has moved. It cannot be used to obtain a new runtime lease at the old path.
    const instanceId = lease?.kind === 'maintenance' && lease.token === ownerToken && identity ? identity.instanceId : local().instanceId;
    const row = db?.prepare('SELECT * FROM leases WHERE instance_id=? AND kind=?').get(instanceId, lease?.kind);
    if (!row || lease.instanceId !== instanceId || row.token !== lease.token || row.epoch !== lease.epoch) fail('PROJECT_LEASE_LOST', 'Project execution lease is no longer owned by this runtime');
    return row;
  }
  function assertNoExecution(db) {
    for (const row of db.prepare('SELECT * FROM leases WHERE instance_id=? AND kind<>?').all(local().instanceId, 'maintenance')) {
      if (!ownerExited(row)) fail('PROJECT_EXECUTION_ACTIVE', 'Project still has active or unverifiable execution');
      db.prepare('DELETE FROM leases WHERE instance_id=? AND kind=?').run(row.instance_id, row.kind);
    }
    for (const row of db.prepare('SELECT * FROM slots WHERE instance_id=?').all(local().instanceId)) {
      if (!ownerExited(row)) fail('PROJECT_EXECUTION_ACTIVE', 'Project still has active or unverifiable execution slots');
      db.prepare('DELETE FROM slots WHERE instance_id=? AND key=?').run(row.instance_id, row.key);
    }
  }
  function cleanSlots(db) {
    for (const row of db.prepare('SELECT * FROM slots').all()) if (ownerExited(row)) db.prepare('DELETE FROM slots WHERE instance_id=? AND key=?').run(row.instance_id, row.key);
  }
  function slotResult(row) { return { instanceId: row.instance_id, key: row.key, kind: row.kind, token: row.token, active: !!row.active, suspended: !!row.suspended, requestedAt: row.requested_at, grantedAt: row.granted_at }; }
  function occupiedSlots(db) { return db.prepare('SELECT * FROM slots').all().filter(row => row.active || ownerState(parse(row.owner)) !== 'alive' && !ownerExited(row)).length; }
  function audit(db, type, data, instanceId = identity.instanceId) { db.prepare('INSERT INTO audit(instance_id,type,data,at) VALUES(?,?,?,?)').run(instanceId, type, json(data), now()); }
  const coordinator = {
    directory, path,
    register({ adoptLegacy = false } = {}) {
      if (!projectRoot || !projectId) throw new Error('Project root and projectId are required');
      if (maintenanceContext) fail('PROJECT_RELOCATED', 'Create a new runtime after project relocation');
      identity = ensureProjectIdentity(projectRoot, projectId, { adoptLegacy });
      if (identity.registryId && !existsSync(path)) fail('MACHINE_REGISTRY_MISSING', 'The project machine registry is missing; inspect stopped owners before repairing it');
      return database(true, db => {
        const registryId = parse(db.prepare('SELECT value FROM settings WHERE key=?').get('registry-id')?.value);
        if (!registryId) fail('MACHINE_PROTOCOL_UNSUPPORTED', 'Machine registry identity is missing');
        if (identity.registryId && identity.registryId !== registryId) fail('MACHINE_REGISTRY_CHANGED', 'Project belongs to another machine registry; inspect stopped owners before repairing it');
        const conflicts = db.prepare('SELECT * FROM projects WHERE project_id=? OR root=? OR instance_id=?').all(projectId, projectRoot, identity.instanceId);
        if (conflicts.some(row => row.root !== projectRoot || row.project_id !== projectId || row.instance_id !== identity.instanceId || parse(row.identity).stateId !== identity.stateId)) fail('PROJECT_IDENTITY_CONFLICT', 'This project identity is already registered at another path; reinitialize or relocate explicitly', { projects: conflicts.map(row => ({ projectRoot: row.root, projectId: row.project_id, instanceId: row.instance_id })) });
        identity = bindProjectMachineIdentity(projectRoot, projectId, registryId);
        const inserted = db.prepare('INSERT OR IGNORE INTO projects VALUES(?,?,?,?,?)').run(identity.instanceId, projectId, projectRoot, json(identity), now());
        if (inserted.changes) audit(db, 'project.registered', { projectId, projectRoot });
        return identity;
      });
    },
    inspect() { return { identity: projectRoot ? inspectProjectIdentity(projectRoot, projectId) : null, ...coordinator.status() }; },
    overlapStatus() {
      const instanceId = projectRoot ? inspectProjectIdentity(projectRoot, projectId).instanceId : undefined;
      return database(false, db => ({ projectRoot, overlaps: overlappingProjects(db, executionRoots(), instanceId) }));
    },
    assertWritable({ maintenanceToken } = {}) {
      if (maintenanceContext && !maintenanceToken) fail('PROJECT_RELOCATED', 'Create a new runtime after project relocation');
      return database(false, db => {
        if (!db || !projectRoot || !existsSync(join(projectStateDirectory(projectRoot), 'instance.json'))) return;
        const current = local();
        if (!maintenanceContext) {
          const registryId = parse(db.prepare('SELECT value FROM settings WHERE key=?').get('registry-id')?.value);
          if (current.registryId && current.registryId !== registryId) fail('MACHINE_REGISTRY_CHANGED', 'Project local identity belongs to a different machine registry');
          const rows = db.prepare('SELECT * FROM projects WHERE instance_id=? OR project_id=? OR root=?').all(current.instanceId, projectId, projectRoot);
          if (rows.some(row => row.instance_id !== current.instanceId || row.project_id !== projectId || row.root !== projectRoot || parse(row.identity).stateId !== current.stateId)) fail('PROJECT_IDENTITY_CONFLICT', 'Project registration no longer matches this local path or state; writes require explicit relocation or reinitialization');
        }
        assertMaintenance(db, maintenanceToken);
      });
    },
    acquireLease(kind = 'runtime', { guardians = [], roots = [] } = {}) {
      if (!['runtime', 'maintenance'].includes(kind)) throw new Error('Unsupported project lease kind');
      if (!Array.isArray(roots) || kind !== 'maintenance' && roots.length) throw new Error('Only maintenance may add protected roots');
      const additionalRoots = roots.map(canonicalMaintenanceRoot);
      if (kind === 'runtime' && maintenanceContext) fail('PROJECT_RELOCATED', 'Create a new runtime after project relocation');
      return database(true, db => {
        const current = registered(db);
        const old = leaseRow(db, kind), scope = executionRoots([...additionalRoots, ...(old?.token === ownerToken ? parse(old.owner).projectRoots ?? [] : [])]);
        assertNoOverlap(db, current, scope);
        if (kind === 'runtime') assertMaintenance(db);
        else assertNoExecution(db);
        if (old?.token === ownerToken) {
          const owner = json({ ...parse(old.owner), projectRoots: scope });
          db.prepare('UPDATE leases SET owner=? WHERE instance_id=? AND kind=?').run(owner, current.instanceId, kind);
          return publicLease({ ...old, owner });
        }
        if (old && !ownerExited(old)) fail('PROJECT_LEASE_BUSY', 'Another runtime owns this project execution lease', { owner: parse(old.owner), kind });
        const resource = `${current.instanceId}:${kind}`, epoch = (db.prepare('SELECT value FROM epochs WHERE resource=?').get(resource)?.value ?? 0) + 1;
        db.prepare('INSERT INTO epochs VALUES(?,?) ON CONFLICT(resource) DO UPDATE SET value=excluded.value').run(resource, epoch);
        const row = { instance_id: current.instanceId, kind, token: ownerToken, epoch, owner: json({ ...processIdentity(), projectRoots: scope }), guardians: json(guardians), at: now() };
        db.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id,kind) DO UPDATE SET token=excluded.token,epoch=excluded.epoch,owner=excluded.owner,guardians=excluded.guardians,at=excluded.at').run(...Object.values(row));
        return publicLease(row);
      });
    },
    acquireMaintenance(options) { return coordinator.acquireLease('maintenance', options); },
    acquireRelocation({ fromRoot, recoveryId }) {
      if (maintenanceContext) return coordinator.acquireMaintenance();
      const originalRoot = resolve(fromRoot), found = inspectProjectIdentity(projectRoot, projectId);
      if (!found.initialized || found.projectId !== projectId || found.projectRoot !== originalRoot) fail('PROJECT_IDENTITY_CONFLICT', 'Relocation requires the original instance marker at the destination');
      const { initialized, matches, currentRoot, ...original } = found;
      const saved = database(false, db => {
        if (db && original.registryId !== parse(db.prepare('SELECT value FROM settings WHERE key=?').get('registry-id')?.value)) fail('MACHINE_REGISTRY_CHANGED', 'Relocation requires the original machine registry');
        return db?.prepare('SELECT * FROM projects WHERE instance_id=?').get(original.instanceId);
      });
      if (!saved || saved.project_id !== projectId || parse(saved.identity).stateId !== original.stateId) fail('PROJECT_NOT_REGISTERED', 'Original project instance is not registered');
      if (saved.root !== originalRoot) {
        const journalDirectory = join(projectStateDirectory(projectRoot), 'maintenance'), journalPath = join(journalDirectory, 'project-operation.json');
        if (saved.root !== projectRoot || !recoveryId || !existsSync(journalPath)) fail('PROJECT_IDENTITY_CONFLICT', 'Relocation registry changed; a matching maintenance journal is required to resume');
        safeFile(journalDirectory, true); safeFile(journalPath);
        if (lstatSync(journalPath).size > 65536) fail('PROJECT_IDENTITY_INVALID', 'Maintenance journal exceeds its size limit');
        let journal;
        try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); } catch { fail('PROJECT_IDENTITY_INVALID', 'Invalid relocation maintenance journal'); }
        if (journal.schemaVersion !== 1 || journal.id !== recoveryId || journal.operation !== 'relocate' || journal.fromRoot !== originalRoot || journal.projectRoot !== projectRoot ||
          journal.identity?.instanceId !== original.instanceId || journal.identity?.stateId !== original.stateId || journal.identity?.projectId !== projectId ||
          !['planned', 'backed-up', 'service-retired', 'rewritten', 'relocated'].includes(journal.phase)) fail('PROJECT_IDENTITY_CONFLICT', 'Relocation maintenance journal does not match this interrupted operation');
      }
      identity = original; maintenanceContext = { registeredRoot: saved.root, originalRoot };
      try { return coordinator.acquireMaintenance(); }
      catch (error) { maintenanceContext = undefined; identity = undefined; throw error; }
    },
    assertLease(lease) { return database(false, db => { if (!db) fail('PROJECT_LEASE_LOST', 'Machine registry is unavailable'); return publicLease(assertLeaseIn(db, lease)); }); },
    heartbeat(lease, { guardians } = {}) {
      return database(true, db => { const row = assertLeaseIn(db, lease); if (lease.kind !== 'maintenance') assertMaintenance(db); db.prepare('UPDATE leases SET at=?,guardians=? WHERE instance_id=? AND kind=?').run(now(), guardians === undefined ? row.guardians : json(guardians), row.instance_id, row.kind); return publicLease(leaseRow(db, row.kind)); });
    },
    releaseLease(lease) {
      return database(true, db => { const row = assertLeaseIn(db, lease); if (!guardiansExited(row)) fail('PROJECT_GUARDIANS_ACTIVE', 'Cannot release ownership while managed processes are alive or unknown'); db.prepare('DELETE FROM leases WHERE instance_id=? AND kind=? AND token=? AND epoch=?').run(row.instance_id, row.kind, row.token, row.epoch); return true; });
    },
    claimRepository({ repository, repositoryId, host = 'github.com' }) {
      const name = repositoryName(repository); checkedHost(host);
      if (repositoryId !== undefined && !positive(repositoryId)) throw new Error('Invalid verified repository ID');
      return database(true, db => {
        const current = registered(db); assertMaintenance(db);
        const rows = db.prepare('SELECT r.*,p.root FROM repositories r JOIN projects p ON p.instance_id=r.instance_id WHERE r.host=? AND (r.name=? OR (? IS NOT NULL AND r.repository_id=?))').all(host, name, repositoryId === undefined ? null : String(repositoryId), repositoryId === undefined ? null : String(repositoryId));
        if (rows.some(row => row.instance_id !== current.instanceId)) fail('GITHUB_REPOSITORY_OWNED', 'GitHub repository is assigned to another local project', { bindings: rows.map(row => ({ repository: row.name, projectRoot: row.root, instanceId: row.instance_id })) });
        const previous = rows.find(row => row.name === name);
        if (previous?.repository_id && repositoryId !== undefined && previous.repository_id !== String(repositoryId)) fail('GITHUB_REPOSITORY_ID_CHANGED', 'The repository name now resolves to a different GitHub repository');
        // Keep old names as aliases for the same verified ID. A deleted/recreated
        // repository cannot inherit old work merely by reusing one of those names.
        db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?) ON CONFLICT(host,name) DO UPDATE SET repository_id=COALESCE(excluded.repository_id,repositories.repository_id)').run(host, name, repositoryId === undefined ? null : String(repositoryId), current.instanceId, now());
        if (!previous || previous.repository_id !== String(repositoryId ?? previous.repository_id)) audit(db, 'repository.bound', { host, repository: name, repositoryId: repositoryId ?? null });
        return { host, repository: name, repositoryId: repositoryId ?? (previous?.repository_id ? Number(previous.repository_id) : null), instanceId: current.instanceId, projectRoot };
      });
    },
    repositoryBinding({ repository, host = 'github.com' } = {}) {
      checkedHost(host); const name = repository === undefined ? null : repositoryName(repository);
      return database(false, db => !db ? [] : db.prepare('SELECT r.*,p.root FROM repositories r JOIN projects p ON p.instance_id=r.instance_id WHERE r.host=? AND (? IS NULL OR r.name=?)').all(host, name, name).map(row => ({ host: row.host, repository: row.name, repositoryId: row.repository_id ? Number(row.repository_id) : null, instanceId: row.instance_id, projectRoot: row.root, at: row.at })));
    },
    releaseRepository({ repository, host = 'github.com', assertSafe, maintenanceToken } = {}) {
      const name = repositoryName(repository); checkedHost(host);
      return database(true, db => { const current = registered(db); assertMaintenance(db, maintenanceToken); assertNoExecution(db); if (typeof assertSafe !== 'function' || assertSafe() !== true) fail('GITHUB_BINDING_RELEASE_UNSAFE', 'Confirm no active work, pending delivery or unknown remote effects before releasing repository ownership'); const row = db.prepare('SELECT * FROM repositories WHERE host=? AND name=?').get(host, name); if (row && row.instance_id !== current.instanceId) fail('GITHUB_REPOSITORY_OWNED', 'Cannot release another project repository'); db.prepare('DELETE FROM repositories WHERE host=? AND name=? AND instance_id=?').run(host, name, current.instanceId); if (row) audit(db, 'repository.released', { host, repository: name, repositoryId: row.repository_id ? Number(row.repository_id) : null }); return true; });
    },
    portStatus({ host, port }) {
      host = portAddress(host); if (!positive(port) || port > 65535) throw new Error('Expected a fixed port');
      return database(false, db => { const instanceId = projectRoot ? inspectProjectIdentity(projectRoot, projectId).instanceId : null; const conflicts = !db ? [] : db.prepare('SELECT p.*,r.root FROM ports p JOIN projects r ON r.instance_id=p.instance_id WHERE port=?').all(port).filter(row => row.instance_id !== instanceId && listenAddressesOverlap(row.host, host)).map(row => ({ host: row.host, port: row.port, instanceId: row.instance_id, projectRoot: row.root })); return { available: !conflicts.length, conflicts }; });
    },
    reservePort({ host, port, maintenanceToken }) {
      host = portAddress(host); if (!positive(port) || port > 65535) throw new Error('Expected a fixed port');
      return database(true, db => { const current = registered(db); assertMaintenance(db, maintenanceToken); const conflicts = db.prepare('SELECT p.*,r.root FROM ports p JOIN projects r ON r.instance_id=p.instance_id WHERE port=?').all(port).filter(row => row.instance_id !== current.instanceId && listenAddressesOverlap(row.host, host)); if (conflicts.length) fail('WEBHOOK_PORT_OWNED', 'Webhook address conflicts with another project', { conflicts: conflicts.map(row => ({ host: row.host, port: row.port, projectRoot: row.root })) }); db.prepare('INSERT OR IGNORE INTO ports VALUES(?,?,?)').run(current.instanceId, host, port); return { instanceId: current.instanceId, host, port, projectRoot }; });
    },
    releasePort({ host, port, maintenanceToken } = {}) { return database(true, db => { const current = registered(db); assertMaintenance(db, maintenanceToken); const active = leaseRow(db); if (active && !ownerExited(active)) fail('PROJECT_EXECUTION_ACTIVE', 'Stop runtime before releasing its port declaration'); db.prepare('DELETE FROM ports WHERE instance_id=? AND (? IS NULL OR host=?) AND (? IS NULL OR port=?)').run(current.instanceId, host ?? null, host ?? null, port ?? null, port ?? null); return true; }); },
    acquireSlot({ key, kind = 'worker', guardians = [], parentKey } = {}) {
      if (typeof key !== 'string' || !key || key.length > 300 || !['worker', 'coordinator', 'child'].includes(kind)) throw new Error('Invalid execution slot');
      return database(true, db => {
        const current = registered(db); assertMaintenance(db); assertNoOverlap(db, current); cleanSlots(db);
        const limit = parse(db.prepare('SELECT value FROM settings WHERE key=?').get('limits')?.value)?.maxActiveExecutions ?? null;
        let row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=?').get(current.instanceId, key);
        if (row && parse(row.owner).coordinatorToken !== ownerToken) fail('EXECUTION_SLOT_OWNED', 'Execution slot belongs to another runtime');
        if (row?.active) return { acquired: true, slot: slotResult(row) };
        if (parentKey && db.prepare('SELECT 1 FROM slots WHERE instance_id=? AND key=? AND active=1').get(current.instanceId, parentKey) && limit !== null && occupiedSlots(db) >= limit) fail('MACHINE_CHILD_CAPACITY', 'Parent execution must safely hand off its slot before waiting for a child');
        if (!row) { db.prepare('INSERT INTO slots VALUES(?,?,?,?,?,?,0,0,?,NULL)').run(current.instanceId, key, kind, randomUUID(), json({ ...processIdentity(), coordinatorToken: ownerToken }), json(guardians), now()); row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=?').get(current.instanceId, key); }
        if (row.suspended) { db.prepare('UPDATE slots SET suspended=0,requested_at=? WHERE instance_id=? AND key=?').run(now(), row.instance_id, row.key); row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=?').get(current.instanceId, key); }
        const active = occupiedSlots(db);
        const lastProject = parse(db.prepare('SELECT value FROM settings WHERE key=?').get('last-granted-project')?.value);
        const waiting = db.prepare('SELECT * FROM slots WHERE active=0 AND suspended=0 ORDER BY requested_at,instance_id,key').all();
        const head = waiting.find(candidate => candidate.instance_id !== lastProject) ?? waiting[0];
        if (limit !== null && (active >= limit || head?.instance_id !== current.instanceId || head?.key !== key)) return { acquired: false, reason: 'machine-capacity', waiting: slotResult(row), maxActiveExecutions: limit, activeExecutions: active };
        db.prepare('UPDATE slots SET active=1,granted_at=? WHERE instance_id=? AND key=?').run(now(), current.instanceId, key);
        db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last-granted-project', json(current.instanceId));
        return { acquired: true, slot: slotResult(db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=?').get(current.instanceId, key)) };
      });
    },
    heartbeatSlot(slot, { guardians } = {}) { return database(true, db => { const row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=? AND token=?').get(local().instanceId, slot.key, slot.token); if (!row) fail('EXECUTION_SLOT_LOST', 'Execution slot is no longer owned'); if (guardians !== undefined) db.prepare('UPDATE slots SET guardians=? WHERE instance_id=? AND key=?').run(json(guardians), row.instance_id, row.key); return slotResult(row); }); },
    yieldSlot(slot) { return database(true, db => { const row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=? AND token=?').get(local().instanceId, slot?.key, slot?.token); if (!row || parse(row.owner).coordinatorToken !== ownerToken) fail('EXECUTION_SLOT_LOST', 'Execution slot is no longer owned'); assertMaintenance(db); db.prepare('UPDATE slots SET active=0,suspended=1 WHERE instance_id=? AND key=? AND token=?').run(row.instance_id, row.key, row.token); return slotResult({ ...row, active: 0, suspended: 1 }); }); },
    releaseSlot(slot) { return database(true, db => { const row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=? AND token=?').get(local().instanceId, slot?.key, slot?.token); if (!row) fail('EXECUTION_SLOT_LOST', 'Execution slot is no longer owned'); if (!guardiansExited(row)) fail('PROJECT_GUARDIANS_ACTIVE', 'Cannot release execution capacity while managed processes are alive or unknown'); db.prepare('DELETE FROM slots WHERE instance_id=? AND key=? AND token=?').run(row.instance_id, row.key, row.token); return true; }); },
    cancelSlot(key) { return database(true, db => { const row = db.prepare('SELECT * FROM slots WHERE instance_id=? AND key=?').get(local().instanceId, key); if (!row) return false; if (parse(row.owner).coordinatorToken !== ownerToken || row.active) fail('EXECUTION_SLOT_ACTIVE', 'Only a waiting slot owned by this runtime can be cancelled'); if (!guardiansExited(row)) { db.prepare('UPDATE slots SET suspended=1 WHERE instance_id=? AND key=?').run(row.instance_id, row.key); return false; } db.prepare('DELETE FROM slots WHERE instance_id=? AND key=?').run(row.instance_id, row.key); return true; }); },
    setLimits({ maxActiveExecutions = null } = {}) { if (maxActiveExecutions !== null && (!positive(maxActiveExecutions) || maxActiveExecutions > 1024)) throw new Error('maxActiveExecutions must be 1..1024 or null'); return database(true, db => { db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('limits', json({ maxActiveExecutions })); return { maxActiveExecutions }; }); },
    status() { return database(false, db => ({ initialized: !!db, protocolVersion: db ? PROTOCOL : null, directory, limits: db ? parse(db.prepare('SELECT value FROM settings WHERE key=?').get('limits')?.value) ?? { maxActiveExecutions: null } : { maxActiveExecutions: null }, leases: db ? db.prepare('SELECT * FROM leases').all().map(row => ({ ...publicLease(row), ownerState: ownerState(parse(row.owner)) })) : [], slots: db ? db.prepare('SELECT * FROM slots ORDER BY requested_at').all().map(row => ({ ...slotResult(row), ownerState: ownerState(parse(row.owner)) })) : [] })); },
    listProjects() { return database(false, db => !db ? [] : db.prepare('SELECT * FROM projects ORDER BY root').all().map(row => ({ ...parse(row.identity), registeredAt: row.registered_at, repositories: db.prepare('SELECT host,name AS repository,repository_id AS repositoryId FROM repositories WHERE instance_id=?').all(row.instance_id), ports: db.prepare('SELECT host,port FROM ports WHERE instance_id=?').all(row.instance_id) }))); },
    audit({ limit = 100 } = {}) { if (!positive(limit) || limit > 1000) throw new Error('Audit limit must be 1..1000'); return database(false, db => !db ? [] : db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit).map(row => ({ sequence: row.seq, instanceId: row.instance_id, type: row.type, data: parse(row.data), at: row.at }))); },
    relocate({ toRoot, maintenanceLease }) {
      const destination = realpathSync(toRoot), fromRoot = maintenanceContext?.registeredRoot ?? projectRoot;
      const result = database(true, db => {
        const current = registered(db);
        if (maintenanceLease?.kind !== 'maintenance') throw new Error('Relocation requires a maintenance lease');
        const lease = assertLeaseIn(db, maintenanceLease); assertNoExecution(db);
        if (db.prepare('SELECT 1 FROM projects WHERE root=? AND instance_id<>?').get(destination, identity.instanceId)) fail('PROJECT_IDENTITY_CONFLICT', 'Destination is already registered');
        const owner = parse(lease.owner), roots = executionRoots([destination, ...(owner.projectRoots ?? [])]);
        assertNoOverlap(db, current, roots);
        db.prepare('UPDATE leases SET owner=? WHERE instance_id=? AND kind=?').run(json({ ...owner, projectRoots: roots }), identity.instanceId, 'maintenance');
        const next = { ...identity, projectRoot: destination };
        db.prepare('UPDATE projects SET root=?,identity=? WHERE instance_id=?').run(destination, json(next), identity.instanceId);
        audit(db, 'project.relocated', { fromRoot, toRoot: destination }); return next;
      });
      maintenanceContext = { ...maintenanceContext, registeredRoot: destination }; return result;
    },
    unregister({ maintenanceLease, assertSafe } = {}) { return database(true, db => { const current = registered(db); if (maintenanceLease?.kind !== 'maintenance') throw new Error('Unregister requires a maintenance lease'); assertLeaseIn(db, maintenanceLease); assertNoExecution(db); if (typeof assertSafe !== 'function' || assertSafe() !== true) fail('PROJECT_UNREGISTER_UNSAFE', 'Confirm stopped execution and settled remote effects before unregistering'); for (const table of ['repositories', 'ports', 'slots', 'leases']) db.prepare(`DELETE FROM ${table} WHERE instance_id=?`).run(current.instanceId); db.prepare('DELETE FROM projects WHERE instance_id=?').run(current.instanceId); return true; }); },
    close() {},
  };
  return coordinator;
}

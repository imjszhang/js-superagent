import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, linkSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

const versionOf = db => Number(db.prepare('PRAGMA user_version').get().user_version);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function existingFile(path, label = 'Database') {
  if (typeof path !== 'string' || !path || path === ':memory:') throw new Error(`${label} requires an existing file path`);
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file, not a symlink`);
  return realpathSync(path);
}
function absent(path) {
  try { lstatSync(path); throw new Error(`Refusing to replace existing file: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function checkIntegrity(db) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (!checks.length || checks.some(row => row.integrity_check !== 'ok')) throw new Error('SQLite integrity check failed');
}
function ownerState(owner) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  try { process.kill(owner.pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
function owners(db) {
  const found = [];
  const add = (name, value) => {
    found.push({ name, owner: value, state: ownerState(value) });
    for (const [index, guardian] of [...(value?.guardians ?? []), ...(value?.guardian ? [value.guardian] : [])].entries()) {
      found.push({ name: `${name}/guardian:${index}`, owner: guardian, state: ownerState(guardian) });
    }
  };
  if (hasTable(db, 'kv')) for (const row of db.prepare('SELECT key, data FROM kv').all()) {
    if (row.key.startsWith('managed-job:')) { const job = JSON.parse(row.data); if (['pending','running'].includes(job.status)) add(row.key, {...job.owner,guardians:job.guardians}); }
    if (row.key.startsWith('native-handoff:')) {
      const lease = JSON.parse(row.data);
      if (['holding','resuming','closing'].includes(lease.status)) add(row.key, { ...lease.owner,
        // Missing/malformed identities remain unverifiable, never evidence that
        // a transferred process can be ignored during backup or migration.
        guardians: Array.isArray(lease.guardianPids) && lease.guardianPids.length
          ? lease.guardianPids.map(pid => ({ pid, host: lease.owner?.host })) : [undefined] });
    }
    if (row.key === 'runtime:loop' || row.key === 'execution' || row.key.startsWith('execution:') || row.key.endsWith(':sync-lock') || row.key.endsWith(':owner')) add(row.key, JSON.parse(row.data));
  }
  if (hasTable(db, 'effects')) for (const row of db.prepare('SELECT kind, key, token, owner FROM effects WHERE token IS NOT NULL OR owner IS NOT NULL').all()) {
    add(`effect:${row.kind}:${row.key}`, row.owner ? JSON.parse(row.owner) : undefined);
  }
  if (versionOf(db) === 1 && hasTable(db, 'tickets')) for (const row of db.prepare('SELECT id, data FROM tickets').all()) {
    const ticket = JSON.parse(row.data);
    if (ticket.status === 'running') add(`legacy-ticket:${row.id}`, ticket.owner);
  }
  return found;
}
function assertOwnersStopped(db) {
  const active = owners(db).filter(item => item.state !== 'dead');
  if (active.length) throw new Error(`Cannot maintain database with live or unverifiable owners: ${active.map(item => item.name).join(', ')}`);
}
export const databaseMaintenanceLockPath = path => `${resolve(path)}.maintenance-lock`;

/** Runtime open/dispatch paths must call this to participate in the maintenance exclusion protocol. */
export function assertDatabaseAvailable(path) {
  if (path === ':memory:') return;
  try { lstatSync(databaseMaintenanceLockPath(path)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Database maintenance is in progress; stop the service before inspecting the maintenance lock');
}

/** Read-only facts. No lock or recovery side effects, and never upgrades the state schema. */
export function inspectDatabase(path) {
  path = existingFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    checkIntegrity(db);
    return { path, schemaVersion: versionOf(db), integrity: 'ok', owners: owners(db),
      migrations: hasTable(db, 'schema_migrations') ? db.prepare('SELECT id, from_version AS fromVersion, to_version AS toVersion, at FROM schema_migrations ORDER BY to_version').all() : [] };
  } finally { db.close(); }
}

async function withMaintenance({ path, assertStopped }, action) {
  path = existingFile(path);
  if (typeof assertStopped !== 'function') throw new Error('Maintenance requires an assertStopped callback that verifies all runtime/service instances are stopped');
  const lockPath = databaseMaintenanceLockPath(path);
  const token = randomUUID();
  writeFileSync(lockPath, JSON.stringify({ token, host: hostname(), pid: process.pid, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  let db;
  try {
    // Idle services have no execution owner. The caller must verify service shutdown, not only an empty work queue.
    if (await assertStopped() !== true) throw new Error('The runtime/service has not been confirmed stopped');
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=5000');
    checkIntegrity(db); assertOwnersStopped(db);
    return await action(db, path);
  } finally {
    db?.close();
    // Never remove a lock somebody replaced while an operator investigated a stopped maintenance process.
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).token === token) unlinkSync(lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function withMaintenanceSync({ path, assertStopped }, action) {
  path = existingFile(path);
  if (typeof assertStopped !== 'function') throw new Error('Maintenance requires stopped runtime proof');
  const lockPath = databaseMaintenanceLockPath(path), token = randomUUID();
  writeFileSync(lockPath, JSON.stringify({token,host:hostname(),pid:process.pid,at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
  let db;
  try {
    if (assertStopped() !== true) throw new Error('Synchronous migration requires synchronous stopped runtime proof');
    db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=5000'); checkIntegrity(db); assertOwnersStopped(db);
    const result = action(db,path);
    if (result && typeof result.then === 'function') throw new Error('Synchronous maintenance cannot await');
    return result;
  } finally {
    db?.close();
    try { if(JSON.parse(readFileSync(lockPath,'utf8')).token===token) unlinkSync(lockPath); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
}

function snapshot(db, source, destination, metadata = {}) {
  destination = resolve(destination ?? `${source}.v${versionOf(db)}-${randomUUID()}.backup`);
  const manifestPath = `${destination}.json`;
  absent(destination); absent(manifestPath);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    chmodSync(temporary, 0o600);
    const facts = inspectDatabase(temporary);
    if (facts.schemaVersion !== versionOf(db)) throw new Error('Backup schema changed during snapshot');
    const manifest = { formatVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), source,
      schemaVersion: facts.schemaVersion, sha256: digest(temporary), ...metadata };
    // A complete snapshot is published without overwriting any existing artifact.
    linkSync(temporary, destination);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { path: destination, manifestPath, ...manifest };
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** A checksum-verified consistent SQLite snapshot; does not change schema, cursors, or queued work. */
export function createDatabaseBackup({ path, destination, assertStopped } = {}) {
  return withMaintenance({ path, assertStopped }, (db, source) => snapshot(db, source, destination));
}

export function createDatabaseBackupSync({ path, destination, assertStopped } = {}) {
  return withMaintenanceSync({ path, assertStopped }, (db, source) => snapshot(db, source, destination));
}

function migrationChain(registry, current, target) {
  if (!Number.isSafeInteger(target) || target < 1 || target < current) throw new Error(`Refusing database downgrade from ${current} to ${target}`);
  if (!Array.isArray(registry)) throw new Error('Migrations must be an array');
  const ids = new Set(), fromVersions = new Set();
  for (const step of registry) {
    if (!step || !Number.isSafeInteger(step.from) || step.from < 1 || step.to !== step.from + 1 || typeof step.id !== 'string' || !step.id.trim() || typeof step.up !== 'function' || step.up.constructor.name === 'AsyncFunction') {
      throw new Error('Each migration requires a unique id, consecutive from/to versions, and synchronous up(db)');
    }
    if (ids.has(step.id) || fromVersions.has(step.from)) throw new Error('Ambiguous migration registry');
    ids.add(step.id); fromVersions.add(step.from);
  }
  const chain = [];
  for (let version = current; version < target; version++) {
    const step = registry.find(item => item.from === version);
    if (!step) throw new Error(`Missing migration from schema ${version}`);
    chain.push(step);
  }
  return chain;
}

/** All steps commit together. Any failure retains both the old state and its validated backup. */
export function migrateDatabase(options = {}) { return migrateWith(withMaintenance, options); }
export function migrateDatabaseSync(options = {}) { return migrateWith(withMaintenanceSync, options); }
function migrateWith(maintain, { path, targetVersion, migrations = [], backupPath, assertStopped }) {
  return maintain({ path, assertStopped }, (db, source) => {
    const fromVersion = versionOf(db);
    const chain = migrationChain(migrations, fromVersion, targetVersion);
    if (!chain.length) return { fromVersion, toVersion: fromVersion, applied: [], backup: null };
    const backup = snapshot(db, source, backupPath, { targetVersion });
    db.exec('BEGIN IMMEDIATE');
    try {
      assertOwnersStopped(db);
      if (versionOf(db) !== fromVersion) throw new Error('Database schema changed after backup');
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL UNIQUE, at TEXT NOT NULL)');
      for (const step of chain) {
        const value = step.up(db);
        if (value && typeof value.then === 'function') throw new Error('Migrations must be synchronous');
        if (versionOf(db) !== step.from) throw new Error('Migration callbacks must not modify user_version');
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(step.id, step.from, step.to, new Date().toISOString());
        db.exec(`PRAGMA user_version=${step.to}`);
      }
      checkIntegrity(db);
      db.exec('COMMIT');
      return { fromVersion, toVersion: targetVersion, applied: chain.map(step => step.id), backup };
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration failed; original schema ${fromVersion} retained. Backup: ${backup.path}`, { cause: error });
    }
  });
}

/** Prepare, never install, a prior snapshot. External writes after that snapshot require explicit reconciliation. */
export function prepareDatabaseRestore({ path, backupPath, destination, expectedVersion, reconciliation, assertStopped } = {}) {
  return withMaintenance({ path, assertStopped }, (_db, source) => {
    backupPath = existingFile(backupPath, 'Backup');
    const manifest = JSON.parse(readFileSync(existingFile(`${backupPath}.json`, 'Backup manifest'), 'utf8'));
    if (manifest.formatVersion !== 1 || manifest.source !== source || manifest.schemaVersion !== expectedVersion || digest(backupPath) !== manifest.sha256) {
      throw new Error('Backup identity, version, or checksum does not match');
    }
    if (!reconciliation || reconciliation.backupId !== manifest.id || typeof reconciliation.note !== 'string' || !reconciliation.note.trim()) {
      throw new Error('Restore preparation requires a recorded external-effects reconciliation for this backup');
    }
    const facts = inspectDatabase(backupPath);
    if (facts.schemaVersion !== expectedVersion) throw new Error('Backup schema does not match its manifest');
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assertOwnersStopped(backupDb);
      return snapshot(backupDb, source, destination ?? `${source}.restore-${randomUUID()}.staged`, {
        restoredFrom: manifest.id, reconciliation: { backupId: manifest.id, note: reconciliation.note },
        installRequired: true, oldPackageRequired: true,
      });
    } finally { backupDb.close(); }
  });
}

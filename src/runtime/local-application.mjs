import { constants, openSync, closeSync, readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync,
  renameSync, unlinkSync, linkSync, fstatSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateWorkspace, inspectWorkspace } from '../workspaces.mjs';
import { assertProjectIdentity } from '../project-identity.mjs';
import { ensureProjectStateDirectory, projectStateDirectory } from '../state-paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const ID = /^[A-Za-z\d_-]{1,120}$/;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_RECORD = 8 * 1024 * 1024;
const denied = new Set(['.git', '.js-superagent', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.ssh', '.aws', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519']);
const inPaths = (path, paths) => paths.some(scope => scope === '.' || path === scope || path.startsWith(`${scope}/`));

function relativePath(path, allowRoot = false) {
  if (allowRoot && path === '.') return path;
  if (typeof path !== 'string' || !path || path.length > 4096 || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\0]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || denied.has(part) || part === '.env' || part.startsWith('.env.'))) throw new Error('Unsafe local application path');
  return path;
}
function pathsOf(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100) throw new Error('Local application requires bounded explicit paths');
  return [...new Set(paths.map(path => relativePath(path, true)))].sort();
}
function safePath(root, path, create = false) {
  relativePath(path);
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw new Error('Local application target root changed');
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) throw new Error('Unsafe local application ancestor');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) break;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return join(root, path);
}
function readState(root, path, withContent = false) {
  const file = safePath(root, path);
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { info: null, bytes: null }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE) throw new Error('Local application only accepts bounded, unlinked regular files');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino || before.size > MAX_FILE) throw new Error('Local application file identity changed');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('Local application file changed while reading');
    return { info: { type: 'file', sha256: hash(bytes), size: bytes.length, mode: before.mode & 0o777 }, bytes: withContent ? bytes : null };
  } finally { closeSync(fd); }
}
function assertSource(root, source) {
  if (source?.root !== root || !source.projectId || !source.instanceId) throw new Error('Local application source identity changed');
  const identity = assertProjectIdentity(root, source.projectId);
  if (identity.instanceId !== source.instanceId) throw new Error('Local application source instance changed');
}
function planFacts(plan) {
  const { digest, ...facts } = plan;
  return facts;
}

/** Read-only, host-scoped review of Worker changes against the imported material baseline. */
export function previewLocalApplication({ projectRoot, workspace, paths }) {
  const root = realpathSync(projectRoot), saved = validateWorkspace({ projectRoot: root, workspace });
  if (saved.mode !== 'copy' || saved.snapshotOrigin !== 'project-materials') throw new Error('Local application requires a material copy workspace');
  assertSource(root, saved.materialSource);
  const allowed = pathsOf(paths), imported = saved.config.includePaths;
  if (!Array.isArray(imported) || allowed.some(path => !inPaths(path, imported))) throw new Error('Local application paths exceed the material scope');
  const baseline = JSON.parse(readFileSync(saved.manifestPath, 'utf8'));
  if (baseline.materialSnapshotDigest !== saved.materialSnapshotDigest || hash(JSON.stringify(baseline.files)) !== saved.sourceSnapshotDigest) throw new Error('Material application baseline changed');
  const changes = inspectWorkspace({ projectRoot: root, workspace: saved }).changes;
  if (changes.length > 20_000 || changes.some(change => !inPaths(change.path, allowed))) throw new Error('Worker changes exceed the allowed application paths');
  let bytes = 0;
  const entries = changes.map(change => {
    const before = baseline.files[change.path] ?? null;
    if (before && before.type !== 'file') throw new Error('Local application refuses non-file baseline changes');
    const after = readState(saved.path, change.path).info, current = readState(root, change.path).info;
    if (!same(before, current)) throw Object.assign(new Error(`Local application conflicts with source changes: ${change.path}`), { code: 'MATERIAL_APPLY_CONFLICT', path: change.path });
    bytes += (before?.size ?? 0) + (after?.size ?? 0);
    if (bytes > MAX_BYTES) throw new Error('Local application exceeds its byte budget');
    return { path: change.path, status: change.status, before, after };
  });
  const facts = { version: 1, kind: 'local-application', ticketId: saved.ticketId, workspaceProvisionId: saved.provisionId,
    generation: saved.generation ?? 0, source: saved.materialSource, materialSnapshotDigest: saved.materialSnapshotDigest,
    sourceSnapshotDigest: saved.sourceSnapshotDigest, paths: allowed, changes: entries };
  if (Buffer.byteLength(JSON.stringify(facts)) + 2 * Buffer.byteLength(JSON.stringify(entries.map(item => item.path))) > MAX_RECORD - 65536) throw new Error('Local application journal exceeds its metadata budget');
  return { ...facts, digest: hash(JSON.stringify(facts)) };
}

function checkAuthority(authorize) {
  if (typeof authorize !== 'function') throw new Error('Local application requires explicit host authorization');
  const result = authorize();
  if (result !== true) throw new Error('Local application authorization was denied or is not synchronous');
}
function recoveryDirectory(root, id, create = false) {
  if (!ID.test(id ?? '')) throw new Error('Invalid local application operation identity');
  let directory = create ? ensureProjectStateDirectory(root) : projectStateDirectory(root);
  for (const part of ['local-applications', id]) {
    directory = join(directory, part);
    try { const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Unsafe local application journal directory'); }
    catch (error) { if (error.code !== 'ENOENT' || !create) throw error; mkdirSync(directory, { mode: 0o700 }); }
  }
  return directory;
}
function readJSON(file, max = MAX_RECORD) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error('Invalid local application journal'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
function saveRecord(directory, record, persist) {
  const temporary = join(directory, `.record-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, join(directory, 'record.json'));
  const result = persist(structuredClone(record));
  if (result?.then) throw new Error('Local application persistence must be synchronous');
}
function readRecord(root, operationId) {
  const directory = recoveryDirectory(root, operationId), record = readJSON(join(directory, 'record.json'));
  if (record.version !== 1 || record.id !== operationId || record.kind !== 'local-application' || record.plan?.source?.root !== root ||
      record.ticketId !== record.plan.ticketId || !ID.test(record.ticketId ?? '') ||
      !['preparing', 'prepared', 'applying', 'interrupted', 'recovering', 'applied', 'rolled-back'].includes(record.status) ||
      !['preparing', 'ready'].includes(record.backupState) || record.plan.version !== 1 || record.plan.kind !== 'local-application' ||
      hash(JSON.stringify(planFacts(record.plan))) !== record.plan.digest) throw new Error('Local application journal identity changed');
  assertSource(root, record.plan.source);
  try {
    const plan = readJSON(join(directory, 'plan.json'));
    if (!same(plan, record.plan)) throw new Error('Local application stored plan changed');
  } catch (error) { if (error.code !== 'ENOENT' || record.backupState !== 'preparing') throw error; }
  return { directory, record };
}

/** Read a durable receipt without creating state or touching business files. */
export function inspectLocalApplication({ projectRoot, operationId }) {
  return structuredClone(readRecord(realpathSync(projectRoot), operationId).record);
}

/** A read-only inventory includes filesystem owners whose database acknowledgement was lost. */
export function listLocalApplications({ projectRoot, ticketId } = {}) {
  const root = realpathSync(projectRoot), state = projectStateDirectory(root), directory = join(state, 'local-applications');
  if (ticketId !== undefined && !ID.test(ticketId)) throw new Error('Invalid local application ticket identity');
  for (const path of [state, directory]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Unsafe local application journal directory');
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const entries = readdirSync(directory).sort();
  if (entries.length > 20000) throw new Error('Local application journal inventory exceeds its limit');
  // Validate every owner before filtering: corruption cannot be hidden by a ticket selector.
  const records = entries.map(operationId => {
    try { return readRecord(root, operationId).record; }
    catch (error) { throw Object.assign(new Error(`Local application journal needs inspection (${operationId}): ${error.message}`), { code: 'MATERIAL_APPLY_JOURNAL_INVALID', operationId }); }
  });
  return records.filter(record => ticketId === undefined || record.ticketId === ticketId).map(record => structuredClone(record));
}
function replace(root, path, bytes, info, before) {
  const file = safePath(root, path, !!info);
  if (!same(readState(root, path).info, before)) throw new Error(`Source changed while applying ${path}`);
  if (!info) { if (before) unlinkSync(file); return; }
  const temporary = join(dirname(file), `.js-superagent-apply-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: info.mode });
    chmodSync(temporary, info.mode);
    safePath(root, path);
    if (!same(readState(root, path).info, before)) throw new Error(`Source changed before replacing ${path}`);
    if (before) renameSync(temporary, file);
    else { linkSync(temporary, file); unlinkSync(temporary); }
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

/** Host-only. The caller supplies the existing cross-process write fence and authoritative permission check. */
export async function applyLocalApplication({ projectRoot, workspace, plan, operationId, persist, authorize, withLock }) {
  if (typeof persist !== 'function' || typeof withLock !== 'function' || !ID.test(operationId ?? '')) throw new Error('Local application requires persistence, a write fence and operation identity');
  const root = realpathSync(projectRoot);
  return withLock(`local-application:${root}`, () => {
    checkAuthority(authorize);
    if (!plan || !/^[a-f\d]{64}$/.test(plan.digest ?? '') || hash(JSON.stringify(planFacts(plan))) !== plan.digest) throw new Error('Invalid local application plan');
    try {
      const old = readRecord(root, operationId).record;
      if (old.plan.digest !== plan.digest) throw new Error('Local application operation identity conflict');
      if (old.status === 'applied') return structuredClone(old);
      throw Object.assign(new Error('Local application already started; explicitly recover its existing operation'), { code: 'MATERIAL_APPLY_RECOVERY_REQUIRED', application: old });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const current = previewLocalApplication({ projectRoot: root, workspace, paths: plan.paths });
    if (!same(current, plan)) throw new Error('Local application plan changed; review the current increment');
    const saved = validateWorkspace({ projectRoot: root, workspace });
    const prepared = current.changes.map(change => {
      const before = readState(root, change.path, true), after = readState(saved.path, change.path, true);
      if (!same(before.info, change.before) || !same(after.info, change.after)) throw new Error('Local application files changed after preview');
      return { change, before: before.bytes, after: after.bytes };
    });
    const directory = recoveryDirectory(root, operationId, true);
    const record = { version: 1, id: operationId, kind: 'local-application', status: 'preparing', backupState: 'preparing', ticketId: saved.ticketId,
      plan: current, createdAt: new Date().toISOString(), appliedPaths: [] };
    // Publish recovery ownership before preparing any backups or touching source files.
    saveRecord(directory, record, persist);
    try {
      writeFileSync(join(directory, 'plan.json'), JSON.stringify(current), { flag: 'wx', mode: 0o600 });
      for (const [index, item] of prepared.entries()) {
        if (item.before !== null) writeFileSync(join(directory, `${index}-before`), item.before, { flag: 'wx', mode: 0o600 });
        if (item.after !== null) writeFileSync(join(directory, `${index}-after`), item.after, { flag: 'wx', mode: 0o600 });
      }
      record.backupState = 'ready'; record.status = 'prepared'; saveRecord(directory, record, persist);
      record.status = 'applying'; saveRecord(directory, record, persist);
      for (const { change, after } of prepared) {
        checkAuthority(authorize); assertSource(root, current.source);
        replace(root, change.path, after, change.after, change.before);
        record.appliedPaths.push(change.path); saveRecord(directory, record, persist);
      }
      record.status = 'applied'; record.endedAt = new Date().toISOString(); saveRecord(directory, record, persist);
      return structuredClone(record);
    } catch (error) {
      record.status = 'interrupted'; record.error = String(error.message ?? error).slice(0, 8192);
      try { saveRecord(directory, record, persist); } catch { /* A prior durable record and backups retain recovery ownership. */ }
      throw Object.assign(new Error(`Local application interrupted: ${record.error}`), { code: 'MATERIAL_APPLY_INTERRUPTED', application: structuredClone(record) });
    }
  });
}

function backupBytes(directory, index, side, expected) {
  if (!expected) return null;
  const fd = openSync(join(directory, `${index}-${side}`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size || stat.size > MAX_FILE) throw new Error('Local application backup is invalid');
    const bytes = readFileSync(fd);
    if (hash(bytes) !== expected.sha256 || bytes.length !== expected.size) throw new Error('Local application backup changed');
    return bytes;
  } finally { closeSync(fd); }
}

/** Explicit reconciliation touches only files still equal to the recorded before/after states. */
export async function recoverLocalApplication({ projectRoot, operationId, record: supplied, mode = 'finish', persist, authorize, withLock }) {
  if (!['finish', 'rollback'].includes(mode) || typeof persist !== 'function' || typeof withLock !== 'function') throw new Error('Invalid local application recovery request');
  const root = realpathSync(projectRoot), id = operationId ?? supplied?.id;
  return withLock(`local-application:${root}`, () => {
    checkAuthority(authorize);
    const { directory, record } = readRecord(root, id);
    if (supplied && supplied.plan?.digest !== record.plan.digest) throw new Error('Local application recovery identity changed');
    const desired = mode === 'finish' ? 'applied' : 'rolled-back';
    if (record.status === desired) return structuredClone(record);
    if (!['preparing', 'prepared', 'applying', 'interrupted', 'recovering'].includes(record.status)) throw new Error('Local application has no interrupted operation to recover');
    if (record.backupState !== 'ready' && mode === 'finish') throw new Error('Local application backup preparation is incomplete; explicitly roll back before trying a new operation');
    const prepared = record.plan.changes.map((change, index) => {
      const actual = readState(root, change.path).info;
      if (!same(actual, change.before) && !same(actual, change.after)) throw Object.assign(new Error(`Local application recovery conflicts with newer changes: ${change.path}`), { code: 'MATERIAL_APPLY_CONFLICT', path: change.path });
      const side = mode === 'finish' ? 'after' : 'before', expected = change[side];
      if (record.backupState !== 'ready' && !same(actual, change.before)) throw new Error('Incomplete local preparation has unexpected source changes');
      return { change, actual, expected, bytes: same(actual, expected) ? null : backupBytes(directory, index, side, expected) };
    });
    const next = { ...record, status: 'recovering', recoveryMode: mode, recoveredPaths: [] };
    saveRecord(directory, next, persist);
    try {
      for (const item of prepared) {
        checkAuthority(authorize); assertSource(root, record.plan.source);
        if (!same(readState(root, item.change.path).info, item.actual)) throw new Error('Source changed during local application recovery');
        if (!same(item.actual, item.expected)) replace(root, item.change.path, item.bytes, item.expected, item.actual);
        next.recoveredPaths.push(item.change.path); saveRecord(directory, next, persist);
      }
      next.status = desired; next.endedAt = new Date().toISOString(); saveRecord(directory, next, persist);
      return structuredClone(next);
    } catch (error) {
      next.status = 'interrupted'; next.error = String(error.message ?? error).slice(0, 8192);
      try { saveRecord(directory, next, persist); } catch { /* Keep the durable previous recovery record. */ }
      throw Object.assign(new Error(`Local application recovery interrupted: ${next.error}`), { code: 'MATERIAL_APPLY_INTERRUPTED', application: structuredClone(next) });
    }
  });
}

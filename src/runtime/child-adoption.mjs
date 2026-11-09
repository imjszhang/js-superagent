import { constants, openSync, closeSync, readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync, fstatSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateWorkspace, captureWorkspaceFiles, inspectWorkspace } from '../workspaces.mjs';
import { ensureProjectStateDirectory, projectStateDirectory } from '../state-paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const inPaths = (path, paths) => paths.some(prefix => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`));
function safePath(root, path, create = false) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || ['.git', '.js-superagent', '.env', 'node_modules'].includes(part) || part.startsWith('.env.'))) throw new Error('Unsafe adoption path');
  const target = join(root, path);
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try { const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) throw new Error('Unsafe adoption ancestor'); }
    catch (error) { if (error.code !== 'ENOENT' || !create) { if (error.code === 'ENOENT' && !create) break; throw error; } mkdirSync(current, { mode: 0o700 }); }
  }
  return target;
}
function contents(root, path, expected) {
  if (!expected) return null;
  if (expected.type !== 'file' || expected.size > 32 * 1024 * 1024) throw new Error('Adoption supports bounded regular files only');
  const file = safePath(root, path), fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode) throw new Error('Adoption file changed');
    const bytes = readFileSync(fd);
    if (hash(bytes) !== expected.sha256 || bytes.length !== expected.size) throw new Error('Adoption file changed');
    return bytes;
  } finally { closeSync(fd); }
}
function persistSync(persist, value) {
  const result = persist(structuredClone(value));
  if (result && typeof result.then === 'function') throw new Error('Adoption journal must be synchronous');
}
function recoveryDirectory(projectRoot, id, create = false) {
  if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid adoption recovery identity');
  let directory = create ? ensureProjectStateDirectory(realpathSync(projectRoot)) : projectStateDirectory(realpathSync(projectRoot));
  for (const part of ['adoptions', id]) {
    directory = join(directory, part);
    try { const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Unsafe adoption recovery directory'); }
    catch (error) { if (error.code !== 'ENOENT' || !create) throw error; mkdirSync(directory, { mode: 0o700 }); }
  }
  return directory;
}

/** A reviewable plan, valid only for the pinned child snapshot and unchanged delegated parent baseline. */
export function planChildAdoption({ projectRoot, parentWorkspace, childWorkspace, paths }) {
  const parent = validateWorkspace({ projectRoot, workspace: parentWorkspace });
  const child = validateWorkspace({ projectRoot, workspace: childWorkspace });
  if (child.mode !== 'copy' || child.snapshotOrigin !== 'parent-workspace' || child.sourceWorkspaceProvisionId !== (parent.provisionId ?? `in-place:${parent.projectRoot}`) || child.sourceWorkspacePath !== parent.path) throw new Error('Child was not created from this parent workspace snapshot');
  if (parent.mode === 'in-place') throw new Error('Child adoption requires an isolated parent workspace');
  const baseline = JSON.parse(readFileSync(child.manifestPath, 'utf8')).files;
  if (hash(JSON.stringify(baseline)) !== child.sourceSnapshotDigest) throw new Error('Child snapshot baseline does not match');
  const delegated = child.config.includePaths;
  if (!Array.isArray(paths) || !paths.length || paths.some(path => !inPaths(path, delegated))) throw new Error('Adoption paths exceed the child snapshot scope');
  const parentCurrent = captureWorkspaceFiles({ projectRoot, workspace: parent, paths: delegated });
  if (!same(parentCurrent.files, baseline)) throw new Error('Parent workspace changed since the child snapshot; inspect conflicts before adopting');
  const childCurrent = captureWorkspaceFiles({ projectRoot, workspace: child, paths: delegated });
  const changes = inspectWorkspace({ projectRoot, workspace: child }).changes;
  if (changes.some(change => !inPaths(change.path, paths))) throw new Error('Child changes exceed the allowed adoption paths');
  const entries = changes.map(change => {
    const before = baseline[change.path] ?? null, after = childCurrent.files[change.path] ?? null;
    if ((before && before.type !== 'file') || (after && after.type !== 'file')) throw new Error('Adoption refuses symlink or special-file changes');
    safePath(parent.path, change.path); safePath(child.path, change.path);
    return { path: change.path, status: change.status, before, after };
  });
  const facts = { version: 1, parentProvisionId: parent.provisionId, childProvisionId: child.provisionId, paths: [...paths], baselineDigest: child.sourceSnapshotDigest, childDigest: childCurrent.digest, changes: entries };
  return { ...facts, digest: hash(JSON.stringify(facts)) };
}

/** Trusted-host only. Journals intent and applied paths; callers fence the parent and invalidate verification. */
export function applyChildAdoption({ projectRoot, parentWorkspace, childWorkspace, plan, persist, invalidateVerification }) {
  if (typeof persist !== 'function' || typeof invalidateVerification !== 'function') throw new Error('Adoption requires journal and verification invalidation callbacks');
  const current = planChildAdoption({ projectRoot, parentWorkspace, childWorkspace, paths: plan?.paths });
  if (!plan || plan.digest !== current.digest || !same(plan, current)) throw new Error('Adoption plan changed; review the current diff');
  const parent = validateWorkspace({ projectRoot, workspace: parentWorkspace }), child = validateWorkspace({ projectRoot, workspace: childWorkspace });
  const prepared = current.changes.map(change => ({ ...change, previous: contents(parent.path, change.path, change.before), bytes: contents(child.path, change.path, change.after) }));
  const record = { version: 1, id: randomUUID(), kind: 'child-adoption', status: 'pending', createdAt: new Date().toISOString(), plan: current, appliedPaths: [], rollbackPaths: [], requiresVerification: true };
  const backup = recoveryDirectory(parent.projectRoot, record.id, true);
  for (const [index, change] of prepared.entries()) {
    if (change.previous) writeFileSync(join(backup, `${index}-before`), change.previous, { flag: 'wx', mode: 0o600 });
    if (change.bytes) writeFileSync(join(backup, `${index}-after`), change.bytes, { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(join(backup, 'plan.json'), JSON.stringify(current), { flag: 'wx', mode: 0o600 });
  record.recoveryDirectory = relative(parent.projectRoot, backup);
  persistSync(persist, record);
  const invalidated = invalidateVerification(structuredClone(record));
  if (invalidated && typeof invalidated.then === 'function') throw new Error('Adoption verification invalidation must be synchronous');
  function replace(change, bytes, info) {
    const file = safePath(parent.path, change.path, !!info);
    if (!info) { unlinkSync(file); return; }
    const temp = join(dirname(file), `.js-superagent-adopt-${randomUUID()}.tmp`);
    try { writeFileSync(temp, bytes, { flag: 'wx', mode: info.mode }); renameSync(temp, file); }
    finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  try {
    record.status = 'applying'; persistSync(persist, record);
    for (const change of prepared) {
      const actual = captureWorkspaceFiles({ projectRoot, workspace: parent, paths: [change.path] }).files[change.path] ?? null;
      if (!same(actual, change.before)) throw new Error(`Parent changed while applying ${change.path}`);
      replace(change, change.bytes, change.after); record.appliedPaths.push(change.path); persistSync(persist, record);
    }
    record.status = 'applied'; record.endedAt = new Date().toISOString();
    record.parentDigestAfter = captureWorkspaceFiles({ projectRoot, workspace: parent, paths: child.config.includePaths }).digest;
    persistSync(persist, record); return structuredClone(record);
  } catch (error) {
    record.status = 'interrupted'; record.error = String(error.message ?? error); record.endedAt = new Date().toISOString();
    // Do not overwrite a concurrent user's edit while restoring our own partial application.
    for (const path of [...record.appliedPaths].reverse()) {
      const change = prepared.find(item => item.path === path);
      try {
        const actual = captureWorkspaceFiles({ projectRoot, workspace: parent, paths: [path] }).files[path] ?? null;
        if (!same(actual, change.after)) continue;
        replace(change, change.previous, change.before); record.rollbackPaths.push(path);
      } catch { /* The journal names paths requiring explicit inspection. */ }
    }
    if (record.rollbackPaths.length === record.appliedPaths.length) record.status = 'rolled-back';
    try { persistSync(persist, record); } catch { /* The durable applying record remains the recovery boundary. */ }
    throw Object.assign(new Error(`Child adoption did not complete: ${record.error}`), { adoption: record });
  }
}

/** Explicit reconciliation after a process interruption; only expected before/after files are touched. */
export function recoverChildAdoption({ projectRoot, parentWorkspace, record, mode = 'rollback', persist, invalidateVerification }) {
  if (!['rollback', 'finish'].includes(mode) || !record || record.version !== 1 || record.kind !== 'child-adoption' || typeof persist !== 'function' || typeof invalidateVerification !== 'function') throw new Error('Invalid adoption recovery request');
  const parent = validateWorkspace({ projectRoot, workspace: parentWorkspace });
  if (parent.mode === 'in-place' || parent.provisionId !== record.plan?.parentProvisionId) throw new Error('Adoption recovery parent identity changed');
  const backup = recoveryDirectory(parent.projectRoot, record.id);
  if (record.recoveryDirectory !== relative(parent.projectRoot, backup)) throw new Error('Adoption recovery directory changed');
  const savedPlan = JSON.parse(readFileSync(join(backup, 'plan.json'), 'utf8'));
  if (!same(savedPlan, record.plan)) throw new Error('Adoption recovery plan changed');
  const prepared = savedPlan.changes.map((change, index) => {
    safePath(parent.path, change.path);
    const actual = captureWorkspaceFiles({ projectRoot, workspace: parent, paths: [change.path] }).files[change.path] ?? null;
    if (!same(actual, change.before) && !same(actual, change.after)) throw new Error('Adoption recovery conflicts with newer parent changes');
    const expected = mode === 'rollback' ? change.before : change.after;
    let bytes = null;
    if (expected) {
      const fd = openSync(join(backup, `${index}-${mode === 'rollback' ? 'before' : 'after'}`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size !== expected.size || stat.size > 32 * 1024 * 1024) throw new Error('Adoption recovery backup is invalid'); bytes = readFileSync(fd); if (hash(bytes) !== expected.sha256) throw new Error('Adoption recovery backup changed'); }
      finally { closeSync(fd); }
    }
    return { change, expected, bytes, actual };
  });
  const next = { ...structuredClone(record), status: 'recovering', recoveryMode: mode, recoveredPaths: [] };
  persistSync(persist, next);
  const invalidated = invalidateVerification(structuredClone(next));
  if (invalidated && typeof invalidated.then === 'function') throw new Error('Adoption verification invalidation must be synchronous');
  for (const { change, expected, bytes, actual } of prepared) {
    const fresh = captureWorkspaceFiles({ projectRoot, workspace: parent, paths: [change.path] }).files[change.path] ?? null;
    if (!same(actual, fresh)) throw new Error('Parent changed during adoption recovery');
    if (!same(fresh, expected)) {
      const file = safePath(parent.path, change.path, !!expected);
      if (!expected) unlinkSync(file);
      else { const temp = join(dirname(file), `.js-superagent-adopt-${randomUUID()}.tmp`); writeFileSync(temp, bytes, { flag: 'wx', mode: expected.mode }); renameSync(temp, file); }
    }
    next.recoveredPaths.push(change.path); persistSync(persist, next);
  }
  next.status = mode === 'rollback' ? 'rolled-back' : 'applied'; next.endedAt = new Date().toISOString(); persistSync(persist, next); return next;
}

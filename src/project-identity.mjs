import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ensureProjectStateDirectory, projectStateDirectory } from './state-paths.mjs';

export function coordinationError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}
const fail = (code, message, details) => { throw coordinationError(code, message, details); };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);
function safe(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 16384)) fail('PROJECT_IDENTITY_INVALID', 'Project identity must use regular local files');
  return stat;
}
function locations(projectRoot) {
  const root = realpathSync(projectRoot), directory = projectStateDirectory(root);
  if (existsSync(directory)) safe(directory, true);
  return { root, directory, path: join(directory, 'instance.json') };
}
function decode(path) {
  safe(path);
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('PROJECT_IDENTITY_INVALID', 'Project instance identity is invalid'); }
  if (value.schemaVersion !== 1 || !id(value.projectId) || !id(value.instanceId) || !id(value.stateId) || !id(value.projectRoot) || !value.projectRoot.startsWith('/') || !Number.isFinite(Date.parse(value.createdAt))) fail('PROJECT_IDENTITY_INVALID', 'Unsupported or malformed project instance identity');
  return value;
}
function validate(identity, root, projectId) {
  if (identity.projectId !== projectId) fail('PROJECT_IDENTITY_CONFLICT', 'Project configuration and local instance identity disagree; explicitly reinitialize or relocate this project', { expectedProjectId: identity.projectId });
  if (identity.projectRoot !== root) fail('PROJECT_RELOCATED', 'Project state was copied or moved; explicitly reinitialize as new or relocate the original project', { originalRoot: identity.projectRoot, currentRoot: root });
  return identity;
}
function legacyEvidence(directory, root, projectId) {
  for (const name of ['service/.owner.json', 'service/manifest.json']) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    safe(path);
    let old;
    try { old = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('PROJECT_IDENTITY_INVALID', 'Existing service ownership is invalid'); }
    if (old.projectRoot && resolve(old.projectRoot) !== root || old.projectId && old.projectId !== projectId) fail('PROJECT_RELOCATED', 'Existing service belongs to another project path or identity; use explicit relocation', { originalRoot: old.projectRoot });
  }
}
function publish(path, value, exclusive) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { if (exclusive) linkSync(temporary, path); else renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function ignoreIdentity(directory) {
  const path = join(directory, '.gitignore');
  let current = '';
  if (existsSync(path)) { safe(path); current = readFileSync(path, 'utf8'); }
  const existing = new Set(current.split(/\r?\n/));
  const missing = ['state.sqlite*', 'workspaces/', 'runs/', 'harness/', 'service/', 'instance.json', 'maintenance/'].filter(value => !existing.has(value));
  if (missing.length) writeFileSync(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, { mode: 0o600 });
}

/** Facts only. Missing local identity is not silently initialized by status/doctor. */
export function inspectProjectIdentity(projectRoot, projectId) {
  const { root, directory, path } = locations(projectRoot);
  if (!existsSync(path)) {
    try { legacyEvidence(directory, root, projectId); }
    catch (error) { if (error.code !== 'PROJECT_RELOCATED') throw error; return { initialized: false, projectRoot: root, projectId, matches: false, legacyState: existsSync(join(directory, 'state.sqlite')), conflict: { code: error.code, ...error.details } }; }
    return { initialized: false, projectRoot: root, projectId, matches: true, legacyState: existsSync(join(directory, 'state.sqlite')) };
  }
  const identity = decode(path);
  return { initialized: true, ...identity, matches: identity.projectRoot === root && identity.projectId === projectId, currentRoot: root };
}

export function assertLegacyProjectRoot(projectRoot, projectId) {
  const { root, directory } = locations(projectRoot);
  legacyEvidence(directory, root, projectId);
}

/** Bind local state to its machine registry so deletion cannot masquerade as a clean machine. */
export function bindProjectMachineIdentity(projectRoot, projectId, registryId) {
  if (!id(registryId)) throw new Error('A machine registry identity is required');
  const identity = assertProjectIdentity(projectRoot, projectId);
  if (identity.registryId && identity.registryId !== registryId) fail('MACHINE_REGISTRY_CHANGED', 'Project was registered with another machine registry; inspect stopped owners before repairing registration');
  if (identity.registryId) return identity;
  const next = { ...identity, registryId }; publish(locations(projectRoot).path, next, false); return next;
}

export function assertProjectIdentity(projectRoot, projectId) {
  const { root, path } = locations(projectRoot);
  if (!existsSync(path)) fail('PROJECT_IDENTITY_REQUIRED', 'Project instance is not initialized; initialize or explicitly adopt the stopped legacy project');
  return validate(decode(path), root, projectId);
}

/** Caller must verify legacy writers are stopped before explicitly adopting old state. */
export function ensureProjectIdentity(projectRoot, projectId, { adoptLegacy = false } = {}) {
  if (!id(projectId)) throw new Error('A projectId is required');
  const { root, directory, path } = locations(projectRoot);
  if (existsSync(path)) return validate(decode(path), root, projectId);
  legacyEvidence(directory, root, projectId);
  if (existsSync(join(directory, 'state.sqlite')) && !adoptLegacy) fail('PROJECT_IDENTITY_ADOPTION_REQUIRED', 'Existing state requires explicit stopped-project identity adoption');
  ensureProjectStateDirectory(root); safe(directory, true);
  const identity = { schemaVersion: 1, projectId, instanceId: randomUUID(), stateId: randomUUID(), projectRoot: root, createdAt: new Date().toISOString() };
  try { publish(path, identity, true); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return assertProjectIdentity(root, projectId); }
  ignoreIdentity(directory);
  return identity;
}

/** Only an explicit relocation transaction may change the remembered root. */
export function writeRelocatedProjectIdentity(projectRoot, identity, { fromRoot } = {}) {
  const { root, directory, path } = locations(projectRoot);
  if (!id(fromRoot) || identity?.projectRoot !== resolve(fromRoot) || identity.schemaVersion !== 1 || !id(identity.instanceId) || !id(identity.projectId) || !id(identity.stateId)) throw new Error('Relocation requires the original local identity and root');
  if (existsSync(path)) {
    const existing = decode(path);
    if (existing.instanceId !== identity.instanceId || existing.stateId !== identity.stateId || ![resolve(fromRoot), root].includes(existing.projectRoot)) fail('PROJECT_IDENTITY_CONFLICT', 'Destination contains another project instance');
  }
  ensureProjectStateDirectory(root); safe(directory, true);
  const next = { ...identity, projectRoot: root, relocatedAt: new Date().toISOString() };
  publish(path, next, false); ignoreIdentity(directory); return next;
}

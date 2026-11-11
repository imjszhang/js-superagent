import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertProjectIdentity } from './project-identity.mjs';
import { projectStateDirectory } from './state-paths.mjs';

const ID = /^[A-Za-z\d][A-Za-z\d._-]{0,119}$/;
const SHA = /^[a-f\d]{40}$/;
const DIGEST = /^[a-f\d]{64}$/;
const PRIVATE = new Set(['.git', '.js-superagent', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.ssh', '.aws', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519']);
export const MATERIAL_LIMITS = Object.freeze({ files: 20000, fileBytes: 32 * 1024 * 1024, snapshotBytes: 256 * 1024 * 1024, recordBytes: 2 * 1024 * 1024 });
export function materialError(code, message) { return Object.assign(new Error(message), { code }); }
const fail = (code, message) => { throw materialError(code, message); };
export const materialDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) fail('MATERIAL_FORMAT', `Invalid ${label}`);
}
function text(value, label, max = 1024) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail('MATERIAL_FORMAT', `Invalid ${label}`); return value; }
function identity(value, label) { object(value, ['source', 'id'], label); return { source: text(value.source, `${label}.source`, 80), id: text(value.id, `${label}.id`, 1024) }; }
function identities(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail('MATERIAL_FORMAT', `Invalid ${label}`);
  const records = value.map(item => identity(item, label));
  return [...new Map(records.map(item => [JSON.stringify(item), item])).values()];
}
export function materialRelativePath(value) {
  text(value, 'material path', 4096);
  if (value === '.') return value;
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[\\*?\[\]{}\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('MATERIAL_PATH', 'Material paths must be plain relative files or directories');
  return value;
}
function paths(value, label, empty = false) {
  if (!Array.isArray(value) || !empty && !value.length || value.length > 256) fail('MATERIAL_FORMAT', `Invalid ${label}`);
  return [...new Set(value.map(materialRelativePath))].sort();
}
function view(value) {
  object(value, ['kind', 'sha', 'snapshotId'], 'material view');
  if (value.kind === 'current' && Object.keys(value).length === 1) return { kind: 'current' };
  if (value.kind === 'commit' && SHA.test(value.sha ?? '') && Object.keys(value).length === 2) return { kind: 'commit', sha: value.sha };
  if (value.kind === 'snapshot' && ID.test(value.snapshotId ?? '') && Object.keys(value).length === 2) return { kind: 'snapshot', snapshotId: value.snapshotId };
  fail('MATERIAL_FORMAT', 'Material view must be current, an exact commit, or a host snapshot ID');
}
export function normalizeMaterialBinding(value) {
  object(value, ['version', 'access', 'sources', 'allowPreparation', 'allowApply', 'owner', 'workspaceSourceId'], 'material binding request');
  if (value.version !== undefined && value.version !== 1 || value.access !== undefined && !['host-only', 'native'].includes(value.access)) fail('MATERIAL_FORMAT', 'Unsupported material contract');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 32) fail('MATERIAL_FORMAT', 'Material sources must be a bounded nonempty list');
  const sources = value.sources.map(source => {
    object(source, ['id', 'view'], 'material source');
    if (!ID.test(source.id ?? '')) fail('MATERIAL_FORMAT', 'Invalid material source ID');
    return { id: source.id, view: view(source.view) };
  });
  if (new Set(sources.map(source => source.id)).size !== sources.length) fail('MATERIAL_FORMAT', 'Duplicate material sources');
  for (const key of ['allowPreparation', 'allowApply']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('MATERIAL_FORMAT', `Invalid ${key}`);
  if (value.workspaceSourceId !== undefined && (value.access !== 'native' || value.allowPreparation !== true || !sources.some(source => source.id === value.workspaceSourceId))) fail('MATERIAL_AUTHORITY', 'Initial material workspace requires a native preparation grant and a bound source');
  let owner;
  if (value.owner !== undefined) {
    object(value.owner, ['kind', 'id', 'contractHash'], 'material owner');
    if (!['operator', 'longrun'].includes(value.owner.kind) || value.owner.contractHash !== undefined && !DIGEST.test(value.owner.contractHash)) fail('MATERIAL_FORMAT', 'Invalid material contract owner');
    if (value.owner.kind === 'longrun' && !DIGEST.test(value.owner.contractHash ?? '')) fail('MATERIAL_FORMAT', 'Frozen task requires its contract hash');
    owner = { kind: value.owner.kind, ...(value.owner.id === undefined ? {} : { id: text(value.owner.id, 'owner.id') }), ...(value.owner.contractHash ? { contractHash: value.owner.contractHash } : {}) };
  }
  if (owner?.kind === 'longrun' && (value.allowApply || sources.some(source => source.view.kind === 'current'))) fail('MATERIAL_AUTHORITY', 'Frozen tasks cannot use live material or host-owned result application');
  return { version: 1, access: value.access ?? 'host-only', sources, allowPreparation: value.allowPreparation === true, allowApply: value.allowApply === true, ...(owner ? { owner } : {}), ...(value.workspaceSourceId === undefined ? {} : { workspaceSourceId: value.workspaceSourceId }) };
}
export function normalizeMaterialSettings(value = { entries: [] }) {
  object(value, ['version', 'revision', 'entries', 'defaults'], 'material settings');
  if (value.version !== undefined && value.version !== 1 || value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0) || !Array.isArray(value.entries) || value.entries.length > 32) fail('MATERIAL_FORMAT', 'Unsupported material settings');
  const entries = value.entries.map(item => {
    object(item, ['id', 'project', 'include', 'exclude', 'views', 'readers', 'destinations'], 'material entry');
    if (!ID.test(item.id ?? '')) fail('MATERIAL_FORMAT', 'Invalid material entry ID');
    let project = item.project;
    if (project !== 'self') {
      object(project, ['root', 'projectId', 'instanceId'], 'material project');
      if (!isAbsolute(text(project.root, 'project.root', 4096))) fail('MATERIAL_PATH', 'Configured project root must be absolute');
      project = { root: project.root, projectId: text(project.projectId, 'project.projectId', 200), instanceId: text(project.instanceId, 'project.instanceId', 200) };
    }
    if (!Array.isArray(item.views) || !item.views.length || item.views.some(kind => !['current', 'commit', 'snapshot'].includes(kind))) fail('MATERIAL_FORMAT', 'Invalid permitted material views');
    return { id: item.id, project, include: paths(item.include, 'include'), exclude: paths(item.exclude ?? [], 'exclude', true), views: [...new Set(item.views)].sort(), readers: identities(item.readers, 'readers'), destinations: identities(item.destinations, 'destinations') };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('MATERIAL_FORMAT', 'Duplicate material entries');
  const defaults = value.defaults == null ? undefined : normalizeMaterialBinding(value.defaults);
  if (defaults) for (const source of defaults.sources) if (!entries.some(entry => entry.id === source.id && entry.views.includes(source.view.kind))) fail('MATERIAL_FORMAT', 'Default material source is not configured');
  return { version: 1, entries, ...(defaults ? { defaults } : {}) };
}
function readIdentity(root, projectId) {
  const canonicalRoot = realpathSync(root);
  if (!projectId) {
    const path = join(projectStateDirectory(canonicalRoot), 'instance.json'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) fail('MATERIAL_IDENTITY', 'Material project identity is unsafe');
    projectId = JSON.parse(readFileSync(path, 'utf8')).projectId;
  }
  const current = assertProjectIdentity(canonicalRoot, projectId);
  return { root: canonicalRoot, projectId: current.projectId, instanceId: current.instanceId };
}
export function assertMaterialSourceIdentity(source) {
  const actual = readIdentity(source.project.root, source.project.projectId);
  if (materialDigest(actual) !== materialDigest(source.project)) fail('MATERIAL_IDENTITY', 'Material source identity changed');
  return true;
}
const matches = (a, b) => a.source === b.source && a.id === b.id;
export function assertMaterialDestination(binding, destination, sourceIds) {
  const target = identity(destination, 'destination');
  for (const source of binding.sources.filter(item => !sourceIds || sourceIds.includes(item.id))) if (!source.destinations.some(allowed => matches(allowed, target))) fail('MATERIAL_DESTINATION_DENIED', 'Material cannot be disclosed to this destination');
  return true;
}
export function resolveMaterialBinding({ projectRoot, projectId, settings, revision = settings?.revision ?? 0, request, actor, destinations = [] }) {
  const normalized = normalizeMaterialSettings(settings), input = normalizeMaterialBinding(request ?? normalized.defaults), principal = identity(actor, 'actor');
  const local = readIdentity(projectRoot, projectId);
  const sources = input.sources.map(source => {
    const entry = normalized.entries.find(item => item.id === source.id);
    if (!entry || !entry.views.includes(source.view.kind) || !entry.readers.some(reader => matches(reader, principal))) fail('MATERIAL_ACCESS_DENIED', 'Material source is not granted to this request');
    const project = entry.project === 'self' ? local : readIdentity(entry.project.root, entry.project.projectId);
    if (entry.project !== 'self' && project.instanceId !== entry.project.instanceId) fail('MATERIAL_IDENTITY', 'Material project identity changed');
    return { id: source.id, view: source.view, project, include: entry.include, exclude: entry.exclude, readers: entry.readers, destinations: entry.destinations };
  });
  const binding = { ...input, revision, configurationDigest: materialDigest(normalized), project: local, actor: principal, sources };
  for (const destination of destinations) assertMaterialDestination(binding, destination);
  return binding;
}
export function validateMaterialBinding({ binding, projectRoot = binding?.project?.root, projectId, settings, revision = settings?.revision ?? 0, actor = binding?.actor, destinations = [] }) {
  if (binding?.version !== 1 || !Array.isArray(binding.sources) || !binding.sources.length || !DIGEST.test(binding.configurationDigest ?? '')) fail('MATERIAL_FORMAT', 'Invalid saved material binding');
  const input = { version: 1, access: binding.access, sources: binding.sources.map(({ id, view }) => ({ id, view })), allowPreparation: binding.allowPreparation, allowApply: binding.allowApply, ...(binding.owner ? { owner: binding.owner } : {}), ...(binding.workspaceSourceId === undefined ? {} : { workspaceSourceId: binding.workspaceSourceId }) };
  const expected = resolveMaterialBinding({ projectRoot, projectId, settings, revision, request: input, actor, destinations });
  if (materialDigest(expected) !== materialDigest(binding)) fail('MATERIAL_BINDING_CHANGED', 'Material configuration, identity or authorization changed');
  return true;
}
export const verifyMaterialBinding = validateMaterialBinding;
function prefix(path, parent) { return parent === '.' || path === parent || path.startsWith(`${parent}/`); }
export function materialPathAllowed(source, path) {
  materialRelativePath(path);
  if (path.split('/').some(part => PRIVATE.has(part) || part === '.env' || part.startsWith('.env.'))) return false;
  return source.include.some(allowed => prefix(path, allowed)) && !source.exclude.some(excluded => prefix(path, excluded));
}
export function materialDirectoryAllowed(source, path) {
  materialRelativePath(path);
  if (path !== '.' && path.split('/').some(part => PRIVATE.has(part) || part === '.env' || part.startsWith('.env.')) || source.exclude.some(excluded => prefix(path, excluded))) return false;
  return source.include.some(allowed => prefix(path, allowed) || prefix(allowed, path));
}
function safeLocation(source, path, directory = false) {
  materialRelativePath(path);
  const root = realpathSync(source.project.root);
  if (root !== source.project.root) fail('MATERIAL_IDENTITY', 'Material root changed');
  let location = root;
  for (const part of path === '.' ? [] : path.split('/')) {
    location = join(location, part);
    const stat = lstatSync(location);
    if (stat.isSymbolicLink()) fail('MATERIAL_PATH', 'Material symlinks are not supported');
    if (location !== join(root, path) && !stat.isDirectory()) fail('MATERIAL_PATH', 'Invalid material directory');
  }
  const stat = lstatSync(location);
  if (relative(root, realpathSync(location)) !== (path === '.' ? '' : path) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('MATERIAL_PATH', 'Material must be a regular contained file or directory');
  return { location, stat };
}
export function readMaterialFile(source, path, maxBytes = MATERIAL_LIMITS.fileBytes) {
  if (!materialPathAllowed(source, path)) fail('MATERIAL_ACCESS_DENIED', 'Material file is outside the configured scope');
  const { location, stat } = safeLocation(source, path);
  if (stat.size > maxBytes) fail('MATERIAL_LIMIT', 'Material file exceeds the permitted size');
  const fd = openSync(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino || before.size > maxBytes) fail('MATERIAL_CHANGED', 'Material identity changed before reading');
    const bytes = readFileSync(fd), after = fstatSync(fd), current = safeLocation(source, path).stat;
    if (bytes.length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== current.dev || after.ino !== current.ino || current.isSymbolicLink() || current.nlink !== 1) fail('MATERIAL_CHANGED', 'Material changed while reading');
    return { bytes, sha256: materialDigest(bytes), mode: before.mode & 0o777, size: bytes.length };
  } finally { closeSync(fd); }
}
function git(source, args, maxBuffer = MATERIAL_LIMITS.fileBytes) {
  try { return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', source.project.root, ...args], { encoding: 'buffer', maxBuffer, timeout: 8000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { fail('MATERIAL_GIT', 'Material Git data is unavailable or exceeds its bound'); }
}
export function materialGitStatus(source) {
  let head = null;
  try { head = git(source, ['rev-parse', '--verify', 'HEAD'], 1024).toString().trim(); } catch { return { head, changes: [], available: false }; }
  if (!SHA.test(head)) fail('MATERIAL_GIT', 'Invalid material Git commit');
  const parts = git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 2 * 1024 * 1024).toString('utf8').split('\0'), changes = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]; if (!record) continue;
    const status = record.slice(0, 2), path = record.slice(3), previous = /[RC]/.test(status) ? parts[++i] : undefined;
    if (materialPathAllowed(source, path)) changes.push({ path, status, ...(previous && materialPathAllowed(source, previous) ? { previousPath: previous } : {}) });
    if (changes.length > MATERIAL_LIMITS.files) fail('MATERIAL_LIMIT', 'Material Git index is too large');
  }
  return { head, changes, available: true };
}
function commitEntries(source) {
  const resolved = git(source, ['rev-parse', '--verify', `${source.view.sha}^{commit}`], 1024).toString().trim();
  if (resolved !== source.view.sha) fail('MATERIAL_GIT', 'Material commit did not resolve to its pinned identity');
  const files = new Map();
  for (const raw of git(source, ['ls-tree', '-rz', '--full-tree', source.view.sha], 8 * 1024 * 1024).toString('utf8').split('\0')) {
    if (!raw) continue;
    const match = /^(\d{6}) (blob|commit) ([a-f\d]{40})\t([\s\S]+)$/.exec(raw);
    if (!match) fail('MATERIAL_GIT', 'Malformed material Git tree');
    const [, mode, kind, sha, path] = match;
    if (!materialPathAllowed(source, path)) continue;
    if (kind !== 'blob' || !['100644', '100755'].includes(mode)) continue;
    files.set(path, { sha, mode: mode === '100755' ? 0o755 : 0o644 });
    if (files.size > MATERIAL_LIMITS.files) fail('MATERIAL_LIMIT', 'Material Git tree is too large');
  }
  return files;
}
export function materialSnapshotDigest(snapshot) {
  return materialDigest({ version: snapshot.version, source: snapshot.source, include: snapshot.include, exclude: snapshot.exclude, files: snapshot.files });
}
export function validateMaterialSnapshot(snapshot, source) {
  if (snapshot?.version !== 1 || !snapshot.source || !snapshot.files || Array.isArray(snapshot.files) || !DIGEST.test(snapshot.digest ?? '') || snapshot.digest !== materialSnapshotDigest(snapshot)) fail('MATERIAL_SNAPSHOT', 'Material snapshot is missing or changed');
  object(snapshot.source, ['root', 'projectId', 'instanceId', 'entryId', 'view'], 'snapshot source');
  if (!isAbsolute(text(snapshot.source.root, 'snapshot source root', 4096)) || !ID.test(snapshot.source.entryId ?? '') || !Number.isFinite(Date.parse(snapshot.observedAt))) fail('MATERIAL_SNAPSHOT', 'Invalid material snapshot source');
  text(snapshot.source.projectId, 'snapshot project ID', 200); text(snapshot.source.instanceId, 'snapshot instance ID', 200); view(snapshot.source.view);
  paths(snapshot.include, 'snapshot include'); paths(snapshot.exclude, 'snapshot exclude', true);
  if (source && (snapshot.source.root !== source.project.root || snapshot.source.projectId !== source.project.projectId || snapshot.source.instanceId !== source.project.instanceId || snapshot.source.entryId !== source.id)) fail('MATERIAL_SNAPSHOT', 'Material snapshot belongs to another source');
  let total = 0;
  if (Object.keys(snapshot.files).length > MATERIAL_LIMITS.files) fail('MATERIAL_LIMIT', 'Material snapshot has too many files');
  for (const [path, file] of Object.entries(snapshot.files)) {
    materialRelativePath(path);
    if (path === '.') fail('MATERIAL_SNAPSHOT', 'Material snapshot cannot replace its root');
    if (source && !materialPathAllowed(source, path)) fail('MATERIAL_ACCESS_DENIED', 'Snapshot file is outside material scope');
    if (file?.encoding !== 'base64' || typeof file.content !== 'string' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MATERIAL_LIMITS.fileBytes || file.content.length > Math.ceil(MATERIAL_LIMITS.fileBytes / 3) * 4) fail('MATERIAL_SNAPSHOT', 'Malformed snapshot file');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.toString('base64') !== file.content || bytes.length !== file.size || materialDigest(bytes) !== file.sha256) fail('MATERIAL_SNAPSHOT', 'Snapshot file identity does not match');
    total += bytes.length; if (total > MATERIAL_LIMITS.snapshotBytes) fail('MATERIAL_LIMIT', 'Material snapshot exceeds its byte limit');
  }
  return snapshot;
}
function snapshotFor(source, snapshots) {
  if (typeof snapshots !== 'function') fail('MATERIAL_SNAPSHOT', 'No trusted material snapshot resolver is configured');
  return validateMaterialSnapshot(snapshots(source.view.snapshotId), source);
}
export function listMaterialDirectory(source, path = '.', snapshots) {
  if (!materialDirectoryAllowed(source, path)) fail('MATERIAL_ACCESS_DENIED', 'Material directory is outside the configured scope');
  const result = new Map();
  if (source.view.kind === 'current') {
    const { location } = safeLocation(source, path, true);
    const names = readdirSync(location).sort();
    if (names.length > MATERIAL_LIMITS.files) fail('MATERIAL_LIMIT', 'Material directory is too large');
    for (const name of names) {
      const child = path === '.' ? name : `${path}/${name}`;
      if (!materialDirectoryAllowed(source, child) && !materialPathAllowed(source, child)) continue;
      const stat = lstatSync(join(location, name));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) result.set(child, { path: child, kind: 'directory' });
      else if (stat.isFile() && stat.nlink === 1 && materialPathAllowed(source, child)) result.set(child, { path: child, kind: 'file', size: stat.size });
    }
  } else {
    const files = source.view.kind === 'commit' ? commitEntries(source) : new Map(Object.keys(snapshotFor(source, snapshots).files).map(key => [key, null]));
    const base = path === '.' ? '' : `${path}/`;
    for (const [file] of files) {
      if (!file.startsWith(base)) continue;
      const rest = file.slice(base.length), slash = rest.indexOf('/'), child = slash < 0 ? file : `${base}${rest.slice(0, slash)}`;
      if (materialDirectoryAllowed(source, child) || materialPathAllowed(source, child)) result.set(child, { path: child, kind: slash < 0 ? 'file' : 'directory' });
    }
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function readMaterialContent(source, path, snapshots) {
  if (!materialPathAllowed(source, path)) fail('MATERIAL_ACCESS_DENIED', 'Material file is outside the configured scope');
  if (source.view.kind === 'current') return readMaterialFile(source, path);
  if (source.view.kind === 'snapshot') {
    const file = snapshotFor(source, snapshots).files[path];
    if (!file) fail('MATERIAL_MISSING', 'Material snapshot file is missing');
    return { bytes: Buffer.from(file.content, 'base64'), sha256: file.sha256, mode: file.mode, size: file.size };
  }
  const entry = commitEntries(source).get(path);
  if (!entry) fail('MATERIAL_MISSING', 'Material commit file is missing');
  const bytes = git(source, ['cat-file', 'blob', entry.sha]);
  return { bytes, sha256: materialDigest(bytes), mode: entry.mode, size: bytes.length };
}
export function captureMaterialSnapshot(source, { snapshots, assertActive = () => {}, now = () => new Date().toISOString() } = {}) {
  assertMaterialSourceIdentity(source);
  if (source.view.kind === 'snapshot') {
    assertActive();
    // A frozen view retains its original source and digest through preparation.
    const snapshot = structuredClone(snapshotFor(source, snapshots));
    assertActive(); assertMaterialSourceIdentity(source);
    return snapshot;
  }
  const collect = () => {
    const files = Object.create(null), queue = ['.']; let total = 0, visits = 0;
    while (queue.length) {
      assertActive(); const directory = queue.shift();
      if (++visits > MATERIAL_LIMITS.files) fail('MATERIAL_LIMIT', 'Material snapshot directory budget exhausted');
      for (const item of listMaterialDirectory(source, directory, snapshots)) {
        if (item.kind === 'directory') { queue.push(item.path); continue; }
        const file = readMaterialContent(source, item.path, snapshots);
        total += file.size;
        if (total > MATERIAL_LIMITS.snapshotBytes || Object.keys(files).length >= MATERIAL_LIMITS.files) fail('MATERIAL_LIMIT', 'Material snapshot exceeds its budget');
        files[item.path] = { content: file.bytes.toString('base64'), encoding: 'base64', sha256: file.sha256, mode: file.mode, size: file.size };
      }
    }
    return files;
  };
  const files = collect(), second = collect();
  assertActive(); assertMaterialSourceIdentity(source);
  if (materialDigest(files) !== materialDigest(second)) fail('MATERIAL_CHANGED', 'Material changed while preparing its snapshot');
  const snapshot = { version: 1, source: { ...source.project, entryId: source.id, view: source.view }, files, include: source.include, exclude: source.exclude, observedAt: now() };
  return { ...snapshot, digest: materialSnapshotDigest(snapshot) };
}

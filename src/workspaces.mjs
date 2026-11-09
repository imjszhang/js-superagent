import {
  constants, lstatSync, realpathSync, mkdirSync, readdirSync, readFileSync,
  writeFileSync, renameSync, openSync, closeSync, readSync, writeSync, fstatSync, readlinkSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureProjectStateDirectory, projectStateDirectory } from './state-paths.mjs';

const MODES = new Set(['in-place', 'auto', 'copy', 'worktree']);
const IGNORED = new Set(['.git', '.js-superagent', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'coverage']);
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function normalizeConfig(value = { mode: 'in-place' }) {
  if (!value || typeof value !== 'object' || !MODES.has(value.mode)) throw new Error('Unsupported workspace mode');
  if (value.baseRef !== undefined) text(value.baseRef, 'workspace.baseRef');
  if (value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.some(path =>
    typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..')))) throw new Error('workspace.exclude must contain relative paths without dot segments');
  return { mode: value.mode, ...(value.baseRef === undefined ? {} : { baseRef: value.baseRef }), exclude: value.exclude ?? [] };
}
function canonicalProject(projectRoot) { return realpathSync(text(projectRoot, 'projectRoot')); }
function ensureDirectory(path) {
  if (exists(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`Workspace directory must not be a symlink or file: ${path}`);
  } else mkdirSync(path, { mode: 0o700 });
}
function generationOf(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error('Invalid workspace generation');
  return value;
}
function workspaceName(ticketId, generation = 0) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(ticketId ?? '')) throw new Error('Invalid workspace ticket ID');
  return generationOf(generation) ? `${ticketId}.g${generation}` : ticketId;
}
function layout(projectRoot, ticketId, create = false, generation = 0) {
  const name = workspaceName(ticketId, generation);
  const state = projectStateDirectory(projectRoot);
  if (create) ensureProjectStateDirectory(projectRoot);
  const root = join(state, 'workspaces');
  const records = join(root, '.records');
  for (const directory of [state, root, records]) {
    if (create) ensureDirectory(directory);
    else if (!exists(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(`Missing or unsafe workspace directory: ${directory}`);
  }
  if (create && !exists(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  return { path: join(root, name), record: join(records, `${name}.json`), manifest: join(records, `${name}.baseline.json`) };
}
function writeRecord(file, value) {
  if (exists(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error(`Unsafe workspace record: ${file}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
function git(cwd, args, allowFailure = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`Git workspace operation failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result;
}
function detectGit(projectRoot) {
  const result = git(projectRoot, ['rev-parse', '--show-toplevel'], true);
  if (result.status === 0) {
    const top = realpathSync(result.stdout.trim());
    return { top, nested: top !== projectRoot };
  }
  if (exists(join(projectRoot, '.git'))) throw new Error('Project has an unreadable or invalid .git entry; repair it before creating a workspace');
  if (result.error && result.error.code !== 'ENOENT') throw new Error(`Cannot inspect Git project: ${result.error.message}`);
  return null;
}
function regularRecord(path) {
  if (!exists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`Missing or unsafe workspace record: ${path}`);
  return json(path);
}
function sameIdentity(a, b) {
  return ['projectRoot', 'path', 'ticketId', 'mode', 'provisionId', 'baseCommit', 'branch', 'sourceWorkspaceProvisionId', 'generation', 'previousProvisionId', 'continuationId'].every(key => a[key] === b[key]);
}
function ownerMarker(path, workspace, create = false) {
  const dir = join(path, '.js-superagent'), marker = join(dir, 'workspace-owner.json');
  if (create) {
    ensureDirectory(dir);
    if (!exists(marker)) writeFileSync(marker, JSON.stringify({ provisionId: workspace.provisionId, ticketId: workspace.ticketId, projectRoot: workspace.projectRoot }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (!exists(dir) || lstatSync(dir).isSymbolicLink()) throw new Error('Workspace owner directory is missing or unsafe');
  const owner = regularRecord(marker);
  if (owner.provisionId !== workspace.provisionId || owner.ticketId !== workspace.ticketId || owner.projectRoot !== workspace.projectRoot) throw new Error('Workspace directory has a different owner');
}
function ignored(path, config) {
  const parts = path.split('/');
  return parts.some(part => IGNORED.has(part) || part === '.env' || part.startsWith('.env.')) ||
    config.exclude.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

// Reads without following file symlinks and stops before accepting oversized snapshots.
function readBounded(file, budget, copyTo) {
  const source = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destination;
  try {
    const stat = fstatSync(source);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || budget.bytes + stat.size > MAX_BYTES) throw new Error(`Workspace snapshot exceeds file/byte limits: ${file}`);
    if (++budget.files > MAX_FILES) throw new Error(`Workspace snapshot exceeds ${MAX_FILES} files`);
    if (copyTo) destination = openSync(copyTo, 'wx', stat.mode & 0o777);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size = 0, count;
    while ((count = readSync(source, buffer, 0, buffer.length, null))) {
      size += count; budget.bytes += count;
      if (size > MAX_FILE_BYTES || budget.bytes > MAX_BYTES) throw new Error(`Workspace snapshot changed or exceeded limits while reading: ${file}`);
      hash.update(buffer.subarray(0, count));
      if (destination !== undefined) {
        let written = 0;
        while (written < count) written += writeSync(destination, buffer, written, count - written);
      }
    }
    const after = fstatSync(source);
    if (stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || size !== stat.size) throw new Error('Workspace snapshot changed while reading');
    return { type: 'file', sha256: hash.digest('hex'), size, mode: stat.mode & 0o777 };
  } finally { closeSync(source); if (destination !== undefined) closeSync(destination); }
}
function snapshot(root, config, destination) {
  const files = Object.create(null), skipped = [], budget = { files: 0, bytes: 0 };
  const walk = (directory, prefix = '') => {
    if (realpathSync(directory) !== directory) throw new Error(`Snapshot directory changed into a symlink: ${directory}`);
    for (const entry of readdirSync(directory).sort()) {
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (config.includePaths && !config.includePaths.some(scope => scope === '.' || rel === scope || rel.startsWith(`${scope}/`) || scope.startsWith(`${rel}/`))) continue;
      if (ignored(rel, config)) { skipped.push({ path: rel, reason: 'excluded' }); continue; }
      const source = join(directory, entry), stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        if (destination) skipped.push({ path: rel, reason: 'symlink-not-copied' });
        else files[rel] = { type: 'symlink', target: readlinkSync(source) };
      } else if (stat.isDirectory()) {
        if (destination) mkdirSync(join(destination, rel), { mode: stat.mode & 0o777 });
        walk(source, rel);
      } else if (stat.isFile()) files[rel] = readBounded(source, budget, destination && join(destination, rel));
      else skipped.push({ path: rel, reason: 'special-file-not-copied' });
    }
  };
  walk(root);
  return { files, skipped, fileCount: budget.files, bytes: budget.bytes };
}
function gitIdentity(projectRoot, workspace) {
  const dotgit = join(workspace.path, '.git');
  if (!exists(dotgit) || lstatSync(dotgit).isSymbolicLink() || !lstatSync(dotgit).isFile()) throw new Error('Worktree .git link is missing or unsafe');
  const top = realpathSync(git(workspace.path, ['rev-parse', '--show-toplevel']).stdout.trim());
  const gitDir = realpathSync(resolve(workspace.path, git(workspace.path, ['rev-parse', '--git-dir']).stdout.trim()));
  const commonDir = realpathSync(resolve(workspace.path, git(workspace.path, ['rev-parse', '--git-common-dir']).stdout.trim()));
  const expectedCommon = realpathSync(resolve(projectRoot, git(projectRoot, ['rev-parse', '--git-common-dir']).stdout.trim()));
  const branch = git(workspace.path, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  if (top !== workspace.path || commonDir !== expectedCommon || branch !== workspace.branch || (workspace.gitDir && workspace.gitDir !== gitDir)) throw new Error('Worktree identity changed; refusing to reuse it');
  const backlink = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim();
  if (resolve(backlink) !== dotgit) throw new Error('Worktree registration points to another directory');
  if (git(workspace.path, ['merge-base', '--is-ancestor', workspace.baseCommit, 'HEAD'], true).status !== 0) throw new Error('Worktree HEAD no longer descends from the saved baseline');
  return { gitDir, commonDir };
}

/** Validate a saved ready workspace without creating or replacing anything. */
export function validateWorkspace({ projectRoot, workspace }) {
  const root = canonicalProject(projectRoot);
  if (!workspace || workspace.projectRoot !== root || workspace.state !== 'ready' || !['in-place', 'copy', 'worktree'].includes(workspace.mode)) throw new Error('Invalid or unfinished saved workspace');
  const generation = generationOf(workspace.generation);
  if (generation && (workspace.mode !== 'worktree' || !/^[a-f\d-]{36}$/.test(workspace.previousProvisionId ?? '') ||
      !/^[A-Za-z\d_-]{1,120}$/.test(workspace.continuationId ?? '') || workspace.branch !== `js-superagent-continuation/${workspace.ticketId}/g${generation}`)) throw new Error('Invalid continuation workspace identity');
  if (workspace.mode === 'in-place') {
    if (workspace.path !== root) throw new Error('In-place workspace points to another project');
    return structuredClone(workspace);
  }
  const paths = layout(root, workspace.ticketId, false, generation);
  if (workspace.path !== paths.path || !exists(paths.path) || lstatSync(paths.path).isSymbolicLink() || !lstatSync(paths.path).isDirectory() || realpathSync(paths.path) !== paths.path) throw new Error('Saved workspace is missing or unsafe; inspect it before retrying');
  const record = regularRecord(paths.record);
  if (!sameIdentity(workspace, record) || record.state !== 'ready') throw new Error('Saved workspace ownership record does not match');
  ownerMarker(workspace.path, workspace);
  if (workspace.mode === 'worktree') gitIdentity(root, workspace);
  else {
    if (workspace.manifestPath !== paths.manifest) throw new Error('Copy workspace manifest points outside its managed directory');
    regularRecord(paths.manifest);
    if (digest(readFileSync(paths.manifest)) !== workspace.manifestSha256) throw new Error('Copy workspace baseline manifest changed');
    if (exists(join(workspace.path, '.git'))) throw new Error('Copy workspace unexpectedly became a Git repository');
  }
  return structuredClone(workspace);
}

/** Provision one pinned workspace. persist must synchronously save each state transition. */
export function prepareWorkspace({ projectRoot, ticketId, config = { mode: 'in-place' }, existing, persist, sourceWorkspace, scopePaths,
  generation = existing?.generation ?? 0, previousProvisionId = existing?.previousProvisionId, continuationId = existing?.continuationId }) {
  const root = canonicalProject(projectRoot), settings = normalizeConfig(config);
  generationOf(generation);
  if (generation && (settings.mode !== 'worktree' || !/^[a-f\d-]{36}$/.test(previousProvisionId ?? '') ||
      !/^[A-Za-z\d_-]{1,120}$/.test(continuationId ?? ''))) throw new Error('Continuation workspace requires an explicit predecessor and identity');
  if (existing && (generationOf(existing.generation) !== generation || existing.previousProvisionId !== previousProvisionId || existing.continuationId !== continuationId)) throw new Error('Workspace generation changed; inspect its existing ownership');
  const source = sourceWorkspace ? validateWorkspace({ projectRoot: root, workspace: sourceWorkspace }) : null;
  if (source) {
    if (settings.mode !== 'copy') throw new Error('Parent snapshots require copy mode');
    if (!Array.isArray(scopePaths) || !scopePaths.length || scopePaths.length > 100 || scopePaths.some(path => typeof path !== 'string' || !path || isAbsolute(path) || /[\\\0]/.test(path) || path !== '.' && path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Parent snapshot requires bounded relative scope paths');
    settings.includePaths = [...new Set(scopePaths)];
    settings.exclude = [...new Set([...settings.exclude, ...(source.config?.exclude ?? [])])];
  } else if (scopePaths !== undefined) throw new Error('Snapshot scope requires a parent workspace');
  if (typeof persist !== 'function') throw new Error('Workspace provisioning requires a persistence callback');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(ticketId ?? '')) throw new Error('Invalid workspace ticket ID');
  if (existing?.state === 'ready') {
    if (existing.ticketId !== ticketId) throw new Error('Saved workspace belongs to another ticket');
    return validateWorkspace({ projectRoot: root, workspace: existing });
  }
  let workspace = existing;
  if (workspace && (workspace.state !== 'preparing' || workspace.projectRoot !== root || workspace.ticketId !== ticketId)) throw new Error('Invalid saved workspace provisioning state');
  if (!workspace) {
    let mode = settings.mode, fallbackReason;
    const repository = ['auto', 'worktree'].includes(mode) ? detectGit(root) : null;
    if (mode === 'auto') {
      mode = repository && !repository.nested ? 'worktree' : 'copy';
      if (repository?.nested) fallbackReason = 'nested-project';
    }
    if (mode === 'worktree' && (!repository || repository.nested)) throw new Error('Worktree mode requires the exact Git project root; use copy for a nested project or ordinary directory');
    workspace = { mode, path: mode === 'in-place' ? root : join(projectStateDirectory(root), 'workspaces', workspaceName(ticketId, generation)),
      projectRoot: root, ticketId, createdAt: new Date().toISOString(), state: 'preparing', provisionId: randomUUID(),
      config: settings, ...(fallbackReason ? { fallbackReason } : {}), ...(generation ? { generation, previousProvisionId, continuationId } : {}) };
    if (source) {
      workspace.sourceWorkspaceProvisionId = source.provisionId ?? `in-place:${root}`;
      workspace.sourceWorkspacePath = source.path;
      workspace.snapshotOrigin = 'parent-workspace';
    }
    if (mode === 'worktree') {
      const base = git(root, ['rev-parse', '--verify', '--end-of-options', `${settings.baseRef ?? 'HEAD'}^{commit}`], true);
      if (base.status !== 0) throw new Error('Git workspace needs an existing base commit; create an initial commit or explicitly select copy mode');
      workspace.baseCommit = base.stdout.trim(); workspace.branch = generation ? `js-superagent-continuation/${ticketId}/g${generation}` : `js-superagent/${ticketId}`;
      workspace.sourceDirty = !!git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).js-superagent']).stdout;
    }
    if (mode !== 'in-place') {
      // Pre-existing directories are never adopted merely because their name matches.
      if (exists(workspace.path)) throw new Error(`Workspace destination already exists: ${workspace.path}`);
      layout(root, ticketId, true, generation);
    }
    persist(structuredClone(workspace));
  }
  if (workspace.mode === 'in-place') {
    workspace = { ...workspace, state: 'ready' }; persist(structuredClone(workspace)); return workspace;
  }
  const paths = layout(root, ticketId, true, generation);
  if (workspace.path !== paths.path || !['copy', 'worktree'].includes(workspace.mode)) throw new Error('Unsafe workspace provisioning destination');
  if (exists(paths.record)) {
    const recorded = regularRecord(paths.record);
    if (!sameIdentity(workspace, recorded)) throw new Error('Workspace destination has a different owner');
    if (recorded.state === 'ready') {
      const recovered = validateWorkspace({ projectRoot: root, workspace: recorded });
      persist(recovered); return recovered;
    }
    if (recorded.prepared) {
      if (!sameIdentity(recorded.prepared, workspace) || recorded.prepared.state !== 'ready' ||
          !recorded.stagingPath?.startsWith(`${paths.path}.staging-`) || !/^[0-9a-f-]{36}$/.test(recorded.stagingPath.slice(`${paths.path}.staging-`.length))) throw new Error('Unsafe prepared workspace journal');
      if (exists(paths.path)) {
        if (exists(recorded.stagingPath)) throw new Error('Both staging and final workspace exist; inspect before retrying');
        ownerMarker(paths.path, workspace);
      } else {
        if (!exists(recorded.stagingPath) || lstatSync(recorded.stagingPath).isSymbolicLink() || realpathSync(recorded.stagingPath) !== recorded.stagingPath) throw new Error('Prepared workspace snapshot is missing or unsafe');
        ownerMarker(recorded.stagingPath, workspace);
        renameSync(recorded.stagingPath, paths.path);
      }
      writeRecord(paths.record, recorded.prepared);
      const recovered = validateWorkspace({ projectRoot: root, workspace: recorded.prepared });
      persist(recovered); return recovered;
    }
  } else {
    if (exists(paths.path)) throw new Error('Unowned workspace destination exists; refusing to overwrite');
    writeFileSync(paths.record, JSON.stringify(workspace, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (workspace.mode === 'worktree') {
    if (!exists(paths.path)) git(root, ['worktree', 'add', '--no-track', '-b', workspace.branch, '--', paths.path, workspace.baseCommit]);
    const identity = gitIdentity(root, workspace);
    ownerMarker(paths.path, workspace, true);
    workspace = { ...workspace, ...identity, state: 'ready' };
  } else {
    if (exists(paths.path)) throw new Error('Incomplete copy workspace requires inspection; completed ownership record is missing');
    // Each incomplete staging attempt is preserved; no pre-existing user files are removed.
    const staging = `${paths.path}.staging-${randomUUID()}`;
    mkdirSync(staging, { mode: 0o700 });
    if (workspace.sourceWorkspaceProvisionId && (!source || workspace.sourceWorkspaceProvisionId !== (source.provisionId ?? `in-place:${root}`) || workspace.sourceWorkspacePath !== source.path)) throw new Error('Parent snapshot recovery requires the same owned source workspace');
    const snapshotRoot = source?.path ?? root;
    const captured = snapshot(snapshotRoot, workspace.config, staging);
    if (source) {
      validateWorkspace({ projectRoot: root, workspace: source });
      const after = snapshot(snapshotRoot, workspace.config);
      const regular = Object.fromEntries(Object.entries(after.files).filter(([, info]) => info.type === 'file'));
      if (JSON.stringify(captured.files) !== JSON.stringify(regular)) throw new Error('Parent workspace changed during child snapshot; inspect the preserved staging copy');
      workspace.sourceSnapshotDigest = digest(JSON.stringify(captured.files));
    }
    const manifest = { version: 1, files: captured.files, skipped: captured.skipped };
    writeRecord(paths.manifest, manifest);
    workspace = { ...workspace, manifestPath: paths.manifest, manifestSha256: digest(readFileSync(paths.manifest)),
      excludedPaths: captured.skipped, snapshotFiles: captured.fileCount, snapshotBytes: captured.bytes, state: 'ready' };
    ownerMarker(staging, workspace, true);
    // Save the completed snapshot before the atomic publish. Recovery can finish either side of rename.
    writeRecord(paths.record, { ...workspace, state: 'preparing', stagingPath: staging, prepared: workspace });
    renameSync(staging, paths.path);
  }
  writeRecord(paths.record, workspace);
  persist(structuredClone(workspace));
  return structuredClone(workspace);
}

/** Read-only preflight. Committed old changes are history; uncommitted work is never discarded. */
export function inspectContinuationWorkspace({ projectRoot, workspace, expectedHead } = {}) {
  let saved;
  try { saved = validateWorkspace({ projectRoot, workspace }); }
  catch (error) { return { version: 1, status: 'inspection', reason: 'previous-workspace-invalid', detail: error.message }; }
  if (saved.mode !== 'worktree') return { version: 1, status: 'inspection', reason: 'continuation-requires-worktree' };
  const headSha = git(saved.path, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
  if (expectedHead !== undefined && (!/^[a-f\d]{40}$/.test(expectedHead) || expectedHead !== headSha)) return { version: 1, status: 'inspection', reason: 'previous-workspace-head-changed', headSha };
  const dirty = !!git(saved.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).js-superagent']).stdout;
  return { version: 1, status: dirty ? 'inspection' : 'ready', reason: dirty ? 'previous-workspace-dirty' : null,
    ticketId: saved.ticketId, provisionId: saved.provisionId, generation: generationOf(saved.generation), headSha };
}

/** Host supplies a verified commit, never a model-selected ref. Existing generations remain untouched. */
export function prepareContinuationWorkspace({ projectRoot, ticketId, previousWorkspace, baseCommit, generation,
  continuationId, existing, persist, config = { mode: 'worktree' }, expectedPreviousHead }) {
  if (!/^[a-f\d]{40}$/.test(baseCommit ?? '') || previousWorkspace?.ticketId !== ticketId ||
      generationOf(generation) !== generationOf(previousWorkspace?.generation) + 1) throw new Error('Invalid pinned continuation target');
  const inspected = inspectContinuationWorkspace({ projectRoot, workspace: previousWorkspace, expectedHead: expectedPreviousHead });
  if (inspected.status !== 'ready') throw Object.assign(new Error(`Continuation requires inspection: ${inspected.reason}`), { continuationReason: inspected.reason });
  const root = canonicalProject(projectRoot);
  if (git(root, ['cat-file', '-e', `${baseCommit}^{commit}`], true).status !== 0) throw new Error('Pinned continuation commit is not available locally');
  if (existing && (existing.baseCommit !== baseCommit || existing.previousProvisionId !== previousWorkspace.provisionId ||
      existing.continuationId !== continuationId || existing.generation !== generation)) throw new Error('Continuation target changed after preparation');
  return prepareWorkspace({ projectRoot: root, ticketId, config: { ...config, mode: 'worktree', baseRef: baseCommit }, existing,
    generation, previousProvisionId: previousWorkspace.provisionId, continuationId, persist });
}

/** A child receives a bounded snapshot of its parent's current files, including uncommitted changes. */
export function prepareChildWorkspaceSnapshot({ projectRoot, ticketId, parentWorkspace, paths, existing, persist }) {
  return prepareWorkspace({ projectRoot, ticketId, config: { mode: 'copy' }, sourceWorkspace: parentWorkspace, scopePaths: paths, existing, persist });
}

/** Read-only bounded regular-file snapshot used for trusted adoption planning. */
export function captureWorkspaceFiles({ projectRoot, workspace, paths }) {
  const saved = validateWorkspace({ projectRoot, workspace });
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(path => typeof path !== 'string' || !path || isAbsolute(path) || /[\\\0]/.test(path) || path !== '.' && path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Workspace capture requires bounded relative paths');
  const captured = snapshot(saved.path, { ...saved.config, exclude: saved.config?.exclude ?? [], includePaths: paths });
  return { ...captured, digest: digest(JSON.stringify(captured.files)) };
}

/** Read-only change summary against the pinned baseline, independent of later source edits. */
export function inspectWorkspace({ projectRoot, workspace }) {
  const saved = validateWorkspace({ projectRoot, workspace });
  if (saved.mode === 'in-place') return { workspace: saved, isolation: false, changes: [], limitation: 'In-place execution has no isolated baseline; inspect the project directly.' };
  const changes = [];
  if (saved.mode === 'worktree') {
    const tokens = git(saved.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', saved.baseCommit, '--']).stdout.split('\0').filter(Boolean);
    for (let i = 0; i < tokens.length; i += 2) changes.push({ path: tokens[i + 1], status: ({ A: 'added', D: 'deleted', T: 'type-changed' })[tokens[i]] ?? 'modified' });
    for (const path of git(saved.path, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean)) {
      if (!path.startsWith('.js-superagent/')) changes.push({ path, status: 'added' });
    }
  } else {
    const before = json(saved.manifestPath).files, after = snapshot(saved.path, { ...saved.config, includePaths: undefined }).files;
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(before, path)) changes.push({ path, status: 'added' });
      else if (!Object.hasOwn(after, path)) changes.push({ path, status: 'deleted' });
      else if (JSON.stringify(before[path]) !== JSON.stringify(after[path])) changes.push({ path, status: before[path].type !== after[path].type ? 'type-changed' : 'modified' });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { workspace: saved, isolation: true, changes };
}

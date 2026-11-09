import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const LEGACY_STATE_NAME = '.js-superagent';
const MAX_KEY = 200;

function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function canonical(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || projectRoot.includes('\0')) throw new Error('projectRoot must be non-empty text');
  return realAncestor(projectRoot);
}

// Workspace and worktree checks compare saved paths with realpath results, so symlinked
// ancestors (macOS /var -> /private/var) must already be resolved here.
function realAncestor(path) {
  let ancestor = resolve(path); const missing = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
}

/** Per-user root for all project state. Projects keep nothing of js-superagent inside their own directory. */
export function stateHome(env = process.env) {
  const value = env.JS_SUPERAGENT_HOME;
  if (value === undefined || value === '') return realAncestor(join(homedir(), LEGACY_STATE_NAME));
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('JS_SUPERAGENT_HOME must be an absolute path');
  return realAncestor(value);
}

/** Like Claude Code's ~/.claude/projects: the real path with every non-alphanumeric character replaced by "-". */
export function projectStateKey(projectRoot) {
  const root = canonical(projectRoot), key = root.replace(/[^A-Za-z0-9]/g, '-');
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 17)}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
}

export function projectStateDirectory(projectRoot, env = process.env) {
  return join(stateHome(env), 'projects', projectStateKey(projectRoot));
}

export function legacyStateDirectory(projectRoot) {
  return join(canonical(projectRoot), LEGACY_STATE_NAME);
}

/** Old releases kept state in <project>/.js-superagent. A workspace owner marker alone is not project state. */
export function hasLegacyState(projectRoot) {
  const legacy = legacyStateDirectory(projectRoot);
  return exists(join(legacy, 'config.json')) || exists(join(legacy, 'state.sqlite'));
}

/** Refuse to start fresh state beside unmigrated state; the old tickets would silently disappear. */
export function assertStateMigrated(projectRoot) {
  if (!hasLegacyState(projectRoot)) return;
  const code = exists(join(projectStateDirectory(projectRoot), 'config.json')) ? 'PROJECT_STATE_CONFLICT' : 'PROJECT_STATE_MIGRATION_REQUIRED';
  const message = code === 'PROJECT_STATE_CONFLICT'
    ? `Project state exists both in ${legacyStateDirectory(projectRoot)} and ${projectStateDirectory(projectRoot)}; inspect and remove one copy`
    : `Project state is still in ${legacyStateDirectory(projectRoot)}; stop the project and run: js-superagent project migrate-state --plan`;
  throw Object.assign(new Error(message), { code });
}

/** Creates the private per-project directory (and its per-user parents) as real directories. */
export function ensureProjectStateDirectory(projectRoot, env = process.env) {
  const directory = projectStateDirectory(projectRoot, env);
  mkdirSync(join(stateHome(env), 'projects'), { recursive: true, mode: 0o700 });
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project state directory must be a real directory, not a symlink');
  return directory;
}

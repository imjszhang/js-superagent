import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectStateDirectory } from '../state-paths.mjs';

const THREAD = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const HOME_ID = /^js-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function directory(path) {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex session home must use real directories');
  return path;
}

/** The account directory supplies login only. It is never the store for a new thread. */
export function codexAccountHome(env = process.env) {
  return typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME : join(homedir(), '.codex');
}

// Login and settings stay in the account directory; the private home only points at them.
const ACCOUNT_FILES = ['auth.json', 'config.toml'];

function linkAccountFiles(accountHome, sessionHome) {
  for (const name of ACCOUNT_FILES) {
    const source = join(accountHome, name);
    let current;
    try { current = lstatSync(source); } catch { continue; }
    if (!current.isFile() && !current.isSymbolicLink()) continue;
    const target = join(sessionHome, name);
    try {
      const existing = lstatSync(target);
      if (existing.isSymbolicLink() && readlinkSync(target) === source) continue;
      throw new Error(`Codex session home already has a different ${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    symlinkSync(source, target);
  }
}

function layout(sourceRoot) {
  const root = directory(join(projectStateDirectory(sourceRoot), 'harness', 'codex-app-server'));
  return { threads: directory(join(root, 'threads')), homes: directory(join(root, 'homes')) };
}

function readBinding(threads, threadId) {
  if (!THREAD.test(threadId ?? '')) throw new Error('Invalid Codex session');
  let saved;
  try { saved = JSON.parse(readFileSync(join(threads, `${threadId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (saved?.version !== 1 || !HOME_ID.test(saved.homeId ?? '')) throw new Error('Invalid Codex session home');
  return saved.homeId;
}

/**
 * New threads get a private CODEX_HOME in the project state directory. Login and settings stay symlinks to
 * the account files, so their contents are not copied. An older thread with no project
 * binding keeps the account home so an existing session can still resume.
 */
export function codexSessionHome({ sourceRoot, sessionId, env = process.env } = {}) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('Codex session home requires its project root');
  const { threads, homes } = layout(realpathSync(sourceRoot));
  const existing = sessionId ? readBinding(threads, sessionId) : null;
  if (sessionId && !existing) return null;
  const homeId = existing ?? `js-${randomUUID()}`;
  const path = directory(join(homes, homeId));
  linkAccountFiles(codexAccountHome(env), path);
  return {
    path, homeId,
    bind(threadId) {
      if (existing) return;
      if (!THREAD.test(threadId ?? '')) throw new Error('Invalid Codex session');
      const file = join(threads, `${threadId}.json`);
      const body = JSON.stringify({ version: 1, homeId }) + '\n';
      try { writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (readBinding(threads, threadId) !== homeId) throw new Error('Codex session is bound to a different home');
      }
    },
  };
}

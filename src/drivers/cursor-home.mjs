import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectStateDirectory } from '../state-paths.mjs';

const CHAT = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const HOME_ID = /^js-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export const isCursorChatId = value => CHAT.test(value ?? '');

function directory(path) {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cursor session home must use real directories');
  return path;
}
function layout(sourceRoot) {
  const root = directory(join(projectStateDirectory(sourceRoot), 'harness', 'cursor-agent'));
  return { sessions: directory(join(root, 'sessions')), homes: directory(join(root, 'homes')) };
}
// macOS keeps the CLI login in the user keychain; nothing else from the account home is shared.
function linkKeychain(home, accountHome) {
  const library = directory(join(home, 'Library')), target = join(library, 'Keychains'), source = join(accountHome, 'Library', 'Keychains');
  try {
    const existing = lstatSync(target);
    if (existing.isSymbolicLink() && readlinkSync(target) === source) return;
    throw new Error('Cursor session home already has a different keychain link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  symlinkSync(source, target);
}
/** Cursor stores chats under md5(realpath(workspace)); a chat id from another workspace resumes as an empty chat. */
export function cursorChatPath(home, workspace, chatId) {
  return join(home, '.cursor', 'chats', createHash('md5').update(realpathSync(workspace)).digest('hex'), chatId, 'store.db');
}
export function cursorChatExists(home, workspace, chatId) {
  try { const stat = lstatSync(cursorChatPath(home, workspace, chatId)); return stat.isFile() && !stat.isSymbolicLink(); }
  catch { return false; }
}
function readBinding(sessions, namespace, chatId) {
  if (!CHAT.test(chatId ?? '')) throw new Error('Invalid Cursor session');
  let saved;
  try { saved = JSON.parse(readFileSync(join(sessions, `${namespace}-${chatId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (saved?.version !== 1 || !HOME_ID.test(saved.homeId ?? '') || typeof saved.workspace !== 'string' || !['api-key', 'keychain'].includes(saved.auth)) throw new Error('Invalid Cursor session binding');
  return saved;
}
/** Each chat owns a private HOME. Only the login source differs between API-key and keychain sessions. */
export function cursorSessionHome({ sourceRoot, namespace, sessionId, workspace, auth, nativeVersion, accountHome = homedir() } = {}) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) throw new Error('Cursor session home requires its project root');
  if (!['api-key', 'keychain'].includes(auth)) throw new Error('Invalid Cursor authentication mode');
  const { sessions, homes } = layout(realpathSync(sourceRoot)), cwd = realpathSync(workspace);
  const existing = sessionId ? readBinding(sessions, namespace, sessionId) : null;
  if (sessionId && !existing) throw new Error('Cursor session binding is missing; explicit replacement is required');
  if (existing && existing.workspace !== cwd) throw new Error('Cursor session belongs to another workspace; explicitly replace the session');
  if (existing && existing.auth !== auth) throw new Error('Cursor session was created with another login; explicitly replace the session');
  if (existing && existing.nativeVersion !== nativeVersion) throw new Error(`Cursor session configuration changed: native version ${existing.nativeVersion} → ${nativeVersion}; explicitly replace the session`);
  const homeId = existing?.homeId ?? `js-${randomUUID()}`;
  const path = directory(join(homes, homeId));
  if (auth === 'keychain') linkKeychain(path, accountHome);
  if (existing && !cursorChatExists(path, cwd, sessionId)) throw new Error('Cursor chat history is missing for this workspace; explicitly replace the session');
  return {
    path, homeId,
    bind(chatId) {
      if (existing) { if (chatId !== sessionId) throw new Error('Cursor resumed a different chat'); return; }
      if (!CHAT.test(chatId ?? '')) throw new Error('Invalid Cursor session');
      const body = JSON.stringify({ version: 1, homeId, workspace: cwd, auth, nativeVersion }) + '\n';
      try { writeFileSync(join(sessions, `${namespace}-${chatId}.json`), body, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (readBinding(sessions, namespace, chatId)?.homeId !== homeId) throw new Error('Cursor session is bound to a different home');
      }
    },
  };
}

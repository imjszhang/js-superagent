import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWorkspace } from './workspaces.mjs';
import { PosixProcessTree } from './drivers/posix-process-tree.mjs';
import { ensureProjectStateDirectory } from './state-paths.mjs';

const supervisorFile = fileURLToPath(new URL('./drivers/codex-supervisor.mjs', import.meta.url));
const EXCLUDED = new Set(['.git', '.js-superagent', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'coverage']);
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 50_000;
const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function relativePath(value, name, dot = false) {
  if (dot && value === '.') return value;
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\\0]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${name} must be a relative path without dot segments`);
  return value;
}
function within(root, path) { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); }
function save(persist, value) {
  const result = persist(structuredClone(value));
  if (result && typeof result.then === 'function') throw new Error('Verification persistence must be synchronous');
}

/** Profiles come only from trusted project configuration, never from a Worker report. */
export function normalizeVerificationProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'version', 'kind', 'command', 'args', 'cwd', 'timeoutMs', 'environment', 'allowHostExecution', 'env', 'maxLogBytes', 'paths'].includes(key))) throw new Error('Invalid verification profile');
  const id = text(value.id, 'profile.id');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid verification profile ID');
  const version = text(value.version, 'profile.version');
  if (!['verify', 'prepare'].includes(value.kind ?? 'verify')) throw new Error('Verification kind must be verify or prepare');
  const command = text(value.command, 'profile.command');
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('Verification args must be an array of strings');
  const timeoutMs = value.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 3_600_000) throw new Error('Verification timeout must be between 10 ms and one hour');
  const maxLogBytes = value.maxLogBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1024 || maxLogBytes > 16 * 1024 * 1024) throw new Error('Verification log limit must be between 1 KiB and 16 MiB');
  // A managed host process has real host permissions. This flag is not a sandbox claim.
  if (value.environment !== 'host' || value.allowHostExecution !== true) throw new Error('Verification environment unavailable: host execution requires explicit allowHostExecution');
  const env = value.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== 'string' || val.includes('\0'))) throw new Error('Invalid verification environment');
  const paths = value.paths ?? ['.'];
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw new Error('Verification paths must be a non-empty bounded list');
  paths.forEach(path => relativePath(path, 'profile.paths', true));
  return { paths: [...new Set(paths)], id, version, kind: value.kind ?? 'verify', command, args: [...(value.args ?? [])], cwd: relativePath(value.cwd ?? '.', 'profile.cwd', true), timeoutMs, environment: 'host', allowHostExecution: true, env: { ...env }, maxLogBytes };
}

/** A bounded content fingerprint, including file modes and symlink targets without following links. */
export function captureVerificationTree({ projectRoot, workspace, paths = ['.'] }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw new Error('Verification paths must be a non-empty bounded list');
  paths.forEach(path => relativePath(path, 'verification paths', true));
  const saved = validateWorkspace({ projectRoot, workspace });
  const root = saved.path, files = [], excluded = saved.config?.exclude ?? [];
  let bytes = 0;
  function walk(directory, prefix = '') {
    if (realpathSync(directory) !== directory) throw new Error('Verification directory became a symlink');
    for (const entry of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${entry}` : entry;
      if (!paths.some(scope => scope === '.' || path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`))) continue;
      if (EXCLUDED.has(entry) || excluded.some(item => path === item || path.startsWith(`${item}/`))) continue;
      const full = join(directory, entry), stat = lstatSync(full);
      if (stat.isDirectory()) { walk(full, path); continue; }
      if (files.length >= MAX_FILES) throw new Error('Verification tree exceeds file limit');
      if (stat.isSymbolicLink()) { files.push({ path, type: 'symlink', target: readlinkSync(full) }); continue; }
      if (!stat.isFile()) throw new Error(`Verification tree contains unsupported special file: ${path}`);
      const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size > MAX_BYTES - bytes) throw new Error('Verification tree exceeds byte limit');
        const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let count, size = 0;
        while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
          bytes += count; size += count;
          if (bytes > MAX_BYTES) throw new Error('Verification tree exceeds byte limit');
          digest.update(buffer.subarray(0, count));
        }
        const after = fstatSync(fd);
        if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== before.size) throw new Error('Verification tree changed while capturing');
        files.push({ path, type: 'file', sha256: digest.digest('hex'), size, mode: before.mode & 0o777 });
      } finally { closeSync(fd); }
    }
  }
  walk(root);
  return { algorithm: 'sha256', paths: [...paths], digest: hash(JSON.stringify(files)), files: files.length, bytes, exclusions: [...EXCLUDED, ...excluded] };
}

export function verificationMatches({ projectRoot, workspace, verification }) {
  return verification?.version === 1 && verification.kind === 'verify' && verification.status === 'passed' &&
    verification.workspaceProvisionId === workspace?.provisionId && HASH.test(verification.treeAfter?.digest ?? '') &&
    verification.treeBefore?.digest === verification.treeAfter.digest && captureVerificationTree({ projectRoot, workspace, paths: verification.treeAfter.paths }).digest === verification.treeAfter.digest;
}

/** Capture durable intent before spawning. Interrupted verification is inspected/re-run explicitly. */
export async function runVerification({ projectRoot, workspace, profile, signal, persist, verificationId = randomUUID(), onControl }) {
  if (typeof persist !== 'function') throw new Error('Verification requires a synchronous persistence callback');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(verificationId)) throw new Error('Invalid verification ID');
  const settings = normalizeVerificationProfile(profile), saved = validateWorkspace({ projectRoot, workspace });
  if (process.platform === 'win32') throw new Error('Verification environment unavailable: process supervision has not been validated on Windows');
  const cwd = realpathSync(resolve(saved.path, settings.cwd));
  if (!within(saved.path, cwd)) throw new Error('Verification cwd must stay inside its owned workspace');
  const command = settings.command.includes('/') ? realpathSync(resolve(cwd, settings.command)) : settings.command;
  const state = ensureProjectStateDirectory(realpathSync(projectRoot));
  for (const dir of [state, join(state, 'verifications')]) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe verification record directory');
  }
  const dir = join(state, 'verifications', verificationId);
  mkdirSync(dir, { mode: 0o700 });
  const record = { version: 1, id: verificationId, kind: settings.kind, profileId: settings.id, profileVersion: settings.version,
    profileDigest: hash(JSON.stringify(settings)), workspaceProvisionId: saved.provisionId, ticketId: saved.ticketId,
    environment: 'host', isolation: false, status: 'pending', command: settings.command, args: settings.args, cwd: settings.cwd,
    startedAt: now(), treeBefore: captureVerificationTree({ projectRoot, workspace: saved, paths: settings.paths }),
    logs: { stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log') } };
  save(persist, record);
  if (signal?.aborted) { record.status = 'cancelled'; record.endedAt = now(); save(persist, record); return record; }
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, settings.env);
  const fds = { stdout: openSync(join(dir, 'stdout.log'), 'wx', 0o600), stderr: openSync(join(dir, 'stderr.log'), 'wx', 0o600) };
  const counts = { stdout: 0, stderr: 0 }; let child, tree, timer, scanner, cleanup, timedOut = false, cancelled = false, failure, persistenceError, outcome;
  const abortSupervisor = reason => { if (child?.connected) child.send({ type: 'abort', reason }, () => {}); };
  const abort = () => { cancelled = true; abortSupervisor('verification cancelled'); };
  try {
    // IPC disconnect makes the already durable supervisor clean up commands when its host dies.
    child = spawn(process.execPath, [supervisorFile], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => {
      try {
        const remaining = settings.maxLogBytes - counts[key];
        if (remaining > 0) writeSync(fds[key], chunk.subarray(0, remaining));
        counts[key] += chunk.length;
      } catch { failure ??= 'Cannot save verification output'; abortSupervisor(failure); }
    });
    const done = new Promise(resolveDone => {
      child.on('error', error => { failure = `Cannot start verification supervisor (${error.code ?? 'spawn error'})`; });
      child.on('close', (code, exitSignal) => resolveDone({ code, signal: exitSignal }));
    });
    child.on('message', message => {
      if (message.type === 'result') { outcome = message; return; }
      if (message.type === 'child') {
        if (!Number.isSafeInteger(message.pid) || message.pid <= 1) { failure = 'Invalid verifier process identity'; abortSupervisor(failure); return; }
        tree = new PosixProcessTree(message.pid);
        try { record.childPid = message.pid; save(persist, record); }
        catch (error) { persistenceError = error; abortSupervisor('verification persistence failed'); return; }
        if (child.connected) child.send({ type: 'ack-child' }, () => {});
      }
    });
    try { record.status = 'running'; record.pid = child.pid ?? null; save(persist, record); }
    catch (error) { persistenceError = error; abortSupervisor('verification persistence failed'); await done; throw error; }
    scanner = setInterval(() => tree?.scan(), 100);
    const setDeadline = deadline => {
      if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 2 * 60 * 60 * 1000 ||
          cancelled || timedOut || outcome || !child.connected) throw new Error('Verification deadline cannot be changed after its owner settled');
      const previousDeadline = record.deadlineAt;
      record.deadlineAt = new Date(deadline).toISOString();
      try { save(persist, record); } catch (error) { record.deadlineAt = previousDeadline; throw error; }
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; abortSupervisor('verification timed out'); }, Math.max(1, deadline - Date.now()));
    };
    setDeadline(Date.now() + settings.timeoutMs);
    if (onControl) {
      const result = onControl(Object.freeze({ setDeadline }));
      if (result?.then) throw new Error('Verification control registration must be synchronous');
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else if (child.connected) child.send({ type: 'start', executable: command, args: settings.args, cwd, prompt: '', killGraceMs: 100 }, error => { if (error) failure = 'Cannot start verification command'; });
    const result = await done;
    if (tree) { cleanup = tree.stop(100); await cleanup; }
    if (persistenceError) throw persistenceError;
    if (!outcome && !failure) failure = 'Verification supervisor exited without a result';
    if (outcome?.error && !failure) failure = 'Verification command could not start';
    record.exitCode = outcome ? outcome.code : null; record.exitSignal = outcome ? outcome.signal : null;
    record.supervisorExitCode = result.code;
    record.status = cancelled ? 'cancelled' : timedOut ? 'timed-out' : failure || record.exitCode !== 0 ? 'failed' : 'passed';
    if (failure) record.error = failure;
    record.treeAfter = captureVerificationTree({ projectRoot, workspace: saved, paths: settings.paths });
    if (record.status === 'passed' && settings.kind === 'verify' && record.treeBefore.digest !== record.treeAfter.digest) record.status = 'changed';
    record.endedAt = now(); record.logTruncated = Object.fromEntries(Object.entries(counts).map(([key, size]) => [key, size > settings.maxLogBytes]));
    save(persist, record);
    return structuredClone(record);
  } finally {
    clearTimeout(timer); clearInterval(scanner); signal?.removeEventListener('abort', abort);
    if (child?.connected) abortSupervisor('verification finished');
    if (tree) await (cleanup ?? tree.stop(100));
    closeSync(fds.stdout); closeSync(fds.stderr);
  }
}

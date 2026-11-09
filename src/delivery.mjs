import { spawn } from 'node:child_process';
import { createGitHubAccountRequest } from './channels/github-account.mjs';
import { mkdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateWorkspace, inspectWorkspace } from './workspaces.mjs';
import { captureVerificationTree, verificationMatches } from './verification.mjs';
import { projectStateDirectory } from './state-paths.mjs';

const SHA = /^[a-f0-9]{40}$/;
const hash = text => createHash('sha256').update(text).digest('hex');
function text(value, name, limit = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) throw new Error(`Invalid ${name}`);
  return value;
}
function repositoryName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(value) || ['.', '..'].includes(value.split('/')[1])) throw new Error('Delivery repository must be owner/repo');
  return value.toLowerCase();
}
function branchName(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) || value.includes('..') || value.includes('@{') || value.includes('//') || value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid delivery branch');
  return value;
}
function paths(value) {
  if (!Array.isArray(value) || !value.length || value.some(path => typeof path !== 'string' || !path || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Delivery requires explicit allowedPaths');
  return [...value];
}
function saveSync(save, key, value) {
  const result = save(key, structuredClone(value));
  if (result && typeof result.then === 'function') throw new Error('Delivery journal persistence must be synchronous');
}
function generationIdentity(workspace) {
  return workspace.generation ? { generation: workspace.generation, continuationId: workspace.continuationId,
    previousProvisionId: workspace.previousProvisionId } : {};
}
/** Legacy journal keys remain stable; continuation runs are also bound to their provision. */
export function deliveryJournalKey({ projectId, workspace, runId }) {
  return `delivery:${hash(workspace.generation
    ? `${projectId}:${workspace.ticketId}:${workspace.provisionId}:${workspace.generation}:${runId}`
    : `${projectId}:${workspace.ticketId}:${runId}`)}`;
}
function cleanEnv(additions = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !/TOKEN|SECRET|PRIVATE_KEY|PASSWORD/.test(key)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...additions };
}
async function git(cwd, args, { env = {}, input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', cwd, ...args], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', bytes = 0, failed, escalation;
    const fail = reason => { failed ??= reason; child.kill('SIGTERM'); escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const timer = setTimeout(() => fail('Git delivery operation timed out'), timeoutMs);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) fail('Git delivery output exceeded limit'); else stdout += data.toString(); });
    // Deliberately do not echo errors that may contain credential helpers or remote URLs.
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', error => { failed = `Cannot start git (${error.code ?? 'spawn error'})`; });
    child.on('close', code => { clearTimeout(timer); clearTimeout(escalation); if (failed || code !== 0) reject(new Error(failed ?? `Git delivery operation failed (exit ${code})`)); else resolve(stdout.trimEnd()); });
    child.stdin.end(input);
  });
}
// A transport may ignore AbortSignal. Race the call against the caller abort and a fixed deadline.
function boundedOperation({ signal: parentSignal, assertAuthorized, timeoutMs = 10_000 }, operation) {
  const deadline = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const check = () => {
    assertAuthorized?.();
    if (deadline.signal.aborted && !parentSignal?.aborted) throw new Error('Timed out waiting for owned PR head to match the delivered commit');
  };
  return (async () => {
    let abort;
    try {
      const interrupted = new Promise((_, reject) => {
        abort = () => { try { check(); } catch (error) { reject(error); } };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await Promise.race([Promise.resolve().then(() => operation(signal)), interrupted]);
      check();
      return result;
    } catch (error) { check(); throw error; }
    finally { if (abort) signal.removeEventListener('abort', abort); clearTimeout(timer); }
  })();
}

function pullRecord(raw, repository, branch, base, marker) {
  if (!raw || !Number.isSafeInteger(raw.number) || raw.number <= 0 || !SHA.test(raw.head?.sha ?? '') || raw.head?.ref !== branch || raw.base?.ref !== base ||
    raw.head?.repo?.full_name?.toLowerCase() !== repository || raw.base?.repo?.full_name?.toLowerCase() !== repository || typeof raw.body !== 'string' || !raw.body.includes(marker) || !['open', 'closed'].includes(raw.state) ||
    raw.html_url !== `https://github.com/${repository}/pull/${raw.number}`) throw new Error('Remote PR does not match saved delivery ownership');
  return { number: raw.number, url: raw.html_url, headSha: raw.head.sha, state: raw.state, merged: Boolean(raw.merged_at), draft: raw.draft === true };
}

// GitHub may expose the pushed branch before its PR projection catches up. Only
// the journaled previous head is a retryable value; all other changes conflict.
async function reconcilePullHead({ pull, record, transport, assertAuthorized, signal: parentSignal }) {
  if (pull.headSha !== record.expectedRemoteHead) throw new Error('PR head does not match the delivered commit');
  const deadline = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 10_000);
  const check = () => {
    assertAuthorized();
    if (deadline.signal.aborted) throw new Error('Timed out waiting for owned PR head to match the delivered commit');
  };
  // A custom read-only transport may ignore AbortSignal. Bound its wait as well
  // as passing the same deadline through the built-in HTTP transport.
  const read = async operation => {
    check();
    let abort;
    try {
      const interrupted = new Promise((_, reject) => {
        abort = () => { try { check(); } catch (error) { reject(error); } };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await Promise.race([Promise.resolve().then(operation), interrupted]);
      check(); return result;
    } catch (error) { check(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  };
  const verifyHead = async () => {
    if (await read(() => transport.readHead(record.branch, { signal })) !== record.commitSha) throw new Error('Remote head changed while reconciling PR');
  };
  try {
    while (true) {
      await verifyHead();
      const raw = await read(() => transport.request(`/repos/${record.repository}/pulls/${pull.number}`, { signal }));
      const next = pullRecord(raw, record.repository, record.branch, record.base, record.marker);
      if (next.number !== pull.number) throw new Error('Remote PR does not match saved delivery ownership');
      if (next.state === 'closed') throw new Error('Owned PR is closed; explicit lifecycle handling is required');
      if (next.headSha !== record.commitSha && next.headSha !== record.expectedRemoteHead) throw new Error('PR head does not match the delivered commit');
      await verifyHead();
      if (next.headSha === record.commitSha) return next;
      await read(() => delay(250, undefined, { signal }));
    }
  } finally { clearTimeout(timer); }
}

/** Host-only transport. credential() must return a repository-scoped write credential. */
export function createGitHubDeliveryTransport({ repository, credential, request, fetch: fetcher = globalThis.fetch }) {
  repository = repositoryName(repository);
  if (typeof credential !== 'function') throw new Error('GitHub delivery requires a host credential provider');
  const prefix = `/repos/${repository}`;
  async function token() { const value = await credential(); if (typeof value !== 'string' || !value || /[\s\0]/.test(value)) throw new Error('Delivery credential unavailable'); return value; }
  async function api(endpoint, options = {}) {
    if (!endpoint.startsWith(`${prefix}/`) || /[\\\0\r\n#]/.test(endpoint) || /%2e|%2f|%5c/i.test(endpoint.split('?')[0]) || !['GET', 'POST', 'PATCH'].includes(options.method ?? 'GET')) throw new Error('Delivery API request outside repository');
    const path = endpoint.split('?')[0];
    if (new URL(endpoint, 'https://api.github.com').pathname !== path || (options.method === 'POST' && path !== `${prefix}/pulls`)) throw new Error('Delivery API write outside allowed PR endpoint');
    if (options.method === 'PATCH' && (!new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pulls/[1-9]\\d*$`).test(path) || endpoint.includes('?') || !options.body ||
        Object.keys(options.body).some(key => !['title','body'].includes(key)) || !Object.values(options.body).every(value => typeof value === 'string'))) throw new Error('Delivery PATCH may only synchronize PR title and description');
    if (request) return request(endpoint, options);
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetcher(`https://api.github.com${endpoint}`, { method: options.method ?? 'GET', redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${await token()}`, 'X-GitHub-Api-Version': '2026-03-10', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    if (!response.ok) { await response.body?.cancel(); const error = new Error(`GitHub delivery request failed (HTTP ${response.status})`); error.status = response.status; throw error; }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty GitHub delivery response');
    const chunks = []; let bytes = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('GitHub delivery response exceeded limit'); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid GitHub delivery JSON'); }
  }
  return {
    repository,
    request: api,
    async readHead(branch, { signal } = {}) {
      branchName(branch);
      try { const result = await api(`${prefix}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { signal }); if (!SHA.test(result?.object?.sha ?? '')) throw new Error('Invalid GitHub branch head'); return result.object.sha; }
      catch (error) { if (error.status === 404) return null; throw error; }
    },
    async push({ cwd, branch, commitSha, expectedHead }) {
      branchName(branch);
      if (!SHA.test(commitSha) || expectedHead !== null && !SHA.test(expectedHead)) throw new Error('Invalid delivery commit identity');
      // A lease is used only as compare-and-swap. History rewrites are rejected locally first.
      if (expectedHead) await git(cwd, ['merge-base', '--is-ancestor', expectedHead, commitSha]);
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${await token()}`).toString('base64')}`;
      await git(cwd, ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', 'push', '--porcelain',
        `--force-with-lease=refs/heads/${branch}:${expectedHead ?? ''}`, `https://github.com/${repository}.git`, `${commitSha}:refs/heads/${branch}`],
      { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header }, timeoutMs: 120_000 });
    },
  };
}


/** Explicit native-gh identity for hosts that already use gh; never passed to a Worker. */
export function createNativeGitHubDeliveryTransport({ repository, executable, account, allowedActors }) {
  if (!account) executable ??= 'gh';
  text(executable, 'GitHub executable');
  const accountRequest = account ? createGitHubAccountRequest({ repository, executable, account, allowedActors }) : null;
  const credential = async () => {
    if (accountRequest) return accountRequest.credential();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['auth', 'token', '--hostname', 'github.com'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let value = '', error, escalation;
      const fail = reason => { error ??= reason; child.kill('SIGTERM'); escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
      const timer = setTimeout(() => fail('GitHub credential lookup timed out'), 15_000);
      child.stdout.on('data', data => { value += data.toString(); if (value.length > 64 * 1024) fail('Invalid GitHub credential response'); });
      child.stderr.resume();
      child.on('error', cause => { error = `Cannot start GitHub CLI (${cause.code ?? 'spawn error'})`; });
      child.on('close', code => { clearTimeout(timer); clearTimeout(escalation); if (error || code !== 0) reject(new Error(error ?? 'GitHub credential lookup failed')); else resolve(value.trim()); });
    });
  };
  return createGitHubDeliveryTransport({ repository, credential });
}

function descriptionParts(marker) { return { start: marker.replace(' -->', ':description:start -->'), end: marker.replace(' -->', ':description:end -->') }; }
function managedDescription(marker, body) {
  const { start, end } = descriptionParts(marker);
  if (body.includes(start) || body.includes(end) || body.includes(marker)) throw new Error('PR description contains reserved host markers');
  return `${start}\n${body}\n${end}`;
}
function splitDescription(content, marker) {
  const { start, end } = descriptionParts(marker), at = content.indexOf(start), to = content.indexOf(end);
  if (at < 0 || to < at || content.indexOf(start, at + start.length) >= 0 || content.indexOf(end, to + end.length) >= 0) return null;
  return { before: content.slice(0, at), managed: content.slice(at, to + end.length), after: content.slice(to + end.length) };
}

/** Preserve edits outside our managed section. GitHub has no conditional PATCH
 * here: the narrow reread/write window is verified afterwards, not called atomic. */
export async function synchronizePullDescription({ record, baseline, transport, save, assertAuthorized, signal }) {
  signal ??= AbortSignal.timeout(30_000);
  const desired = { title: record.title, managed: managedDescription(record.marker, record.body) };
  const endpoint = `/repos/${record.repository}/pulls/${record.pullRequest.number}`;
  const read = async () => {
    const raw = await boundedOperation({ signal, assertAuthorized, timeoutMs: 10_000 }, requestSignal => transport.request(endpoint, { method: 'GET', signal: requestSignal }));
    const pull = pullRecord(raw, record.repository, record.branch, record.base, record.marker);
    if (pull.headSha !== record.commitSha || pull.state !== 'open' || pull.merged) throw new Error('PR changed while synchronizing its description');
    if (typeof raw.title !== 'string') throw new Error('PR title could not be verified');
    assertAuthorized(); return raw;
  };
  const persist = value => { record.description = value; save(record); };
  try {
    let remote = await read(), parts = splitDescription(remote.body, record.marker);
    if (remote.title === desired.title && parts?.managed === desired.managed) {
      persist({ status: 'synced', ...desired, at: new Date().toISOString() }); return record.description;
    }
    if (!baseline || baseline.status !== 'synced' || remote.title !== baseline.title || parts?.managed !== baseline.managed) {
      persist({ status: 'conflict', reason: 'PR title or managed description was edited, or its historical baseline is missing', desired, at: new Date().toISOString() });
      throw new Error('PR description conflicts with human edits or lacks a saved baseline; code is already pushed');
    }
    const intended = { title: desired.title, body: `${parts.before}${desired.managed}${parts.after}` };
    // A saved uncertain PATCH must match either its old or intended version.
    // This is content replacement, never a notification-producing retry.
    const fresh = await read();
    if (fresh.title !== remote.title || fresh.body !== remote.body) throw new Error('PR description changed before update; inspect before retrying');
    persist({ status: 'sending', desired, beforeDigest: hash(JSON.stringify([remote.title, remote.body])), at: new Date().toISOString() });
    assertAuthorized();
    await transport.request(endpoint, { method: 'PATCH', body: intended, signal });
    remote = await read(); parts = splitDescription(remote.body, record.marker);
    if (remote.title !== desired.title || parts?.managed !== desired.managed || remote.body !== intended.body) throw new Error('PR description write could not be confirmed');
    persist({ status: 'synced', ...desired, at: new Date().toISOString() }); return record.description;
  } catch (error) {
    if (!['conflict','synced'].includes(record.description?.status)) persist({ ...record.description, status: 'pending', error: String(error.message ?? error).slice(0, 800), at: new Date().toISOString() });
    throw error;
  }
}

/** Caller provides a cross-process lock and durable synchronous journal (e.g. Store.atomic). */
export function createDeliveryService({ projectRoot, projectId, load, save, withLock, transport }) {
  text(projectId, 'projectId', 200);
  if (typeof load !== 'function' || typeof save !== 'function') throw new Error('Delivery requires durable load/save callbacks');
  function preview({ workspace, allowedPaths, verification }) {
    const saved = validateWorkspace({ projectRoot, workspace });
    const inspection = inspectWorkspace({ projectRoot, workspace: saved });
    const allowed = allowedPaths === undefined ? null : paths(allowedPaths);
    if (allowed) for (const change of inspection.changes) {
      if (!allowed.some(path => change.path === path || change.path.startsWith(`${path}/`))) throw new Error(`Change outside delivery scope: ${change.path}`);
      if (change.path.split('/').some(part => part === '.env' || part.startsWith('.env.')) || change.path.startsWith('.js-superagent/')) throw new Error(`Private state cannot be delivered: ${change.path}`);
    }
    return { workspace: saved, changes: inspection.changes, tree: captureVerificationTree({ projectRoot, workspace: saved, paths: verification?.treeAfter?.paths ?? allowed ?? ['.'] }) };
  }
  async function deliver(input) {
    const { workspace, verification, runId, title, body = '' } = input;
    const assertAuthorized = () => { if (input.signal?.aborted || input.authorize && input.authorize() !== true) throw new Error('Delivery cancelled or no longer authorized'); };
    assertAuthorized();
    const mode = input.mode ?? 'local';
    if (!['local', 'draft-pr'].includes(mode)) throw new Error('Delivery mode must be local or draft-pr');
    const prepared = preview(input);
    if (mode === 'local') return { version: 1, mode, status: 'local', ticketId: workspace.ticketId, ...prepared };
    if (typeof withLock !== 'function') throw new Error('Remote delivery requires a cross-process ownership lock');
    if (!transport || typeof transport.readHead !== 'function' || typeof transport.push !== 'function' || typeof transport.request !== 'function') throw new Error('Remote delivery transport is not configured');
    const repository = repositoryName(input.repository), base = branchName(input.base ?? 'main');
    if (transport.repository !== repository) throw new Error('Delivery transport repository mismatch');
    if (workspace.mode !== 'worktree') throw new Error('Remote delivery requires an owned Git worktree');
    const branch = branchName(workspace.branch);
    if (branch === base) throw new Error('Delivery cannot target the base branch');
    const allowedPaths = paths(input.allowedPaths);
    text(runId, 'runId', 120); text(title, 'PR title', 256);
    if (typeof body !== 'string' || body.includes('\0') || body.length > 30_000) throw new Error('Invalid PR body');
    if (!verificationMatches({ projectRoot, workspace, verification })) throw new Error('Delivery requires a passing verification for the current tree');
    for (const change of prepared.changes) {
      const covered = (verification.treeAfter.paths ?? ['.']).some(scope => scope === '.' || change.path === scope || change.path.startsWith(`${scope}/`));
      const excluded = verification.treeAfter.exclusions.some(path => change.path === path || change.path.startsWith(`${path}/`) || !path.includes('/') && change.path.split('/').includes(path));
      if (!covered || excluded) throw new Error(`Delivery change is outside verified paths: ${change.path}`);
      if (change.path.startsWith('.github/workflows/') && input.allowWorkflowChanges !== true) throw new Error('Workflow delivery requires explicit allowWorkflowChanges');
    }
    if (!prepared.changes.length) throw new Error('No changes to deliver');
    const key = deliveryJournalKey({ projectId, workspace, runId });
    const branchKey = `delivery-branch:${hash(`${repository}:${branch}`)}`;
    return withLock(branchKey, async () => {
      let record = load(key);
      let owner = load(branchKey);
      if (owner && (owner.projectId !== projectId || owner.ticketId !== workspace.ticketId || owner.provisionId !== workspace.provisionId || owner.repository !== repository || owner.branch !== branch)) throw new Error('Delivery branch has a different owner');
      const identity = { projectId, ticketId: workspace.ticketId, provisionId: workspace.provisionId, ...generationIdentity(workspace), repository, branch, base, runId, treeDigest: prepared.tree.digest, verificationId: verification.id, allowedPaths, title, body };
      if (record && record.identityDigest !== hash(JSON.stringify(identity))) throw new Error('Delivery intent changed; inspect the existing delivery before retrying');
      // A closed prior PR is a historical destination, never a writable target.
      // Check before commit/push, not only after publishing the branch.
      if (owner?.pullRequest) {
        const marker = `<!-- js-superagent-delivery:${hash(`${projectId}:${workspace.ticketId}:${workspace.provisionId}`)} -->`;
        const remote = pullRecord(await boundedOperation({ signal: input.signal, assertAuthorized }, signal => transport.request(`/repos/${repository}/pulls/${owner.pullRequest.number}`, { signal })), repository, branch, base, marker);
        assertAuthorized();
        if (remote.number !== owner.pullRequest.number || remote.state === 'closed' || remote.merged) throw new Error('Owned PR is closed; prepare an explicit continuation before delivering');
        if (remote.headSha !== owner.headSha && remote.headSha !== record?.commitSha) throw new Error('Remote head changed or branch is not owned');
      }
      if (!record) {
        const remoteHead = await transport.readHead(branch);
        if (!owner && remoteHead !== null || owner && remoteHead !== owner.headSha) throw new Error('Remote head changed or branch is not owned');
        const parentSha = await git(workspace.path, ['rev-parse', 'HEAD']);
        if (!owner && parentSha !== workspace.baseCommit) throw new Error('Local worktree contains unowned commits');
        if (owner && parentSha !== owner.headSha) throw new Error('Local worktree head changed outside the saved delivery');
        const journalDir = join(projectStateDirectory(projectRoot), 'delivery');
        mkdirSync(journalDir, { recursive: true, mode: 0o700 });
        if (lstatSync(journalDir).isSymbolicLink()) throw new Error('Unsafe delivery journal directory');
        const temporary = mkdtempSync(join(journalDir, 'index-'));
        let tree;
        try {
          const env = { GIT_INDEX_FILE: join(temporary, 'index') };
          await git(workspace.path, ['read-tree', parentSha], { env });
          await git(workspace.path, ['add', '--all', '--', '.', ':(exclude).js-superagent'], { env });
          tree = await git(workspace.path, ['write-tree'], { env });
        } finally { rmSync(temporary, { recursive: true, force: true }); }
        if (!SHA.test(tree) || captureVerificationTree({ projectRoot, workspace, paths: verification.treeAfter.paths }).digest !== prepared.tree.digest) throw new Error('Tree changed while preparing delivery');
        record = { version: 1, ...identity, identityDigest: hash(JSON.stringify(identity)), state: 'prepared', parentSha, tree, expectedRemoteHead: remoteHead,
          createdAt: new Date().toISOString(), marker: `<!-- js-superagent-delivery:${hash(`${projectId}:${workspace.ticketId}:${workspace.provisionId}`)} -->` };
        saveSync(save, key, record);
        if (!owner) { owner = { projectId, ticketId: workspace.ticketId, provisionId: workspace.provisionId, ...generationIdentity(workspace), repository, branch, headSha: null }; saveSync(save, branchKey, owner); }
      }
      if (!owner) {
        owner = { projectId, ticketId: workspace.ticketId, provisionId: workspace.provisionId, ...generationIdentity(workspace), repository, branch, headSha: record.expectedRemoteHead };
        saveSync(save, branchKey, owner);
      }
      assertAuthorized();
      // Reconcile commit creation and branch movement independently after a crash.
      const dateEnv = { GIT_AUTHOR_NAME: 'js-superagent', GIT_AUTHOR_EMAIL: 'js-superagent@users.noreply.github.com', GIT_COMMITTER_NAME: 'js-superagent', GIT_COMMITTER_EMAIL: 'js-superagent@users.noreply.github.com', GIT_AUTHOR_DATE: record.createdAt, GIT_COMMITTER_DATE: record.createdAt };
      const commitSha = await git(workspace.path, ['commit-tree', record.tree, '-p', record.parentSha], { env: dateEnv, input: `${record.title}\n\n${record.marker}\n` });
      if (!SHA.test(commitSha) || record.commitSha && record.commitSha !== commitSha) throw new Error('Delivery commit reconciliation failed');
      record.commitSha = commitSha; saveSync(save, key, record);
      const head = await git(workspace.path, ['rev-parse', 'HEAD']);
      assertAuthorized();
      if (head === record.parentSha) await git(workspace.path, ['update-ref', `refs/heads/${branch}`, commitSha, record.parentSha]);
      else if (head !== commitSha) throw new Error('Local branch changed while delivering');
      // Refresh the owned index through normal staging, preserving sparse flags.
      // Plain read-tree clears skip-worktree and invents deletions outside the cone.
      await git(workspace.path, ['add', '--all', '--', '.', ':(exclude).js-superagent']);
      if (await git(workspace.path, ['write-tree']) !== record.tree) throw new Error('Workspace changed while updating its delivery index');
      record.state = 'committed'; saveSync(save, key, record);
      if (!verificationMatches({ projectRoot, workspace, verification })) throw new Error('Tree changed after verification');
      const remoteHead = await transport.readHead(branch);
      if (remoteHead !== commitSha) {
        if (remoteHead !== record.expectedRemoteHead) throw new Error('Remote head changed while delivering');
        assertAuthorized();
        await transport.push({ cwd: workspace.path, branch, commitSha, expectedHead: remoteHead });
        if (await transport.readHead(branch) !== commitSha) throw new Error('Push result could not be verified');
      }
      record.state = 'pushed'; saveSync(save, key, record);
      const prefix = `/repos/${repository}`;
      const pulls = await transport.request(`${prefix}/pulls?state=all&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=100`);
      if (!Array.isArray(pulls) || pulls.length >= 100) throw new Error('Cannot establish unique PR ownership');
      const owned = pulls.filter(pull => pull.body?.includes(record.marker));
      if (owned.length > 1 || !owned.length && pulls.length) throw new Error('PR ownership conflict');
      let pull = owned.length ? pullRecord(owned[0], repository, branch, base, record.marker) : null;
      if (pull?.state === 'closed') throw new Error('Owned PR is closed; explicit lifecycle handling is required');
      if (!pull) {
        assertAuthorized();
        const raw = await transport.request(`${prefix}/pulls`, { method: 'POST', body: { title, body: `${managedDescription(record.marker, body)}\n\n${record.marker}`, head: branch, base, draft: true } });
        pull = pullRecord(raw, repository, branch, base, record.marker);
      }
      if (pull.headSha !== commitSha) pull = await reconcilePullHead({ pull, record, transport, assertAuthorized, signal: input.signal });
      assertAuthorized();
      record.pullRequest = pull;
      // Code is committed and pushed regardless of a later description conflict.
      saveSync(save, key, record);
      await synchronizePullDescription({ record, baseline: owner.description, transport, assertAuthorized, signal: input.signal,
        save: updated => saveSync(save, key, updated) });
      record.state = 'delivered'; record.pullRequest = pull; record.completedAt = new Date().toISOString();
      saveSync(save, key, record);
      saveSync(save, branchKey, { ...owner, headSha: commitSha, pullRequest: pull, description: record.description });
      return structuredClone(record);
    });
  }
  return { preview, deliver };
}

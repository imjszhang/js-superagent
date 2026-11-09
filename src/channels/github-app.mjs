import { createPrivateKey, sign } from 'node:crypto';
import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { GitHubRequestError } from './github-errors.mjs';
import { scopedReviewGraphql } from './github-review.mjs';

const ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_KEY = 64 * 1024;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i;

function settings(options) {
  const repository = typeof options?.repository === 'string' ? options.repository.toLowerCase() : undefined;
  if (typeof repository !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) throw new Error('GitHub App requires an explicit owner/repository');
  const app = options.app;
  if (!app || typeof app !== 'object' || Array.isArray(app) || Object.keys(app).some(key => !['appId', 'installationId', 'privateKeyEnv', 'privateKeyPath', 'pullRequestComments', 'pullRequestReviews'].includes(key)) ||
      typeof app.appId !== 'string' || !/^[1-9]\d*$/.test(app.appId) || !Number.isSafeInteger(Number(app.appId)) ||
      !Number.isSafeInteger(app.installationId) || app.installationId <= 0) throw new Error('GitHub App requires a numeric appId and installationId');
  if (app.pullRequestComments !== undefined && typeof app.pullRequestComments !== 'boolean') throw new Error('GitHub App pullRequestComments must be boolean');
  if (app.pullRequestReviews !== undefined && typeof app.pullRequestReviews !== 'boolean') throw new Error('GitHub App pullRequestReviews must be boolean');
  if (Boolean(app.privateKeyEnv) === Boolean(app.privateKeyPath) ||
      (app.privateKeyEnv !== undefined && (typeof app.privateKeyEnv !== 'string' || !ENV.test(app.privateKeyEnv))) ||
      (app.privateKeyPath !== undefined && (typeof app.privateKeyPath !== 'string' || !app.privateKeyPath.trim() || /[\0\r\n]/.test(app.privateKeyPath)))) throw new Error('Configure exactly one GitHub App private-key environment name or file path');
  return { repository, app: { ...app } };
}

function readKey(app) {
  if (app.privateKeyEnv) return process.env[app.privateKeyEnv];
  let fd;
  try {
    fd = openSync(app.privateKeyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_KEY) throw new Error('invalid key file');
    return readFileSync(fd);
  } catch { throw new Error('Cannot read GitHub App private key from the configured regular file'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function privateKey(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value)) || !value.length || Buffer.byteLength(value) > MAX_KEY) throw new Error('GitHub App private key is missing or exceeds 64 KiB');
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('Unsupported signing key');
    return key;
  } catch { throw new Error('GitHub App private key must be an unencrypted RSA key of at least 2048 bits'); }
}

/** Native installation authentication. Secrets stay in memory and are never part of errors or configuration. */
export function createGitHubAppRequest(options, { fetch: fetcher = globalThis.fetch, now = Date.now, readPrivateKey = readKey } = {}) {
  const { repository, app } = settings(options);
  if (typeof fetcher !== 'function' || typeof now !== 'function' || typeof readPrivateKey !== 'function') throw new Error('Invalid GitHub App transport dependency');
  const prefix = `/repos/${repository}`;
  const permissions = { metadata: 'read', issues: 'write', pull_requests: app.pullRequestComments || app.pullRequestReviews ? 'write' : 'read',
    ...(options.ci?.checkApps?.length ? { checks: 'read' } : {}), ...(options.ci?.statusContexts?.length ? { statuses: 'read' } : {}) };
  let token, minting, identityPromise;
  function jwt() {
    const seconds = Math.floor(now() / 1000);
    if (!Number.isFinite(seconds)) throw new Error('Invalid GitHub App clock');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: app.appId })).toString('base64url');
    let key;
    try { key = privateKey(readPrivateKey(app)); } catch (error) {
      if (error instanceof Error && /^GitHub App private key|^Cannot read GitHub App private key/.test(error.message)) throw error;
      throw new Error('Cannot load GitHub App private key');
    }
    return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
  }
  async function http(endpoint, { method = 'GET', body, authorization, signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new Error('GitHub App request cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      let response;
      try {
        response = await fetcher(`${ORIGIN}${endpoint}`, { method, redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'js-superagent',
            ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch { throw new Error(controller.signal.aborted ? 'GitHub App API request timed out' : 'GitHub App API request failed'); }
      if (response.redirected || response.status >= 300 && response.status < 400 ||
          (response.url && new URL(response.url).origin !== ORIGIN)) throw new Error('GitHub App API redirects are not allowed');
      if (!response.ok) {
        // Read only a bounded structured error to distinguish a locked discussion.
        let detail, bytes = 0; const chunks = [], reader = response.body?.getReader();
        try {
          if (reader) while (true) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.byteLength; if (bytes > 16 * 1024) { await reader.cancel(); break; }
            chunks.push(Buffer.from(value));
          }
          if (bytes <= 16 * 1024) detail = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { /* HTTP identity remains trustworthy when the optional body is invalid. */ }
        finally { reader?.releaseLock(); }
        const error = new GitHubRequestError(response.status, { message: detail?.message,
          ...(!endpoint.startsWith(prefix) ? { scope: 'repository' } : {}) });
        error.message = `GitHub App API request failed (HTTP ${response.status})`; throw error;
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE) { await response.body?.cancel(); throw new Error('GitHub App API response exceeded 16 MiB'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('GitHub App API returned an empty response');
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE) { await reader.cancel(); throw new Error('GitHub App API response exceeded 16 MiB'); }
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (error?.message === 'GitHub App API response exceeded 16 MiB') throw error;
        throw new Error(controller.signal.aborted ? 'GitHub App API request timed out' : 'GitHub App API response could not be read');
      } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('GitHub App API returned malformed JSON'); }
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  async function mint() {
    const response = await http(`/app/installations/${app.installationId}/access_tokens`, { method: 'POST', authorization: jwt(),
      body: { repositories: [repository.split('/')[1]], permissions } });
    const expires = Date.parse(response?.expires_at);
    if (typeof response?.token !== 'string' || !response.token.length || response.token.length > MAX_KEY || /[\s\0]/.test(response.token) ||
        !Number.isFinite(expires) || expires <= now() + 60_000 || expires > now() + 3_700_000 ||
        response.repository_selection !== 'selected' || !Array.isArray(response.repositories) || response.repositories.length !== 1 ||
        response.repositories[0]?.full_name?.toLowerCase() !== repository || !Number.isSafeInteger(response.repositories[0]?.id) || response.repositories[0].id <= 0 ||
        !response.permissions || typeof response.permissions !== 'object' || Array.isArray(response.permissions)) throw new Error('GitHub App returned an invalid repository-scoped installation token');
    for (const [name, level] of Object.entries(response.permissions)) {
      if (permissions[name] !== level) throw new Error('GitHub App returned permissions outside the requested scope');
    }
    for (const [name, level] of Object.entries(permissions)) {
      if (name !== 'metadata' && response.permissions[name] !== level) throw new Error('GitHub App installation lacks required permissions');
    }
    token = { value: response.token, expires }; return token;
  }
  async function credential() {
    if (token && token.expires > now() + 60_000) return token;
    if (!minting) minting = mint().finally(() => { minting = undefined; });
    return minting;
  }
  const waitCredential = signal => {
    const pending = credential().catch(error => { error.scope = 'repository'; throw error; });
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('GitHub App request cancelled'));
      if (signal.aborted) { pending.catch(() => {}); abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
  const request = async (endpoint, { method = 'GET', body, signal } = {}) => {
    if (typeof endpoint !== 'string' || !endpoint.startsWith(`${prefix}/`) && endpoint !== prefix && !endpoint.startsWith(`${prefix}?`) ||
        /[\\\0\r\n#]/.test(endpoint) || !['GET', 'POST'].includes(method)) throw new Error('GitHub App request is outside the configured repository');
    const url = new URL(endpoint, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || !url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix ||
        /%2f|%5c|%2e/i.test(url.pathname) || url.pathname !== endpoint.split('?')[0]) throw new Error('GitHub App request is outside the configured repository');
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reviewRequest = app.pullRequestReviews && new RegExp(`^${escaped}/pulls/[1-9]\\d*/requested_reviewers$`).test(url.pathname);
    if (reviewRequest && method === 'POST' && (!body || Object.keys(body).some(key => !['reviewers','team_reviewers'].includes(key)) ||
        ![body.reviewers,body.team_reviewers].every(items => Array.isArray(items) && items.length <= 20 && items.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(item))))) throw new Error('Invalid requested reviewer scope');
    if (method === 'POST' && (!new RegExp(`^${escaped}/issues/[1-9]\\d*/comments$`).test(url.pathname)
      && !((app.pullRequestComments || app.pullRequestReviews) && new RegExp(`^${escaped}/pulls/[1-9]\\d*/comments/[1-9]\\d*/replies$`).test(url.pathname)) && !reviewRequest || url.search)) throw new Error('GitHub App writes are limited to comments and explicitly enabled PR review actions');
    if (signal?.aborted) throw new Error('GitHub App request cancelled');
    const current = await waitCredential(signal);
    try { return await http(endpoint, { method, body, authorization: current.value, signal }); }
    catch (error) {
      if (error.status !== 401) throw error;
      if (token === current) token = undefined;
      // GET is safe to retry once. A POST may have reached GitHub; Outbox reconciles it.
      if (method !== 'GET') throw error;
      const refreshed = await waitCredential(signal);
      return http(endpoint, { method, body, authorization: refreshed.value, signal });
    }
  };
  request.reviewGraphql = (operation, { number, headSha, threadId, commentId, signal, beforeWrite } = {}) => scopedReviewGraphql({ repository, operation, number, headSha, threadId, commentId, signal, beforeWrite, allowWrite: app.pullRequestReviews === true,
    request: async (endpoint, init) => {
      const current = await waitCredential(init.signal);
      // scopedReviewGraphql supplies only fixed documents and first verifies
      // every mutable node against this repository and PR.
      return http(endpoint, { ...init, authorization: current.value });
    } });
  request.reviewerIdentity = async (login,{signal}={}) => {
    if(typeof login!=='string'||!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(login))throw new Error('Invalid reviewer identity');
    const current=await waitCredential(signal);
    return http(`/users/${encodeURIComponent(login.toLowerCase())}`,{authorization:current.value,signal});
  };
  request.identity = async () => {
    if (!identityPromise) identityPromise = (async () => {
      const identity = await http('/app', { authorization: jwt() });
      if (String(identity?.id) !== app.appId || !SLUG.test(identity?.slug ?? '')) throw new Error('GitHub App identity does not match configuration');
      const login = `${identity.slug.toLowerCase()}[bot]`;
      // Bot IDs are immutable; this public lookup does not transmit a JWT or installation token.
      const bot = await http(`/users/${encodeURIComponent(login)}`);
      if (bot?.type !== 'Bot' || bot.login?.toLowerCase() !== login || !Number.isSafeInteger(bot.id) || bot.id <= 0) throw new Error('GitHub App bot identity could not be verified');
      return { login, id: String(bot.id), type: 'Bot', appId: app.appId, installationId: app.installationId };
    })().catch(error => { identityPromise = undefined; throw error; });
    return identityPromise;
  };
  return request;
}

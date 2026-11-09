import { execFile } from 'node:child_process';
import { ghRequest } from './github.mjs';
import { scopedReviewGraphql } from './github-review.mjs';

const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
/** A dedicated CLI wrapper owns credentials; ambient tokens must not override it. */
export function githubAccountEnvironment(environment = process.env) {
  const env = { ...environment, GH_PROMPT_DISABLED: '1' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
  return env;
}

/** Select by login, not gh's mutable active account; never echo credential output. */
export async function githubAccountCredential(executable, login, { signal } = {}) {
  const lookup = selected => new Promise((resolve, reject) => execFile(executable,
    ['auth', 'token', '--hostname', 'github.com', ...(selected ? ['--user', login] : [])],
    { env: githubAccountEnvironment(), signal, timeout: 15000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      // Older gh configurations store only the active token, with no per-user entry.
      // The caller still verifies the exact resulting token's /user before any use.
      if (selected && error?.code === 1 && stderr?.trim() === `no oauth token found for github.com account ${login}`) { resolve(null); return; }
      const token = stdout?.trim();
      if (error || !token || /[\s\0]/.test(token)) reject(new Error('GitHub agent credential lookup failed'));
      else resolve(token);
    }));
  return await lookup(true) ?? await lookup(false);
}

/** Bind all host reads and writes to an explicitly selected GitHub user account. */
export function createGitHubAccountRequest(options, { request: cliRequest = ghRequest, credential = githubAccountCredential } = {}) {
  const repository = options?.repository?.toLowerCase(), login = options?.account?.login?.toLowerCase();
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/.test(repository ?? '') || ['.', '..'].includes(repository.split('/')[1])) throw new Error('GitHub account requires a repository');
  if (options.app || !LOGIN.test(login ?? '')) throw new Error('GitHub account requires a user login and cannot use App authentication');
  if (typeof options.executable !== 'string' || !options.executable.trim() || /[\0\r\n]/.test(options.executable)) throw new Error('GitHub account requires its dedicated CLI executable');
  if (!Array.isArray(options.allowedActors) || !options.allowedActors.length || options.allowedActors.some(actor => !LOGIN.test(actor) || actor.toLowerCase() === login)) throw new Error('GitHub agent account must be separate from allowed operators');
  const prefix = `/repos/${repository}`;
  let actorId;
  const raw = (token, endpoint, init = {}) => cliRequest(options.executable, endpoint, { ...init, env: { ...githubAccountEnvironment(), GH_TOKEN: token } });
  const authorized = async ({ signal } = {}) => {
    const token = await credential(options.executable, login, { signal });
    if (typeof token !== 'string' || !token || /[\s\0]/.test(token)) throw new Error('GitHub agent credential unavailable');
    const user = await raw(token, '/user', { method: 'GET', signal });
    if (user?.type !== 'User' || user.login?.toLowerCase() !== login || !Number.isSafeInteger(user.id) || user.id <= 0 || actorId !== undefined && user.id !== actorId) throw new Error('GitHub agent account identity does not match configuration');
    actorId = user.id;
    return { token, user: { login, id: user.id, type: 'User' } };
  };
  const scoped = endpoint => {
    if (typeof endpoint !== 'string' || /[\0\r\n\\#%]/.test(endpoint.split('?')[0]) || endpoint.split('?')[0].split('/').some(part => part === '.' || part === '..')) return false;
    const path = endpoint.split('?')[0];
    return path === prefix || path.startsWith(`${prefix}/`) || /^\/users\/[a-z\d][a-z\d-]{0,38}$/i.test(path);
  };
  const request = async (endpoint, init = {}) => {
    if (endpoint !== '/user' && !scoped(endpoint)) throw new Error('GitHub account request outside configured repository');
    const { token, user } = await authorized(init);
    if (endpoint === '/user') {
      if (init.method && init.method !== 'GET') throw new Error('GitHub account identity is read-only');
      return user;
    }
    if (endpoint.startsWith('/users/') && init.method && init.method !== 'GET') throw new Error('GitHub user lookup is read-only');
    return raw(token, endpoint, init);
  };
  request.identity = async init => (await authorized(init)).user;
  request.credential = async init => (await authorized(init)).token;
  request.notifications = async (endpoint, init = {}) => {
    if (typeof endpoint !== 'string' || /[\0\r\n#\\]/.test(endpoint) || endpoint.split('?')[0] !== `${prefix}/notifications` || init.method && init.method !== 'GET') throw new Error('GitHub notifications are read-only and limited to the configured repository');
    const { token } = await authorized(init);
    return raw(token, endpoint, { ...init, method: 'GET', includeHeaders: true });
  };
  request.reviewGraphql = (operation, args = {}) => scopedReviewGraphql({ ...args, repository, operation, allowWrite: true,
    request: async (endpoint, init) => {
      if (endpoint !== '/graphql') return request(endpoint, init);
      const { token } = await authorized(init); return raw(token, endpoint, init);
    } });
  return request;
}

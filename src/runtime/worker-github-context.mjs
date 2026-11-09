import { execFile } from 'node:child_process';
import { createGitHubAppRequest } from '../channels/github-app.mjs';
import { createGitHubAccountRequest } from '../channels/github-account.mjs';
import { contextBytes, contextVersion, utf8Slice } from './worker-context.mjs';

const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/;
const SHA = /^[a-f\d]{40}$/;
const PAGE_SIZE = 30, MAX_PAGES = 5, MAX_RESPONSE = 2 * 1024 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => contextVersion(value).slice(0, 32);
const fail = () => { throw new Error('GitHub context reference is outside this assignment scope'); };
function nativeGet(executable) {
  return (endpoint, { signal }) => new Promise((resolve, reject) => execFile(executable, ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint],
    { signal, timeout: 8000, maxBuffer: MAX_RESPONSE, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) { reject(new Error(signal?.aborted ? 'GitHub context read cancelled' : 'GitHub context GET failed')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('GitHub returned invalid context JSON')); }
    }));
}
function text(value, maximum = 128 * 1024) {
  if (value == null) return '';
  if (typeof value !== 'string' || contextBytes(value) > maximum) throw new Error('GitHub context text exceeds its bound');
  return value;
}
function linked(value, repository, number, pull) {
  let url; try { url = new URL(value); } catch { throw new Error('GitHub context link is invalid'); }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.pathname.toLowerCase() !== `/${repository}/${pull ? 'pull' : 'issues'}/${number}`) throw new Error('GitHub context link is outside its discussion');
  return url.href;
}
function comment(value, repository, scope, kind) {
  if (!positive(value?.id)) throw new Error('GitHub returned an invalid context item');
  return { id: String(value.id), kind, text: text(value.body), url: linked(value.html_url, repository, scope.number, scope.pull),
    actor: typeof value.user?.login === 'string' ? value.user.login : null, at: value.updated_at ?? value.submitted_at ?? value.created_at ?? null,
    ...(positive(value.in_reply_to_id) ? { parentId: String(value.in_reply_to_id) } : {}),
    ...(typeof value.path === 'string' ? { path: text(value.path, 2048), line: value.line ?? null, originalLine: value.original_line ?? null,
      side: value.side ?? null, diff: text(value.diff_hunk, 32 * 1024), commitId: value.commit_id ?? null } : {}),
    ...(SHA.test(value.commit_id ?? '') ? { commitId: value.commit_id } : {}), ...(typeof value.state === 'string' ? { state: value.state } : {}) };
}

/** Host-minted references only. No model URL, endpoint, repository or credentials reach the transport. */
export function createWorkerGitHubReads({ github, request, threads, assertActive = () => {}, signal } = {}) {
  const repository = github?.repository?.toLowerCase();
  if (!REPOSITORY.test(repository ?? '') || typeof threads !== 'function') return null;
  const prefix = `/repos/${repository}`, configuration = digest(github), descriptors = new Map();
  const transport = request ?? (github.account ? createGitHubAccountRequest(github) : github.app ? createGitHubAppRequest({ repository, app: github.app, ci: github.ci }) : nativeGet(github.executable ?? 'gh'));
  const scopes = () => {
    assertActive(); signal?.throwIfAborted();
    if (configuration !== digest(github)) throw new Error('GitHub context configuration changed');
    const values = threads();
    if (!Array.isArray(values) || values.length > 128) throw new Error('GitHub context scope exceeds its bound');
    return [...new Map(values.map(value => {
      if (!positive(value?.number) || typeof value.pull !== 'boolean' || value.headSha !== undefined && (!value.pull || !SHA.test(value.headSha)) || value.reviewRootId !== undefined && (!value.pull || !positive(value.reviewRootId))) fail();
      const scope = { number: value.number, pull: value.pull, ...(value.headSha ? { headSha: value.headSha } : {}), ...(value.reviewRootId ? { reviewRootId: value.reviewRootId } : {}) };
      return [digest(scope), scope];
    })).values()];
  };
  const register = descriptor => {
    const id = `github:${repository}:${digest(descriptor)}`;
    if (!descriptors.has(id)) {
      if (descriptors.size >= 512) throw new Error('GitHub context reference budget exhausted');
      descriptors.set(id, { ...descriptor, id });
    }
    return { resource: 'github', id };
  };
  const allowed = descriptor => scopes().some(scope => digest(scope) === descriptor.scopeKey);
  const references = () => {
    for (const scope of scopes()) {
      const kinds = scope.reviewRootId ? ['review-thread'] : ['root', 'comments', ...(scope.pull ? ['reviews', 'review-comments'] : [])];
      if (scope.pull && !scope.reviewRootId && github.ci?.checkApps?.length) kinds.push('checks');
      if (scope.pull && !scope.reviewRootId && github.ci?.statusContexts?.length) kinds.push('statuses');
      for (const kind of kinds) register({ scope, scopeKey: digest(scope), kind, page: 1, anchors: [] });
    }
    return [...descriptors.values()].filter(allowed).map(descriptor => ({ resource: 'github', id: descriptor.id,
      value: { repository, number: descriptor.scope.number, pull: descriptor.scope.pull, kind: descriptor.kind, page: descriptor.page,
        ...(descriptor.scope.headSha ? { headSha: descriptor.scope.headSha } : {}), ...(descriptor.scope.reviewRootId ? { reviewRootId: descriptor.scope.reviewRootId } : {}) } }));
  };
  const validate = prepared => {
    const descriptor = descriptors.get(prepared?.id);
    if (prepared?.configuration !== configuration || !descriptor || digest(descriptor) !== prepared.descriptorDigest || !allowed(descriptor)) fail();
  };
  const prepare = args => {
    if (!args || Object.keys(args).some(key => !['resource', 'id', 'version', 'offset', 'limit'].includes(key)) || args.resource !== 'github') throw new Error('Invalid GitHub context read arguments');
    references();
    const descriptor = descriptors.get(args.id);
    if (!descriptor || !allowed(descriptor)) fail();
    const offset = args.offset ?? 0, limit = args.limit ?? 8192;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 256 || limit > 8192 || args.version !== undefined && !/^[a-f\d]{64}$/.test(args.version)) throw new Error('Invalid GitHub context page');
    if (offset > 0 && args.version === undefined) throw new Error('GitHub context continuation requires a version');
    return { id: args.id, configuration, descriptorDigest: digest(descriptor), args: { ...args, offset, limit } };
  };
  const read = async (prepared, { signal: callSignal, charge = () => {} } = {}) => {
    validate(prepared);
    const descriptor = descriptors.get(prepared.id), { scope, kind, page } = descriptor;
    const activeSignal = signal && callSignal ? AbortSignal.any([signal, callSignal]) : callSignal ?? signal;
    const active = () => { activeSignal?.throwIfAborted(); validate(prepared); };
    const get = async path => {
      active();
      if (!path.startsWith(`${prefix}/`) || /[\\\0\r\n#]/.test(path)) fail();
      charge({ requests: 1 });
      const value = await transport(path, { method: 'GET', signal: activeSignal });
      charge({ bytes: contextBytes(value) }); active();
      if (contextBytes(value) > MAX_RESPONSE) throw new Error('GitHub context response exceeds its transport bound');
      return value;
    };
    const root = async () => {
      const value = await get(`${prefix}/${scope.pull ? 'pulls' : 'issues'}/${scope.number}`);
      if (value?.number !== scope.number || scope.pull && (value.base?.repo?.full_name?.toLowerCase() !== repository || value.head?.repo?.full_name?.toLowerCase() !== repository || !SHA.test(value.head.sha ?? ''))) throw new Error('GitHub returned a different or unsupported discussion');
      if (scope.headSha && value.head.sha !== scope.headSha) throw new Error('GitHub context head changed; reconcile the ticket binding');
      return { ...comment(value, repository, scope, 'root'), number: scope.number, title: text(value.title, 16_000),
        state: value.state, ...(scope.pull ? { headSha: value.head.sha, merged: value.merged === true } : {}) };
    };
    const before = await root(), guard = digest(before);
    if (descriptor.guard && descriptor.guard !== guard) throw new Error('GitHub discussion changed between pages; reread its current references');
    const pageOf = async pageNumber => {
      const suffix = `?per_page=${PAGE_SIZE}&page=${pageNumber}`;
      let values;
      if (kind === 'checks') {
        const result = await get(`${prefix}/commits/${before.headSha}/check-runs${suffix}&filter=latest`);
        values = result?.check_runs;
      } else if (kind === 'statuses') values = await get(`${prefix}/commits/${before.headSha}/statuses${suffix}`);
      else values = await get(`${prefix}/${kind === 'comments' ? `issues/${scope.number}/comments` : `pulls/${scope.number}/${kind === 'reviews' ? 'reviews' : 'comments'}`}${suffix}`);
      if (!Array.isArray(values) || values.length > PAGE_SIZE) throw new Error('GitHub context page is invalid');
      const items = values.map(value => {
        if (kind === 'checks') {
          if (!positive(value?.id) || value.head_sha !== before.headSha || typeof value.name !== 'string') throw new Error('GitHub returned an invalid current-head check');
          return { id: String(value.id), name: text(value.name, 2048), status: value.status, conclusion: value.conclusion ?? null, app: value.app?.slug ?? null,
            summary: text(value.output?.summary), at: value.completed_at ?? value.started_at ?? null };
        }
        if (kind === 'statuses') {
          if (!positive(value?.id) || typeof value.context !== 'string') throw new Error('GitHub returned an invalid commit status');
          return { id: String(value.id), name: text(value.context, 2048), state: value.state, description: text(value.description), at: value.updated_at ?? value.created_at ?? null };
        }
        const item = comment(value, repository, scope, kind);
        return { ...item, ...(item.commitId ? { historical: item.commitId !== before.headSha } : {}) };
      });
      return { items, full: values.length === PAGE_SIZE, version: digest(items) };
    };
    let value, references = [];
    if (kind === 'root') value = before;
    else {
      for (const anchor of descriptor.anchors) if ((await pageOf(anchor.page)).version !== anchor.version) throw new Error('GitHub context changed between pages; reread the discussion');
      const loaded = await pageOf(page);
      let items = loaded.items;
      if (kind === 'review-thread') {
        const original = await get(`${prefix}/pulls/comments/${scope.reviewRootId}`);
        const origin = comment(original, repository, scope, kind);
        if (origin.id !== String(scope.reviewRootId) || origin.parentId) throw new Error('GitHub review root changed or belongs to another thread');
        items = [origin, ...items.filter(item => item.parentId === origin.id)];
      }
      if (kind === 'checks') items = items.filter(item => github.ci.checkApps.includes(item.app));
      if (kind === 'statuses') items = items.filter(item => github.ci.statusContexts.includes(item.name));
      value = { repository, number: scope.number, kind, page, headSha: before.headSha ?? null, items, more: loaded.full, limited: loaded.full && page >= MAX_PAGES };
      if (loaded.full && page < MAX_PAGES) references.push(register({ scope, scopeKey: descriptor.scopeKey, kind, page: page + 1, guard, anchors: [...descriptor.anchors, { page, version: loaded.version }] }));
    }
    if (digest(await root()) !== guard) throw new Error('GitHub discussion changed during the read');
    active();
    const version = contextVersion(value), { args } = prepared;
    if (args.version !== undefined && args.version !== version) throw new Error('GitHub context version changed; reread its current version');
    if (contextBytes(value) > 256 * 1024) throw new Error('GitHub context record exceeds its retained bound');
    return { resource: 'github', id: prepared.id, version, offset: args.offset, ...utf8Slice(JSON.stringify(value), args.offset, args.limit), references,
      source: { repository, number: scope.number, headSha: before.headSha ?? null, observedAt: new Date().toISOString(), guard } };
  };
  return Object.freeze({ references, prepare, validate, read });
}

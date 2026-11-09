import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGitHubAppRequest } from '../channels/github-app.mjs';
import { createGitHubAccountRequest } from '../channels/github-account.mjs';
import { contextBytes, contextVersion, utf8Slice } from './worker-context.mjs';

const SHA = /^[a-f\d]{40}$/;
const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/;
const MAX_BYTES = 256 * 1024;
const PAGE_SIZE = 30;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
function safePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\0-\x1f\x7f:]/.test(value) || value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.' || part.startsWith('-'))) return false;
  return !value.split('/').some(part => /^(?:\.git|\.js-superagent|\.ssh|\.aws|\.azure|\.config|node_modules|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(part));
}
function run(executable, args, { signal, maxBuffer = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => execFile(executable, args, { signal, timeout: 15_000, maxBuffer, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
    if (error) { reject(new Error(signal?.aborted ? 'Context read cancelled' : 'Scoped context command failed')); return; }
    resolve(stdout);
  }));
}
function nativeRequest(executable, repository) {
  return async (endpoint, { signal } = {}) => {
    if (endpoint !== `/repos/${repository}` && !endpoint.startsWith(`/repos/${repository}/`) || /[\0\r\n\\#]/.test(endpoint)) throw new Error('Context request is outside the configured repository');
    const raw = await run(executable, ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint], { signal, maxBuffer: 2 * 1024 * 1024 });
    try { return JSON.parse(raw); } catch { throw new Error('Source returned malformed context JSON'); }
  };
}
function threadNumber(thread, repository) {
  const id = typeof thread === 'string' ? thread.replace(/^github:/, '') : thread?.source === 'github' ? thread.id : undefined;
  if (typeof id !== 'string' || !id.startsWith(`${repository}#`)) return null;
  const match = /^(?:pr:)?([1-9]\d*)$/.exec(id.slice(repository.length + 1));
  return match && Number.isSafeInteger(Number(match[1])) ? { number: Number(match[1]), pull: id.startsWith(`${repository}#pr:`) } : null;
}
function originRepository(value) {
  const normalized = value.trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(normalized);
  if (ssh) return ssh[1].toLowerCase();
  try { const url = new URL(normalized); if (['https:', 'ssh:'].includes(url.protocol) && url.hostname.toLowerCase() === 'github.com' && (!url.username || url.protocol === 'ssh:' && url.username === 'git') && !url.password && !url.search && !url.hash && !url.port) return url.pathname.slice(1).toLowerCase(); } catch { /* Not a permitted origin. */ }
  return null;
}
function sourceItem(value, repository, number, kind) {
  if (!value || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.body !== 'string' && value.body !== null) throw new Error('Source returned invalid context content');
  const url = new URL(value.html_url);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || ![`/${repository}/issues/${number}`, `/${repository}/pull/${number}`].includes(url.pathname.toLowerCase())) throw new Error('Source context link is outside the selected thread');
  const text = value.body ?? '';
  if (contextBytes(text) > MAX_BYTES) throw new Error('Source context item exceeds size budget');
  return { id: String(value.id), kind, text, url: url.href, actor: value.user?.login ?? null, at: value.updated_at ?? value.submitted_at ?? value.created_at ?? null,
    ...(value.in_reply_to_id ? { parentId: String(value.in_reply_to_id) } : {}), ...(typeof value.path === 'string' && safePath(value.path) ? { path: value.path } : {}) };
}

/** Candidate-scoped, read-only source catalog. IDs are minted by the host; the model never supplies URLs or filesystem paths. */
export function createCandidateSourceContext({ candidate, projectRoot, github, repository = github?.repository, request: injectedRequest, assertActive = () => {}, signal, maxRecords = 256 } = {}) {
  const repo = repository?.toLowerCase();
  if (!REPOSITORY.test(repo ?? '') || !candidate?.triggers?.length || !projectRoot) return { contextReferences: [], async readContextRecord() { throw new Error('Source context is not configured'); } };
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1024) throw new Error('Invalid source context record budget');
  const transport = injectedRequest ?? (github?.app ? createGitHubAppRequest({ repository: repo, app: github.app, ci: github.ci })
    : github?.account ? createGitHubAccountRequest({ ...github, repository: repo }) : nativeRequest(github?.executable ?? 'gh', repo));
  const descriptors = new Map(), cache = new Map(), loading = new Map(), threads = new Map(), shas = new Set();
  const register = descriptor => {
    const id = `${descriptor.resource}:${repo}:${digest(descriptor)}`;
    if (!descriptors.has(id)) { if (descriptors.size >= maxRecords) throw new Error('Candidate source reference budget exhausted'); descriptors.set(id, descriptor); }
    return { resource: descriptor.resource, id };
  };
  const addThread = value => { const thread = threadNumber(value, repo); if (thread) { const old = threads.get(thread.number); threads.set(thread.number, { ...thread, pull: thread.pull || !!old?.pull }); } };
  addThread(candidate.thread?.ref); addThread(candidate.thread?.key);
  let directIssue = false, directPull = false;
  for (const trigger of candidate.triggers) {
    if (trigger.source !== 'github' || trigger.meta?.repository?.toLowerCase() !== repo) continue;
    for (const thread of trigger.threads ?? []) addThread(thread);
    const directThreads = (trigger.threads ?? []).map(value => threadNumber(value, repo)).filter(Boolean);
    const pull = !!trigger.meta.pullRequest || !!trigger.meta.pullEvent || directThreads.some(thread => thread.pull);
    directPull ||= pull;
    directIssue ||= !pull && directThreads.some(thread => !thread.pull);
    const head = trigger.meta?.pullRequest?.headSha ?? trigger.meta?.headSha;
    if (typeof head === 'string' && SHA.test(head.toLowerCase()) && (!trigger.meta?.pullRequest || trigger.meta.pullRequest.headRepository?.toLowerCase() === repo)) shas.add(head.toLowerCase());
  }
  for (const ticket of candidate.tickets ?? []) {
    for (const follow of ticket.follows ?? []) addThread(follow.thread);
    for (const thread of ticket.threads ?? []) addThread(thread);
  }
  const initial = [];
  for (const { number, pull } of threads.values()) {
    initial.push(register({ resource: 'sources', kind: 'root', number, pull }));
    initial.push(register({ resource: 'sources', kind: 'comments', number, pull, page: 1 }));
    if (pull) {
      initial.push(register({ resource: 'sources', kind: 'reviews', number, pull, page: 1 }));
      initial.push(register({ resource: 'sources', kind: 'review-comments', number, pull, page: 1 }));
    }
  }
  for (const sha of shas) initial.push(register({ resource: 'repository', kind: 'tree', sha, path: '', page: 1 }));
  // Resolve this reference only when requested. The resulting tree and every child
  // reference use one immutable commit, even if the default branch later advances.
  if (!shas.size && directIssue && !directPull) initial.push(register({ resource: 'repository', kind: 'default-tree' }));
  const assert = () => { if (signal?.aborted) throw new Error('Source context cancelled'); assertActive(); };
  const get = async endpoint => {
    if (endpoint !== `/repos/${repo}` && !endpoint.startsWith(`/repos/${repo}/`) || /[\0\r\n\\#]/.test(endpoint)) throw new Error('Context request is outside the configured repository');
    assert(); const value = await transport(endpoint, { method: 'GET', signal }); assert();
    if (contextBytes(value) > 2 * 1024 * 1024) throw new Error('Source response exceeded context transport budget');
    return value;
  };
  const git = async args => {
    assert(); const result = await run('git', ['-C', projectRoot, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], { signal }); assert(); return result;
  };
  const localCommit = async sha => {
    let origin;
    try { origin = await git(['remote', 'get-url', 'origin']); }
    catch { assert(); return false; }
    if (originRepository(origin) !== repo) throw new Error('Local repository origin does not match candidate repository');
    let type;
    try { type = (await git(['cat-file', '-t', sha])).trim(); }
    catch { assert(); return false; }
    if (type !== 'commit') throw new Error('Fixed candidate commit is not a commit');
    return true;
  };
  const remoteObject = async (kind, sha) => {
    if (!SHA.test(sha)) throw new Error('Invalid fixed repository object');
    const value = await get(`/repos/${repo}/git/${kind}/${sha}`);
    if (value?.sha !== sha) throw new Error('Source returned a different repository object');
    return value;
  };
  const remoteEntries = async descriptor => {
    let treeSha = descriptor.objectSha;
    if (!treeSha) {
      if (descriptor.path) throw new Error('Remote directory has no fixed tree identity');
      const commit = await remoteObject('commits', descriptor.sha);
      treeSha = commit.tree?.sha;
    }
    const tree = await remoteObject('trees', treeSha);
    if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error('Repository tree is incomplete or exceeds its size budget');
    return tree.tree.map(item => {
      if (!item || typeof item.path !== 'string' || !item.path || item.path.includes('/') || !SHA.test(item.sha) || !['blob','tree','commit'].includes(item.type)) throw new Error('Malformed fixed repository tree');
      return { mode: item.mode, type: item.type, name: item.path, objectSha: item.sha };
    });
  };
  let defaultTree, repositoryId;
  const readRepositoryIdentity = async () => {
    const value = await get(`/repos/${repo}`);
    if (value?.full_name?.toLowerCase() !== repo || !Number.isSafeInteger(value.id) || value.id < 1 || repositoryId !== undefined && value.id !== repositoryId) throw new Error('Source returned a different repository identity');
    repositoryId = value.id;
    return value;
  };
  const load = async descriptor => {
    if (descriptor.resource === 'sources') {
      const prefix = `/repos/${repo}`;
      if (descriptor.kind === 'root') {
        const value = await get(`${prefix}/${descriptor.pull ? 'pulls' : 'issues'}/${descriptor.number}`);
        if (value.number !== descriptor.number || descriptor.pull && value.base?.repo?.full_name?.toLowerCase() !== repo) throw new Error('Source returned a different root discussion');
        return { value: { ...sourceItem(value, repo, descriptor.number, 'root'), title: value.title, number: descriptor.number }, references: [] };
      }
      const part = descriptor.kind === 'comments' ? `issues/${descriptor.number}/comments` : `pulls/${descriptor.number}/${descriptor.kind === 'reviews' ? 'reviews' : 'comments'}`;
      const values = await get(`${prefix}/${part}?per_page=${PAGE_SIZE}&page=${descriptor.page}`);
      if (!Array.isArray(values) || values.length > PAGE_SIZE) throw new Error('Invalid discussion context page');
      const references = [];
      if (values.length === PAGE_SIZE && descriptor.page < 20) references.push(register({ ...descriptor, page: descriptor.page + 1 }));
      return { value: { kind: descriptor.kind, number: descriptor.number, page: descriptor.page, items: values.map(value => sourceItem(value, repo, descriptor.number, descriptor.kind)),
        more: values.length === PAGE_SIZE, limited: values.length === PAGE_SIZE && descriptor.page >= 20 }, references };
    }
    if (descriptor.kind === 'default-tree') {
      if (defaultTree) return load(defaultTree);
      const repository = await readRepositoryIdentity(), branch = repository.default_branch;
      if (typeof branch !== 'string' || !/^[A-Za-z\d_][A-Za-z\d_./-]{0,254}$/.test(branch) || branch.includes('..') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid repository default branch');
      const ref = await get(`/repos/${repo}/git/ref/heads/${branch}`);
      if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !SHA.test(ref.object?.sha)) throw new Error('Source returned an invalid default branch commit');
      defaultTree = { resource: 'repository', kind: 'tree', sha: ref.object.sha, path: '', page: 1 };
      return load(defaultTree);
    }
    if (!SHA.test(descriptor.sha) || !safePath(descriptor.path)) throw new Error('Unsafe fixed repository context');
    const local = await localCommit(descriptor.sha);
    // Recheck before each uncached remote record. A frozen commit is not permission
    // to keep reading a different repository that later acquires the same name.
    if (!local) await readRepositoryIdentity();
    const object = `${descriptor.sha}${descriptor.path ? `:${descriptor.path}` : '^{tree}'}`;
    if (descriptor.kind === 'file') {
      let value;
      if (local) value = await git(['cat-file', 'blob', object]);
      else {
        const blob = await remoteObject('blobs', descriptor.objectSha);
        if (blob.encoding !== 'base64' || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_BYTES || typeof blob.content !== 'string') throw new Error('Repository blob exceeds its text budget or uses an unsupported encoding');
        const encoded = blob.content.replace(/[\r\n]/g, '');
        if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded)) throw new Error('Invalid repository blob encoding');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== blob.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== descriptor.objectSha) throw new Error('Repository blob content does not match its fixed identity');
        value = bytes.toString('utf8');
      }
      if (value.includes('\0') || value.includes('\ufffd')) throw new Error('Repository context is not UTF-8 text');
      return { value: { repository: repo, sha: descriptor.sha, path: descriptor.path, text: value }, references: [] };
    }
    const entries = (local ? (await git(['ls-tree', '-z', object])).split('\0').filter(Boolean).map(line => {
      const match = /^(\d+) (blob|tree|commit) ([a-f\d]{40})\t([\s\S]+)$/.exec(line); if (!match) throw new Error('Malformed fixed repository tree');
      return { mode: match[1], type: match[2], name: match[4], objectSha: match[3] };
    }) : await remoteEntries(descriptor)).filter(item => (item.type === 'tree' ? item.mode === '040000' : item.type === 'blob' && ['100644', '100755'].includes(item.mode)) && safePath(`${descriptor.path ? descriptor.path + '/' : ''}${item.name}`));
    const selected = entries.slice((descriptor.page - 1) * PAGE_SIZE, descriptor.page * PAGE_SIZE);
    const references = selected.map(item => register({ resource: 'repository', kind: item.type === 'tree' ? 'tree' : 'file', sha: descriptor.sha, objectSha: item.objectSha, path: `${descriptor.path ? descriptor.path + '/' : ''}${item.name}`, page: 1 }));
    if (entries.length > descriptor.page * PAGE_SIZE) references.push(register({ ...descriptor, page: descriptor.page + 1 }));
    return { value: { repository: repo, sha: descriptor.sha, path: descriptor.path, page: descriptor.page, entries: selected.map((item, index) => ({ name: item.name, type: item.type, reference: references[index] })) }, references };
  };
  return { contextReferences: initial,
    async readContextRecord(resource, id, { version, offset = 0, limit = 8000 } = {}) {
      assert(); const descriptor = descriptors.get(id);
      if (!descriptor || descriptor.resource !== resource) throw new Error('Source reference is outside the current candidate');
      if (!Number.isSafeInteger(limit) || limit < 256 || limit > 32_000) throw new Error('Invalid source context page size');
      let record = cache.get(id);
      if (!record) {
        if (!loading.has(id)) loading.set(id, (async () => {
          const result = await load(descriptor);
          if (contextBytes(result.value) > MAX_BYTES) throw new Error('Source record exceeds its retained size budget');
          result.version = contextVersion(result.value); cache.set(id, result); return result;
        })());
        try { record = await loading.get(id); } finally { loading.delete(id); }
      }
      assert(); if (version !== undefined && version !== record.version) throw new Error('Source context version changed');
      if (offset > 0 && version === undefined) throw new Error('Source continuation requires a version');
      return { resource, id, version: record.version, offset, ...utf8Slice(JSON.stringify(record.value), offset, limit), references: record.references,
        ...(resource === 'repository' ? { provenance: { repository: record.value.repository, sha: record.value.sha, path: record.value.path } } : {}) };
    },
  };
}

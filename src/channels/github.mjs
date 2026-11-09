import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createGitHubAppRequest } from './github-app.mjs';
import { createGitHubAccountRequest } from './github-account.mjs';
import { createGitHubReviewTransport } from './github-review.mjs';
import { GitHubRequestError, classifyGitHubError, githubRepositoryFailure, githubIdentityError } from './github-errors.mjs';
import { summarizeGitHubCi } from '../runtime/github-ci-observation.mjs';

const API_VERSION = '2026-03-10';
const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_PAGES = 100;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i;
const SHA = /^[a-f0-9]{40}$/i;
const FAILED_CHECKS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty single-line string`);
  return value;
}
function number(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
function repositoryName(value) {
  const repository = nonempty(value, 'GitHub repository').toLowerCase();
  const parts = repository.split('/');
  if (parts.length !== 2 || !LOGIN.test(parts[0]) || !/^[a-z0-9_.-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1])) throw new Error('GitHub repository must be owner/repo');
  return repository;
}
function actor(user) {
  if (!user || typeof user.login !== 'string' || !user.login.trim() || typeof user.type !== 'string') throw new Error('GitHub returned an invalid author');
  return { login: user.login.toLowerCase(), id: String(number(user.id, 'GitHub author ID')), type: user.type };
}
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('GitHub returned an invalid creation time');
  return new Date(value).toISOString();
}
function body(value) {
  if (value === null) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) throw new Error('GitHub body exceeds the supported 256 KiB limit');
  return value;
}
function link(value, repository, issueNumber, commentId, pull = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('GitHub returned an invalid resource URL'); }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.pathname.toLowerCase() !== `/${repository}/${pull ? 'pull' : 'issues'}/${issueNumber}` ||
      url.search || url.hash !== (commentId === undefined ? '' : `#issuecomment-${commentId}`)) throw new Error('GitHub resource URL does not match its configured issue');
  return url.href;
}
function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error('GitHub head SHA must be a full 40-character commit ID');
  return value.toLowerCase();
}
function pullLink(value, repository, pullNumber, anchor = '') {
  let url;
  try { url = new URL(value); } catch { throw new Error('GitHub returned an invalid pull request URL'); }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.pathname.toLowerCase() !== `/${repository}/pull/${pullNumber}` ||
      url.search || !(anchor instanceof RegExp ? anchor.test(url.hash) : url.hash === anchor)) throw new Error('GitHub resource URL does not match its configured pull request');
  return url.href;
}
function boundedText(value, limit = 32 * 1024) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('GitHub returned invalid check output');
  const bytes = Buffer.from(value);
  return bytes.length <= limit ? value : `${bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD$/, '')}\n[truncated]`;
}
function ciOptions(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub ci must be an object');
  if (Object.keys(value).some(key => !['checkApps', 'statusActors', 'statusContexts'].includes(key))) throw new Error('GitHub ci contains an unsupported setting');
  const result = {};
  for (const key of ['checkApps', 'statusActors', 'statusContexts']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || !value[key].length || value[key].some(item => typeof item !== 'string' || !item.trim() || /[\0\r\n]/.test(item))) throw new Error(`GitHub ci.${key} must be a non-empty string list`);
    if (key === 'checkApps' && value[key].some(item => !APP_SLUG.test(item))) throw new Error('GitHub checkApps must contain app slugs');
    if (key === 'statusActors' && value[key].some(item => !LOGIN.test(item.replace(/\[bot\]$/i, '')))) throw new Error('GitHub statusActors must contain account logins');
    if (key === 'statusContexts' && value[key].some(item => item.length > 255 || /[\x00-\x1f\x7f]/.test(item))) throw new Error('GitHub statusContexts must contain at most 255 printable characters');
    result[key] = [...new Set(value[key].map(item => key === 'statusContexts' ? item : item.toLowerCase()))];
  }
  if (Boolean(result.statusActors) !== Boolean(result.statusContexts)) throw new Error('GitHub statusContexts and statusActors must be configured together');
  if (!result.checkApps && !result.statusContexts) throw new Error('GitHub ci must enable checkApps or commit statuses');
  return result;
}
/** Shared canonical review identity for repository discovery, webhook reads and bound feedback. */
export async function githubReviewCommentEvent({ repository, pull, comment, readParent, observedAt = new Date().toISOString() }) {
  const id = number(comment?.id, 'GitHub review comment ID'), prefix = `/repos/${repository}`;
  if (comment.pull_request_url !== undefined && comment.pull_request_url !== `https://api.github.com${prefix}/pulls/${pull.number}`) throw new Error('GitHub review comment belongs to a different PR');
  const line = comment.line == null ? null : number(comment.line, 'GitHub review line');
  const side = line === null && comment.side == null ? null : comment.side;
  if (side !== null && !['LEFT', 'RIGHT'].includes(side) || comment.original_side != null && !['LEFT', 'RIGHT'].includes(comment.original_side)) throw new Error('GitHub returned an invalid review side');
  const chain = [comment], seen = new Set([id]);
  while (chain.at(-1).in_reply_to_id != null) {
    const parentId = number(chain.at(-1).in_reply_to_id, 'GitHub review parent ID');
    if (seen.has(parentId) || chain.length >= 32) throw new Error('Invalid GitHub review ancestry');
    seen.add(parentId);
    const parent = await readParent(parentId);
    if (parent?.id !== parentId || parent.pull_request_url !== undefined && parent.pull_request_url !== `https://api.github.com${prefix}/pulls/${pull.number}`) throw new Error('GitHub returned a different review parent');
    chain.push(parent);
  }
  const root = chain.at(-1), context = [...new Map([root, chain[1]].filter(value => value && value.id !== id).map(value => [value.id, value])).values()];
  return { repository, pullNumber: pull.number, headSha: pull.headSha, pullState: pull.state, pullRequest: pull,
    kind: 'review_comment', id: `github:${repository}:review_comment:${id}`, text: body(comment.body), actor: actor(comment.user),
    createdAt: date(comment.created_at), updatedAt: date(comment.updated_at ?? comment.created_at), observedAt,
    url: pullLink(comment.html_url, repository, pull.number, new RegExp(`^#(?:discussion_r${id}|discussion-diff-\\d+)$`)),
    path: nonempty(comment.path, 'GitHub review path'), line, side, commitId: sha(comment.commit_id),
    historicalPosition: sha(comment.commit_id) !== pull.headSha,
    ...(comment.pull_request_review_id == null ? {} : {reviewId:number(comment.pull_request_review_id,'GitHub review ID')}),
    reviewCommentId: id, reviewRootId: root.id, ...(comment.in_reply_to_id == null ? {} : { inReplyToId: number(comment.in_reply_to_id, 'GitHub review parent ID') }),
    originalLine: comment.original_line == null ? null : number(comment.original_line, 'GitHub original review line'),
    ...(comment.original_side == null ? {} : { originalSide: comment.original_side }), diffHunk: boundedText(comment.diff_hunk, 16 * 1024),
    reviewContext: context.map(value => ({ commentId: value.id, text: boundedText(value.body, 8 * 1024), actor: actor(value.user),
      url: pullLink(value.html_url, repository, pull.number, new RegExp(`^#(?:discussion_r${value.id}|discussion-diff-\\d+)$`)),
      ...(value.commit_id ? { commitId: sha(value.commit_id) } : {}) })) };
}
function issueState(issue) {
  if (!['open', 'closed'].includes(issue.state)) throw new Error('GitHub returned an invalid issue state');
  return issue.state;
}
export function ghRequest(executable, endpoint, { method = 'GET', body: input, signal, env, includeHeaders = false, headers: requestHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method,
      '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, endpoint];
    if (includeHeaders) args.push('--include');
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (!['if-modified-since'].includes(name.toLowerCase()) || typeof value !== 'string' || /[\0\r\n]/.test(value)) { reject(new Error('Unsupported GitHub conditional request header')); return; }
      args.push('-H', `${name}: ${value}`);
    }
    if (input !== undefined) args.push('--input', '-');
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal, ...(env === undefined ? {} : { env }) });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', bytes = 0, error;
    let escalation;
    const fail = reason => {
      error ??= new Error(reason);
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => fail('GitHub API request timed out'), 30_000);
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE) { fail('GitHub API response exceeded 16 MiB'); return; }
      stdout += chunk;
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
    child.stdin.on('error', () => {});
    child.on('error', cause => { error ??= new Error(`Cannot start GitHub CLI (${cause.code ?? 'spawn error'})`); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(escalation);
      if (error) { reject(error); return; }
      const boundary = /\r?\n\r?\n/.exec(stdout), status = Number(stdout.match(/^HTTP\/\S+\s+(\d{3})\b/)?.[1]);
      const headers = {};
      if (includeHeaders && boundary && status) {
        for (const line of stdout.slice(0, boundary.index).split(/\r?\n/).slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      if (includeHeaders && status === 304 && boundary) { resolve({ status: 304, body: null, headers }); return; }
      if (code !== 0) {
        // Preserve only quota timing facts, never response text or credential-bearing diagnostics.
        const statusCode = status || Number(stderr.match(/\bHTTP\s+(\d{3})\b/i)?.[1]);
        let response; try { response = JSON.parse(includeHeaders && boundary ? stdout.slice(boundary.index + boundary[0].length) : stdout); } catch { /* A status does not require a body. */ }
        const failure = new GitHubRequestError(statusCode, { message: response?.message });
        failure.headers = Object.fromEntries(['retry-after', 'x-ratelimit-reset', 'x-ratelimit-remaining', 'x-poll-interval'].filter(key => headers[key] !== undefined).map(key => [key, headers[key]]));
        reject(failure); return;
      }
      try {
        if (!includeHeaders) { resolve(JSON.parse(stdout)); return; }
        if (!boundary || status < 200 || status >= 300) throw new Error('Invalid response headers');
        resolve({ body: JSON.parse(stdout.slice(boundary.index + boundary[0].length)), headers });
      } catch { reject(new Error('GitHub API returned malformed JSON')); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
function marker(projectId, messageId) {
  if (!SAFE_ID.test(projectId ?? '') || !SAFE_ID.test(messageId ?? '')) throw new Error('Invalid GitHub delivery identity');
  return `<!-- js-superagent:${projectId}:${messageId} -->`;
}
/** Omitting projectId also suppresses echoes from other instances sharing an issue. */
export function isGitHubReceipt(text, projectId) {
  if (typeof text !== 'string') return false;
  if (projectId === undefined) return /<!-- js-superagent:[a-zA-Z0-9_-]{1,200}:[a-zA-Z0-9_-]{1,200} -->/.test(text);
  if (!SAFE_ID.test(projectId)) return false;
  return text.includes(`<!-- js-superagent:${projectId}:`) &&
    new RegExp(`<!-- js-superagent:${projectId}:[a-zA-Z0-9_-]{1,200} -->`).test(text);
}

/** Uses configured GitHub App installation authentication, or the existing gh login. */
export function createGitHubChannel(options, { request: injectedRequest } = {}) {
  if (!options || typeof options !== 'object') throw new Error('GitHub configuration is required');
  const repository = repositoryName(options.repository);
  if (!Array.isArray(options.allowedActors) || !options.allowedActors.length || options.allowedActors.some(value => !LOGIN.test(value))) throw new Error('GitHub allowedActors must be a non-empty login list');
  const allowedActors = [...new Set(options.allowedActors.map(value => value.toLowerCase()))];
  if (options.issues !== undefined && (!Array.isArray(options.issues) || !options.issues.length)) throw new Error('GitHub issues must be a non-empty issue-number list');
  const issues = options.issues?.map(value => number(value, 'GitHub issue number'));
  const command = options.command ?? '/js-superagent';
  if (!/^\/[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(command)) throw new Error('GitHub command must be one slash command');
  const executable = nonempty(options.executable ?? 'gh', 'GitHub executable');
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 86_400_000) throw new Error('GitHub pollIntervalMs must be between 1000 and 86400000');
  const ci = ciOptions(options.ci);
  if (injectedRequest !== undefined && typeof injectedRequest !== 'function') throw new Error('GitHub request must be a function');
  if (options.account && options.app) throw new Error('GitHub account and App authentication are mutually exclusive');
  const accountRequest = options.account ? createGitHubAccountRequest(options) : undefined;
  const appRequest = options.app ? createGitHubAppRequest({ repository, app: options.app, ci }) : undefined;
  const request = injectedRequest ?? accountRequest ?? appRequest ?? ((endpoint, init) => ghRequest(executable, endpoint, init));
  const sendingIdentity = async () => options.app
    ? typeof request.identity === 'function' ? request.identity() : (() => { throw new Error('GitHub App transport must provide an authenticated bot identity'); })()
    : actor(await request('/user', { method: 'GET' }));
  const authoredBy = (comment, user) => String(comment?.user?.id) === user.id && (!options.app ||
    (comment.user.type === 'Bot' && (comment.performed_via_github_app == null || String(comment.performed_via_github_app.id) === options.app.appId)));
  const prefix = `/repos/${repository}`;
  const permittedIssue = value => !issues || issues.includes(value);
  async function pages(endpoint, field) {
    const items = [];
    let expected = 0;
    for (let page = 1; page <= MAX_PAGES + 1; page++) {
      const result = await request(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { method: 'GET' });
      const batch = field ? result?.[field] : result;
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('GitHub returned an invalid paginated response');
      if (field) {
        if (!Number.isSafeInteger(result.total_count) || result.total_count < 0) throw new Error('GitHub returned an invalid pagination count');
        expected = Math.max(expected, result.total_count);
      }
      if (page > MAX_PAGES && batch.length) throw new Error('GitHub pagination exceeds 100 pages; narrow the configured issues');
      items.push(...batch);
      if (batch.length < 100) {
        if (items.length < expected) throw new Error('GitHub pagination ended before all results were returned');
        return items;
      }
    }
    throw new Error('GitHub pagination did not finish');
  }
  function receipt(comment, issueNumber, pull = false) {
    const id = number(comment?.id, 'GitHub comment ID');
    return { id: String(id), url: link(comment.html_url, repository, issueNumber, id, pull) };
  }
  async function pullSnapshot(pullNumber) {
    number(pullNumber, 'GitHub pull request number');
    const raw = await request(`${prefix}/pulls/${pullNumber}`, { method: 'GET' });
    if (raw?.number !== pullNumber || raw.base?.repo?.full_name?.toLowerCase() !== repository) throw githubIdentityError('GitHub returned a different pull request repository');
    if (raw.head?.repo?.full_name?.toLowerCase() !== repository) throw new Error('Fork pull requests are not supported; the head must belong to the configured repository');
    if (typeof raw.merged !== 'boolean') throw new Error('GitHub returned an invalid pull request merge state');
    return { raw, metadata: { repository, number: pullNumber, id: number(raw.id, 'GitHub pull request ID'),
      headSha: sha(raw.head.sha), headRef: nonempty(raw.head.ref, 'GitHub pull request head ref'), headRepository: repository,
      ...(raw.base.ref === undefined ? {} : { baseRef: nonempty(raw.base.ref, 'GitHub PR base ref') }),
      ...(raw.base.sha === undefined ? {} : { baseSha: sha(raw.base.sha) }),
      state: issueState(raw), merged: raw.merged, url: pullLink(raw.html_url, repository, pullNumber), title: nonempty(raw.title, 'GitHub pull request title') } };
  }
  function bindings(values, history = false) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error('trackedPullRequests must be an array of at most 1000 bindings');
    const normalized = new Map();
    for (const value of values) {
      const pullNumber = number(value?.number, 'Tracked GitHub pull request number');
      const headSha = sha(value?.headSha);
      if (value.ticketId !== undefined && !SAFE_ID.test(value.ticketId)) throw new Error('Invalid GitHub pull request ticket identity');
      const key = history ? `${pullNumber}:${headSha}:${value.ticketId ?? ''}` : pullNumber;
      if (!history && normalized.has(key)) throw new Error('GitHub pull request has duplicate bindings');
      normalized.set(key, { number: pullNumber, headSha, ...(value.ticketId === undefined ? {} : { ticketId: value.ticketId }) });
    }
    return [...normalized.values()].sort((a, b) => a.number - b.number);
  }
  async function checkText(check) {
    const lines = [`Check: ${nonempty(check.name, 'GitHub check name')}`, `Status: ${check.status}; conclusion: ${check.conclusion ?? 'none'}`,
      boundedText(check.output?.title), boundedText(check.output?.summary), boundedText(check.output?.text)];
    if (check.status === 'completed' && FAILED_CHECKS.has(check.conclusion)) {
      const annotations = await request(`${prefix}/check-runs/${number(check.id, 'GitHub check ID')}/annotations?per_page=20&page=1`, { method: 'GET' });
      if (!Array.isArray(annotations) || annotations.length > 20) throw new Error('GitHub returned invalid check annotations');
      for (const annotation of annotations) lines.push(
        `${boundedText(annotation.path, 1024)}:${annotation.start_line ?? '?'} ${boundedText(annotation.title, 1024)}`,
        boundedText(annotation.message, 4096));
      if (annotations.length === 20 || check.output?.annotations_count > annotations.length) lines.push('[Only the first 20 check annotations are included; further annotations may be omitted.]');
    }
    return boundedText(lines.filter(Boolean).join('\n\n'), 240 * 1024);
  }
  return {
    ...createGitHubReviewTransport({ repository, request, graphql: request.reviewGraphql, allowWrite: !options.app || options.app.pullRequestReviews === true }),
    options: { repository, allowedActors, ...(issues ? { issues: [...issues] } : {}), command, executable, pollIntervalMs, ...(options.account ? { account: { ...options.account } } : {}), ...(ci ? { ci } : {}), ...(options.app ? { app: { ...options.app } } : {}) },
    async getPullRequest(pullNumber) { return (await pullSnapshot(pullNumber)).metadata; },
    async repositoryIdentity() {
      const repo = await request(prefix, { method: 'GET' });
      if (repo?.full_name?.toLowerCase() !== repository || !Number.isSafeInteger(repo.id) || repo.id < 1) {
        throw Object.assign(new Error('GitHub repository identity could not be verified'), { code: 'GITHUB_REPOSITORY_IDENTITY_UNVERIFIED' });
      }
      return { repository, repositoryId: repo.id };
    },
    async probe() {
      const user = await sendingIdentity();
      const repo = await request(prefix, { method: 'GET' });
      if (options.account && repo?.permissions?.push !== true) throw new Error('GitHub agent account requires repository write access');
      if (options.account) {
        if (typeof request.notifications !== 'function') throw new Error('GitHub account transport must support notifications');
        await request.notifications(`${prefix}/notifications?all=true&per_page=1`, { method: 'GET' });
      }
      if (repo?.full_name?.toLowerCase() !== repository || repo.has_issues !== true) throw new Error('GitHub repository is inaccessible or has Issues disabled');
      return { repository, ...(Number.isSafeInteger(repo.id) && repo.id > 0 ? { repositoryId: repo.id } : {}), login: user.login, actorId: user.id, issuesEnabled: true, ...(options.account ? { authentication: 'account' } : {}), ...(options.app ? { authentication: 'app', appId: options.app.appId, installationId: options.app.installationId } : {}) };
    },
    async poll({ trackedIssues = [], trackedPullRequests = [], contextPullRequests = [], candidateReviewComments = [], skipObjects = [] } = {}) {
      if (!Array.isArray(trackedIssues)) throw new Error('trackedIssues must be an array');
      const pulls = bindings(trackedPullRequests);
      if (!Array.isArray(candidateReviewComments) || candidateReviewComments.length > 1000) throw new Error('Invalid GitHub review candidates');
      const targets = new Map(pulls.map(pull => [pull.number, pull]));
      if(!Array.isArray(contextPullRequests)||contextPullRequests.length>1000)throw new Error('Invalid GitHub PR context subscriptions');
      for(const value of contextPullRequests){const pullNumber=number(value,'Context PR number');targets.set(pullNumber,{...(targets.get(pullNumber)??{number:pullNumber}),context:true});}
      for (const candidate of candidateReviewComments) {
        const pullNumber = number(candidate?.number, 'Candidate PR number'), commentId = number(candidate?.commentId, 'Candidate review comment ID');
        if (!targets.has(pullNumber)) targets.set(pullNumber, { number: pullNumber, candidateIds: new Set() });
        targets.get(pullNumber).candidateIds?.add(commentId);
      }
      if (!Array.isArray(skipObjects) || skipObjects.some(item => !['issue', 'pull'].includes(item?.kind) || !Number.isSafeInteger(item.number) || item.number < 1)) throw new Error('Invalid GitHub skipped objects');
      const skipped = new Set(skipObjects.map(item => `${item.kind}:${item.number}`));
      const observedAt = new Date().toISOString(), objects = [], errors = [], discovery = { complete: !!issues };
      let repositoryVerified = false;
      const numbers = new Set(issues ?? []), snapshots = new Map();
      const failed = (error, scope, object) => {
        const fact = classifyGitHubError(error);
        if (githubRepositoryFailure(error)) errors.push({ scope: 'repository', error: fact });
        if (object) objects.push({ ...object, status: 'failed', observedAt, error: fact });
        else if (!githubRepositoryFailure(error)) errors.push({ scope, error: fact });
      };
      if (options.account) {
        try {
          const repo = await request(prefix, { method: 'GET' });
          if (repo?.full_name?.toLowerCase() !== repository || repo.permissions?.push !== true || repo.has_issues !== true) throw githubIdentityError('GitHub agent repository access could not be verified');
          repositoryVerified = true;
        } catch (error) { failed(error, 'repository'); }
      }
      if (!issues && !options.account) {
        try {
          const discovered = await pages(`${prefix}/issues?state=open&sort=created&direction=asc`);
          repositoryVerified = true;
          discovery.complete = true;
          for (const issue of discovered) {
            try {
              if (issue?.pull_request) continue;
              const issueNumber = number(issue?.number, 'GitHub issue number');
              numbers.add(issueNumber); snapshots.set(issueNumber, issue);
            } catch (error) { discovery.complete = false; failed(error, 'discovery'); }
          }
        } catch (error) { failed(error, 'discovery'); }
      }
      for (const value of trackedIssues) { number(value, 'Tracked GitHub issue number'); if (permittedIssue(value)) numbers.add(value); }
      if (numbers.size > 1000) throw new Error('GitHub polling exceeds 1000 issues; narrow the configured issues');
      const events = []; let bytes = 0;
      const append = event => {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (events.length >= MAX_EVENTS || bytes > MAX_EVENT_BYTES) throw new Error('GitHub poll exceeds event limits; narrow the configured issues');
        events.push(event);
      };
      const inspectObject = async (kind, objectNumber, work) => {
        if (skipped.has(`${kind}:${objectNumber}`)) return;
        const start = events.length, previousBytes = bytes;
        try { objects.push({ kind, number: objectNumber, status: 'ok', observedAt, ...await work() }); }
        catch (error) { events.splice(start); bytes = previousBytes; failed(error, 'object', { kind, number: objectNumber }); }
      };
      for (const issueNumber of [...numbers].sort((a, b) => a - b)) await inspectObject('issue', issueNumber, async () => {
        const issue = snapshots.get(issueNumber) ?? await request(`${prefix}/issues/${issueNumber}`, { method: 'GET' });
        if (issue?.pull_request) return { ignored: true };
        if (issue?.number !== issueNumber) throw new Error('GitHub returned a different issue');
        const issueId = number(issue.id, 'GitHub issue ID'), state = issueState(issue);
        append({ id: `github:${repository}:issue:${issueId}`, repository, issueNumber, issueId, kind: 'issue',
          text: body(issue.body), title: nonempty(issue.title, 'GitHub issue title'), actor: actor(issue.user),
          createdAt: date(issue.created_at), url: link(issue.html_url, repository, issueNumber), issueState: state });
        for (const comment of await pages(`${prefix}/issues/${issueNumber}/comments`)) {
          const commentId = number(comment.id, 'GitHub comment ID');
          append({ id: `github:${repository}:comment:${commentId}`, repository, issueNumber, issueId, kind: 'comment',
            text: body(comment.body), actor: actor(comment.user), createdAt: date(comment.created_at), updatedAt: date(comment.updated_at ?? comment.created_at), observedAt: new Date().toISOString(),
            url: link(comment.html_url, repository, issueNumber, commentId), issueState: state });
        }
      return { state };
      });
      for (const binding of targets.values()) await inspectObject('pull', binding.number, async () => {
        const { raw, metadata: pull } = await pullSnapshot(binding.number);
        const common = { repository, pullNumber: pull.number, headSha: pull.headSha, pullState: pull.state, pullRequest: pull };
        if (binding.candidateIds) {
          for (const commentId of binding.candidateIds) {
            const comment = await request(`${prefix}/pulls/comments/${commentId}`, { method: 'GET' });
            if (comment?.id !== commentId || comment.pull_request_url !== `https://api.github.com${prefix}/pulls/${pull.number}`) throw new Error('GitHub returned a different review candidate');
            append(await githubReviewCommentEvent({ repository, pull, comment, observedAt,
              readParent: id => request(`${prefix}/pulls/comments/${id}`, { method: 'GET' }) }));
          }
          return { state: pull.state, headSha: pull.headSha, merged: pull.merged };
        }
        append({ ...common, kind: 'pull_request_state', id: `github:${repository}:pull_request_state:${pull.number}:${pull.headSha}:${pull.merged ? 'merged' : pull.state}`,
          text: '', createdAt: date(raw.updated_at), actor: actor(raw.user), url: pull.url, merged: pull.merged });
        // A live PR with a changed head still requires explicit rebinding. Closed
        // discussions remain readable; receiving them never grants permission to write the old head.
        if (!binding.context && pull.state === 'open' && !pull.merged && pull.headSha !== binding.headSha) return { state: pull.state, headSha: pull.headSha, merged: pull.merged };
        for (const comment of await pages(`${prefix}/issues/${pull.number}/comments`)) {
          const id = number(comment.id, 'GitHub PR comment ID');
          append({ ...common, kind: 'pr_comment', id: `github:${repository}:pr_comment:${id}`, text: body(comment.body), actor: actor(comment.user),
            createdAt: date(comment.created_at), updatedAt: date(comment.updated_at ?? comment.created_at), observedAt: new Date().toISOString(), url: link(comment.html_url, repository, pull.number, id, true) });
        }
        for (const review of await pages(`${prefix}/pulls/${pull.number}/reviews`)) {
          if (review.state === 'PENDING' || review.submitted_at === null) continue;
          const id = number(review.id, 'GitHub review ID');
          if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(review.state)) throw new Error('GitHub returned an invalid review state');
          append({ ...common, kind: 'review', id: `github:${repository}:review:${id}`, text: body(review.body), actor: actor(review.user),
            createdAt: date(review.submitted_at), updatedAt: date(review.updated_at ?? review.submitted_at), observedAt: new Date().toISOString(), url: pullLink(review.html_url, repository, pull.number, `#pullrequestreview-${id}`), state: review.state, commitId: sha(review.commit_id) });
        }
        const reviewComments = await pages(`${prefix}/pulls/${pull.number}/comments`);
        const reviewById = new Map(reviewComments.map(comment => [number(comment?.id, 'GitHub review comment ID'), comment]));
        const reviewParent = async id => {
          if (!reviewById.has(id)) {
            const parent = await request(`${prefix}/pulls/comments/${id}`, { method: 'GET' });
            if (parent?.id !== id || parent.pull_request_url !== `https://api.github.com${prefix}/pulls/${pull.number}`) throw new Error('GitHub returned a different review parent');
            reviewById.set(id, parent);
          }
          return reviewById.get(id);
        };
        for (const comment of reviewComments) {
          if (pull.state === 'open' && comment.commit_id?.toLowerCase() !== pull.headSha) continue;
          append(await githubReviewCommentEvent({ repository, pull, comment, readParent: reviewParent, observedAt }));
        }
        if (pull.state !== 'open' || pull.merged) return { state: pull.state, headSha: pull.headSha, merged: pull.merged };
        const ciEventStart = events.length, checkRecords = [], statusRecords = [];
        if (ci?.checkApps) {
          const latest = new Map();
          for (const check of await pages(`${prefix}/commits/${pull.headSha}/check-runs?filter=latest`, 'check_runs')) {
            if (!ci.checkApps.includes(check.app?.slug?.toLowerCase())) continue;
            if (check.head_sha?.toLowerCase() !== pull.headSha) continue;
            checkRecords.push(check);
            number(check.id, 'GitHub check ID'); number(check.app?.id, 'GitHub check app ID'); nonempty(check.name, 'GitHub check name');
            const key = JSON.stringify([check.app.id, check.name, check.check_suite?.workflow_id ?? check.workflow_id ?? null]), previous = latest.get(key);
            const time = value => value.started_at ? date(value.started_at) : '';
            const newer = previous && check.started_at && previous.started_at ? time(check) > time(previous) || (time(check) === time(previous) && check.id > previous.id) : !previous || check.id > previous.id;
            if (newer) latest.set(key, check);
          }
          for (const check of latest.values()) {
            const app = nonempty(check.app.slug, 'GitHub check app slug').toLowerCase();
            if (!APP_SLUG.test(app) || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(check.status) ||
                (check.conclusion !== null && !['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(check.conclusion))) throw new Error('GitHub returned invalid check state or app');
            const event = { ...common, kind: 'check_run', id: `github:${repository}:check_run:${check.id}:${pull.headSha}:${check.status}:${check.conclusion ?? 'none'}`,
              text: await checkText(check), actor: { login: app, id: String(check.app.id), type: 'Bot' }, createdAt: date(check.completed_at ?? check.started_at ?? raw.updated_at),
              url: `https://github.com/${repository}/commit/${pull.headSha}/checks?check_run_id=${check.id}`,
              ci: { name: check.name, app, appId: String(check.app.id), runId: String(check.id),
                ...(check.check_suite?.id ? { suiteId: String(check.check_suite.id) } : {}),
                ...(check.check_suite?.workflow_id ?? check.workflow_id ? { workflowId: String(check.check_suite?.workflow_id ?? check.workflow_id) } : {}),
                conclusion: check.conclusion, status: check.status, headSha: pull.headSha } };
            append(event);
          }
        }
        if (ci?.statusContexts && ci?.statusActors) {
          const latest = new Map();
          for (const status of await pages(`${prefix}/commits/${pull.headSha}/statuses`)) {
            if (!ci.statusContexts.includes(status.context) || !ci.statusActors.includes(status.creator?.login?.toLowerCase())) continue;
            statusRecords.push(status);
            const context = nonempty(status.context, 'GitHub status context'), key = JSON.stringify([context, status.creator.login.toLowerCase()]), previous = latest.get(key);
            number(status.id, 'GitHub status ID'); date(status.created_at);
            if (!previous || date(status.created_at) > date(previous.created_at) || (date(status.created_at) === date(previous.created_at) && status.id > previous.id)) latest.set(key, status);
          }
          for (const status of latest.values()) {
            if (!['error', 'failure', 'pending', 'success'].includes(status.state)) throw new Error('GitHub returned an invalid commit status');
            append({ ...common, kind: 'commit_status', id: `github:${repository}:commit_status:${status.id}`, text: body(status.description ?? null), actor: actor(status.creator),
              createdAt: date(status.created_at), url: `https://github.com/${repository}/commit/${pull.headSha}`,
              ci: { name: status.context, actor: status.creator.login.toLowerCase(), runId: String(status.id), conclusion: status.state, status: status.state === 'pending' ? 'pending' : 'completed', headSha: pull.headSha } });
          }
        }
        const ciSnapshot = ci ? summarizeGitHubCi({ repository, target: `pull:${pull.number}`, headSha: pull.headSha, config: ci, checks: checkRecords, statuses: statusRecords, observedAt }) : undefined;
        if (ciSnapshot) for (const event of events.slice(ciEventStart)) event.ciSnapshot = ciSnapshot;
      return { state: pull.state, headSha: pull.headSha, merged: pull.merged, ...(ciSnapshot ? { ciSnapshot } : {}) };
      });
      // Immutable native IDs, not edited timestamps, prevent edits from replaying commands.
      const rank = event => ['issue', 'pull_request_state'].includes(event.kind) ? 0 : 1;
      events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
      return { version: 1, repository, observedAt, events, objects, errors, discovery,
        repositoryVerified: repositoryVerified || objects.some(object => object.status === 'ok') };
    },
    async deliver(message, { projectId, sourceProjectRoot, pullRequests = [], authorizeSend, coordinatorAnswer, workerAnswer } = {}) {
      const address = message?.channel?.address;
      const isPull = address?.pullNumber !== undefined;
      const issueNumber = Number(isPull ? address.pullNumber : address?.issueNumber);
      number(issueNumber, 'GitHub delivery issue number');
      if (message.channel.source !== 'github' || repositoryName(address?.repository) !== repository ||
          message.channel.thread !== `${repository}#${isPull ? 'pr:' : ''}${issueNumber}` || (isPull ? address.issueNumber !== undefined : !permittedIssue(issueNumber))) throw new Error('GitHub delivery is outside the configured channel');
      // Only the trusted runtime can supply this source-bound answer proof. Message
      // content and coordinator output cannot grant PR ownership or delivery rights.
      if (coordinatorAnswer !== undefined && (!coordinatorAnswer || typeof coordinatorAnswer !== 'object' || Array.isArray(coordinatorAnswer) ||
          Object.keys(coordinatorAnswer).some(key => !['triggerId', 'channel'].includes(key)) ||
          typeof coordinatorAnswer.triggerId !== 'string' || !coordinatorAnswer.triggerId.trim() || coordinatorAnswer.triggerId.length > 2000 || /[\0\r\n]/.test(coordinatorAnswer.triggerId) ||
          message.ticketId !== undefined || message.kind !== 'reply' || typeof authorizeSend !== 'function' ||
          !isDeepStrictEqual(coordinatorAnswer.channel, message.channel))) throw new Error('GitHub coordinator answer requires a matching source proof and send authorization');
      if (workerAnswer !== undefined && (!workerAnswer || typeof workerAnswer !== 'object' || Array.isArray(workerAnswer) ||
          Object.keys(workerAnswer).some(key => !['triggerId', 'ticketId', 'channel'].includes(key)) || coordinatorAnswer !== undefined ||
          typeof workerAnswer.triggerId !== 'string' || !workerAnswer.triggerId.trim() || workerAnswer.triggerId.length > 2000 || /[\0\r\n]/.test(workerAnswer.triggerId) ||
          !message.ticketId || workerAnswer.ticketId !== message.ticketId || message.kind !== 'reply' || typeof authorizeSend !== 'function' ||
          !isDeepStrictEqual(workerAnswer.channel, message.channel))) throw new Error('GitHub worker answer requires a matching source proof and send authorization');
      let deliveryHead;
      if (isPull) {
        deliveryHead = sha(address.headSha);
        // Historical heads remain deliverable only when the runtime explicitly authorizes them.
        const binding = bindings(pullRequests, true).find(value => value.number === issueNumber && value.headSha === deliveryHead && (value.ticketId === undefined || value.ticketId === message.ticketId));
        if (!binding && coordinatorAnswer === undefined) throw new Error('GitHub pull request delivery requires an authorized ticket/head binding');
      }
      const tag = marker(projectId, message.id);
      if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('GitHub delivery text is empty');
      let text = message.text;
      if (typeof sourceProjectRoot === 'string' && sourceProjectRoot.length > 1) text = text.split(sourceProjectRoot).join('[project]');
      const kind = message.kind === 'acknowledgement' ? 'Accepted' : message.kind === 'notice' ? 'Notice' : 'Update';
      if (message.ticketId !== undefined && !SAFE_ID.test(message.ticketId)) throw new Error('Invalid GitHub ticket identity');
      const content = `[js-superagent] ${kind}\n\n${text}${message.ticketId ? `\n\nTicket: \`${message.ticketId}\`` : ''}${deliveryHead ? `\n\nHead: \`${deliveryHead}\`` : ''}\n\n${tag}`;
      if (Buffer.byteLength(content) > 60 * 1024) throw new Error('GitHub delivery exceeds 60 KiB; inspect the local result');
      const requestedRoot = address.reviewRootId === undefined ? undefined : number(Number(address.reviewRootId), 'GitHub review root ID');
      const sourceComment = address.reviewCommentId === undefined ? requestedRoot : number(Number(address.reviewCommentId), 'GitHub review comment ID');
      if ((requestedRoot !== undefined || sourceComment !== undefined) && !isPull) throw new Error('Review delivery requires a pull request');
      if (sourceComment !== undefined && requestedRoot === undefined) throw new Error('Review delivery requires a verified root');
      try {
        const user = await sendingIdentity();
        const mine = comment => typeof comment.body === 'string' && comment.body.includes(tag) && authoredBy(comment, user);
        const reviewReceipt = (comment, root) => ({ id: String(number(comment?.id, 'GitHub comment ID')),
          url: pullLink(comment.html_url, repository, issueNumber, `#discussion_r${comment.id}`),
          destination: { kind: 'review-thread', reviewRootId: String(root) } });
        if (requestedRoot !== undefined) {
          for (const comment of await pages(`${prefix}/pulls/${issueNumber}/comments`)) {
            if (comment.in_reply_to_id === requestedRoot && mine(comment)) return reviewReceipt(comment, requestedRoot);
          }
        }
        // Check a possible previous fallback too, before resolving a deleted review target.
        for (const comment of await pages(`${prefix}/issues/${issueNumber}/comments`)) {
          if (mine(comment)) return { ...receipt(comment, issueNumber, isPull), ...(requestedRoot === undefined ? {} : {
            destination: { kind: 'conversation', reviewRootId: String(requestedRoot), fallbackReason: 'review-target-missing' } }) };
        }
        let rootId = requestedRoot, fallbackReason;
        if (rootId !== undefined) {
          try {
            const seen = new Set(); let current = sourceComment;
            while (true) {
              if (seen.has(current) || seen.size >= 32) throw new Error('Invalid GitHub review ancestry');
              seen.add(current);
              const comment = await request(`${prefix}/pulls/comments/${current}`, { method: 'GET' });
              if (comment?.id !== current || comment.pull_request_url !== `https://api.github.com${prefix}/pulls/${issueNumber}`) throw new Error('GitHub review target belongs to a different pull request');
              pullLink(comment.html_url, repository, issueNumber, new RegExp(`^#(?:discussion_r${current}|discussion-diff-\\d+)$`));
              if (comment.in_reply_to_id == null) {
                if (comment.id !== requestedRoot) throw new Error('GitHub review root does not match its source comment');
                break;
              }
              current = number(comment.in_reply_to_id, 'GitHub review parent ID');
            }
          } catch (error) {
            if (![404, 410].includes(error?.status ?? error?.statusCode)) throw error;
            // A missing review target is only a fallback when the parent PR is still accessible.
            await pullSnapshot(issueNumber);
            rootId = undefined; fallbackReason = 'review-target-missing';
          }
        }
        const destination = rootId === undefined ? { kind: 'conversation', ...(fallbackReason ? { reviewRootId: String(requestedRoot), fallbackReason } : {}) }
          : { kind: 'review-thread', reviewRootId: String(rootId) };
        // Read-only reconciliation and gone settlement remain possible while new writes are blocked.
        if (authorizeSend !== undefined) { if (typeof authorizeSend !== 'function') throw new Error('Invalid GitHub send authorization'); await authorizeSend(destination); }
        const target = rootId === undefined ? `${prefix}/issues/${issueNumber}/comments` : `${prefix}/pulls/${issueNumber}/comments/${rootId}/replies`;
        const posted = await request(target, { method: 'POST', body: { body: content } });
        if (!authoredBy(posted, user)) throw new Error('GitHub delivery response has an unexpected author');
        if (rootId !== undefined && posted.in_reply_to_id !== rootId) throw new Error('GitHub delivery response has an unexpected review root');
        return rootId === undefined ? { ...receipt(posted, issueNumber, isPull), ...(fallbackReason ? { destination } : {}) } : reviewReceipt(posted, rootId);
      } catch (error) {
        const category = classifyGitHubError(error).category;
        if (!githubRepositoryFailure(error) && (category === 'gone' || category === 'locked')) return { status: 'gone', reason: category === 'gone' ? 'deleted' : 'locked' };
        throw error;
      }
    },
  };
}

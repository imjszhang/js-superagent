import { createGitHubRepositorySource } from './github-repository.mjs';
import { createGitHubAccountRequest } from './github-account.mjs';
import { verifiedGitHubMentionIdentity } from '../github-mention.mjs';
import { classifyGitHubError, githubIdentityError, githubRepositoryFailure } from './github-errors.mjs';

const MIN_INTERVAL = 60_000, RETRY_WINDOW = 86_400_000, PAGE_SIZE = 100, MAX_THREADS = 1000;
const time = value => { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error('Invalid GitHub notification timestamp'); return result; };
const positive = value => { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid GitHub notification object number'); return value; };
const header = (headers, name) => typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
const iso = value => new Date(value).toISOString();
const modified = headers => { const value = header(headers, 'last-modified'); return typeof value === 'string' && value.length < 128 && !/[\0\r\n]/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; };
function rateLimited(error) {
  return error?.status === 429 || error?.statusCode === 429 || (error?.status === 403 || error?.statusCode === 403) && (header(error.headers, 'retry-after') != null || header(error.headers, 'x-ratelimit-remaining') === '0');
}
function retryDelay(error, cutoff, failures, interval) {
  const after = header(error?.headers, 'retry-after'), reset = Number(header(error?.headers, 'x-ratelimit-reset')) * 1000;
  const asked = /^\d+$/.test(String(after)) ? Number(after) * 1000 : Number.isFinite(Date.parse(after)) ? Date.parse(after) - cutoff : 0;
  return Math.max(interval, Math.min(3_600_000, interval * 2 ** Math.min(6, failures)), Number.isFinite(asked) ? asked : 0, Number.isFinite(reset) ? reset - cutoff : 0);
}
/** Follow only page numbers from trusted links; never send a link URL to the transport. */
function nextPage(headers, endpoint, length, page) {
  const link = header(headers, 'link');
  if (typeof link !== 'string' || !link.trim()) return length === PAGE_SIZE ? page + 1 : null;
  const match = /<([^>]+)>\s*;\s*rel="?next"?(?:\s*[,;]|\s*$)/i.exec(link);
  if (!match) return null;
  const expected = new URL(`https://api.github.com${endpoint}`), target = new URL(match[1]);
  if (target.origin !== expected.origin || target.pathname !== expected.pathname || target.username || target.password || target.hash) throw new Error('Untrusted GitHub notification pagination link');
  const targetPage = Number(target.searchParams.get('page'));
  target.searchParams.delete('page'); expected.searchParams.delete('page');
  target.searchParams.sort(); expected.searchParams.sort();
  if (target.search !== expected.search || targetPage !== page + 1) throw new Error('Invalid GitHub notification pagination link');
  return targetPage;
}

/** Account notifications are hints, never authorization. Re-read each original message. */
export function createGitHubNotificationsSource(options, { request: injectedRequest, readThread: injectedReadThread,
  now = () => Date.now(), random = Math.random, maxPages = 20, isTrackedIssue, isTrackedPullRequest, streams, observe, mentionEpoch = 0, mentionStartedAt } = {}) {
  if (!options?.account || options.app) throw new Error('GitHub notifications require a dedicated user account, not a GitHub App');
  if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(options.account.login ?? '')) throw new Error('GitHub notifications require an explicit account login');
  const repository = options?.repository?.toLowerCase();
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/.test(repository ?? '') || ['.', '..'].includes(repository.split('/')[1])) throw new Error('GitHub notifications require owner/repository');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid notification page limit');
  const transport = injectedRequest ?? createGitHubAccountRequest(options);
  if (typeof transport !== 'function') throw new Error('GitHub notifications require an authenticated transport');
  const delegate = createGitHubRepositorySource(options, { request: transport, now, maxPages,
    streams: { ...streams, mentions: true }, observe, mentionEpoch, mentionStartedAt, pollMentions: false, isTrackedIssue, isTrackedPullRequest });
  const prefix = `/repos/${repository}`, notificationPrefix = `${prefix}/notifications`, checkEndpoint = `${notificationPrefix}?all=true&per_page=1`;
  let interval = Math.max(MIN_INTERVAL, options.pollIntervalMs ?? MIN_INTERVAL);
  const read = async (endpoint, signal) => { signal?.throwIfAborted(); const result = await transport(endpoint, { method: 'GET', signal }); signal?.throwIfAborted(); return result; };
  async function notifications(endpoint, signal, headers) {
    signal?.throwIfAborted();
    const response = typeof transport.notifications === 'function' ? await transport.notifications(endpoint, { method: 'GET', signal, ...(headers ? { headers } : {}) }) : { body: await read(endpoint, signal), headers: {} };
    signal?.throwIfAborted();
    const asked = Number(header(response.headers, 'x-poll-interval'));
    if (Number.isFinite(asked) && asked > 0) interval = Math.max(interval, asked * 1000);
    if (response.status !== 304 && (!Array.isArray(response.body) || response.body.length > PAGE_SIZE)) throw new Error('Invalid GitHub notifications pagination');
    return response;
  }
  async function pages(endpoint, signal) {
    const result = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await read(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, signal);
      if (!Array.isArray(batch) || batch.length > PAGE_SIZE) throw new Error('Invalid GitHub thread pagination');
      result.push(...batch);
      if (batch.length < PAGE_SIZE) return result;
    }
    throw new Error('GitHub thread pagination limit reached');
  }
  async function readThread({ kind, number, since, startedAt, signal }) {
    if (injectedReadThread) return injectedReadThread({ kind, number, since, startedAt, signal });
    const selectors = [], after = raw => {
      const at = time(raw.updated_at ?? raw.submitted_at ?? raw.created_at);
      return at > time(startedAt) && at >= time(since);
    };
    const body = await read(`${prefix}/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`, signal);
    if (body?.number !== number || kind === 'issue' && body.pull_request) throw githubIdentityError('GitHub notification parent mismatch');
    if (after(body)) selectors.push({ mention: true, kind, number });
    for (const raw of await pages(`${prefix}/issues/${number}/comments?since=${encodeURIComponent(since)}`, signal)) {
      if (after(raw)) selectors.push({ mention: true, kind, number, commentId: positive(raw.id) });
    }
    if (kind === 'pull') {
      for (const raw of await pages(`${prefix}/pulls/${number}/reviews`, signal)) {
        if (raw.state !== 'PENDING' && after(raw)) selectors.push({ mention: true, kind, number, reviewId: positive(raw.id) });
      }
      for (const raw of await pages(`${prefix}/pulls/${number}/comments?since=${encodeURIComponent(since)}`, signal)) {
        if (after(raw)) selectors.push({ mention: true, kind, number, reviewCommentId: positive(raw.id) });
      }
    }
    const events = [];
    for (const selector of selectors) events.push(...await delegate.readContext({ mentionSelector: selector, signal }));
    return events;
  }
  return {
    id: delegate.id, source: 'github', authentication: 'native-gh',
    configurationKey: delegate.configurationKey, normalize: delegate.normalize, readContext: delegate.readContext,
    get pollIntervalMs() { return interval; },
    async poll({ cursor, signal } = {}) {
      signal?.throwIfAborted();
      const cutoff = now(), at = iso(cutoff);
      const identity = await verifiedGitHubMentionIdentity(transport, { signal });
      if (identity.type !== 'User' || identity.login !== options.account.login.toLowerCase()) throw githubIdentityError('GitHub notifications require a user account');
      const current = [2, 3].includes(cursor?.schemaVersion) && cursor.repository === repository && cursor.mentionEpoch === mentionEpoch ? structuredClone(cursor) : null;
      if (current && (current.identity?.id !== identity.id || current.identity?.login !== identity.login)) throw githubIdentityError('GitHub notifications account changed; explicitly reset discovery before switching accounts');
      const base = await delegate.poll({ cursor: current?.repositoryCursor ?? (cursor?.schemaVersion === 1 ? cursor : undefined), signal });
      if (!current) {
        const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * Math.min(interval / 10, 15_000));
        return { ...base, cursor: { schemaVersion: 3, repository, identity, mentionEpoch, repositoryCursor: base.cursor, startedAt: at, since: at, scan: null, retries: [], nextAt: iso(cutoff + interval + jitter), pollIntervalMs: interval, failures: 0 } };
      }
      current.schemaVersion = 3;
      time(current.since); time(current.startedAt);
      interval = Math.max(interval, Number.isFinite(current.pollIntervalMs) ? current.pollIntervalMs : MIN_INTERVAL);
      if (current.nextAt && time(current.nextAt) > cutoff) return { ...base, cursor: { ...current, repositoryCursor: base.cursor } };
      if (!Array.isArray(current.retries) || current.retries.length > MAX_THREADS) throw new Error('Invalid GitHub notification retries');
      const events = [...base.events], errors = [...(base.errors ?? [])], pending = new Map();
      for (const retry of current.retries) {
        if (!['issue', 'pull'].includes(retry.kind)) throw new Error('Invalid GitHub notification retry kind');
        positive(retry.number); time(retry.since); time(retry.failedAt);
        pending.set(`${retry.kind}:${retry.number}`, retry);
      }
      let scan = current.scan ?? null, since = current.since, nextAt = cutoff + interval, failures = Number.isSafeInteger(current.failures) ? current.failures : 0, scanFailed = false, throttled = false;
      if (scan) {
        time(scan.since); time(scan.until); time(scan.before); positive(scan.page);
        if (time(scan.since) > time(scan.until) || time(scan.before) > time(scan.until) || !Number.isSafeInteger(scan.pagesRead) || scan.pagesRead < 0) throw new Error('Invalid GitHub notification scan');
      }
      const errorFor = (error, object) => {
        signal?.throwIfAborted(); const fact = classifyGitHubError(error);
        errors.push({ scope: 'notifications', ...fact, ...(rateLimited(error) ? { category: 'rate-limit', message: 'GitHub rate limit reached' } : {}), error: rateLimited(error) ? 'GitHub rate limit reached' : fact.message, ...(object ? { object } : {}), ...(githubRepositoryFailure(error) ? { repositoryFailure: true } : {}) });
        if (rateLimited(error)) { throttled = true; nextAt = Math.max(nextAt, cutoff + retryDelay(error, cutoff, failures + 1, interval)); }
      };
      try {
        let unchanged = false, validator = null;
        if (!scan && current.conditionalSupported !== false) {
          const response = await notifications(checkEndpoint, signal, current.lastModified ? { 'If-Modified-Since': current.lastModified } : undefined);
          if (response.status === 304) {
            if (!current.lastModified) throw new Error('Unsolicited GitHub not-modified response');
            unchanged = true; since = at;
          } else {
            const value = modified(response.headers); current.conditionalSupported = value !== null;
            // A notification arriving after our fixed cutoff must remain discoverable next time.
            // HTTP dates have second precision: do not cache a validator overlapping the cutoff second.
            validator = value && time(value) + 1000 <= cutoff && response.body.every(row => time(row.updated_at) <= cutoff) ? value : null;
          }
        }
        if (!unchanged) {
          scan ??= { since: iso(Math.max(time(current.startedAt), time(since) - 1000)), until: at, before: at, page: 1, pagesRead: 0, lastModified: validator };
          for (let readPages = 0; readPages < maxPages && pending.size <= MAX_THREADS - PAGE_SIZE; readPages++) {
            const endpoint = `${notificationPrefix}?all=true&since=${encodeURIComponent(scan.since)}&before=${encodeURIComponent(scan.before)}&per_page=${PAGE_SIZE}&page=${scan.page}`;
            const response = await notifications(endpoint, signal);
            if (response.status === 304) throw new Error('Unexpected not-modified scan page');
            let oldest = Infinity;
            for (const notification of response.body) {
              if (notification?.repository?.full_name?.toLowerCase() !== repository) continue;
              const updated = time(notification.updated_at);
              if (updated > time(scan.until) || updated < time(scan.since)) continue;
              oldest = Math.min(oldest, updated);
              const subject = notification.subject;
              if (!['Issue', 'PullRequest'].includes(subject?.type) || updated <= time(current.startedAt)) continue;
              const kind = subject.type === 'Issue' ? 'issue' : 'pull', location = kind === 'issue' ? 'issues' : 'pulls';
              const base = `https://api.github.com${prefix}/${location}/`, address = typeof subject.url === 'string' ? subject.url.toLowerCase() : '';
              if (!address.startsWith(base) || !/^[1-9]\d*$/.test(address.slice(base.length))) { errorFor(githubIdentityError('Untrusted GitHub notification subject')); continue; }
              const number = positive(Number(address.slice(base.length)));
              if (options.issues && kind === 'issue' && !options.issues.includes(number)) continue;
              const key = `${kind}:${number}`;
              if (!pending.has(key)) pending.set(key, { kind, number, since: scan.since });
            }
            const page = nextPage(response.headers, endpoint, response.body.length, scan.page);
            scan.pagesRead++;
            if (page === null) { since = scan.until; current.lastModified = scan.lastModified ?? null; scan = null; break; }
            // Seek by timestamp when possible so moving newer notifications do not shift all later page offsets.
            // Retain a one-second overlap; equal-timestamp groups use ordinary pagination and event deduplication.
            if (Number.isFinite(oldest) && oldest + 1000 < time(scan.before)) { scan.before = iso(oldest + 1000); scan.page = 1; }
            else scan.page = page;
          }
        }
        failures = 0;
      } catch (error) { scanFailed = true; failures = Math.min(10, failures + 1); errorFor(error); nextAt = Math.max(nextAt, cutoff + retryDelay(error, cutoff, failures, interval)); }
      const retries = [];
      for (const item of pending.values()) {
        if (throttled) { retries.push({ ...item, failedAt: item.failedAt ?? at }); continue; }
        try {
          signal?.throwIfAborted();
          const batch = await readThread({ ...item, startedAt: current.startedAt, signal });
          if (!Array.isArray(batch)) throw new Error('Invalid notified thread events');
          events.push(...batch);
        } catch (error) {
          errorFor(error, { kind: item.kind, number: item.number });
          const failedAt = item.failedAt ?? at;
          if (classifyGitHubError(error).category !== 'gone' && cutoff - time(failedAt) < RETRY_WINDOW) retries.push({ ...item, failedAt, attempts: (item.attempts ?? 0) + 1 });
        }
      }
      if (throttled && !scanFailed) failures = Math.min(10, failures + 1);
      nextAt = Math.max(nextAt, cutoff + interval);
      return { events: [...new Map(events.map(event => [event.id, event])).values()], errors,
        cursor: { ...current, repositoryCursor: base.cursor, since, scan, retries, nextAt: iso(nextAt), pollIntervalMs: interval, failures } };
    },
  };
}

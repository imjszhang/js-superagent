import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubNotificationsSource } from '../src/channels/github-notifications.mjs';

const options = { repository: 'owner/repo', account: { login: 'helper' }, allowedActors: ['owner'] };
const origin = Date.parse('2026-11-03T00:00:00Z');
const user = { id: 7, login: 'helper', type: 'User' };
const notification = (number, extra = {}) => ({ id: String(number), repository: { full_name: 'owner/repo' },
  subject: { type: 'Issue', url: `https://api.github.com/repos/owner/repo/issues/${number}` }, updated_at: new Date(origin + 1000).toISOString(), ...extra });
function fixture({ notifications = [], request: handler, readThread, maxPages } = {}) {
  let clock = origin;
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, method: init.method });
    if (path === '/user') return user;
    if (path.startsWith('/repos/owner/repo/notifications?')) return typeof notifications === 'function' ? notifications(path) : notifications;
    if (handler) return handler(path, init);
    throw new Error(`Unexpected request ${path}`);
  };
  const source = createGitHubNotificationsSource(options, { request, readThread, maxPages, streams: { pulls: false }, now: () => clock, random: () => 0 });
  return { source, request, calls, advance: (ms = 60_000) => { clock += ms; } };
}

test('notification discovery baselines once, persists restart cursor and honors the server interval', async () => {
  const read = [];
  const f = fixture({ readThread: async item => { read.push(item.number); return [{ id: `event-${item.number}` }]; } });
  f.request.notifications = async () => ({ body: [notification(1)], headers: { 'x-poll-interval': '120' } });
  const initial = await f.source.poll();
  assert.equal(f.calls.some(c => c.path.startsWith('/repos/owner/repo/notifications?')), false);
  assert.equal(initial.cursor.schemaVersion, 3);
  f.advance();
  const next = await f.source.poll({ cursor: initial.cursor });
  assert.deepEqual(read, [1]); assert.equal(next.cursor.pollIntervalMs, 120_000);
  f.advance();
  await f.source.poll({ cursor: next.cursor });
  assert.deepEqual(read, [1]);
  const restarted = fixture({ notifications: [], readThread: async () => assert.fail('no new notifications') });
  restarted.advance(180_000);
  const after = await restarted.source.poll({ cursor: JSON.parse(JSON.stringify(next.cursor)) });
  assert.equal(after.cursor.startedAt, initial.cursor.startedAt);
  assert.equal(after.cursor.pollIntervalMs, 120_000);
  assert.ok(restarted.calls.find(c => c.path.includes(encodeURIComponent(new Date(Date.parse(next.cursor.since) - 1000).toISOString()))));
});

test('a notification re-reads all new comments; mentions, authors and bodies retain existing normalization', async () => {
  const timestamp = new Date(origin + 1000).toISOString();
  const comments = [11, 12, 13].map(id => ({ id, body: id === 13 ? 'ordinary discussion' : '@helper please fix this', user: { id: 8, login: 'owner', type: 'User' },
    created_at: timestamp, updated_at: timestamp, issue_url: 'https://api.github.com/repos/owner/repo/issues/1' }));
  const f = fixture({ notifications: [notification(1)], request: path => {
    if (path === '/repos/owner/repo/issues/1') return { id: 1, number: 1, title: 'Task', state: 'open', body: 'old text', user: { id: 8, login: 'owner', type: 'User' }, created_at: new Date(origin - 1000).toISOString(), updated_at: new Date(origin - 1000).toISOString() };
    if (path.startsWith('/repos/owner/repo/issues/1/comments?')) return comments;
    if (path.startsWith('/repos/owner/repo/issues/comments/')) return comments.find(c => c.id === Number(path.split('/').at(-1)));
    throw new Error(`Unexpected request ${path}`);
  } });
  const initial = await f.source.poll(); f.advance();
  const result = await f.source.poll({ cursor: initial.cursor });
  assert.deepEqual(result.errors, []);
  assert.equal(result.events.length, 2);
  assert.equal(f.source.normalize(result.events[0]).meta.addressedVia, 'mention');
  assert.equal(f.source.normalize(result.events[0]).meta.actor, 'owner');
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('one unreadable thread retries after restart while healthy notifications progress', async () => {
  let fail = true;
  const f = fixture({ notifications: [notification(1), notification(2)], readThread: async ({ number }) => {
    if (number === 1 && fail) throw new Error('unavailable');
    return [{ id: `event-${number}` }];
  } });
  const initial = await f.source.poll(); f.advance();
  const failed = await f.source.poll({ cursor: initial.cursor });
  assert.deepEqual(failed.events, [{ id: 'event-2' }]);
  assert.equal(failed.cursor.retries[0].number, 1);
  assert.equal(failed.cursor.retries[0].since, initial.cursor.since);
  assert.equal(failed.errors.length, 1);
  fail = false; f.advance();
  const repaired = await f.source.poll({ cursor: JSON.parse(JSON.stringify(failed.cursor)) });
  assert.ok(repaired.events.some(e => e.id === 'event-1'));
  assert.deepEqual(repaired.cursor.retries, []);
});

test('notification pagination does not lose the cursor on failure and subject URLs never redirect requests', async () => {
  const targets = [];
  const f = fixture({ maxPages: 1, notifications: Array.from({ length: 100 }, (_, i) => notification(i + 1)), readThread: async item => { targets.push(item); return []; } });
  const initial = await f.source.poll(); f.advance();
  const failed = await f.source.poll({ cursor: initial.cursor });
  assert.equal(failed.cursor.since, initial.cursor.since); assert.equal(failed.errors.length, 0);
  assert.equal(failed.cursor.scan.pagesRead, 1);
  assert.equal(targets.length, 100);
  const unsafe = fixture({ notifications: [notification(1, { subject: { type: 'Issue', url: 'https://evil.invalid/repos/owner/repo/issues/1' } }),
    notification(2, { repository: { full_name: 'other/repo' } }), notification(3, { updated_at: new Date(origin - 1000).toISOString() })],
  readThread: async () => assert.fail('untrusted or old thread must not be read') });
  const baseline = await unsafe.source.poll(); unsafe.advance();
  const result = await unsafe.source.poll({ cursor: baseline.cursor });
  assert.deepEqual(result.events, []); assert.equal(result.errors.length, 1);
});

test('account identity is pinned and App authentication is rejected', async () => {
  assert.throws(() => createGitHubNotificationsSource({ ...options, app: {} }), /dedicated user/);
  const f = fixture(); const initial = await f.source.poll(); f.advance();
  const switched = structuredClone(initial.cursor); switched.identity.id = '99';
  await assert.rejects(f.source.poll({ cursor: switched }), /account changed/);
  const request = async () => ({ ...user, login: 'wrong' });
  await assert.rejects(createGitHubNotificationsSource(options, { request, streams: { pulls: false } }).poll(), /user account/);
});

test('pagination reads later notifications and deduplicates a repeatedly notified PR', async () => {
  const selected = [];
  const pull = notification(2, { subject: { type: 'PullRequest', url: 'https://api.github.com/repos/Owner/Repo/pulls/2' } });
  const f = fixture({ notifications: path => path.includes('page=2') ? [notification(3)] : Array.from({ length: 100 }, () => pull),
    readThread: async ({ kind, number }) => { selected.push([kind, number]); return []; } });
  const initial = await f.source.poll(); f.advance();
  const result = await f.source.poll({ cursor: initial.cursor });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(selected, [['pull', 2], ['issue', 3]]);
});

test('legacy repository cursor survives notification activation without resetting repository streams', async () => {
  const f = fixture();
  const legacy = { schemaVersion: 1, repository: 'owner/repo', mentionEpoch: 0,
    streams: { pulls: { since: new Date(origin - 10000).toISOString() }, 'mentions:comments': { since: new Date(origin - 1000).toISOString() } } };
  const result = await f.source.poll({ cursor: legacy });
  assert.equal(result.cursor.repositoryCursor.streams.pulls.since, legacy.streams.pulls.since);
  assert.deepEqual(result.events, []);
  assert.equal(result.cursor.startedAt, new Date(origin).toISOString());
});

test('bounded scans resume their original window and retain boundary notifications after restart', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => notification(i + 1, { updated_at: new Date(origin + (i + 1) * 1000).toISOString() }));
  const handler = path => {
    const query = new URL(`https://api.github.com${path}`).searchParams;
    const start = Date.parse(query.get('since') ?? new Date(origin).toISOString());
    const end = Date.parse(query.get('before') ?? new Date(origin + 1_000_000).toISOString());
    const page = Number(query.get('page') ?? 1), size = Number(query.get('per_page'));
    return rows.filter(row => Date.parse(row.updated_at) >= start && Date.parse(row.updated_at) < end)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice((page - 1) * size, page * size);
  };
  const f = fixture({ notifications: handler, maxPages: 1, readThread: async ({ number }) => [{ id: `event-${number}` }] });
  const initial = await f.source.poll(); f.advance(120_000);
  const first = await f.source.poll({ cursor: initial.cursor });
  assert.equal(first.events.length, 100);
  assert.equal(first.cursor.since, initial.cursor.since);
  assert.equal(first.cursor.scan.until, new Date(origin + 120_000).toISOString());
  rows[100].updated_at = new Date(origin + 150_000).toISOString();
  const restarted = fixture({ notifications: handler, maxPages: 1, readThread: async ({ number }) => [{ id: `event-${number}` }] });
  restarted.advance(180_000);
  const second = await restarted.source.poll({ cursor: JSON.parse(JSON.stringify(first.cursor)) });
  assert.equal(second.cursor.scan, null);
  assert.equal(second.cursor.since, first.cursor.scan.until);
  assert.equal(new Set([...first.events, ...second.events].map(e => e.id)).size, 101);
  assert.ok(second.events.some(e => e.id === 'event-1'));
});

test('equal timestamp groups continue on later pages instead of restarting page one forever', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => notification(i + 1));
  const f = fixture({ maxPages: 1, notifications: path => {
    const query = new URL(`https://api.github.com${path}`).searchParams, size = Number(query.get('per_page')), page = Number(query.get('page') ?? 1);
    return rows.slice((page - 1) * size, page * size);
  }, readThread: async ({ number }) => [{ id: `event-${number}` }] });
  let cursor = (await f.source.poll()).cursor;
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    f.advance(); const result = await f.source.poll({ cursor }); cursor = JSON.parse(JSON.stringify(result.cursor));
    result.events.forEach(event => seen.add(event.id));
  }
  assert.equal(cursor.scan, null); assert.equal(seen.size, 101);
  assert.ok(f.calls.some(c => c.path.includes('&page=2')));
});

test('version two cursors preserve baseline, failed threads and repository streams', async () => {
  const read = [];
  const f = fixture({ notifications: [], readThread: async item => { read.push(item); return [{ id: 'retried' }]; } });
  const legacy = (await f.source.poll()).cursor;
  legacy.schemaVersion = 2; delete legacy.scan;
  legacy.retries = [{ kind: 'issue', number: 8, since: legacy.since, failedAt: legacy.since, attempts: 1 }];
  legacy.repositoryCursor.streams.custom = { since: '2026-11-02T00:00:00.000Z' };
  f.advance(); const result = await f.source.poll({ cursor: legacy });
  assert.equal(result.cursor.schemaVersion, 3); assert.equal(result.cursor.startedAt, legacy.startedAt);
  assert.equal(result.cursor.repositoryCursor.streams.custom.since, legacy.repositoryCursor.streams.custom.since);
  assert.equal(read[0].number, 8); assert.equal(read[0].since, legacy.since); assert.deepEqual(result.cursor.retries, []);
});

test('conditional polling uses only the stable repository endpoint and handles 304', async () => {
  const reads = [], requests = [], lastModified = 'Tue, 03 Nov 2026 00:00:01 GMT';
  const f = fixture({ readThread: async ({ number }) => { reads.push(number); return [{ id: `event-${number}` }]; } });
  f.request.notifications = async (path, init) => {
    requests.push({ path, headers: init.headers });
    if (path.endsWith('?all=true&per_page=1')) {
      if (init.headers?.['If-Modified-Since']) { assert.equal(init.headers['If-Modified-Since'], lastModified); return { status: 304, body: null, headers: { 'x-poll-interval': '60' } }; }
      return { body: [notification(1)], headers: { 'last-modified': lastModified } };
    }
    assert.equal(init.headers, undefined); return { body: [notification(1)], headers: {} };
  };
  const initial = await f.source.poll(); f.advance();
  const changed = await f.source.poll({ cursor: initial.cursor }); assert.equal(changed.cursor.lastModified, lastModified);
  f.advance(); const unchanged = await f.source.poll({ cursor: JSON.parse(JSON.stringify(changed.cursor)) });
  assert.deepEqual(reads, [1]); assert.equal(requests.length, 3); assert.deepEqual(unchanged.errors, []); assert.equal(unchanged.cursor.scan, null);
});

test('rate limits preserve watermarks and honor server backoff without exposing response diagnostics', async () => {
  const f = fixture({ readThread: async () => assert.fail('do not spend quota while limited') });
  const initial = await f.source.poll(); f.advance(); let calls = 0;
  f.request.notifications = async () => { calls++; throw Object.assign(new Error('private diagnostics'), { status: 403, headers: { 'retry-after': '600', 'x-ratelimit-remaining': '0' } }); };
  const limited = await f.source.poll({ cursor: initial.cursor });
  assert.equal(limited.cursor.since, initial.cursor.since); assert.equal(limited.errors[0].category, 'rate-limit');
  assert.equal(limited.cursor.nextAt, new Date(origin + 660_000).toISOString()); assert.ok(!JSON.stringify(limited).includes('private diagnostics'));
  f.advance(); await f.source.poll({ cursor: limited.cursor }); assert.equal(calls, 1);
});

test('pagination links cannot redirect notification reads to another origin', async () => {
  const f = fixture({ readThread: async () => [] });
  f.request.notifications = async path => ({ body: [notification(1)], headers: path.includes('&before=') ? { link: '<https://evil.invalid/notifications?page=2>; rel="next"' } : {} });
  const initial = await f.source.poll(); f.advance(); const result = await f.source.poll({ cursor: initial.cursor });
  assert.equal(result.errors.length, 1); assert.equal(result.cursor.since, initial.cursor.since); assert.equal(result.cursor.scan.page, 1);
});

test('two projects sharing an account query only their own repository notifications', async () => {
  let clock = origin;
  const calls = [];
  const make = repository => {
    const request = async (path) => {
      calls.push(path);
      if (path === '/user') return user;
      assert.ok(path.startsWith(`/repos/${repository}/notifications?`));
      const row = notification(1, { repository: { full_name: repository }, subject: { type: 'Issue', url: `https://api.github.com/repos/${repository}/issues/1` } });
      return repository === 'owner/busy' ? Array.from({ length: 100 }, () => row) : [row];
    };
    return createGitHubNotificationsSource({ ...options, repository }, { request, now: () => clock, random: () => 0, maxPages: 1, streams: { pulls: false }, readThread: async () => [{ id: repository }] });
  };
  const busy = make('owner/busy'), quiet = make('owner/quiet');
  const busyCursor = (await busy.poll()).cursor, quietCursor = (await quiet.poll()).cursor;
  clock += 60_000;
  const partial = await busy.poll({ cursor: busyCursor }), complete = await quiet.poll({ cursor: quietCursor });
  assert.ok(partial.cursor.scan);
  assert.equal(complete.cursor.scan, null);
  assert.deepEqual(complete.events, [{ id: 'owner/quiet' }]);
  assert.ok(!calls.some(path => path.startsWith('/notifications')));
});

test('a probe validator newer than the scan cutoff cannot hide notifications arriving during the request', async () => {
  const future = notification(4, { updated_at: new Date(origin + 60_500).toISOString() });
  const f = fixture({ readThread: async ({ number }) => [{ id: `event-${number}` }] });
  f.request.notifications = async (path, init) => {
    if (path.endsWith('?all=true&per_page=1')) {
      assert.equal(init.headers, undefined, 'the post-cutoff probe must not become a conditional baseline');
      return { body: [future], headers: { 'last-modified': 'Tue, 03 Nov 2026 00:01:00 GMT' } };
    }
    const until = Date.parse(new URL(`https://api.github.com${path}`).searchParams.get('before'));
    return { body: until > Date.parse(future.updated_at) ? [future] : [], headers: {} };
  };
  const initial = await f.source.poll(); f.advance();
  const first = await f.source.poll({ cursor: initial.cursor });
  assert.equal(first.cursor.lastModified, null);
  f.advance(); const second = await f.source.poll({ cursor: first.cursor });
  assert.deepEqual(second.events, [{ id: 'event-4' }]);
});

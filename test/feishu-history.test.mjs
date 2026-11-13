import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuSource, FEISHU_TOPIC_HORIZON_MS } from '../src/channels/feishu.mjs';
import { SourceRegistry } from '../src/sources.mjs';
import { Store } from '../src/store.mjs';

const NOW = 1_800_000_000_000, SINCE = NOW / 1000 - 100;
const scope = chatId => ({ chatId, type: 'group', mode: 'mentions' });
const row = (id, extra = {}) => ({ message_id: id, chat_id: 'oc_group', message_type: 'text', create_time: String(NOW - 10_000),
  body: { content: JSON.stringify({ text: id }) }, sender: { id_type: 'open_id', id: 'ou_alice', sender_type: 'user' },
  mentions: [{ id: 'cli_bot' }], ...extra });
const page = (items = [], page_token) => ({ code: 0, data: { items, has_more: !!page_token, ...(page_token ? { page_token } : {}) } });
const baseline = (scopes = { oc_group: { since: SINCE } }) => ({ schemaVersion: 2, scopes,
  discovery: Object.fromEntries(Object.keys(scopes).map(chatId => [chatId, { complete: true }])) });
function fixture({ list = async () => page(), get = async () => page(), ...options } = {}) {
  const calls = [];
  const source = createFeishuSource({ client: { im: { message: {
    list: async request => { calls.push(['list', request]); return list(request.params); },
    get: async request => { calls.push(['get', request]); return get(request.path); }, reply: async () => page(),
  } } }, botOpenId: 'ou_bot', botAppId: 'cli_bot', tenantKey: 'tenant', scopes: [scope('oc_group')], now: () => NOW, ...options });
  return { source, calls };
}
const topicCursor = (extra = {}) => ({ ...baseline(), topics: {
  'oc_group:omt_topic': { chatId: 'oc_group', threadId: 'omt_topic', rootId: 'om_root', since: SINCE, lastSeen: NOW - 10_000, ...extra },
} });

test('native topic and parent metadata never replace the existing domain root key', () => {
  const { source } = fixture();
  const value = source.normalize({ message: row('om_reply', { root_id: 'om_root', parent_id: 'om_parent', thread_id: 'omt_topic' }) });
  assert.equal(value.threads[0].id, 'tenant:oc_group:om_root');
  assert.equal(value.meta.threadId, 'omt_topic'); assert.equal(value.meta.parentId, 'om_parent');
  assert.equal(value.meta.rootId, 'om_root'); assert.equal(value.channel.address.messageId, 'om_root');
});

test('unaddressed configured group roots discover active topics and recover their missed mentions', async () => {
  const { source, calls } = fixture({ list: async params => params.container_id_type === 'chat'
    ? page([row('om_root', { mentions: [], thread_id: 'omt_topic' })])
    : page([row('om_request', { thread_id: 'omt_topic' })]) });
  const result = await source.poll({ cursor: baseline() });
  assert.deepEqual(result.events.map(event => event.message.message_id), ['om_request']);
  assert.equal(source.normalize(result.events[0]).threads[0].id, 'tenant:oc_group:om_root');
  assert.equal(result.cursor.topics['oc_group:omt_topic'].since, NOW / 1000);
  assert.equal(calls.length, 2);
  const params = calls[1][1].params;
  assert.equal(params.container_id_type, 'thread'); assert.equal(params.sort_type, 'ByCreateTimeDesc');
  assert.equal('start_time' in params, false); assert.equal('end_time' in params, false);
});

test('topic time filtering happens locally, completes at the lower boundary and preserves the fixed window', async () => {
  const { source, calls } = fixture({ list: async params => params.container_id_type === 'chat' ? page() : page([
    row('om_future', { thread_id: 'omt_topic', create_time: String(NOW + 10_000) }),
    row('om_new', { thread_id: 'omt_topic', create_time: String(NOW - 10_000) }),
    row('om_old', { thread_id: 'omt_topic', create_time: String((SINCE - 3) * 1000) }),
  ], 'older-page') });
  const result = await source.poll({ cursor: topicCursor() });
  assert.deepEqual(result.events.map(event => event.message.message_id), ['om_new']);
  assert.equal(result.cursor.topics['oc_group:omt_topic'].since, NOW / 1000);
  assert.equal(result.cursor.topics['oc_group:omt_topic'].pageToken, undefined);
  assert.equal(calls.filter(([name, request]) => name === 'list' && request.params.container_id_type === 'thread').length, 1);
});

test('history checks returned chat and topic identities before any scope adaptation', async () => {
  const { source } = fixture({ scopes: [scope('oc_group'), scope('oc_other')], list: async params => {
    if (params.container_id === 'oc_group') return page([row('om_cross_chat', { chat_id: 'oc_foreign' })]);
    if (params.container_id === 'omt_topic') return page([row('om_cross_topic', { thread_id: 'omt_other' })]);
    return page([row('om_good', { chat_id: 'oc_other' })]);
  } });
  const cursor = topicCursor(); cursor.scopes.oc_other = { since: SINCE };
  const result = await source.poll({ cursor });
  assert.deepEqual(result.events.map(event => event.message.message_id), ['om_good']);
  assert.equal(result.errors.length, 2); assert.ok(result.errors.every(error => error.category === 'validation'));
  assert.equal(result.cursor.scopes.oc_group.since, SINCE);
  assert.equal(result.cursor.scopes.oc_other.since, NOW / 1000);
  assert.equal(result.cursor.topics['oc_group:omt_topic'].since, SINCE);
});

test('legacy chat pagination survives migration and container scheduling is fair across restart', async () => {
  let clock = NOW;
  const settings = { maxPages: 1, now: () => clock, list: async params => params.container_id_type === 'thread'
    ? page([row('om_topic_reply', { thread_id: 'omt_topic' })])
    : page([row('om_chat')], params.page_token === 'old-token' ? 'next-token' : 'last-token') };
  const first = fixture(settings), cursor = topicCursor(); cursor.schemaVersion = 1;
  cursor.scopes.oc_group = { since: SINCE, until: NOW / 1000 - 5, pageToken: 'old-token' };
  const result = await first.source.poll({ cursor });
  assert.equal(first.calls[0][1].params.page_token, 'old-token');
  assert.equal(result.cursor.scopes.oc_group.until, NOW / 1000 - 5);
  assert.equal(result.cursor.scopes.oc_group.pageToken, 'next-token');
  assert.equal(result.cursor.next, 'thread:oc_group:omt_topic');
  clock += 60_000;
  const restarted = fixture(settings), next = await restarted.source.poll({ cursor: result.cursor });
  assert.equal(restarted.calls[0][1].params.container_id_type, 'thread');
  assert.equal(next.events[0].message.message_id, 'om_topic_reply');
  assert.equal(next.cursor.scopes.oc_group.until, NOW / 1000 - 5);
});

test('pagination cycles across polls fail safely and restart the same window without skipping it', async () => {
  let calls = 0;
  const { source } = fixture({ maxPages: 1, list: async () => page([], ++calls === 1 ? 'A' : calls === 2 ? 'B' : 'A') });
  const first = await source.poll({ cursor: baseline() });
  const second = await source.poll({ cursor: first.cursor });
  const third = await source.poll({ cursor: second.cursor });
  assert.equal(third.errors.length, 1); assert.match(third.errors[0].error, /pagination did not advance/);
  assert.equal(third.cursor.scopes.oc_group.since, SINCE);
  assert.equal(third.cursor.scopes.oc_group.until, NOW / 1000);
  assert.equal(third.cursor.scopes.oc_group.pageToken, undefined);
});

test('associated legacy topics resolve from verified root messages and exclude pre-subscription history', async () => {
  const minimumAt = NOW - 20_000;
  const { source, calls } = fixture({ trackedThreads: () => [{ chatId: 'oc_group', rootId: 'om_root', since: minimumAt, lastAt: minimumAt }],
    get: async () => page([row('om_root', { thread_id: 'om_native_topic' })]),
    list: async params => params.container_id_type === 'chat' ? page() : page([
      row('om_followup', { thread_id: 'om_native_topic', mentions: [], create_time: String(NOW - 10_000) }),
      row('om_old_context', { thread_id: 'om_native_topic', create_time: String(NOW - 30_000) }),
    ]) });
  const first = await source.poll();
  assert.ok(calls.some(([name]) => name === 'get'));
  assert.deepEqual(first.events.map(event => event.message.message_id), ['om_followup']);
  assert.equal(source.normalize(first.events[0]).addressed, undefined);
  assert.equal(source.normalize(first.events[0]).threads[0].id, 'tenant:oc_group:om_root');
  calls.length = 0;
  await source.poll({ cursor: first.cursor });
  assert.ok(calls.every(([name]) => name !== 'get'));
});

test('a forged root lookup cannot redirect a subscription to a different chat', async () => {
  const { source } = fixture({ trackedThreads: () => [{ chatId: 'oc_group', rootId: 'om_root', since: NOW - 20_000 }],
    get: async () => page([row('om_root', { chat_id: 'oc_foreign', thread_id: 'omt_stolen' })]) });
  const result = await source.poll();
  assert.equal(result.errors.length, 1); assert.match(result.errors[0].error, /outside the requested/);
  assert.deepEqual(result.cursor.topics, {});
});

test('quiet active topics expire while eligible subscriptions remain, and removed groups never get polled', async () => {
  const cursor = topicCursor({ lastSeen: NOW - FEISHU_TOPIC_HORIZON_MS - 1, initialized: true });
  const quiet = fixture(); const expired = await quiet.source.poll({ cursor });
  assert.deepEqual(expired.cursor.topics, {});
  const linked = fixture({ trackedThreads: () => [{ chatId: 'oc_group', rootId: 'om_root', since: NOW - FEISHU_TOPIC_HORIZON_MS - 1000, lastAt: NOW - FEISHU_TOPIC_HORIZON_MS - 1000 }] });
  const retained = await linked.source.poll({ cursor });
  assert.ok(retained.cursor.topics['oc_group:omt_topic']);
  const removed = fixture({ scopes: [scope('oc_other')], trackedThreads: () => [{ chatId: 'oc_group', rootId: 'om_root', since: NOW - 1000 }] });
  const result = await removed.source.poll({ cursor });
  assert.deepEqual(result.cursor.topics, {}); assert.equal(result.cursor.scopes.oc_group, undefined);
  assert.ok(removed.calls.every(([, request]) => request.params.container_id === 'oc_other'));
});

test('permission failures survive skipped rounds and clear only after that container recovers', async () => {
  let broken = true;
  const { source } = fixture({ maxPages: 1, list: async params => {
    if (params.container_id_type === 'chat' && broken) throw Object.assign(new Error('Request failed with status code 400'), { response: { data: { code: 230027, secret: 'never-retain' } } });
    return page();
  } });
  const first = await source.poll({ cursor: topicCursor() });
  assert.equal(first.errors[0].code, 230027); assert.equal(first.errors[0].category, 'permission');
  assert.equal(first.errors[0].operation, 'history'); assert.ok(!JSON.stringify(first.errors).includes('never-retain'));
  const skipped = await source.poll({ cursor: first.cursor });
  assert.equal(skipped.errors[0].code, 230027);
  broken = false;
  const recovered = await source.poll({ cursor: skipped.cursor });
  assert.equal(recovered.errors.length, 0);
});

test('real-time, chat, and topic copies deduplicate durably, and failed intake rolls back every cursor', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let fail = true;
  const receive = trigger => { store.triggers.save(trigger); if (trigger.meta.messageId === 'om_reply' && fail) throw new Error('intake unavailable'); };
  const settings = { list: async params => params.container_id_type === 'chat' ? page([row('om_root', { thread_id: 'omt_topic' })])
    : page([row('om_reply', { thread_id: 'omt_topic' }), row('om_root', { thread_id: 'omt_topic' })]) };
  const first = fixture(settings), registry = new SourceRegistry({ store, receive }).register(first.source);
  store.setMeta('source:feishu:state', { cursor: baseline() });
  registry.ingest('feishu', { message: row('om_root', { thread_id: 'omt_topic' }) });
  await assert.rejects(registry.poll('feishu'), /intake unavailable/);
  assert.deepEqual(registry.state('feishu').cursor, baseline()); assert.equal(store.triggers.get('feishu:tenant:om_reply'), undefined);
  fail = false;
  const accepted = await registry.poll('feishu'); assert.equal(accepted.received, 1); assert.equal(accepted.duplicates, 2);
  await registry.close();
  const reopened = new SourceRegistry({ store, receive }).register(fixture(settings).source);
  assert.equal(reopened.ingest('feishu', { message: row('om_reply', { root_id: 'om_root', thread_id: 'omt_topic' }) }).status, 'duplicate');
  assert.equal((await reopened.poll('feishu')).received, 0); await reopened.close();
});

test('v1 discovery finds recent roots behind the chat cursor without replaying older requests', async () => {
  const yesterday = NOW - 24 * 60 * 60 * 1000;
  const { source } = fixture({ list: async params => params.container_id_type === 'thread' ? page([
    row('om_missed_request', { thread_id: 'omt_topic' }),
    row('om_older_request', { thread_id: 'omt_topic', create_time: String(yesterday + 1000) }),
    row('om_root', { thread_id: 'omt_topic', create_time: String(yesterday), mentions: [] }),
  ]) : Number(params.start_time) < SINCE - 10 ? page([row('om_root', { create_time: String(yesterday), thread_id: 'omt_topic', mentions: [] })]) : page() });
  const result = await source.poll({ cursor: { schemaVersion: 1, scopes: { oc_group: { since: SINCE } } } });
  assert.deepEqual(result.events.map(event => event.message.message_id), ['om_missed_request']);
  assert.equal(result.cursor.discovery.oc_group.complete, true);
  assert.equal(result.cursor.topics['oc_group:omt_topic'].minimumAt, SINCE * 1000);
});

test('new chat discovery does not turn old topic mentions into new requests', async () => {
  let clock = NOW;
  const { source } = fixture({ now: () => clock, list: async params => params.container_id_type === 'thread'
    ? page([row('om_after_enable', { thread_id: 'omt_topic', create_time: String(NOW + 10_000) }), row('om_before_enable', { thread_id: 'omt_topic' })])
    : page([row('om_root', { thread_id: 'omt_topic', mentions: [], create_time: String(NOW - 60_000) })]) });
  const first = await source.poll(); assert.deepEqual(first.events, []);
  assert.equal(first.cursor.topics['oc_group:omt_topic'].minimumAt, NOW);
  clock += 60_000;
  const next = await source.poll({ cursor: first.cursor });
  assert.deepEqual(next.events.map(event => event.message.message_id), ['om_after_enable']);
});

test('descending pages persist without intake until the entire window can be delivered oldest-first', async () => {
  const { source } = fixture({ maxPages: 1, list: async params => params.container_id_type === 'chat' ? page()
    : params.page_token ? page([row('om_first_request', { thread_id: 'omt_topic', create_time: String(NOW - 40_000) })])
      : page([row('om_later_followup', { thread_id: 'omt_topic', mentions: [], create_time: String(NOW - 10_000) })], 'older') });
  let cursor = topicCursor(); const delivered = [];
  for (let i = 0; i < 4; i++) {
    const result = await source.poll({ cursor }); cursor = structuredClone(result.cursor);
    if (i < 3) assert.deepEqual(result.events, []);
    delivered.push(...result.events);
  }
  assert.deepEqual(delivered.map(event => event.message.message_id), ['om_first_request', 'om_later_followup']);
  assert.equal(cursor.topics['oc_group:omt_topic'].pendingEvents, undefined);
  assert.equal(cursor.topics['oc_group:omt_topic'].since, NOW / 1000);
});

test('large buffered topic windows restart ascending with a fixed bound and no premature or duplicate delivery', async () => {
  let clock = NOW;
  const rows = Array.from({ length: 9 }, (_, i) => row(`om_large_${i}`, { thread_id: 'omt_topic',
    create_time: String(NOW - 10_000 - i * 1000), body: { content: JSON.stringify({ text: 'x'.repeat(130_000) }) } }));
  const { source, calls } = fixture({ maxPages: 1, now: () => clock, list: async params => params.container_id_type === 'chat' ? page()
    : page(params.sort_type === 'ByCreateTimeDesc' ? rows : [...rows].reverse()) });
  let cursor = topicCursor();
  for (let i = 0; i < 2; i++) { const result = await source.poll({ cursor }); cursor = result.cursor; assert.deepEqual(result.events, []); }
  assert.equal(cursor.topics['oc_group:omt_topic'].order, 'asc');
  assert.equal(cursor.topics['oc_group:omt_topic'].pendingEvents, undefined);
  assert.equal(cursor.topics['oc_group:omt_topic'].until, NOW / 1000);
  clock += 60_000;
  const delivered = [];
  for (let i = 0; i < 2; i++) { const result = await source.poll({ cursor }); cursor = result.cursor; delivered.push(...result.events); }
  assert.deepEqual(delivered.map(event => event.message.message_id), [...rows].reverse().map(message => message.message_id));
  assert.equal(cursor.topics['oc_group:omt_topic'].since, NOW / 1000);
  assert.equal(cursor.topics['oc_group:omt_topic'].order, undefined);
  assert.deepEqual(calls.filter(([, request]) => request.params.container_id_type === 'thread').map(([, request]) => request.params.sort_type), ['ByCreateTimeDesc', 'ByCreateTimeAsc']);
});

test('malformed successful pages never silently become empty successful scans', async () => {
  for (const data of [{}, { items: null, has_more: false }, { items: [], has_more: 'false' }, { items: [], has_more: true }]) {
    const { source } = fixture({ list: async () => ({ code: 0, data }) });
    const result = await source.poll({ cursor: baseline() });
    assert.equal(result.errors.length, 1); assert.equal(result.cursor.scopes.oc_group.since, SINCE); assert.deepEqual(result.events, []);
  }
});

test('a later-page failure retains the buffered window and retries that page before ordered delivery', async () => {
  let broken = true;
  const { source } = fixture({ list: async params => {
    if (params.container_id_type === 'chat') return page();
    if (!params.page_token) return page([row('om_followup', { thread_id: 'omt_topic', mentions: [] })], 'older');
    if (broken) return { code: 230027 };
    return page([row('om_request', { thread_id: 'omt_topic', create_time: String(NOW - 40_000) })]);
  } });
  const failed = await source.poll({ cursor: topicCursor() });
  assert.deepEqual(failed.events, []); assert.equal(failed.errors[0].code, 230027);
  assert.equal(failed.cursor.topics['oc_group:omt_topic'].since, SINCE);
  assert.equal(failed.cursor.topics['oc_group:omt_topic'].pageToken, 'older');
  assert.equal(failed.cursor.topics['oc_group:omt_topic'].pendingEvents.length, 1);
  broken = false;
  const recovered = await source.poll({ cursor: failed.cursor });
  assert.deepEqual(recovered.events.map(event => event.message.message_id), ['om_request', 'om_followup']);
  assert.deepEqual(recovered.errors, []); assert.equal(recovered.cursor.topics['oc_group:omt_topic'].pendingEvents, undefined);
});

test('mixed-case platform IDs cannot starve later containers in round-robin scheduling', async () => {
  const { source, calls } = fixture({ maxPages: 1 });
  let cursor = { ...baseline(), topics: Object.fromEntries(['omt_a', 'omt_A', 'omt_z'].map(threadId => [`oc_group:${threadId}`,
    { chatId: 'oc_group', threadId, rootId: `om_${threadId}`, since: SINCE, lastSeen: NOW }])) };
  for (let i = 0; i < 8; i++) cursor = (await source.poll({ cursor })).cursor;
  const seen = calls.map(([, request]) => request.params.container_id);
  for (const id of ['oc_group', 'omt_a', 'omt_A', 'omt_z']) assert.equal(seen.filter(value => value === id).length, 2);
});

test('a newly accepted delayed request revisits its earlier authorized interval only once', async () => {
  let refs = [];
  const { source } = fixture({ trackedThreads: () => refs, list: async params => params.container_id_type === 'chat' ? page() : page([
    row('om_offline_followup', { thread_id: 'omt_topic', mentions: [] }),
  ]) });
  let cursor = topicCursor({ since: NOW / 1000, minimumAt: NOW, initialized: true });
  const first = await source.poll({ cursor }); assert.deepEqual(first.events, []);
  refs = [{ chatId: 'oc_group', rootId: 'om_root', since: NOW - 40_000, lastAt: NOW }];
  const recovered = await source.poll({ cursor: first.cursor });
  assert.deepEqual(recovered.events.map(event => event.message.message_id), ['om_offline_followup']);
  assert.equal(recovered.cursor.topics['oc_group:omt_topic'].minimumAt, NOW - 40_000);
  assert.equal(recovered.cursor.topics['oc_group:omt_topic'].associatedSince, NOW - 40_000);
  const stable = await source.poll({ cursor: recovered.cursor }); assert.deepEqual(stable.events, []);
});

test('arbitrary SDK transport messages never persist credentials in source diagnostics', async () => {
  const { source } = fixture({ list: async () => { throw new Error('GET https://example.invalid?tenant_access_token=secret-value'); } });
  const result = await source.poll({ cursor: baseline() });
  assert.equal(result.errors[0].error, 'Feishu history transport failed');
  assert.ok(!JSON.stringify(result.cursor).includes('secret-value'));
});

for (const order of ['asc', 'desc']) test(`earlier authorization within the same second restarts ${order} pagination without extending its fixed window`, async () => {
  const start = NOW - 1000, until = NOW / 1000;
  const { source, calls } = fixture({ now: () => NOW + 60_000,
    trackedThreads: () => [{ chatId: 'oc_group', rootId: 'om_root', since: start + 100, lastAt: NOW }],
    list: async params => params.container_id_type === 'chat' ? page() : params.page_token ? page()
      : page([
        row('om_after_window', { thread_id: 'omt_topic', create_time: String(NOW + 1000) }),
        row('om_later', { thread_id: 'omt_topic', create_time: String(start + 950) }),
        row('om_previously_filtered', { thread_id: 'omt_topic', create_time: String(start + 500) }),
        row('om_accepted_origin', { thread_id: 'omt_topic', create_time: String(start + 100) }),
      ]) });
  const cursor = topicCursor({ since: start / 1000, until, minimumAt: start + 900, associatedSince: start + 900,
    order, pageToken: 'old-second-page', seenTokens: ['old-token-hash'],
    pendingEvents: [{ message: row('om_discarded_buffer', { thread_id: 'omt_topic', create_time: String(start + 950) }) }] });
  const result = await source.poll({ cursor });
  assert.equal(calls.find(([, request]) => request.params.container_id_type === 'thread')[1].params.page_token, undefined);
  assert.deepEqual(result.events.map(event => event.message.message_id), ['om_accepted_origin', 'om_previously_filtered', 'om_later']);
  const saved = result.cursor.topics['oc_group:omt_topic'];
  assert.equal(saved.since, until, 'recovery must finish the original fixed window, not extend it to the new poll time');
  assert.equal(saved.minimumAt, start + 100); assert.equal(saved.associatedSince, start + 100);
  for (const key of ['pageToken', 'seenTokens', 'pendingEvents', 'ready', 'order']) assert.equal(saved[key], undefined);
});

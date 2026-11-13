import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { SourceRegistry } from '../src/sources.mjs';

const event = id => ({ id, source: 'test', actor: { source: 'test', id: 'operator' }, human: true, text: id,
  threads: [{ source: 'test', id: 'thread' }], at: new Date().toISOString(), meta: {} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, receive) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const registry = new SourceRegistry({ store, receive: receive ?? (value => store.triggers.save(value)) });
  return { store, registry };
}
test('real-time and polled copies deduplicate with an atomic cursor and survive registry reopening', async t => {
  const f = fixture(t), raw = event('one');
  const adapter = { id: 'test', source: 'test', normalize: value => value, poll: async () => ({ events: [raw, raw], cursor: { page: 1 } }) };
  f.registry.register(adapter); assert.equal(f.registry.ingest('test', raw).status, 'received');
  const polled = await f.registry.poll('test'); assert.equal(polled.received, 0); assert.equal(polled.duplicates, 2);
  assert.equal(f.store.listMeta('source:test:event:')[0].value.firstReceivedVia, 'live');
  await f.registry.close();
  const reopened = new SourceRegistry({ store: f.store, receive() { throw new Error('must not replay'); } }).register(adapter);
  assert.deepEqual(reopened.state('test').cursor, { page: 1 }); assert.equal(reopened.ingest('test', raw).status, 'duplicate'); await reopened.close();
});
test('history intake records the trusted first path and live duplicates cannot overwrite it', async t => {
  const f = fixture(t), raw = { ...event('missed'), meta: { firstReceivedVia: 'live' } };
  f.registry.register({ id: 'test', source: 'test', normalize: value => value, poll: async () => ({ events: [raw], cursor: 1,
    errors: [{ scope: 'oc_group', error: 'permission denied', code: 230027, category: 'permission', operation: 'history', container: { type: 'thread', id: 'omt_thread', chatId: 'oc_group' } }] }) });
  assert.equal((await f.registry.poll('test')).received, 1);
  assert.equal(f.registry.ingest('test', raw).status, 'duplicate');
  assert.equal(f.store.listMeta('source:test:event:')[0].value.firstReceivedVia, 'history');
  assert.deepEqual(f.registry.state('test').error[0], { scope: 'oc_group', error: 'permission denied', code: 230027, category: 'permission', operation: 'history', container: { type: 'thread', id: 'omt_thread', chatId: 'oc_group' } });
  await f.registry.close();
});
test('domain reception failure rolls back the entire poll and leaves the cursor for retry', async t => {
  const f = fixture(t, value => { f.store.triggers.save(value); if (value.id === 'two') throw new Error('transaction failed'); });
  f.registry.register({ id: 'test', source: 'test', normalize: value => value, poll: async () => ({ events: [event('one'), event('two')], cursor: 'advanced' }) });
  await assert.rejects(f.registry.poll('test'), /transaction failed/);
  assert.equal(f.store.triggers.get('one'), undefined); assert.equal(f.registry.state('test').cursor, null);
  assert.equal(f.store.listMeta('source:test:event:').length, 0); await f.registry.close();
});
test('same-instance concurrent callers share a poll; a second registry sees durable ownership', async t => {
  const f = fixture(t), wait = deferred(); let calls = 0;
  const adapter = { id: 'test', source: 'test', normalize: value => value, async poll() { calls++; await wait.promise; return { events: [], cursor: 1 }; } };
  f.registry.register(adapter); const first = f.registry.poll('test'); assert.equal(f.registry.poll('test'), first);
  const second = new SourceRegistry({ store: f.store, receive() {} }).register(adapter);
  assert.equal((await second.poll('test')).busy, true); wait.resolve(); await first;
  assert.equal(calls, 1); await f.registry.close(); await second.close();
});
test('a late response from an expired owner cannot advance source state', async t => {
  const f = fixture(t), wait = deferred();
  f.registry.register({ id: 'test', source: 'test', normalize: value => value, async poll() { await wait.promise; return { events: [event('late')], cursor: 'stale' }; } });
  const pending = f.registry.poll('test'); f.store.setMeta('source:test:owner', { token: 'replacement', expires: Date.now() + 30_000 }); wait.resolve();
  await assert.rejects(pending, /Stale/); assert.equal(f.store.triggers.get('late'), undefined); assert.equal(f.registry.state('test').cursor, null); await f.registry.close();
});
test('one failed source does not prevent another source from receiving and close aborts polling', async t => {
  const f = fixture(t);
  f.registry.register({ id: 'broken', source: 'test', normalize: value => value, async poll() { throw new Error('offline'); } });
  f.registry.register({ id: 'good', source: 'test', normalize: value => value, async poll() { return { events: [event('good')], cursor: 1 }; } });
  const result = await f.registry.pollAll(); assert.deepEqual(result.map(item => item.status), ['rejected', 'fulfilled']); assert.ok(f.store.triggers.get('good'));
  f.registry.register({ id: 'long', source: 'test', normalize: value => value, async poll({ signal }) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { events: [], cursor: 0 }; } });
  const work = f.registry.poll('long'); const rejected = assert.rejects(work, /Stale/); await f.registry.close(); await rejected;
  assert.throws(() => f.registry.ingest('good', event('new')), /stopped/);
});
test('pollDue respects per-source intervals and a stopped registry can be started again', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); let now = 100_000, calls = 0;
  const registry = new SourceRegistry({ store, receive() {}, now: () => now });
  registry.register({ id: 'test', source: 'test', pollIntervalMs: 2000, normalize: value => value, async poll() { calls++; return { events: [], cursor: calls }; } });
  assert.equal((await registry.pollDue()).length, 1); now += 1000;
  assert.equal((await registry.pollDue()).length, 0); now += 1000;
  assert.equal((await registry.pollDue()).length, 1); await registry.stop();
  await registry.poll('test'); assert.equal(calls, 3); await registry.close();
  await assert.rejects(registry.poll('test'), /stopped/);
});
test('stopping closes live intake until the shared source drain completes', async t => {
  const f = fixture(t), wait = deferred();
  f.registry.register({ id: 'test', source: 'test', normalize: value => value, async poll() {
    await wait.promise; return { events: [event('late-poll')], cursor: 'late' };
  } });
  const poll = f.registry.poll('test'), rejected = assert.rejects(poll, /Stale/);
  const first = f.registry.stop(), second = f.registry.stop();
  try {
    assert.equal(first, second, 'concurrent stops must wait for the same drain');
    assert.throws(() => f.registry.ingest('test', event('late-live')), /stopped/);
    assert.ok(f.store.getMeta('source:test:owner'), 'a live poll retains its owner while draining');
  } finally { wait.resolve(); await Promise.all([first, second, rejected]); }
  assert.equal(f.store.triggers.get('late-live'), undefined);
  assert.equal(f.store.triggers.get('late-poll'), undefined);
  assert.equal(f.registry.state('test').cursor, null);
  assert.equal(f.store.getMeta('source:test:owner'), undefined);
  assert.equal(f.registry.ingest('test', event('new-cycle')).status, 'received');
});

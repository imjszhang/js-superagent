import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { SourceRegistry, sourceDiagnostic } from '../src/sources.mjs';
import { BusinessHealthRegistry } from '../src/runtime/business-health.mjs';
import { acceptServiceHeartbeat, startServiceHeartbeat } from '../src/service-health.mjs';

const runId = 'f77c172b-b594-4138-a8f6-a6201fac31d3';
const diagnostic = { reason: 'timeout', transportCode: 'ERR_CANCELED', phase: 'auth', elapsedMs: 30002, failedAt: '2026-11-13T14:00:00.000Z', cancellationSource: 'deadline' };

test('read diagnostics survive source persistence, health and repeated service IPC sanitization', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = 1_000_000, calls = 0;
  const error = { scope: 'oc_private', operation: 'history', category: 'transport',
    container: { type: 'thread', id: 'omt_private', chatId: 'oc_private' }, error: 'Feishu history read timed out',
    ...diagnostic, request: { headers: { Authorization: 'SECRET' } }, response: { data: 'SECRET' }, config: { appSecret: 'SECRET' } };
  const registry = new SourceRegistry({ store, receive() { throw Error('no new input'); }, now: () => now });
  registry.register({ id: 'feishu', source: 'feishu', normalize: () => null,
    async poll() { calls++; return { events: [], cursor: { retainedWindow: true }, errors: [error] }; } });
  const observer = new BusinessHealthRegistry(store, { now: () => now });
  let health;
  for (let i = 0; i < 3; i++) {
    now += 1000; await registry.poll('feishu');
    health = observer.observe({ sources: [{ id: 'feishu', connection: 'ready', ...registry.state('feishu') }] });
  }
  assert.equal(calls, 3); assert.deepEqual(registry.state('feishu').cursor, { retainedWindow: true });
  const stored = registry.state('feishu').error[0];
  assert.deepEqual(sourceDiagnostic(stored), { ...diagnostic, scope: 'oc_private', category: 'transport', operation: 'history', container: error.container });
  assert.doesNotMatch(JSON.stringify(stored), /SECRET|Authorization|appSecret/);
  assert.deepEqual(health.sources[0].history.issues[0], sourceDiagnostic(stored));
  assert.deepEqual(health.incidents[0].facts.historyIssues[0], sourceDiagnostic(stored));
  assert.equal(health.sources[0].history.state, 'degraded'); assert.equal(health.sources[0].live.state, 'ready');
  assert.deepEqual(new BusinessHealthRegistry(store).current(), health);
  const sent = [];
  const stop = startServiceHeartbeat({ status: () => ({ machine: { ready: true } }), businessHealth: () => health }, {
    host: { env: { JS_SUPERAGENT_SERVICE_RUN_ID: runId }, connected: true, send: value => sent.push(value) },
    setInterval: () => ({ unref() {} }), clearInterval() {},
  });
  stop();
  const accepted = acceptServiceHeartbeat(sent[0], { runId, now, pid: 100, childPid: 101 });
  assert.deepEqual(accepted.business.sources[0].history.diagnostics, [diagnostic]);
  assert.equal(accepted.business.sources[0].history.failedScopes, 1);
  assert.doesNotMatch(JSON.stringify(accepted), /private|SECRET|Authorization|appSecret|error/);
  await registry.close();
});

test('diagnostic whitelist rejects arbitrary text, unbounded numbers and nested payloads', () => {
  assert.deepEqual(sourceDiagnostic({ reason: 'SECRET', transportCode: 'SECRET', phase: 'SECRET', elapsedMs: Infinity,
    statusCode: 999, failedAt: 'SECRET', cancellationSource: 'SECRET', request: { secret: 'SECRET' } }), {});
  assert.deepEqual(sourceDiagnostic({ reason: 'http', transportCode: 'ERR_BAD_RESPONSE', statusCode: 503, phase: 'history', elapsedMs: 12 }),
    { reason: 'http', transportCode: 'ERR_BAD_RESPONSE', statusCode: 503, phase: 'history', elapsedMs: 12 });
  for (const elapsedMs of [-1, 1.5, NaN, 86_400_001]) assert.equal(sourceDiagnostic({ elapsedMs }).elapsedMs, undefined);
});

test('service summaries cap safe diagnostics and preserve old heartbeat shape when absent', () => {
  const base = { type: 'js-superagent:heartbeat', runId, sequence: 1, business: { available: true, sources: [{ id: 'feishu', state: 'degraded',
    history: { state: 'degraded', issues: Array.from({ length: 150 }, () => ({ ...diagnostic, scope: 'oc_private', error: 'SECRET' })) } }] } };
  const result = acceptServiceHeartbeat(base, { runId, now: 1000, pid: 100, childPid: 101 });
  assert.ok(result.business.sources[0].history.diagnostics.length > 0);
  assert.ok(result.business.sources[0].history.diagnostics.length <= 20);
  assert.equal(result.business.sources[0].history.failedScopes, 150);
  assert.doesNotMatch(JSON.stringify(result), /private|SECRET/);
  base.business.sources[0].history.issues = [{ code: 230027, error: 'SECRET' }];
  const legacy = acceptServiceHeartbeat(base, { runId, now: 1000, pid: 100, childPid: 101 });
  assert.deepEqual(legacy.business.sources[0].history, { state: 'degraded', healthy: false, failedScopes: 1, codes: [230027] });
});

test('added diagnostic bytes cannot overflow the service heartbeat file budget across sources', () => {
  const sources = Array.from({ length: 100 }, (_, i) => ({ id: `feishu-${i}`, state: 'degraded',
    history: { state: 'degraded', issues: Array.from({ length: 100 }, () => ({ ...diagnostic, code: 230027 })) } }));
  const accepted = acceptServiceHeartbeat({ type: 'js-superagent:heartbeat', runId, sequence: 1, business: { sources } }, { runId, now: 1000, pid: 100, childPid: 101 });
  assert.ok(accepted.business.sources.reduce((total, source) => total + (source.history.diagnostics?.length ?? 0), 0) <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) < 64 * 1024);
  // Preserve an already large but valid legacy summary, adding no facts when its headroom is exhausted.
  for (const source of sources) {
    source.id += 'x'.repeat(180);
    source.history.codes = Array.from({ length: 90 }, (_, i) => 10000 + i);
  }
  const large = acceptServiceHeartbeat({ type: 'js-superagent:heartbeat', runId, sequence: 1, business: { sources: sources.slice(0, 66) } }, { runId, now: 1000, pid: 100, childPid: 101 });
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 64 * 1024);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createWorkerToolHost } from '../src/runtime/agent-tools.mjs';
import { createWorkerGitHubReads } from '../src/runtime/worker-github-context.mjs';

const repository = 'owner/repo', head = 'a'.repeat(40);
const root = (number = 1, pull = false) => ({ id: number + 100, number, body: 'Original scoped request', title: 'Scoped task', state: 'open', updated_at: '2026-11-02T00:00:00Z',
  html_url: `https://github.com/${repository}/${pull ? 'pull' : 'issues'}/${number}`, user: { login: 'owner' },
  ...(pull ? { base: { repo: { full_name: repository } }, head: { sha: head, repo: { full_name: repository } } } : {}) });
const comment = (id, body = `Comment ${id}`) => ({ id, body, html_url: `https://github.com/${repository}/issues/1#issuecomment-${id}`, user: { login: 'owner' }, updated_at: '2026-11-02T00:00:00Z' });
function fixture(t, { request, limits, scopes: initialScopes } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let scopes = initialScopes ?? [{ number: 1, pull: false }], active = true;
  const controller = new AbortController(), requests = [];
  const remoteReads = createWorkerGitHubReads({ github: { repository }, threads: () => scopes, signal: controller.signal,
    assertActive() { if (!active) throw new Error('Assignment no longer active'); },
    request: async (endpoint, options) => {
      assert.equal(store.inTransaction, false, 'Network reads must be outside Store transactions');
      assert.equal(options.method, 'GET'); assert.ok(options.signal);
      requests.push(endpoint);
      return request ? request(endpoint, options) : endpoint === `/repos/${repository}/issues/1` ? root() : [comment(201)];
    } });
  const options = { store, identity: { ticketId: 'ticket-one', assignmentId: 'assignment-one', runId: 'run-one' }, signal: controller.signal,
    sessionId: () => 'session-one', assertActive() { if (!active) throw new Error('Assignment no longer active'); }, resources: () => [], remoteReads, limits };
  const host = createWorkerToolHost(options);
  const call = (id, callId = 'call-one', args = {}) => ({ name: 'js_superagent_read', sessionId: 'session-one', turnId: 'turn-one', callId,
    arguments: { resource: 'github', id, ...args } });
  const reference = kind => host.contextResources().find(item => item.value.kind === kind);
  return { store, host, options, controller, requests, remoteReads, reference, call, setScopes: value => scopes = value, deactivate: () => { active = false; } };
}

test('Worker GitHub references are discoverable and async reads keep durable scoped receipts', async t => {
  const f = fixture(t);
  const list = f.host.call({ ...f.call(undefined), arguments: { resource: 'github' } });
  assert.equal(list.then, undefined, 'Reference listing remains synchronous');
  assert.ok(list.items.every(item => item.remote && item.version === undefined));
  const ref = f.reference('comments'), call = f.call(ref.id, 'read-comments');
  const page = await f.host.call(call);
  assert.match(page.text, /Comment 201/); assert.equal(page.source.repository, repository);
  assert.deepEqual(await createWorkerToolHost(f.options).call(call), page);
  assert.equal(f.requests.length, 3, 'Cached call rechecks scope without repeating GET');
  const receipt = f.store.getMeta('agent-tool:run-one:call:read-comments');
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.arguments.id, ref.id); assert.ok(receipt.resultDigest);
  f.setScopes([]);
  assert.throws(() => f.host.call(call), /outside/);
  assert.throws(() => f.host.call(f.call('github:other/repo:forged', 'outside')), /outside/);
});

test('Concurrent delivery of the same remote call joins one request and cancellation keeps consumed budgets', async t => {
  let finish;
  const f = fixture(t, { limits: { maxReads: 1 }, request: () => new Promise(resolve => { finish = resolve; }) });
  const call = f.call(f.reference('root').id);
  const first = f.host.call(call), duplicate = f.host.call(call);
  assert.equal(first, duplicate);
  await new Promise(resolve => setImmediate(resolve));
  f.controller.abort(new Error('Worker cancelled'));
  await assert.rejects(first, /cancelled/);
  const budget = f.store.getMeta('agent-tool:run-one:budget');
  assert.equal(budget.reads, 1); assert.equal(budget.calls, 1); assert.equal(budget.remoteRequests, 1); assert.equal(budget.reservedBytes, 0);
  assert.equal(f.store.getMeta('agent-tool:run-one:call:call-one').status, 'failed');
  finish(root());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.getMeta('agent-tool:run-one:call:call-one').status, 'failed', 'Late result never replaces cancellation');
});

test('Revocation during a remote GET refuses the result and does not refund requests or read attempts', async t => {
  let release;
  const f = fixture(t, { limits: { maxReads: 1 }, request: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.host.call(f.call(f.reference('root').id));
  await new Promise(resolve => setImmediate(resolve));
  f.deactivate(); release(root());
  await assert.rejects(pending, /active/);
  const budget = f.store.getMeta('agent-tool:run-one:budget');
  assert.equal(budget.reads, 1); assert.equal(budget.remoteRequests, 1); assert.ok(budget.remoteBytes > 0); assert.equal(budget.reservedBytes, 0);
  assert.deepEqual(f.host.consumedRecords(), []);
});

test('Continuation revalidates earlier pages even when root metadata did not change', async t => {
  let changed = false;
  const f = fixture(t, { request: async endpoint => {
    if (endpoint === `/repos/${repository}/issues/1`) return root();
    if (endpoint.endsWith('page=1')) return Array.from({ length: 30 }, (_, n) => comment(n + 1, changed && n === 0 ? 'Edited after page one' : `Comment ${n + 1}`));
    return [comment(31)];
  } });
  const first = await f.host.call(f.call(f.reference('comments').id));
  assert.equal(first.references.length, 1);
  changed = true;
  await assert.rejects(f.host.call(f.call(first.references[0].id, 'page-two')), /changed between pages/);
  assert.equal(f.store.getMeta('agent-tool:run-one:call:page-two').status, 'failed');
});

test('Current-head scope rejects changed PR snapshots and rejects caller endpoints before any network work', async t => {
  const f = fixture(t, { scopes: [{ number: 2, pull: true, headSha: head }], request: async () => ({ ...root(2, true), head: { sha: 'b'.repeat(40), repo: { full_name: repository } } }) });
  const ref = f.reference('root');
  assert.throws(() => f.host.call(f.call(ref.id, 'endpoint', { endpoint: '/repos/other/repo/issues/3' })), /arguments/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.host.call(f.call(ref.id)), /head changed/);
  assert.equal(f.requests.length, 1);
});

test('Remote byte pagination uses the configured page size and refuses changed content versions', async t => {
  let content = 'Long comment '.repeat(400);
  const f = fixture(t, { limits: { pageBytes: 1024 }, request: async endpoint => endpoint === `/repos/${repository}/issues/1` ? root() : [comment(201, content)] });
  const ref = f.reference('comments'), first = await f.host.call(f.call(ref.id));
  assert.ok(Buffer.byteLength(first.text) <= 1024); assert.ok(first.nextOffset);
  content = 'Changed comment '.repeat(400);
  await assert.rejects(f.host.call(f.call(ref.id, 'next', { version: first.version, offset: first.nextOffset })), /version changed/);
  assert.deepEqual(f.host.consumedRecords(), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createWorkerToolHost } from '../src/runtime/agent-tools.mjs';
import { buildWorkerContext, workerContextResources, writeWorkerContextSnapshot, contextBytes, utf8Slice } from '../src/runtime/worker-context.mjs';

function fixture(t, overrides = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const rows = [{ resource: 'messages', id: 'input-one', value: { text: 'Authorized text', triggerId: 'trigger-one' } }];
  let active = true, session = 'session-one';
  const options = { store, identity: { ticketId: 'ticket-one', assignmentId: 'assignment-one', runId: 'run-one' },
    assertActive() { if (!active) throw new Error('Assignment was cancelled or policy revoked'); }, sessionId: () => session, resources: () => rows,
    commands: { ack(args) { store.setMeta('ack-count', (store.getMeta('ack-count') ?? 0) + 1); return { acknowledged: args.triggerId }; } }, ...overrides };
  const host = createWorkerToolHost(options);
  const request = (name, args, callId = 'call-one', changes = {}) => ({ name: `js_superagent_${name}`, arguments: args, callId, sessionId: session, turnId: 'turn-one', ...changes });
  return { store, rows, host, options, request, setActive: value => active = value, setSession: value => session = value };
}
test('business tools journal exactly one domain mutation across host reconstruction and reject call-ID conflicts', t => {
  const f = fixture(t), call = f.request('ack', { triggerId: 'trigger-one', text: 'I will handle this request' });
  assert.deepEqual(f.host.call(call), { acknowledged: 'trigger-one' });
  assert.deepEqual(createWorkerToolHost(f.options).call(call), { acknowledged: 'trigger-one' });
  assert.equal(f.store.getMeta('ack-count'), 1);
  assert.throws(() => f.host.call({ ...call, arguments: { ...call.arguments, text: 'Different payload' } }), /identity conflict/);
  assert.equal(f.store.getMeta('ack-count'), 1);
});

test('workspace preparation is explicitly granted, bounded and idempotent across host reconstruction', t => {
  const f = fixture(t, { commands: { prepare_workspace(args, identity) {
    f.store.setMeta('prepare-count', (f.store.getMeta('prepare-count') ?? 0) + 1);
    assert.equal(identity.runId, 'run-one');
    return { accepted: true, status: 'pending', materialId: args.materialId, provisionId: args.provisionId };
  } } });
  const args = { materialId: 'material-source-one', provisionId: 'ec401f82-bc28-4667-b870-cb56a8ade120', reason: 'Use the current material baseline' };
  const call = f.request('prepare_workspace', args);
  assert.equal(f.host.call(call).status, 'pending');
  assert.equal(createWorkerToolHost(f.options).call(call).status, 'pending');
  assert.equal(f.store.getMeta('prepare-count'), 1);
  assert.equal(f.host.terminalReport(), null, 'Preparation is not a business completion report');
  for (const forbidden of [{ cwd: '/elsewhere' }, { command: 'run anything' }, { permission: 'workspace-write' }]) {
    assert.throws(() => f.host.call(f.request('prepare_workspace', { ...args, ...forbidden }, 'invalid-call')), /arguments/);
  }
  assert.throws(() => f.host.call(f.request('prepare_workspace', { materialId: args.materialId, provisionId: args.provisionId }, 'missing-reason')), /arguments/);
  const ungranted = fixture(t);
  assert.equal(ungranted.host.definitions.some(tool => tool.name === 'js_superagent_prepare_workspace'), false);
  assert.throws(() => ungranted.host.call(ungranted.request('prepare_workspace', args)), /not available/);
  f.setActive(false);
  assert.throws(() => f.host.call(call), /revoked/);
});
test('session spoofing, cancellation and renewed policy refusal apply even to cached calls', t => {
  const f = fixture(t), call = f.request('read', { resource: 'messages', id: 'input-one' });
  assert.throws(() => f.host.call({ ...call, sessionId: 'another-session' }), /identity/);
  f.host.call(call); f.setActive(false);
  assert.throws(() => f.host.call(call), /revoked/);
  f.setActive(true); f.setSession('replacement-session');
  assert.throws(() => f.host.call(call), /identity/);
});
test('resource IDs and fields cannot widen a bound Worker view, including replay after access changes', t => {
  const f = fixture(t);
  assert.throws(() => f.host.call(f.request('read', { resource: 'messages', id: 'another-ticket-input' })), /outside/);
  assert.throws(() => f.host.call(f.request('read', { resource: 'secrets' })), /outside/);
  assert.throws(() => f.host.call(f.request('read', { resource: 'messages', ticketId: 'another-ticket' })), /arguments/);
  const call = f.request('read', { resource: 'messages', id: 'input-one' }); f.host.call(call); f.rows.length = 0;
  assert.throws(() => f.host.call(call), /outside/);
  assert.throws(() => f.host.call(f.request('note', { text: 'Inject shared authority' })), /not available/);
});
test('record reads enforce UTF-8 boundaries, consistent versions and complete coverage before consumption', t => {
  const f = fixture(t); f.rows[0].value.text = '汉🙂'.repeat(120);
  const first = f.host.call(f.request('read', { resource: 'messages', id: 'input-one', limit: 256 }));
  assert.ok(Buffer.byteLength(first.text) <= 256); assert.equal(first.text.includes('\ufffd'), false);
  assert.deepEqual(f.host.consumedRecords(), []);
  assert.throws(() => f.host.call(f.request('read', { resource: 'messages', id: 'input-one', offset: first.nextOffset, limit: 256 }, 'no-version')), /requires a record version/);
  let previous = first, n = 1;
  while (previous.nextOffset !== null) previous = f.host.call(f.request('read', { resource: 'messages', id: 'input-one', version: first.version, offset: previous.nextOffset, limit: 256 }, `page-${n++}`));
  assert.deepEqual(f.host.consumedRecords(), [{ resource: 'messages', id: 'input-one', version: first.version }]);
  f.rows[0].value.text = 'Changed';
  assert.throws(() => f.host.call(f.request('read', { resource: 'messages', id: 'input-one', version: first.version }, 'changed')), /changed/);
});
test('context lists page within the assignment and reject stale cursors', t => {
  const f = fixture(t); f.rows[0].id = 'github:owner/repo#1'; for (let n = 0; n < 50; n++) f.rows.push({ resource: 'messages', id: `input-${n}`, value: { text: String(n) } });
  const first = f.host.call(f.request('read', { resource: 'messages' })); assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
  const next = f.host.call(f.request('read', { resource: 'messages', cursor: first.nextCursor }, 'list-next'));
  assert.equal(next.items.length, 20); assert.ok(next.items.every(item => !first.items.some(old => old.id === item.id)));
  f.rows[0].value.text = 'updated';
  assert.throws(() => f.host.call(f.request('read', { resource: 'messages', cursor: first.nextCursor }, 'stale')), /stale/);
  assert.deepEqual(f.host.consumedRecords(), [], 'Listing references does not mark contents read');
});
test('read budgets are durable and cached retries do not consume them twice', t => {
  const f = fixture(t, { limits: { maxReads: 1 } }), call = f.request('read', { resource: 'messages', id: 'input-one' });
  f.host.call(call); f.host.call(call);
  assert.throws(() => createWorkerToolHost(f.options).call(f.request('read', { resource: 'messages' }, 'extra-read')), /budget/);
});
test('remote receipt replay does not reprepare changed material and still checks current authorization', async t => {
  let preparations = 0, reads = 0, authorized = true, contentChanged = false;
  const remoteReads = {
    references: () => [{ resource: 'materials', id: 'material-one', value: { sourceId: 'current' } }],
    prepare(args) { preparations++; if (contentChanged) throw new Error('Material source changed'); return { resource: args.resource, id: args.id }; },
    validate() { if (!authorized) throw new Error('Material authorization revoked'); },
    async read(prepared) { reads++; return { ...prepared, version: 'a'.repeat(64), offset: 0, text: 'old', length: 3, nextOffset: null }; },
  };
  const f = fixture(t, { remoteReads }), call = f.request('read', { resource: 'materials', id: 'material-one' });
  const original = await f.host.call(call);
  contentChanged = true;
  assert.deepEqual(await createWorkerToolHost(f.options).call(call), original);
  assert.equal(preparations, 1); assert.equal(reads, 1);
  assert.throws(() => f.host.call(f.request('read', call.arguments, 'new-observation')), /source changed/);
  authorized = false;
  assert.throws(() => f.host.call(call), /authorization revoked/);
});
test('failed or oversized domain mutations roll back journals and side effects atomically', t => {
  const f = fixture(t);
  const host = createWorkerToolHost({ ...f.options, commands: { ack() { f.store.setMeta('side-effect', true); return { text: 'x'.repeat(40_000) }; } } });
  assert.throws(() => host.call(f.request('ack', { triggerId: 'trigger-one', text: 'ack' })), /output budget/);
  assert.equal(f.store.getMeta('side-effect'), undefined); assert.equal(f.store.getMeta('agent-tool:run-one:call:call-one'), undefined);
});
test('terminal report staging is durable and progress cannot erase it', t => {
  const f = fixture(t), host = createWorkerToolHost({ ...f.options, commands: { report: () => ({ accepted: true }) } });
  const report = { state: 'waiting', summary: 'Ready for review', question: 'Please inspect the preview', artifacts: [] };
  host.call(f.request('report', report));
  host.call(f.request('report', { ...report, state: 'progress', question: null }, 'progress'));
  assert.deepEqual(host.terminalReport(), report);
  assert.throws(() => host.call(f.request('report', { ...report, artifacts: ['../outside'] }, 'bad-path')), /artifacts/);
});
test('built-in Worker context stays bounded while legacy input arrays remain intact', () => {
  const input = { ticket: { id: 'ticket', scope: 'Change only allowed.txt', text: 'Implement request', messages: Array.from({ length: 400 }, (_, n) => ({ id: `m${n}`, text: '汉🙂'.repeat(2000) })), reports: [] }, runId: 'run', assignmentId: 'assignment' };
  const pack = buildWorkerContext(input);
  assert.equal(pack.authorizedScope, input.ticket.scope); assert.ok(contextBytes(pack) <= 32 * 1024);
  assert.ok(pack.coverage.omittedMessages > 0); assert.ok(pack.messages.every(card => card.truncated));
  assert.equal(input.ticket.messages.length, 400); assert.equal(input.ticket.messages[0].text.length, 6000);
  assert.throws(() => buildWorkerContext({ ...input, ticket: { ...input.ticket, scope: 'x'.repeat(40_000) } }), /scope.*not truncated/);
});
test('exec snapshots contain only supplied ticket facts and preserve complete old records outside the initial prompt', t => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-context-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = { ticket: { id: 'ticket', scope: 'Allowed scope', text: 'Request', messages: Array.from({ length: 30 }, (_, n) => ({ id: `m${n}`, text: `fact-${n}` })), reports: [] }, runId: 'run', assignmentId: 'assignment' };
  const result = writeWorkerContextSnapshot(input, join(directory, 'context'));
  const manifest = JSON.parse(readFileSync(result.manifestPath));
  assert.equal(manifest.records.length, 31); assert.equal(result.pack.coverage.omittedMessages, 14);
  const first = manifest.records.find(item => item.id === 'm0'); assert.equal(JSON.parse(readFileSync(join(directory, 'context', first.file))).text, 'fact-0');
  assert.equal(workerContextResources(input).length, 31);
  assert.throws(() => utf8Slice('汉字', 1, 10), /UTF-8/);
});

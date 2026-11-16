import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../dist/core/index.js';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { buildWorkerContext, workerContextResources, contextVersion, contextBytes, writeWorkerContextSnapshot } from '../src/runtime/worker-context.mjs';

function fixture(t, inspect = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-input-context-')), calls = [];
  const options = { projectRoot: root, driver: { capabilities: { boundedContextVersion: 1, agentTools: true }, async run(input) {
    input.checkpoint({ driver: 'fixture', id: 'input-context-session' });
    const pack = buildWorkerContext(input); calls.push({ input, pack });
    const refs = pack.messages.filter(card => !card.truncated).map(({ resource, id, version }) => ({ resource, id, version }));
    input.contextDelivered({ records: await inspect(input, pack, refs) ?? refs });
    return { version: 2, state: 'ready', summary: 'Read the assigned original messages', artifacts: [], attention: null };
  } } };
  let runtime = createProjectAgent(options).init();
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  const engine = new Engine({ repo: store, policy: () => ({ version: 'fixture', paused: false, revalidate: () => true }),
    scope: { scope: () => ({}) }, now: () => new Date().toISOString(), assessor: { request() {} },
    executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status() {}, withdraw() {} } });
  t.after(async () => { await runtime.stop(); runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  return { root, store, calls, get runtime() { return runtime; },
    attach(ticket, id, text = `Original supplement ${id}`) {
      const trigger = { id, source: 'local', actor: { source: 'local', id: 'operator' }, human: true, threads: [{ source: 'local', id }], at: new Date().toISOString(), text };
      store.triggers.save(trigger);
      engine.attach(runtime.getDomainTicket(ticket.id).id, id, 'Routing note only; this is not the original request.');
      return trigger;
    },
    async restart() { await runtime.stop(); runtime.close(); runtime = createProjectAgent(options).init(); },
  };
}

for (const restart of [false, true]) test(`an attached current input supplies its original text before execution (restart=${restart})`, async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Inspect only the fictional archive' });
  const original = f.attach(ticket, 'attached-note', 'Keep the exact supplemental requirement [SUPPLEMENT-A].');
  assert.equal(f.runtime.get(ticket.id).messages.some(message => message.triggerId === original.id), false, 'attach does not create a second persistent message mirror');
  if (restart) await f.restart();
  const result = await f.runtime.runNext(), call = f.calls.at(-1);
  assert.equal(result.status, 'completed', result.reports.at(-1).summary);
  const matching = call.input.ticket.messages.filter(message => message.triggerId === original.id);
  assert.equal(matching.length, 1); assert.equal(matching[0].text, original.text); assert.equal(matching[0].at, original.at);
  assert.equal(matching[0].source, original.source); assert.deepEqual(matching[0].actor, original.actor); assert.deepEqual(matching[0].threads, original.threads);
  const stored = f.runtime.getDomainTicket(ticket.id).inputs.find(input => input.triggerId === original.id);
  assert.ok(stored.readAt); assert.equal(f.runtime.get(ticket.id).messages.some(message => message.triggerId === original.id), false);
  assert.equal(call.pack.coverage.currentInputs.complete, 1);
  const resource = workerContextResources(call.input).find(record => record.value.triggerId === original.id);
  assert.ok(call.pack.messages.some(card => card.id === resource.id && card.version === contextVersion(resource.value) && !card.truncated));
});

test('ordinary fanout and attach of the same original keep one message with its old identity and version', async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Keep the original task scope' });
  f.runtime.reply(ticket.id, 'An ordinary follow-up [FANOUT]');
  const before = f.runtime.get(ticket.id), message = before.messages.at(-1);
  const expected = workerContextResources({ ticket: before }).find(record => record.value.triggerId === message.triggerId);
  const domain = f.runtime.getDomainTicket(ticket.id), input = domain.inputs.find(item => item.triggerId === message.triggerId);
  input.note = 'Later routing metadata must not alter the original record'; f.store.tickets.save(domain);
  const result = await f.runtime.runNext(); assert.equal(result.status, 'completed', result.reports.at(-1).summary);
  const current = workerContextResources(f.calls.at(-1).input).filter(record => record.value.triggerId === message.triggerId && !record.value.lifecycle);
  assert.equal(current.length, 1); assert.equal(current[0].id, expected.id); assert.equal(contextVersion(current[0].value), contextVersion(expected.value));
});

test('retired and unassigned attached history does not become a new initial instruction', async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Keep the original task scope' });
  const retired = f.attach(ticket, 'retired', 'Superseded content'), unassigned = f.attach(ticket, 'unassigned', 'Not in this Assignment');
  const domain = f.runtime.getDomainTicket(ticket.id), unassignedInput = domain.inputs.find(item => item.triggerId === unassigned.id);
  domain.undelivered = domain.undelivered.filter(id => id !== unassignedInput.id); f.store.tickets.save(domain);
  f.store.setMeta(`input:retired:${domain.id}:${retired.id}`, { reason: 'superseded', at: retired.at });
  // Leave a valid current input so the normal scheduler can execute this batch.
  f.attach(ticket, 'current', 'The current requirement');
  assert.equal((await f.runtime.runNext()).status, 'completed');
  const { input, pack } = f.calls.at(-1);
  assert.equal(input.ticket.messages.some(message => [retired.id, unassigned.id].includes(message.triggerId)), false);
  assert.equal(pack.coverage.currentInputs.count, 1);
});

for (const mode of ['none', 'list', 'metadata', 'partial', 'complete']) test(`a long attached original is consumed only with complete versioned pages (${mode})`, async t => {
  const f = fixture(t, async (input, pack) => {
    const ref = pack.coverage.currentInputs.references[0]; assert.ok(ref); assert.equal(pack.coverage.currentInputs.truncated, 1);
    let call = 0;
    const read = args => input.agentTools.call({ name: 'js_superagent_read', arguments: args, sessionId: input.session?.id ?? 'input-context-session', turnId: 'turn-one', callId: `read-${++call}` });
    if (mode === 'list') await read({ resource: 'messages' });
    if (mode === 'metadata') await read({ resource: 'inputs', id: ref.inputId });
    if (mode === 'partial' || mode === 'complete') {
      let result = await read({ resource: ref.resource, id: ref.id, version: ref.version });
      assert.ok(result.nextOffset);
      while (mode === 'complete' && result.nextOffset !== null) result = await read({ resource: ref.resource, id: ref.id, version: ref.version, offset: result.nextOffset });
    }
  });
  const ticket = f.runtime.submit({ text: 'Read the assigned long original within the existing budgets' });
  f.attach(ticket, 'long-note', '原文🙂'.repeat(2000));
  const result = await f.runtime.runNext();
  assert.equal(result.status, mode === 'complete' ? 'completed' : 'failed', result.reports.at(-1).summary);
  const input = f.runtime.getDomainTicket(ticket.id).inputs.find(item => item.triggerId === 'long-note');
  assert.equal(!!input.readAt, mode === 'complete');
});

test('missing original text remains a visible gap and does not fall back to the routing note', async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Read original sources only' });
  const original = f.attach(ticket, 'missing-note'); delete original.text; f.store.triggers.save(original);
  const result = await f.runtime.runNext(); assert.equal(result.status, 'failed');
  const call = f.calls.at(-1); assert.equal(call.pack.coverage.currentInputs.missing, 1);
  assert.equal(call.input.ticket.messages.some(message => message.triggerId === original.id), false);
  assert.equal(call.pack.coverage.omittedMessages, 0, 'history coverage is distinct from missing current input');
});

test('a changed original cannot borrow the initial card receipt from its previous version', async t => {
  const f = fixture(t, () => {
    const original = f.store.triggers.get('changed-note'); original.text = 'A different current version'; f.store.triggers.save(original);
  });
  const ticket = f.runtime.submit({ text: 'Keep versioned original-message proofs' }); f.attach(ticket, 'changed-note', 'Initial original version');
  const result = await f.runtime.runNext(); assert.equal(result.status, 'failed'); assert.match(result.reports.at(-1).summary, /Stale context receipt/);
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.find(item => item.triggerId === 'changed-note').readAt, null);
});

function packInput(messages, contextInputs = []) {
  return { ticket: { id: 'pack-ticket', scope: 'Read only the assigned originals', text: 'Current request', reports: [], messages, contextInputs }, runId: 'pack-run', assignmentId: 'pack-assignment' };
}

test('current input selection keeps the 16-card and byte limits without changing old record identities', t => {
  const messages = Array.from({ length: 40 }, (_, n) => ({ text: `History ${n}`, triggerId: `trigger-${n}`, at: new Date(1700000000000 + n * 1000).toISOString() }));
  const input = packInput(messages, [{ id: 'required-input', kind: 'trigger', triggerId: 'trigger-0' }]);
  const before = workerContextResources(input), pack = buildWorkerContext(input);
  assert.equal(pack.messages.length, 16); assert.ok(pack.messages.some(card => card.id === 'pack-ticket:messages:0'));
  assert.equal(pack.coverage.currentInputs.complete, 1); assert.equal(pack.coverage.omittedMessages, 24);
  assert.ok(contextBytes(pack) <= 32768); assert.deepEqual(workerContextResources(input), before);
  const directory = mkdtempSync(join(tmpdir(), 'worker-input-snapshot-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const snapshot = writeWorkerContextSnapshot(input, directory), manifest = JSON.parse(readFileSync(snapshot.manifestPath));
  for (const card of snapshot.pack.messages) assert.ok(manifest.records.some(ref => ref.resource === card.resource && ref.id === card.id && ref.version === card.version));
});

test('omitted current input references are bounded, versioned and readable in the same snapshot', t => {
  const input = packInput(Array.from({ length: 70 }, (_, n) => ({ id: `message-${n}`, triggerId: `trigger-${n}`, text: '原文🙂'.repeat(1000) })),
    Array.from({ length: 70 }, (_, n) => ({ id: `input-${n}`, kind: 'trigger', triggerId: `trigger-${n}` })));
  const directory = mkdtempSync(join(tmpdir(), 'worker-input-limits-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { pack, manifestPath } = writeWorkerContextSnapshot(input, directory, { limits: { initialBytes: 8192 } });
  const manifest = JSON.parse(readFileSync(manifestPath));
  assert.ok(contextBytes(pack) <= 8192); assert.ok(pack.messages.length <= 16); assert.ok(pack.coverage.currentInputs.references.length <= 16);
  assert.ok(pack.coverage.currentInputs.omittedReferences > 0);
  assert.equal(pack.coverage.currentInputs.count, pack.coverage.currentInputs.complete + pack.coverage.currentInputs.truncated + pack.coverage.currentInputs.omitted + pack.coverage.currentInputs.missing);
  for (const ref of pack.coverage.currentInputs.references) assert.ok(manifest.records.some(record => record.resource === ref.resource && record.id === ref.id && record.version === ref.version));
});

test('live resources cannot replace a frozen initial version or silently add a later instruction', () => {
  const input = packInput([{ id: 'initial', triggerId: 'initial-trigger', text: 'Original current text' }], [{ id: 'input-one', kind: 'trigger', triggerId: 'initial-trigger' }]);
  const resources = workerContextResources(input); resources.find(row => row.id === 'initial').value = { ...input.ticket.messages[0], text: 'Changed after the snapshot' };
  resources.push({ resource: 'messages', id: 'late', value: { triggerId: 'late-trigger', text: 'Later delivery follows its own path' } });
  const pack = buildWorkerContext(input, { resources }); assert.equal(pack.messages.length, 0); assert.equal(pack.coverage.currentInputs.missing, 1);
});

test('native pending inputs are not replayed as initial cards or listed as a substitute read reference', () => {
  const input = packInput([{ id: 'queued', triggerId: 'queued-trigger', text: 'Already in the native pending queue' }],
    [{ id: 'queued-input', kind: 'trigger', triggerId: 'queued-trigger', nativePending: true }]);
  const pack = buildWorkerContext(input); assert.equal(pack.messages.length, 0); assert.equal(pack.coverage.currentInputs.nativePending, 1);
  assert.equal(pack.coverage.currentInputs.count, 0); assert.deepEqual(pack.coverage.currentInputs.references, []);
});

test('an adopted native pending input cannot obtain consumption proof through the ordinary context tools', async t => {
  let inspected = false;
  const f = fixture(t, (input, pack) => {
    inspected = true;
    const pending = input.adoption.pending[0], original = f.store.triggers.get('native-pending');
    assert.equal(pack.coverage.currentInputs.nativePending, 1);
    assert.equal(pack.messages.some(card => card.text.includes('[NATIVE-PENDING]')), false);
    for (const [resource, id, value] of [['triggers', original.id, original], ['inputs', pending.inputId, input.domainTicket.inputs.find(item => item.id === pending.inputId)]]) {
      assert.throws(() => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource, id }, sessionId: 'input-context-session', turnId: 'adopted-turn', callId: `read-${resource}` }), /outside/);
      assert.throws(() => input.contextDelivered({ records: [{ resource, id, version: contextVersion(value) }] }), /Stale context receipt/);
    }
  });
  const ticket = f.runtime.submit({ text: 'Keep the original scope' }); f.attach(ticket, 'native-pending', '[NATIVE-PENDING] Previously queued original');
  const domain = f.runtime.getDomainTicket(ticket.id), pending = domain.inputs.find(item => item.triggerId === 'native-pending');
  const meta = f.store.getMeta(`ticket:${ticket.id}`);
  meta.driverSession = { driver: 'fixture', id: 'input-context-session' }; meta.agentToolsVersion = 1; meta.contextVersion = 1;
  meta.inputAdoption = { status: 'prepared', sessionId: meta.driverSession.id, sourceRunId: 'previous-run', pending: [{ inputId: pending.id, messageId: 'native-message', sourceRunId: 'previous-run' }] };
  f.store.setMeta(`ticket:${ticket.id}`, meta);
  const result = await f.runtime.runNext(); assert.equal(inspected, true, result.reports.at(-1).summary); assert.equal(result.status, 'failed');
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.find(item => item.id === pending.id).readAt, null);
});

test('unknown delivery blocks before building a replacement initial prompt', async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Keep the original scope' }); f.attach(ticket, 'unknown-native');
  const pending = f.runtime.getDomainTicket(ticket.id).inputs.find(item => item.triggerId === 'unknown-native');
  f.store.setMeta(`live-input:previous-run:${pending.id}`, { runId: 'previous-run', inputId: pending.id, status: 'unknown' });
  const result = await f.runtime.runNext(); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 0);
  assert.match(result.reports.at(-1).summary, /delivery is uncertain/);
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.find(item => item.id === pending.id).readAt, null);
});

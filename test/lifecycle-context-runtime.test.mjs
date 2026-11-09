import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { buildWorkerContext, workerContextResources, contextVersion, contextConsumption } from '../src/runtime/worker-context.mjs';

function fixture(t, inspect = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-lifecycle-'));
  let runtime;
  const calls = [];
  const driver = { reportVersion: 2, capabilities: { reportVersion: 2, boundedContextVersion: 1 }, async run(input) {
    const pack = buildWorkerContext(input);
    calls.push({ input, pack });
    const records = pack.messages.filter(card => !card.truncated).map(({ resource, id, version }) => ({ resource, id, version }));
    input.contextDelivered({ records: inspect(input, records) ?? records });
    return { version: 2, state: 'ready', summary: 'Verified current task', artifacts: [], attention: null };
  } };
  const open = () => runtime = createProjectAgent({ projectRoot: root, driver }).init();
  open();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, calls, get runtime() { return runtime; }, async restart() { await runtime.stop(); runtime.close(); return open(); } };
}

test('synthetic lifecycle cards and source references never prove original message consumption', () => {
  const { triggerIds, inputIds } = contextConsumption([
    { resource: 'messages', id: 'synthetic', value: { inputId: 'lifecycle', triggerId: 'unread', text: 'Runtime fact', lifecycle: { kind: 'resumed', triggerId: 'unread' } } },
    { resource: 'inputs', id: 'input', value: { triggerId: 'unread' } },
    { resource: 'decisions', id: 'decision', value: { triggerId: 'unread', inputId: 'not-input' } },
    { resource: 'messages', id: 'message', value: { triggerId: 'read-message', text: 'Full original human text' } },
    { resource: 'triggers', id: 'read-trigger', value: { text: 'Full original trigger text' } },
    { resource: 'triggers', id: 'missing-text', value: {} },
  ]);
  assert.deepEqual([...triggerIds], ['read-message', 'read-trigger']);
  assert.deepEqual([...inputIds], ['lifecycle', 'input']);
});

test('completed task consumes the exact resumed lifecycle after pause, feedback and runtime restart', async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Maintain the same authorized file' });
  assert.equal((await f.runtime.runNext()).status, 'completed');
  f.runtime.pause();
  f.runtime.reply(ticket.id, 'Apply the first follow-up');
  await f.restart(); assert.equal(f.runtime.isPaused(), true); assert.equal(await f.runtime.runNext(), null);
  f.runtime.resume();
  const result = await f.runtime.runNext();
  const resumed = f.runtime.getDomainTicket(ticket.id).inputs.find(input => input.kind === 'resumed');
  assert.ok(resumed); assert.equal(Object.hasOwn(resumed, 'text'), false);
  assert.equal(result.status, 'completed', result.reports.at(-1).summary);
  const card = f.calls.at(-1).input.ticket.messages.find(message => message.inputId === resumed.id);
  assert.deepEqual(card.lifecycle, resumed); assert.equal(card.context, true);
  assert.equal(f.calls.at(-1).pack.authorizedScope, ticket.scope);
  assert.deepEqual(f.runtime.getDomainTicket(ticket.id).undelivered, []);
  f.runtime.reply(ticket.id, 'Apply the second follow-up');
  assert.equal((await f.runtime.runNext()).status, 'completed');
  assert.equal(f.calls.at(-1).input.ticket.messages.some(message => message.inputId === resumed.id), false,
    'Consumed lifecycle history must not crowd current input cards');
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input => input.kind === 'resumed').length, 2);
});

test('a receipt for the source trigger cannot stand in for the separate resumed lifecycle', async t => {
  const f = fixture(t, (input, records) => records.filter(record => !input.ticket.messages.find(message => message.id === record.id)?.lifecycle));
  const ticket = f.runtime.submit({ text: 'Keep original scope' });
  assert.equal((await f.runtime.runNext()).status, 'completed');
  f.runtime.reply(ticket.id, 'Resume with a follow-up');
  const result = await f.runtime.runNext(), domain = f.runtime.getDomainTicket(ticket.id);
  assert.equal(result.status, 'failed'); assert.match(result.reports.at(-1).summary, /remain unread/);
  const lifecycle = domain.inputs.find(input => input.kind === 'resumed');
  assert.ok(domain.undelivered.includes(lifecycle.id));
  assert.ok(domain.inputs.find(input => input.kind === 'trigger' && input.triggerId === lifecycle.triggerId).readAt);
  assert.equal(domain.ended, undefined);
});

for (const kind of ['trigger', 'resumed']) test(`reading only ${kind} input metadata cannot prove the user's follow-up text was read`, async t => {
  const f = fixture(t, (input, records) => {
    const lifecycle = input.domainTicket.inputs.find(value => value.kind === 'resumed');
    if (!lifecycle) return records;
    const metadata = input.domainTicket.inputs.find(value => value.kind === kind && value.triggerId === lifecycle.triggerId);
    assert.equal(Object.hasOwn(metadata, 'text'), false);
    const withoutUserText = records.filter(ref => workerContextResources(input).find(record => record.id === ref.id)?.value.triggerId !== lifecycle.triggerId);
    // Read the lifecycle card and its separate source reference, but never the human text.
    return [...withoutUserText, { resource: 'inputs', id: metadata.id, version: contextVersion(metadata) }];
  });
  const ticket = f.runtime.submit({ text: 'Maintain only the existing file' });
  assert.equal((await f.runtime.runNext()).status, 'completed');
  f.runtime.reply(ticket.id, 'This human follow-up must actually reach the model');
  const result = await f.runtime.runNext(), domain = f.runtime.getDomainTicket(ticket.id);
  assert.equal(result.status, 'failed'); assert.match(result.reports.at(-1).summary, /remain unread/);
  const trigger = domain.inputs.find(value => value.kind === 'trigger');
  assert.equal(trigger.readAt, null); assert.ok(domain.undelivered.includes(trigger.id));
});

test('the real business read host does not mistake complete resumed metadata for complete human text', async t => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-lifecycle-tool-'));
  const runtime = createProjectAgent({ projectRoot: root, driver: { capabilities: { reportVersion: 2, boundedContextVersion: 1, agentTools: true }, async run(input) {
    const resumed = input.domainTicket.inputs.find(value => value.kind === 'resumed');
    if (!resumed) {
      input.checkpoint({ driver: 'fixture', id: 'fixture-session' });
      input.contextDelivered({ records: buildWorkerContext(input).messages.map(({ resource, id, version }) => ({ resource, id, version })) });
    } else {
      const read = input.agentTools.call({ sessionId: input.session.id, turnId: 'turn-2', callId: 'read-resumed', name: 'js_superagent_read', arguments: { resource: 'inputs', id: resumed.id } });
      assert.deepEqual(JSON.parse(read.text), resumed); assert.equal(read.nextOffset, null);
    }
    return { version: 2, state: 'ready', summary: 'Finished', artifacts: [], attention: null };
  } } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const ticket = runtime.submit({ text: 'Keep the original scope' }); assert.equal((await runtime.runNext()).status, 'completed');
  runtime.reply(ticket.id, 'Read this human follow-up before claiming completion');
  const result = await runtime.runNext(), domain = runtime.getDomainTicket(ticket.id);
  assert.equal(result.status, 'failed'); assert.match(result.reports.at(-1).summary, /remain unread/);
  const trigger = domain.inputs.find(value => value.kind === 'trigger');
  assert.equal(trigger.readAt, null); assert.ok(domain.undelivered.includes(trigger.id));
});

function addInputs(f, ticket, inputs) {
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  const domain = store.tickets.get(f.runtime.getDomainTicket(ticket.id).id);
  domain.inputs.push(...inputs); domain.undelivered.push(...inputs.map(input => input.id));
  store.tickets.save(domain); store.close();
}

test('policy changes and legacy reopen facts carry their complete structure and own consumption IDs', async t => {
  const f = fixture(t), ticket = f.runtime.submit({ text: 'Review existing authorization only' });
  const inputs = [
    { id: 'policy-fact', kind: 'policy-changed', from: 'v1', to: 'v2', at: new Date().toISOString(), effect: { proactive: false } },
    { id: 'reopen-fact', kind: 'reopen', decisionId: 'decision-1', at: new Date().toISOString() },
  ];
  addInputs(f, ticket, inputs);
  assert.equal((await f.runtime.runNext()).status, 'completed');
  for (const input of inputs) {
    const message = f.calls.at(-1).input.ticket.messages.find(message => message.inputId === input.id);
    assert.deepEqual(message.lifecycle, input); assert.match(message.text, /grant no additional authority/);
  }
});

for (const mode of ['truncated', 'omitted', 'stale']) test(`${mode} lifecycle context remains unread and blocks completion`, async t => {
  const f = fixture(t, (input, records) => mode === 'stale' ? records.map(record => ({ ...record, version: 'stale' })) : records);
  const ticket = f.runtime.submit({ text: 'Do not omit pending lifecycle facts' });
  const inputs = Array.from({ length: mode === 'omitted' ? 20 : 1 }, (_, index) => ({ id: `lifecycle-${index}`, kind: 'policy-changed', from: 'v1', to: 'v2',
    at: new Date().toISOString(), effect: { rules: [{ id: 'rule', name: 'scope', change: 'changed', instruction: mode === 'truncated' ? 'large '.repeat(1000) : 'Keep current scope' }] } }));
  addInputs(f, ticket, inputs);
  const result = await f.runtime.runNext();
  assert.equal(result.status, 'failed'); assert.match(result.reports.at(-1).summary, mode === 'stale' ? /Stale context receipt/ : /remain unread/);
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended, undefined);
  if (mode !== 'stale') assert.ok(f.runtime.getDomainTicket(ticket.id).undelivered.includes(inputs[0].id));
});

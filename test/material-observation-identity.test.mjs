import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';

const oldText = 'SAME_TICKET_OLD_ORCHARD_REPORT';
const newText = 'SAME_TICKET_CURRENT_ORCHARD_REPORT';
const oldRequest = 'OLD_REQUEST_ORCHARD_CANARY';

function fixture(t, { feishu = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-observation-identity-')));
  const file = join(root, 'notes.md'), events = [], reads = [], sent = [], network = { fail: true };
  writeFileSync(file, oldText);
  const api = {
    list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async request => ({ code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: 'oc_dm' }] } }),
    reply: async request => { if (network.fail) throw new Error('delivery pending'); sent.push(request); return { code: 0, data: { message_id: `om_sent_${sent.length}` } }; },
    create: async request => { if (network.fail) throw new Error('delivery pending'); sent.push(request); return { code: 0, data: { message_id: `om_sent_${sent.length}`, chat_id: 'oc_dm' } }; },
  };
  const feishuSDK = { Client: class { constructor() { this.im = { message: api }; } }, EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  let callback = () => ({ summary: 'Host status inspected', actions: [] });
  let afterRead = async () => {};
  const runtime = createProjectAgent({ projectRoot: root, ...(feishu ? { feishuSDK } : {}),
    execution: { driver: 'fixture', enableAgentTools: true },
    driver: { capabilities: { agentTools: true, boundedMaterialReadsVersion: 1, sessionResume: true }, async run(input) {
      const sessionId = input.session?.id ?? `worker-${input.ticket.id}`;
      input.checkpoint({ driver: 'fixture', id: sessionId });
      const turnId = `actual-read-${reads.length + 1}`;
      let n = 0;
      const refs = () => input.agentTools.contextResources().filter(ref => ref.resource === 'materials');
      const read = ref => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id },
        callId: `${turnId}-${++n}`, sessionId, turnId });
      await read(refs().find(ref => ref.value.kind === 'directory' && ref.value.path === '.'));
      const result = await read(refs().find(ref => ref.value.kind === 'file' && ref.value.path === 'notes.md'));
      const text = JSON.parse(result.text).text;
      reads.push({ ticketId: input.ticket.id, runId: input.runId, text });
      await afterRead(input);
      return { version: 2, state: 'waiting', summary: text, artifacts: [], attention: null };
    } },
    assessor: {
      async assess() { return { kind: 'ignore', reason: `Old assessment ${oldText}`, rules: [] }; },
      async handleEvent(input) {
        events.push(input); input.checkpoint({ driver: 'fixture-assessor', id: input.session?.id ?? `coordinator-${events.length}` });
        return callback(input);
      },
    },
  }).init();
  if (feishu) {
    process.env.MATERIAL_IDENTITY_FEISHU_SECRET = 'fixture-secret';
    runtime.configure({ feishu: { appId: 'cli_fixture', appSecretEnv: 'MATERIAL_IDENTITY_FEISHU_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant',
      chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], operator: { openId: 'ou_alice' } } });
  }
  const principal = { source: 'local', id: 'operator' };
  runtime.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['notes.md'], views: ['current'], readers: [principal],
    destinations: [principal, ...(feishu ? [{ source: 'feishu', id: 'operator' }] : [])] }] }, { expectedRevision: 0 });
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' }, workflowMode: 'continuous' }, { expectedRevision: 0 });
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { store.close(); await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const submit = () => runtime.submit({ text: 'Read the fictional orchard notes', materials: { sources: [{ id: 'project', view: { kind: 'current' } }] } });
  const coordinate = async (id, text = 'Inspect current recorded status') => {
    if (feishu) runtime.receiveSourceEvent('feishu', { sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 'tenant' }, message: {
      message_id: `om_${id.replaceAll('-', '_')}`, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '1793491200000', content: JSON.stringify({ text }),
    } });
    else runtime.coordinate({ id, text });
    await runtime.runNext();
  };
  const reread = async ticket => {
    writeFileSync(file, newText); runtime.note(ticket.id, 'Read the updated notes within the existing mandate');
    for (let i = 0; i < 5 && reads.length < 2; i++) await runtime.runNext();
    assert.deepEqual(reads.map(read => read.text), [oldText, newText], 'the same Worker ticket actually reads both versions through the host tool');
    assert.ok(reads.every(read => read.ticketId === ticket.id));
  };
  return { root, file, runtime, store, events, reads, sent, network, submit, coordinate, reread,
    setCallback: value => { callback = value; }, setAfterRead: value => { afterRead = value; } };
}

test('a same-ticket reread cannot refresh old coordinator summaries or request freeform', async t => {
  const f = fixture(t), ticket = f.submit(); await f.runtime.runNext();
  f.setCallback(() => ({ summary: oldText, actions: [{ kind: 'request', ticketId: null, text: oldRequest }] }));
  await f.coordinate('old-request', oldRequest);
  const origin = f.runtime.coordinationStatus().events.find(event => event.id === 'old-request');
  assert.equal(origin.status, 'completed', origin.error);
  const request = origin.receipts.find(receipt => receipt.kind === 'request').result;
  await f.runtime.runNext();
  f.setCallback(() => ({ summary: 'Safe host status', actions: [] }));
  await f.reread(ticket);
  let inspected = false;
  f.setCallback(input => {
    inspected = true;
    assert.equal(input.session, undefined, 'old native context cannot resume after observation identity changes');
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(`${oldText}|${oldRequest}`));
    assert.match(JSON.stringify(input.context), new RegExp(newText));
    const card = JSON.parse(input.readContext({ resource: 'requests', recordId: request.triggerId }).text);
    assert.equal(card.materialState, 'stale');
    for (const field of ['text', 'summary', 'reason', 'message']) assert.equal(Object.hasOwn(card, field), false);
    assert.equal(input.readContext({ resource: 'requests', query: oldText }).total, 0);
    assert.doesNotMatch(input.readContext({ resource: 'tickets', recordId: ticket.id }).text, new RegExp(oldText));
    return { summary: 'Only current investigation facts are available', actions: [{ kind: 'reply', ticketId: null, text: newText }] };
  });
  await f.coordinate('after-reread');
  assert.equal(inspected, true);
  const event = f.runtime.coordinationStatus().events.find(event => event.id === 'after-reread');
  assert.equal(event.status, 'completed', event.error);
  assert.equal(f.runtime.notifications().find(message => message.text === newText)?.status, 'sent');
});

test('a same-ticket reread cannot authorize delivery of a queued older body', async t => {
  const f = fixture(t, { feishu: true }), ticket = f.submit(); await f.runtime.runNext(); await f.runtime.prepareExecution();
  f.setCallback(() => ({ summary: oldText, actions: [{ kind: 'reply', ticketId: null, text: oldText }] }));
  await f.coordinate('queue-old-body');
  const queued = f.runtime.notifications().find(message => message.channel.source === 'feishu' && message.text === oldText);
  assert.ok(queued); assert.equal(queued.status, 'pending');
  f.setCallback(() => ({ summary: 'Safe host status', actions: [] }));
  await f.reread(ticket);
  f.network.fail = false; f.store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run();
  await f.runtime.flushNotifications();
  const result = f.runtime.notifications().find(message => message.id === queued.id);
  assert.equal(result.status, 'dropped'); assert.equal(result.terminal.reason, 'MATERIAL_CHANGED');
  assert.ok(f.sent.every(request => !request.data.content.includes(oldText)));
});

test('new observations during a running continuation cannot attest its previous report', async t => {
  const f = fixture(t), ticket = f.submit(); await f.runtime.runNext();
  let started, release;
  const reading = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.setAfterRead(async () => { started(); await held; });
  writeFileSync(f.file, newText); f.runtime.note(ticket.id, 'Read updated notes');
  const run = f.runtime.runNext();
  try {
    await reading;
    assert.equal(f.reads.at(-1).text, newText);
    let inspected = false;
    f.setCallback(input => {
      inspected = true;
      assert.doesNotMatch(JSON.stringify(input.context), new RegExp(oldText));
      assert.doesNotMatch(input.readContext({ resource: 'tickets', recordId: ticket.id }).text, new RegExp(oldText));
      return { summary: 'The current investigation is still running', actions: [] };
    });
    await f.coordinate('during-reread');
    assert.equal(inspected, true);
    const event = f.runtime.coordinationStatus().events.find(event => event.id === 'during-reread');
    assert.equal(event.status, 'completed', event.error);
  } finally { release(); await run; }
});

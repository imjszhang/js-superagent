import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { validateProjectOptions } from '../src/config.mjs';
import { cardAnswers, decisionCard, parseCardAction } from '../src/runtime/operator-channel.mjs';
import { normalizeDecision } from '../src/runtime/decisions.mjs';
import { validateWorkEventResult } from '../src/runtime/coordination.mjs';

const decision = {
  items: [{ id: 'C0001', title: 'First source', url: 'https://example.com/a' }, { id: 'C0002', title: 'Second source', summary: 'Author, 2026' }],
  options: [{ id: 'adopted', label: '采纳' }, { id: 'rejected', label: '拒绝' }, { id: 'later', label: '稍后' }],
  reason: 'required',
};
const dm = (id, text, extra = {}) => ({ sender: { sender_id: { open_id: extra.from ?? 'ou_alice' }, sender_type: 'user', tenant_key: 'tenant' },
  message: { message_id: id, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '1793491200000', content: JSON.stringify({ text }),
    ...(extra.parent ? { parent_id: extra.parent } : {}) } });

function project(t, { worker = [], assess = async () => ({ kind: 'ignore', reason: 'unused', rules: [] }), coordinator = () => ({ summary: 'nothing', actions: [] }) } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-operator-')));
  const calls = { create: [], reply: [], patch: [], failed: 0 }, events = [], control = { failCreate: false };
  let sent = 0, runs = 0;
  const api = {
    list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async request => ({ code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: request.path.message_id.startsWith('om_g') ? 'oc_group' : 'oc_dm' }] } }),
    reply: async request => { calls.reply.push(request); return { code: 0, data: { message_id: `om_reply_${++sent}` } }; },
    create: async request => {
      if (control.failCreate) { calls.failed++; throw new Error('network unavailable'); }
      calls.create.push(request); return { code: 0, data: { message_id: `om_dm_${++sent}`, chat_id: 'oc_dm' } };
    },
    patch: async request => { calls.patch.push(request); return { code: 0, data: {} }; },
  };
  const sdk = { Client: class { constructor() { this.im = { message: api }; } }, EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  const registry = createHarnessRegistry({ adapters: [{ id: 'operator-fixture', version: '1', roles: ['coordinator', 'worker'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, async run(input) {
      input.checkpoint({ driver: 'operator-fixture', id: 'worker-session' });
      const step = worker[Math.min(runs++, worker.length - 1)];
      return typeof step === 'function' ? step(input) : step;
    } }),
    createAssessor: () => ({
      assess,
      async handleEvent(input) { events.push(input); input.checkpoint({ driver: 'operator-fixture', id: 'coordinator-session' }); return coordinator(input); },
    }) }] });
  process.env.TEST_FEISHU_APP_SECRET = 'fixture-secret';
  const runtime = createProjectAgent({ projectRoot: root, harnessRegistry: registry, feishuSDK: sdk }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  runtime.configure({ feishu: { appId: 'cli_bot', appSecretEnv: 'TEST_FEISHU_APP_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], operator: { openId: 'ou_alice' } } });
  runtime.configureExecutor({ driver: 'operator-fixture' }, { expectedRevision: 0 });
  runtime.configureCoordinator({ assessor: { driver: 'operator-fixture' }, workflowMode: 'continuous' }, { expectedRevision: 0 });
  return { root, runtime, calls, events, control };
}
const waiting = { version: 2, state: 'waiting', summary: 'Two candidates found', artifacts: [], attention: { question: 'Decide each candidate.', decision } };
const ready = { version: 2, state: 'ready', summary: 'Decisions recorded', artifacts: [], attention: null };
const sentCard = request => JSON.parse(request.data.content);
const buttonValue = card => card.body.elements.find(element => element.tag === 'form').elements.at(-1).behaviors[0].value;
const header = request => JSON.parse(request.data.content).header.title.content;

test('operator configuration accepts one open id and can be removed', () => {
  const base = { appId: 'cli_bot', appSecretEnv: 'X', botOpenId: 'ou_bot', tenantKey: 't', chats: [{ chatId: 'oc_g', type: 'group', mode: 'mentions' }] };
  assert.deepEqual(validateProjectOptions({ feishu: { ...base, operator: { openId: 'ou_alice' } } }).feishu.operator, { openId: 'ou_alice' });
  assert.throws(() => validateProjectOptions({ feishu: { ...base, operator: { openId: 'alice' } } }), /open id/);
  assert.throws(() => validateProjectOptions({ feishu: { ...base, operator: { openId: 'ou_alice', chatId: 'oc_x' } } }), /Unsupported|Unknown|field/);
});

test('enabling operator delivery sends an existing unanswered question once without resuming its ticket', async t => {
  const { runtime, calls } = project(t, { worker: [{ ...waiting, attention: { question: 'Legacy candidates still need review.' } }] });
  runtime.configureV2({ feishu: { operator: null } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Find candidates before private notifications are enabled' });
  await runtime.runNext();
  const before = runtime.getDetailed(ticket.id);
  await runtime.flushNotifications();
  assert.equal(calls.create.length, 0);
  await runtime.stop();
  runtime.configureV2({ feishu: { operator: { openId: 'ou_alice' } } });
  await runtime.prepareExecution();
  await runtime.flushNotifications();
  await runtime.flushNotifications();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].data.msg_type, 'text');
  assert.equal(calls.create[0].data.receive_id, 'ou_alice');
  assert.match(JSON.parse(calls.create[0].data.content).text, /Legacy candidates still need review/);
  assert.equal(runtime.get(ticket.id).status, 'waiting');
  assert.deepEqual(runtime.getDetailed(ticket.id).attention, before.attention);
  assert.deepEqual(runtime.listAnswers(ticket.id), []);
  assert.equal(runtime.get(ticket.id).reports.length, 1);
});

test('decision cards use positional fields, plain text for Worker text, and map submissions back to item ids', () => {
  const card = decisionCard({ publicId: 'ticket-1', attentionId: 'attention-1', nonce: 'n', question: 'Pick *each*', decision: normalizeDecision(decision) });
  const form = card.body.elements.find(element => element.tag === 'form');
  assert.deepEqual(form.elements.filter(element => element.name).map(element => element.name), ['o0', 'r0', 'o1', 'r1', 'submit']);
  assert.equal(card.body.elements[0].text.content, 'Pick *each*');
  assert.deepEqual(buttonValue(card), { attention: 'attention-1', nonce: 'n' });
  assert.deepEqual(cardAnswers(normalizeDecision(decision), { o0: 'adopted', r0: ' fits ', o1: ['later'] }),
    { C0001: { option: 'adopted', reason: 'fits' }, C0002: { option: 'later' } });
  assert.deepEqual(parseCardAction({ schema: '2.0', header: { event_type: 'card.action.trigger', tenant_key: 'tenant' }, event: { operator: { open_id: 'ou_a' },
    action: { value: { attention: 'a', nonce: 'n' }, form_value: { o0: 'x' } }, context: { open_message_id: 'om_1', open_chat_id: 'oc_1' } } }),
  { type: 'card.action.trigger', tenantKey: 'tenant', operatorId: 'ou_a', messageId: 'om_1', chatId: 'oc_1', attentionId: 'a', nonce: 'n', form: { o0: 'x' } });
});

test('operator direct messages reach the coordinator, never open tickets, and replies return to the same message', async t => {
  const { runtime, calls, events } = project(t, { coordinator: input => ({ summary: 'answered', actions: [{ kind: 'reply', ticketId: null, text: `Nothing is running (${input.event.text})` }] }) });
  await runtime.prepareExecution();
  assert.equal(runtime.receiveSourceEvent('feishu', dm('om_in1', 'What is running?')).status, 'received');
  assert.equal(runtime.receiveSourceEvent('feishu', dm('om_in1', 'What is running?')).status, 'duplicate');
  assert.equal(runtime.receiveSourceEvent('feishu', dm('om_bob', 'hello', { from: 'ou_bob' })).status, 'ignored');
  assert.equal(runtime.list().length, 0);
  await runtime.runNext();
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].event.kind, events[0].event.actor.source, events[0].event.source.channel], ['operator', 'feishu', 'feishu']);
  await runtime.flushNotifications();
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].path.message_id, 'om_in1');
  assert.equal(JSON.parse(calls.reply[0].data.content).text, 'Nothing is running (What is running?)');
  assert.equal(runtime.list().length, 0);
});

test('a structured question reaches the operator as a card; only the operator\'s first valid submission is recorded', async t => {
  const { runtime, calls, events } = project(t, { worker: [waiting, ready],
    coordinator: input => input.event.kind === 'result'
      ? { summary: 'notify', actions: [{ kind: 'notify', ticketId: input.event.ticketId, text: 'Round finished: decisions recorded.' }] }
      : { summary: 'nothing', actions: [] } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Find candidates' });
  assert.equal((await runtime.runNext()).status, 'waiting');
  await runtime.flushNotifications();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].params.receive_id_type, 'open_id');
  assert.equal(calls.create[0].data.receive_id, 'ou_alice');
  assert.equal(calls.create[0].data.msg_type, 'interactive');
  const value = buttonValue(sentCard(calls.create[0]));
  const callback = overrides => ({ schema: '2.0', header: { event_type: 'card.action.trigger', tenant_key: 'tenant' }, event: {
    operator: { open_id: 'ou_alice' }, action: { value, form_value: { o0: 'adopted', r0: 'fits', o1: 'rejected', r1: 'duplicate' } },
    context: { open_message_id: 'om_dm_1', open_chat_id: 'oc_dm' }, ...overrides } });

  assert.equal(runtime.receiveFeishuCardAction(callback({ operator: { open_id: 'ou_bob' } })).toast.type, 'error');
  assert.equal(runtime.receiveFeishuCardAction(callback({ action: { value: { ...value, nonce: 'forged' }, form_value: {} } })).toast.type, 'error');
  assert.equal(runtime.receiveFeishuCardAction(callback({ context: { open_message_id: 'om_other', open_chat_id: 'oc_dm' } })).toast.type, 'error');
  assert.match(runtime.receiveFeishuCardAction(callback({ action: { value, form_value: { o0: 'adopted', o1: 'rejected', r1: 'x' } } })).toast.content, /needs a reason/);
  assert.equal(runtime.listAnswers(ticket.id).length, 0);
  const accepted = runtime.receiveFeishuCardAction(callback());
  assert.equal(accepted.toast.type, 'success');
  assert.equal(accepted.card.data.header.title.content, '已提交');
  assert.equal(runtime.receiveFeishuCardAction(callback()).toast.type, 'info');
  const [record] = runtime.listAnswers(ticket.id);
  assert.deepEqual([record.kind, record.via, record.by.id], ['structured', 'feishu-card', 'ou_alice']);
  assert.deepEqual(record.answers, { C0001: { option: 'adopted', reason: 'fits' }, C0002: { option: 'rejected', reason: 'duplicate' } });

  assert.equal((await runtime.runNext()).status, 'completed');
  await runtime.runNext();
  assert.equal(events.at(-1).event.kind, 'result');
  await runtime.flushNotifications();
  assert.equal(calls.patch.length, 0);
  const notice = calls.create.filter(request => request.data.msg_type === 'text').map(request => JSON.parse(request.data.content).text);
  assert.deepEqual(notice, [`Round finished: decisions recorded.\n\n工单 ${ticket.id}`]);
});

test('a text answer from the direct message goes through the coordinator and closes the sent card', async t => {
  const { runtime, calls, events } = project(t, { worker: [waiting],
    coordinator: input => {
      const open = input.context.tickets.find(item => item.question && !item.question.answered);
      return input.event.kind === 'operator' && open ? { summary: 'answer', actions: [{ kind: 'answer', ticketId: open.id, text: input.event.text }] } : { summary: 'none', actions: [] };
    } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Find candidates' });
  await runtime.runNext();
  await runtime.flushNotifications();
  runtime.receiveSourceEvent('feishu', dm('om_in2', 'Adopt both, they fit', { parent: 'om_dm_1' }));
  await runtime.runNext();
  assert.equal(events.at(-1).event.references.repliedTicketId, ticket.id);
  const [record] = runtime.listAnswers(ticket.id);
  assert.deepEqual([record.kind, record.via, record.text], ['text', 'feishu-text', 'Adopt both, they fit']);
  await runtime.flushNotifications();
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0].path.message_id, 'om_dm_1');
  assert.equal(header(calls.patch[0]), '已在别处回答');
});

test('a local completion receipt cannot silently satisfy the required operator notice; retry sends it once', async t => {
  let omitNotice = true;
  const { runtime, calls, events } = project(t, { worker: [ready], coordinator: input => omitNotice
    ? { summary: 'The host already delivered the completed result; no notification needed.', actions: [] }
    : { summary: 'Send the pending operator result.', actions: [{ kind: 'notify', ticketId: input.event.ticketId, text: 'Decisions recorded.' }] } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Record the supplied decisions' });
  await runtime.runNext();
  await runtime.flushNotifications();
  assert.ok(runtime.notifications().some(item => item.channel.source === 'local'));
  assert.equal(calls.create.length, 0);
  await runtime.runNext();
  const input = events.at(-1);
  assert.deepEqual(input.context.operatorNotification, { required: true, eventId: input.event.id, ticketId: ticket.id,
    channel: 'feishu', hostResultDelivery: 'local-only' });
  const missed = runtime.coordinationStatus().events.find(event => event.id === input.event.id);
  assert.equal(missed.status, 'failed');
  assert.match(missed.error, /requires exactly one notify.*local result receipt is not Feishu delivery/);
  assert.deepEqual(missed.receipts, []);
  omitNotice = false;
  runtime.retryCoordination(missed.id);
  await runtime.runNext();
  await runtime.flushNotifications();
  assert.equal(runtime.coordinationStatus().events.find(event => event.id === missed.id).status, 'completed');
  runtime.retryCoordination(missed.id);
  await runtime.runNext();
  await runtime.flushNotifications();
  const messages = calls.create.map(request => JSON.parse(request.data.content).text);
  assert.deepEqual(messages, [`Decisions recorded.\n\n工单 ${ticket.id}`]);
});

for (const state of ['failed', 'blocked']) test(`an operator ${state} report requires its own result notice`, async t => {
  const { runtime, events, calls } = project(t, { worker: [{ version: 2, state, summary: 'The supplied input cannot be processed.', artifacts: [] }],
    coordinator: input => ({ summary: 'Explain the obstacle.', actions: [{ kind: 'notify', ticketId: input.event.ticketId, text: input.event.text }] }) });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Process the supplied input' });
  await runtime.runNext();
  await runtime.runNext();
  await runtime.flushNotifications();
  assert.equal(events.at(-1).event.references.reportState, state);
  assert.equal(events.at(-1).context.operatorNotification.ticketId, ticket.id);
  assert.equal(events.at(-1).context.operatorNotification.required, true);
  assert.equal(calls.create.length, 1);
});

test('a required result notice cannot be omitted, retargeted or multiplied', () => {
  const event = { id: 'result-1', ticketId: 'ticket-1', kind: 'result' };
  const context = { tickets: [{ id: 'ticket-1' }, { id: 'ticket-2' }],
    operatorNotification: { required: true, eventId: event.id, ticketId: event.ticketId, channel: 'feishu', hostResultDelivery: 'local-only' } };
  const notify = (ticketId, text = 'The task finished.') => ({ kind: 'notify', ticketId, text });
  for (const actions of [[], [notify(null)], [notify('ticket-2')], [notify('ticket-1'), notify('ticket-1', 'Another message.')]]) {
    assert.throws(() => validateWorkEventResult({ summary: 'done', actions }, { event, context }), /exactly one notify/);
  }
  assert.deepEqual(validateWorkEventResult({ summary: 'done', actions: [notify('ticket-1')] }, { event, context }).actions, [notify('ticket-1')]);
  assert.deepEqual(validateWorkEventResult({ summary: 'host handles the original conversation', actions: [] },
    { event, context: { tickets: context.tickets } }).actions, []);
});

test('a coordinator cannot paraphrase an answer or notify from an operator message', async t => {
  const { runtime } = project(t, { worker: [waiting],
    coordinator: input => input.event.kind === 'operator'
      ? { summary: 'bad', actions: [{ kind: 'answer', ticketId: input.context.tickets[0].id, text: 'adopt everything' }] } : { summary: 'none', actions: [] } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Find candidates' });
  await runtime.runNext();
  runtime.receiveSourceEvent('feishu', dm('om_in3', 'Adopt C0001 only'));
  await runtime.runNext();
  assert.equal(runtime.listAnswers(ticket.id).length, 0);
  assert.match(runtime.coordinationStatus().events.find(event => event.kind === 'operator').error, /original operator message/);
});

test('cancelling withdraws an unsent question and closes a sent card', async t => {
  const first = project(t, { worker: [waiting] });
  await first.runtime.prepareExecution();
  first.control.failCreate = true;
  const unsent = first.runtime.submit({ text: 'First' });
  await first.runtime.runNext();
  await first.runtime.flushNotifications();
  assert.ok(first.calls.failed >= 1);
  first.runtime.cancel(unsent.id);
  first.control.failCreate = false;
  const database = new DatabaseSync(join(stateDir(first.root), 'state.sqlite'));
  try { database.exec('UPDATE effects SET due = 0'); } finally { database.close(); }
  await first.runtime.flushNotifications();
  assert.equal(first.calls.create.length, 0);
  assert.equal(first.calls.patch.length, 0);

  const second = project(t, { worker: [waiting] });
  await second.runtime.prepareExecution();
  const sent = second.runtime.submit({ text: 'Second' });
  await second.runtime.runNext();
  await second.runtime.flushNotifications();
  second.runtime.cancel(sent.id);
  await second.runtime.flushNotifications();
  assert.equal(second.calls.patch.length, 1);
  assert.equal(header(second.calls.patch[0]), '工单已结束');
});

test('a plain question is a text message, and a newer question marks the earlier card as superseded', async t => {
  const plainQuestion = { version: 2, state: 'waiting', summary: 'Need a path', artifacts: [], attention: { question: 'Which folder should I use?' } };
  const text = project(t, { worker: [plainQuestion] });
  await text.runtime.prepareExecution();
  const asked = text.runtime.submit({ text: 'Plain' });
  await text.runtime.runNext(); await text.runtime.flushNotifications();
  assert.equal(text.calls.create[0].data.msg_type, 'text');
  assert.equal(JSON.parse(text.calls.create[0].data.content).text, `需要你回复（工单 ${asked.id}）\n\nWhich folder should I use?`);

  const second = { ...waiting, attention: { question: 'Decide again with new facts.', decision } };
  const cards = project(t, { worker: [waiting, second] });
  await cards.runtime.prepareExecution();
  const ticket = cards.runtime.submit({ text: 'Cards' });
  await cards.runtime.runNext(); await cards.runtime.flushNotifications();
  cards.runtime.note(ticket.id, 'A new fact arrived');
  await cards.runtime.runNext(); await cards.runtime.flushNotifications();
  assert.equal(cards.calls.create.length, 2);
  assert.equal(cards.calls.patch.length, 1);
  assert.equal(cards.calls.patch[0].path.message_id, 'om_dm_1');
  assert.equal(header(cards.calls.patch[0]), '已失效：有新的问题');
  assert.equal(cards.runtime.listAnswers(ticket.id).length, 0);
});

test('a runtime that never connected Feishu does not overwrite the connection state when it stops', async t => {
  const { runtime, root } = project(t);
  await runtime.stop();
  const database = new DatabaseSync(join(stateDir(root), 'state.sqlite'));
  try { assert.equal(database.prepare("SELECT data FROM kv WHERE key = 'feishu:connection'").get(), undefined); } finally { database.close(); }
});


const legacyWaiting = { ...waiting, attention: { question: 'Decide these existing candidates.' } };
const decisionCallback = (value, messageId = 'om_dm_2') => ({ schema: '2.0', header: { event_type: 'card.action.trigger', tenant_key: 'tenant' }, event: {
  operator: { open_id: 'ou_alice' }, action: { value, form_value: { o0: 'adopted', r0: 'fits', o1: 'later', r1: 'review later' } },
  context: { open_message_id: messageId, open_chat_id: 'oc_dm' },
} });

test('attaching choices upgrades a sent legacy question to one card without replacing the question or resuming work', async t => {
  const { runtime, calls } = project(t, { worker: [legacyWaiting, ready] });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Review existing candidates' });
  await runtime.runNext();
  await runtime.flushNotifications();
  const before = runtime.getDetailed(ticket.id);
  const attentionId = before.attention.id;
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].data.msg_type, 'text');
  assert.equal(sentCard(calls.create[0]).body, undefined, 'legacy text contains no interactive callback');

  runtime.attachDecision(ticket.id, { attentionId, decision });
  runtime.attachDecision(ticket.id, { attentionId, decision: structuredClone(decision) });
  await runtime.flushNotifications();
  await runtime.flushNotifications();
  assert.equal(calls.create.length, 2, 'one original text and one upgrade card');
  assert.equal(calls.create[1].data.msg_type, 'interactive');
  assert.equal(calls.create[1].data.receive_id, 'ou_alice');
  const after = runtime.getDetailed(ticket.id);
  assert.equal(after.attention.id, attentionId);
  assert.equal(after.attention.question, before.attention.question);
  assert.deepEqual(after.attention.decision, normalizeDecision(decision));
  assert.equal(after.ticket.status, 'waiting');
  assert.deepEqual(runtime.listAnswers(ticket.id), []);
  assert.equal(after.reports.length, before.reports.length);
  const card = sentCard(calls.create[1]);
  const value = buttonValue(card);
  assert.equal(value.attention, attentionId);
  assert.equal(runtime.receiveFeishuCardAction(decisionCallback(value, 'om_dm_1')).toast.type, 'error', 'original text cannot be used as the submitting card');
  assert.equal(runtime.receiveFeishuCardAction(decisionCallback({ ...value, nonce: 'old-or-forged' })).toast.type, 'error');
  assert.equal(runtime.listAnswers(ticket.id).length, 0);
  assert.equal(runtime.receiveFeishuCardAction(decisionCallback(value)).toast.type, 'success');
  assert.equal(runtime.receiveFeishuCardAction(decisionCallback(value)).toast.type, 'info');
  assert.equal(runtime.listAnswers(ticket.id).length, 1);
  assert.equal(runtime.listAnswers(ticket.id)[0].kind, 'structured');
  assert.throws(() => runtime.answer(ticket.id, { attentionId, answers: { C0001: { option: 'later', reason: 'late' }, C0002: { option: 'later', reason: 'late' } } }), /already answered|open question|waiting/i);
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId, decision }), /already answered|open question|waiting/i);
});

test('a text answer after upgrading a legacy question wins once and invalidates the card', async t => {
  const { runtime, calls } = project(t, { worker: [legacyWaiting, ready], coordinator: input => {
    const ticket = input.context.tickets.find(item => item.question && !item.question.answered);
    return input.event.kind === 'operator' && ticket
      ? { summary: 'answer', actions: [{ kind: 'answer', ticketId: ticket.id, text: input.event.text }] }
      : { summary: 'none', actions: [] };
  } });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Review existing candidates' });
  await runtime.runNext(); await runtime.flushNotifications();
  const attentionId = runtime.getDetailed(ticket.id).attention.id;
  runtime.attachDecision(ticket.id, { attentionId, decision });
  await runtime.flushNotifications();
  const value = buttonValue(sentCard(calls.create[1]));
  runtime.receiveSourceEvent('feishu', dm('om_legacy_answer', 'Defer both, I need more time', { parent: 'om_dm_1' }));
  await runtime.runNext();
  assert.equal(runtime.listAnswers(ticket.id).length, 1);
  assert.deepEqual([runtime.listAnswers(ticket.id)[0].kind, runtime.listAnswers(ticket.id)[0].via], ['text', 'feishu-text']);
  await runtime.flushNotifications();
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0].path.message_id, 'om_dm_2');
  assert.equal(header(calls.patch[0]), '已在别处回答');
  assert.notEqual(runtime.receiveFeishuCardAction(decisionCallback(value)).toast.type, 'success');
  assert.equal(runtime.listAnswers(ticket.id).length, 1);
});

test('attaching choices requires the current unanswered question and cannot rewrite existing choices', async t => {
  const { runtime, calls } = project(t, { worker: [legacyWaiting, ready] });
  await runtime.prepareExecution();
  const ticket = runtime.submit({ text: 'Review existing candidates' });
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId: 'not-open', decision }));
  await runtime.runNext(); await runtime.flushNotifications();
  const attentionId = runtime.getDetailed(ticket.id).attention.id;
  assert.throws(() => runtime.attachDecision(ticket.id, { decision }));
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId: '', decision }));
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId: 'stale-question', decision }));
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId, decision: { ...decision, items: [] } }));
  assert.equal(runtime.getDetailed(ticket.id).attention.decision, undefined);
  runtime.attachDecision(ticket.id, { attentionId, decision });
  const different = structuredClone(decision);
  different.items[0].url = 'https://example.com/changed';
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId, decision: different }));
  assert.deepEqual(runtime.getDetailed(ticket.id).attention.decision, normalizeDecision(decision));
  await runtime.flushNotifications();
  assert.equal(calls.create.length, 2);
  runtime.cancel(ticket.id);
  assert.throws(() => runtime.attachDecision(ticket.id, { attentionId, decision }));
  assert.equal(runtime.listAnswers(ticket.id).length, 0);
});


test('upgrading an unsent legacy question withdraws the text retry and sends only the card', async t => {
  const { runtime, calls, control, root } = project(t, { worker: [legacyWaiting] });
  await runtime.prepareExecution();
  control.failCreate = true;
  const ticket = runtime.submit({ text: 'Review existing candidates while the channel is unavailable' });
  await runtime.runNext(); await runtime.flushNotifications();
  assert.ok(calls.failed >= 1);
  assert.equal(calls.create.length, 0);
  const attentionId = runtime.getDetailed(ticket.id).attention.id;
  runtime.attachDecision(ticket.id, { attentionId, decision });
  control.failCreate = false;
  const database = new DatabaseSync(join(stateDir(root), 'state.sqlite'));
  try { database.exec('UPDATE effects SET due = 0'); } finally { database.close(); }
  await runtime.flushNotifications();
  runtime.attachDecision(ticket.id, { attentionId, decision });
  await runtime.flushNotifications();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].data.msg_type, 'interactive');
  assert.equal(buttonValue(sentCard(calls.create[0])).attention, attentionId);
  assert.equal(runtime.get(ticket.id).status, 'waiting');
  assert.equal(runtime.get(ticket.id).reports.length, 1);
  assert.deepEqual(runtime.listAnswers(ticket.id), []);
});


test('candidate assessment failures reach the original operator and remain recoverable without duplicate tickets', async t => {
  let accept = false;
  const { runtime, calls, events } = project(t, { worker: [waiting],
    coordinator: input => input.event.text === 'Inspect the project' ? { summary: 'New authorized request', actions: [{ kind: 'request', ticketId: null, text: input.event.text }] }
      : { summary: 'Inspected request status', actions: [] },
    assess: async input => {
      if (!accept) throw Object.assign(new Error('private-token-should-not-leak'), { failureKind: 'format', code: 'assessment_format', retryable: true, attempts: 3, corrections: 2, exhausted: true });
      return { kind: 'accept', reason: 'Explicit request', title: 'Inspect project', scope: 'Read-only inspection', rules: [] };
    } });
  await runtime.prepareExecution();
  runtime.receiveSourceEvent('feishu', dm('om_request', 'Inspect the project'));
  await runtime.runNext();
  const event = runtime.coordinationStatus().events.find(item => item.text === 'Inspect the project');
  const triggerId = event.receipts[0].result.triggerId;
  await runtime.runNext();
  const failed = runtime.eventDiagnostic(triggerId);
  assert.equal(failed.evaluation.status, 'failed');
  assert.equal(failed.evaluation.assessment.failureKind, 'format');
  assert.equal(failed.evaluation.assessment.retryable, true);
  assert.equal(failed.evaluation.assessment.corrections, 2);
  assert.equal(runtime.list().length, 0);
  await runtime.flushNotifications();
  const receipt = calls.reply.find(request => request.path.message_id === 'om_request');
  assert.ok(receipt); assert.match(receipt.data.content, /纠正 2 次/); assert.doesNotMatch(receipt.data.content, /private-token/);
  const original = runtime.eventDiagnostics({ query: 'Inspect the project' }).items.find(item => item.source === 'feishu');
  assert.equal(original.requests[0].status, 'failed');
  runtime.receiveSourceEvent('feishu', dm('om_status', 'What happened?'));
  await runtime.runNext();
  const request = events.at(-1).context.recentEvents.find(item => item.id === event.id).requests[0];
  assert.equal(request.status, 'failed'); assert.equal(request.failureKind, 'format');
  assert.doesNotMatch(JSON.stringify(request), /private-token/);
  accept = true;
  assert.equal(runtime.reevaluate(triggerId), true);
  assert.equal(runtime.eventDiagnostic(triggerId).evaluation.status, 'pending');
  await runtime.runNext();
  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.reevaluate(triggerId), false);
  await runtime.runNext(); assert.equal(runtime.list().length, 1);
  assert.equal(runtime.notifications().filter(item => item.id.startsWith('assessment-result:')).length, 2);
  assert.equal(runtime.eventDiagnostic(triggerId).evaluation.status, 'decided');
});

test('legacy request receipts recover provenance and revoked operator authority cannot be retried', async t => {
  const { runtime, root } = project(t, { coordinator: input => ({ summary: 'Request', actions: [{ kind: 'request', ticketId: null, text: input.event.text }] }),
    assess: async () => { throw new Error('Unavailable adapter'); } });
  await runtime.prepareExecution();
  runtime.receiveSourceEvent('feishu', dm('om_legacy', 'Inspect source records'));
  await runtime.runNext();
  const triggerId = runtime.coordinationStatus().events[0].receipts[0].result.triggerId;
  const db = new DatabaseSync(join(stateDir(root), 'state.sqlite'));
  db.prepare('DELETE FROM kv WHERE key=?').run(`assessment-origin:${triggerId}`); db.close();
  await runtime.runNext();
  await runtime.stop();
  runtime.configureV2({ feishu: { operator: { openId: 'ou_bob' } } });
  assert.throws(() => runtime.reevaluate(triggerId), /authority/);
  assert.equal(runtime.list().length, 0);
});

test('candidate ticket creation rolls back if its durable operator receipt cannot be queued', async t => {
  const { runtime, root } = project(t, { worker: [waiting],
    coordinator: input => ({ summary: 'Request', actions: [{ kind: 'request', ticketId: null, text: input.event.text }] }),
    assess: async () => ({ kind: 'accept', reason: 'Authorized', title: 'Inspect source', scope: 'Read-only inspection', rules: [] }) });
  await runtime.prepareExecution();
  runtime.receiveSourceEvent('feishu', dm('om_atomic', 'Inspect source'));
  await runtime.runNext();
  const triggerId = runtime.coordinationStatus().events[0].receipts[0].result.triggerId;
  const db = new DatabaseSync(join(stateDir(root), 'state.sqlite'));
  db.exec("CREATE TRIGGER fail_assessment_receipt BEFORE INSERT ON receipts WHEN json_extract(NEW.data, '$.text') LIKE '已建立工单 %' BEGIN SELECT RAISE(ABORT, 'receipt storage failure'); END");
  await runtime.runNext();
  assert.equal(runtime.list().length, 0);
  assert.equal(runtime.eventDiagnostic(triggerId).evaluation.status, 'failed');
  assert.equal(runtime.notifications().some(item => item.text.startsWith('已建立工单')), false);
  db.exec('DROP TRIGGER fail_assessment_receipt'); db.close();
  runtime.reevaluate(triggerId); await runtime.runNext();
  assert.equal(runtime.list().length, 1);
});

test('semantic unavailable replies once without being reported as an execution failure', async t => {
  const { runtime, calls } = project(t, {
    coordinator: input => ({ summary: 'Request', actions: [{ kind: 'request', ticketId: null, text: input.event.text }] }),
    assess: async () => ({ kind: 'unavailable', reason: 'The source date is missing', rules: [] }) });
  await runtime.prepareExecution();
  runtime.receiveSourceEvent('feishu', dm('om_missing_info', 'Check the source'));
  await runtime.runNext(); const triggerId = runtime.coordinationStatus().events[0].receipts[0].result.triggerId;
  await runtime.runNext(); await runtime.flushNotifications();
  assert.equal(runtime.eventDiagnostic(triggerId).evaluation.status, 'decided');
  assert.equal(runtime.eventDiagnostic(triggerId).evaluation.assessment.failureKind, null);
  assert.equal(calls.reply.filter(item => item.path.message_id === 'om_missing_info').length, 1);
  assert.match(calls.reply.at(-1).data.content, /补充信息/);
});

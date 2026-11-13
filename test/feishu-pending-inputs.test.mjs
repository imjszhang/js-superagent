import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { createRuntimePolicy, retainedFeishuSupplementAllowed } from '../src/policy.mjs';
import { writeProjectConfig } from '../src/config.mjs';

const triggerId = id => `feishu:tenant:${id}`;
const rootId = 'om_request';
const threadKey = `feishu:tenant:oc_group:${rootId}`;
const accept = { kind: 'accept', title: 'Inspect fictional notes', scope: 'Read the fictional project only', reason: 'Authorized request', rules: [] };
async function assessmentStarted(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture assessment did not start')), 10_000); timer.unref();
  })]); } finally { clearTimeout(timer); }
}
function message(id, { author = 'ou_alice', root, addressed = false, text = 'Read only; preserve existing files', senderType = 'user' } = {}) {
  return { sender: { sender_id: { open_id: author }, sender_type: senderType, tenant_key: 'tenant' },
    message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1793491200000',
      ...(root ? { root_id: root } : {}), content: JSON.stringify({ text }),
      mentions: addressed ? [{ id: { open_id: 'ou_bot' } }] : [] } };
}
function fixture(t, { assess, noAssessor = false, actors = ['ou_alice', 'ou_bob'], bots = [], workerState = 'waiting' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-pending-'))), seen = [], sent = [];
  const api = { list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async ({ path }) => ({ code: 0, data: { items: [{ message_id: path.message_id, chat_id: 'oc_group' }] } }),
    reply: async request => { sent.push(request); return { code: 0, data: { message_id: `om_sent_${sent.length}` } }; } };
  const sdk = { Client: class { constructor() { this.im = { message: api }; } },
    EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  process.env.FEISHU_PENDING_SECRET = 'fixture-secret';
  const open = () => createProjectAgent({ projectRoot: root, feishuSDK: sdk,
    driver: { async run() { return { version: 2, state: workerState, summary: 'Fixture result', artifacts: [], attention: null }; } },
    ...(!noAssessor ? { assessor: { async assess(input) { seen.push(structuredClone(input.candidate)); return assess ? assess(input) : accept; } } } : {}) }).init();
  let runtime = open();
  const config = { appId: 'cli_fixture', appSecretEnv: 'FEISHU_PENDING_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] };
  runtime.configure({ feishu: config });
  const policy = { mode: 'off', rules: [], sourceRows: [{ id: 'group', source: 'feishu', scope: { tenantKey: 'tenant', chatId: 'oc_group' }, actors, bots, admission: {} }] };
  runtime.configureCoordinator({ policy, ...(!noAssessor ? { assessor: { driver: 'fixture-assessor' } } : {}) }, { expectedRevision: 0 });
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { await runtime.stop(); store.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const receive = (id, options) => runtime.receiveSourceEvent('feishu', message(id, options));
  const request = () => receive(rootId, { addressed: true, text: 'Inspect the fictional notes' });
  const note = (id = 'om_note', options = {}) => receive(id, { root: rootId, ...options });
  return { root, get runtime() { return runtime; }, store, seen, sent, receive, request, note, policy, config,
    async reopen() { await runtime.stop(); runtime.close(); runtime = open(); await runtime.prepareExecution(); } };
}

for (const noteFirst of [false, true]) test(`a qualified topic supplement joins the pre-assessment batch (noteFirst=${noteFirst})`, async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  if (noteFirst) f.note(); f.request(); if (!noteFirst) f.note();
  assert.deepEqual(new Set(f.store.threads.get(threadKey).pending), new Set([triggerId(rootId), triggerId('om_note')]));
  assert.equal(f.store.triggers.get(triggerId('om_note')).addressed, undefined);
  assert.deepEqual(f.store.triggers.disposition(triggerId('om_note')).fanout, []);
  await f.runtime.runNext();
  assert.deepEqual(new Set(f.seen[0].triggers.map(item => item.id)), new Set([triggerId(rootId), triggerId('om_note')]));
  assert.equal(f.runtime.list().length, 1);
  const ticket = f.runtime.getDomainTicket(f.runtime.list()[0].id);
  assert.equal(ticket.origin.triggerIds.filter(id => id === triggerId('om_note')).length, 1);
  assert.equal(ticket.origin.triggerId, triggerId(rootId), 'the supplement does not become the authorizing origin');
  assert.equal(f.note().status, 'duplicate');
});

test('a supplement arriving during assessment stays pending for explicit next-round attach', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { async assess({ candidate }) {
    if (candidate.triggers.some(item => item.id === triggerId(rootId))) { started.resolve(); await release.promise; return accept; }
    return { kind: 'attach', triggerId: triggerId('om_during'), ticketId: candidate.tickets[0].id, reason: 'Supplement belongs to the existing investigation', rules: [] };
  } });
  await f.runtime.prepareExecution(); f.request(); const running = f.runtime.runNext();
  try { await assessmentStarted(started.promise); f.note('om_during'); assert.deepEqual(f.store.threads.get(threadKey).pending, [triggerId('om_during')]); }
  finally { release.resolve(); await running; }
  assert.equal(f.runtime.list().length, 1);
  const id = f.runtime.list()[0].id;
  assert.equal(f.runtime.getDomainTicket(id).inputs.some(input => input.triggerId === triggerId('om_during')), false, 'pending is not unconditional fanout');
  await f.runtime.runNext();
  assert.equal(f.seen.length, 2); assert.equal(f.runtime.list().length, 1);
  assert.equal(f.runtime.getDomainTicket(id).inputs.filter(input => input.triggerId === triggerId('om_during')).length, 1);
  f.note('om_after'); await f.runtime.runNext();
  assert.equal(f.seen.length, 2, 'post-ticket followup stays with its Worker');
  assert.equal(f.runtime.getDomainTicket(id).inputs.filter(input => input.triggerId === triggerId('om_after')).length, 1);
});

test('ignoring an irrelevant non-addressed input does not fail or discard its authorized sibling', async t => {
  const f = fixture(t, { assess: ({ candidate }) => candidate.triggers.some(item => item.id === triggerId('om_note'))
    ? { kind: 'ignore', triggerId: triggerId('om_note'), reason: 'Unrelated aside', rules: [] } : accept });
  await f.runtime.prepareExecution(); f.request(); f.note(); await f.runtime.runNext();
  const disposition = f.store.triggers.disposition(triggerId('om_note'));
  assert.equal(f.store.decisions.get(disposition.decisionId).kind, 'ignore');
  const thread = f.store.threads.get(threadKey);
  assert.deepEqual([...thread.pending, ...(thread.evaluating?.triggerIds ?? [])], [triggerId(rootId)]);
  await f.runtime.runNext(); assert.equal(f.runtime.list().length, 1);
  assert.equal(f.runtime.getDomainTicket(f.runtime.list()[0].id).inputs.some(input => input.triggerId === triggerId('om_note')), false);
});

test('a same-batch withdrawal can ignore the original request without inventing a stop ticket', async t => {
  const f = fixture(t, { assess: ({ candidate }) => {
    assert.ok(candidate.triggers.some(item => item.text === 'Cancel this request before creating work'));
    return { kind: 'ignore', triggerId: triggerId(rootId), reason: 'Requester withdrew the work', rules: [] };
  } });
  await f.runtime.prepareExecution(); f.request(); f.note('om_withdraw', { text: 'Cancel this request before creating work' });
  await f.runtime.runNext(); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 0); assert.equal(f.seen.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.store.decisions.byThread(threadKey).every(item => item.kind === 'ignore'), true);
});

test('an isolated supplement cannot start work or be revived by a later mention', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); f.note(); await f.runtime.runNext();
  assert.equal(f.seen.length, 0); assert.equal(f.runtime.list().length, 0);
  assert.equal(f.store.decisions.get(f.store.triggers.disposition(triggerId('om_note')).decisionId).kind, 'ignore');
  f.request(); await f.runtime.runNext();
  assert.deepEqual(f.seen[0].triggers.map(item => item.id), [triggerId(rootId)]);
  assert.equal(f.note().status, 'duplicate');
  assert.equal(f.runtime.getDomainTicket(f.runtime.list()[0].id).inputs.some(input => input.triggerId === triggerId('om_note')), false);
});

test('unlisted people, configured bots and ordinary roots do not borrow a mention in the same topic', async t => {
  const f = fixture(t, { bots: ['ou_automation'] }); await f.runtime.prepareExecution(); f.request();
  f.note('om_outsider', { author: 'ou_outsider' }); f.note('om_bot', { author: 'ou_automation' });
  f.note('om_nativebot', { author: 'ou_bob', senderType: 'app' });
  assert.equal(f.receive('om_plain').status, 'ignored');
  await f.runtime.runNext(); assert.deepEqual(f.seen[0].triggers.map(item => item.id), [triggerId(rootId)]);
  for (const id of ['om_outsider', 'om_bot', 'om_nativebot']) assert.ok(f.store.triggers.disposition(triggerId(id)).filtered);
});

test('a retained second author revoked before assessment is removed without discarding the original request', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); f.request(); f.note('om_bob', { author: 'ou_bob' });
  const policy = structuredClone(f.policy); policy.sourceRows[0].actors = ['ou_alice'];
  f.runtime.configureCoordinator({ policy }, { expectedRevision: 1 });
  await f.runtime.runNext();
  const denied = f.store.decisions.get(f.store.triggers.disposition(triggerId('om_bob')).decisionId);
  assert.equal(denied.kind, 'unavailable'); assert.equal(f.seen.length, 0, 'revoked supplement must not enter the model');
  await f.runtime.runNext(); assert.equal(f.runtime.list().length, 1);
  assert.deepEqual(f.seen[0].triggers.map(item => item.id), [triggerId(rootId)]);
});

test('listed supplement authors cannot borrow the original requester material grant', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'notes.md'), 'FICTIONAL PRIVATE MATERIAL');
  f.runtime.configureMaterials({ entries: [{ id: 'notes', project: 'self', include: ['notes.md'], views: ['current'],
    readers: [{ source: 'feishu', id: 'ou_alice' }], destinations: [{ source: 'feishu', id: 'oc_group' }] }],
    defaults: { sources: [{ id: 'notes', view: { kind: 'current' } }] } }, { expectedRevision: 0 });
  await f.runtime.prepareExecution(); f.request(); f.note('om_bob', { author: 'ou_bob' }); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 0);
  const denied = f.store.decisions.get(f.store.triggers.disposition(triggerId('om_bob')).decisionId);
  assert.equal(denied.kind, 'unavailable');
  assert.equal(f.store.getMeta(`assessment:${denied.audit.triggerDecision.sourceEvalId}`).code, 'MATERIAL_ACCESS_DENIED');
});

test('without an assessor the existing synchronous mention path and subscribed followup remain available', async t => {
  const f = fixture(t, { noAssessor: true }); await f.runtime.prepareExecution(); f.request();
  assert.equal(f.runtime.list().length, 1); f.note(); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1); assert.equal(f.seen.length, 0);
  assert.equal(f.runtime.getDomainTicket(f.runtime.list()[0].id).inputs.filter(input => input.triggerId === triggerId('om_note')).length, 1);
});

test('pending input and its qualification survive a runtime reopen without duplicating work', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); f.request(); f.note();
  await f.reopen(); assert.equal(f.note().status, 'duplicate'); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1); assert.equal(f.seen.length, 1);
  assert.deepEqual(new Set(f.runtime.getDomainTicket(f.runtime.list()[0].id).origin.triggerIds), new Set([triggerId(rootId), triggerId('om_note')]));
});

test('scope removed during assessment cannot commit a retained supplement', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { async assess() { started.resolve(); await release.promise; return accept; } });
  await f.runtime.prepareExecution(); f.request(); f.note(); const running = f.runtime.runNext();
  try {
    await assessmentStarted(started.promise);
    writeProjectConfig(f.root, { feishu: { ...f.config, chats: [{ chatId: 'oc_other', type: 'group', mode: 'mentions' }] } });
  } finally { release.resolve(); await running; }
  assert.equal(f.runtime.list().length, 0);
  const decision = f.store.decisions.get(f.store.triggers.disposition(triggerId('om_note')).decisionId);
  assert.equal(decision.kind, 'unavailable');
  assert.equal(f.store.getMeta(`assessment:${decision.audit.triggerDecision.sourceEvalId}`).failureKind, 'authority');
});

test('a new supplement cannot revive a human-stopped ticket', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); f.request(); await f.runtime.runNext();
  const id = f.runtime.list()[0].id; f.runtime.cancel(id);
  const before = f.runtime.getDomainTicket(id); assert.equal(before.ended.by, 'human');
  f.note(); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1); assert.equal(f.seen.length, 1);
  assert.deepEqual(f.runtime.getDomainTicket(id).inputs, before.inputs);
  assert.equal(f.runtime.getDomainTicket(id).ended.by, 'human');
});

test('a normal completed ticket retains its existing human followup behavior', async t => {
  const f = fixture(t, { workerState: 'ready' }); await f.runtime.prepareExecution(); f.request(); await f.runtime.runNext();
  const id = f.runtime.list()[0].id; assert.equal(f.runtime.get(id).status, 'completed');
  f.note(); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1); assert.equal(f.seen.length, 1);
  assert.equal(f.runtime.getDomainTicket(id).inputs.filter(input => input.kind === 'trigger' && input.triggerId === triggerId('om_note')).length, 1);
});

test('retention checks platform identity and topic shape rather than message supplied claims', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); f.note();
  const original = f.store.triggers.get(triggerId('om_note')), policy = createRuntimePolicy({ config: f.policy });
  assert.equal(retainedFeishuSupplementAllowed(policy, f.config, original), true);
  const changes = [
    value => { value.actor.source = 'github'; }, value => { value.actor.id = 'ou_outsider'; },
    value => { value.human = false; }, value => { value.meta.contextOnly = true; }, value => { value.meta.operator = true; },
    value => { value.meta.chatId = 'oc_else'; }, value => { value.meta.tenantKey = 'elsewhere'; },
    value => { value.threads[0].id = 'tenant:oc_group:om_else'; }, value => { value.channel.address.messageId = 'om_else'; },
    value => { value.channel.address.tenantKey = 'elsewhere'; }, value => { value.meta.parentId = 'invalid'; },
    value => { value.channel.address.sourceId = 'another-adapter'; }, value => { value.meta.threadId = 'invalid'; },
    value => { value.meta.rootId = value.meta.messageId; }, value => { value.meta = undefined; },
    value => { value.addressed = 'mention'; }, value => { value.threads.push({ source: 'feishu', id: 'tenant:oc_group:om_else' }); },
  ];
  for (const change of changes) {
    const value = structuredClone(original); change(value);
    assert.equal(retainedFeishuSupplementAllowed(policy, f.config, value), false, String(change));
  }
  const ambiguous = structuredClone(f.policy); ambiguous.sourceRows.push({ ...ambiguous.sourceRows[0], id: 'duplicate' });
  assert.equal(retainedFeishuSupplementAllowed(createRuntimePolicy({ config: ambiguous }), f.config, original), false);
});

test('a cancellation received during assessment is considered next round and can stop the original ticket', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { async assess({ candidate }) {
    if (candidate.triggers.some(item => item.id === triggerId(rootId))) { started.resolve(); await release.promise; return accept; }
    assert.equal(candidate.triggers[0].text, 'Stop the requested investigation');
    return { kind: 'stop', ticketId: candidate.tickets[0].id, reason: 'Explicit human cancellation', rules: [] };
  } });
  await f.runtime.prepareExecution(); f.request(); const running = f.runtime.runNext();
  try { await assessmentStarted(started.promise); f.note('om_cancel', { text: 'Stop the requested investigation' }); }
  finally { release.resolve(); await running; }
  const id = f.runtime.list()[0].id;
  assert.equal(f.runtime.get(id).status, 'waiting', 'natural-language cancellation is not a first-round execution barrier');
  await f.runtime.runNext(); assert.equal(f.runtime.list().length, 1);
  assert.equal(f.runtime.getDomainTicket(id).ended.by, 'human');
});

test('a previously filtered message is not replayed after its author becomes eligible', async t => {
  const f = fixture(t, { actors: ['ou_alice'] }); await f.runtime.prepareExecution(); f.note('om_old', { author: 'ou_bob' });
  assert.ok(f.store.triggers.disposition(triggerId('om_old')).filtered);
  const policy = structuredClone(f.policy); policy.sourceRows[0].actors.push('ou_bob');
  f.runtime.configureCoordinator({ policy }, { expectedRevision: 1 }); f.request();
  assert.equal(f.note('om_old', { author: 'ou_bob' }).status, 'duplicate'); await f.runtime.runNext();
  assert.deepEqual(f.seen[0].triggers.map(item => item.id), [triggerId(rootId)]);
  assert.equal(f.runtime.list().length, 1);
});

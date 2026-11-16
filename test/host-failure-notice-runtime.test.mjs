import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { Outbox } from '../src/outbox.mjs';
import { Effects } from '../src/effects.mjs';
import { buildWorkerContext, workerContextResources } from '../src/runtime/worker-context.mjs';
import { HOST_FAILURE_NOTICE_TEXT, WORKER_INPUT_UNREAD_CODE } from '../src/runtime/host-failure-notice.mjs';

const materialSecret = 'FICTIONAL_PRIVATE_MATERIAL_BODY';
const inputSecret = 'FICTIONAL_PRIVATE_SUPPLEMENT_BODY';
const prefix = 'host-failure-notice-';
const rawMessage = (id, text, rootId) => ({ sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 'tenant' },
  message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1793491200000',
    ...(rootId ? { root_id: rootId } : {}), content: JSON.stringify({ text }), mentions: rootId ? [] : [{ id: { open_id: 'ou_bot' }, key: '@_user_1', name: 'Bot' }] } });

function fixture(t, { materials = false, pause = false, consume = false, reportState = 'ready', operator = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-failure-notice-'))), calls = [];
  writeFileSync(join(root, 'notes.md'), materialSecret);
  const state = { runs: 0, consume, reportState, pause, acceptedThenLost: false, onRun: null };
  let runtime, store;
  const api = { list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async request => { await state.onGet?.(request); return { code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: request.path.message_id.startsWith('om_dm') ? 'oc_dm' : 'oc_group' }] } }; },
    reply: async request => {
      calls.push(structuredClone(request));
      await state.onWrite?.(request);
      if (state.acceptedThenLost && JSON.parse(request.data.content).text.startsWith(HOST_FAILURE_NOTICE_TEXT)) throw new Error('Fixture remote accepted but response was lost');
      return { code: 0, data: { message_id: `om_sent_${calls.length}` } };
    } };
  const sdk = { Client: class { constructor() { this.im = { message: api }; } }, EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  const driver = { capabilities: { boundedContextVersion: 1, agentTools: true, boundedMaterialReadsVersion: 1, sessionResume: true }, async run(input) {
    state.runs++; state.lastInput = input; input.checkpoint({ driver: 'fixture', id: 'fixed-worker-session' });
    if (state.consume) input.contextDelivered({ records: buildWorkerContext(input).messages.filter(card => !card.truncated).map(({ resource, id, version }) => ({ resource, id, version })) });
    if (state.consumeOriginOnly) input.contextDelivered({ records: buildWorkerContext(input).messages.filter(card => !card.truncated &&
      workerContextResources(input).some(ref => ref.resource === card.resource && ref.id === card.id && ref.value.triggerId === input.domainTicket.origin.triggerId)).map(({ resource, id, version }) => ({ resource, id, version })) });
    if (materials) {
      let call = 0;
      const read = ref => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id }, sessionId: 'fixed-worker-session', turnId: `turn-${state.runs}`, callId: `read-${++call}` });
      await read(input.agentTools.contextResources().find(ref => ref.resource === 'materials' && ref.value.kind === 'directory'));
      await read(input.agentTools.contextResources().find(ref => ref.resource === 'materials' && ref.value.kind === 'file'));
    }
    await state.onRun?.(input);
    if (state.pause) runtime.pause('Hold delivery before the first network attempt');
    return { version: 2, state: state.reportState, summary: state.summary ?? `Unverified model claim ${WORKER_INPUT_UNREAD_CODE} ${materialSecret}`, artifacts: [], attention: state.attention ?? null,
      ...(state.answer ? { answers: input.domainTicket.origin.triggerId } : {}) };
  } };
  const open = () => { runtime = createProjectAgent({ projectRoot: root, driver, feishuSDK: sdk, execution: { driver: 'fixture', enableAgentTools: true } }).init(); store = new Store(join(projectStateDirectory(root), 'state.sqlite')); };
  const previousSecret = process.env.HOST_FAILURE_TEST_SECRET; process.env.HOST_FAILURE_TEST_SECRET = 'fixture-secret';
  open();
  runtime.configure({ feishu: { appId: 'cli_fixture', appSecretEnv: 'HOST_FAILURE_TEST_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant', chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], ...(operator ? { operator: { openId: 'ou_alice' } } : {}) } });
  runtime.configureCoordinator({ policy: { mode: 'off', rules: [], sourceRows: [{ id: 'group', source: 'feishu', scope: { tenantKey: 'tenant', chatId: 'oc_group' }, actors: ['ou_alice'], bots: [], admission: {} }] } }, { expectedRevision: 0 });
  if (materials) runtime.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['notes.md'], views: ['current'], readers: [{ source: 'feishu', id: 'ou_alice' }], destinations: [{ source: 'feishu', id: 'oc_group' }] }], defaults: { sources: [{ id: 'project', view: { kind: 'current' } }] } }, { expectedRevision: 0 });
  t.after(async () => { store.close(); await runtime.stop(); runtime.close(); if (previousSecret === undefined) delete process.env.HOST_FAILURE_TEST_SECRET; else process.env.HOST_FAILURE_TEST_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  return { root, state, calls, get runtime() { return runtime; }, get store() { return store; },
    notices: () => runtime.notifications().filter(message => message.id.startsWith(prefix)),
    sentNotices: () => calls.filter(request => JSON.parse(request.data.content).text.startsWith(HOST_FAILURE_NOTICE_TEXT)),
    async start() { await runtime.prepareExecution(); runtime.receiveSourceEvent('feishu', rawMessage('om_root', '@_user_1 inspect the fictional project'));
      runtime.receiveSourceEvent('feishu', rawMessage('om_note', inputSecret, 'om_root')); return runtime.list()[0]; },
    async run() { const ticket = await this.start(); await runtime.runNext(); return ticket; },
    async flush() { store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run(); await runtime.flushNotifications(); },
    async reopen() { store.close(); await runtime.stop(); runtime.close(); open(); await runtime.prepareExecution(); },
  };
}

test('host unread rejection retains blocked Input and sends one fixed original-group notice', async t => {
  const f = fixture(t), ticket = await f.start();
  f.runtime.receiveSourceEvent('feishu', rawMessage('om_note', inputSecret, 'om_root'));
  await f.runtime.runNext(); await f.flush();
  assert.equal(f.runtime.getDomainTicket(ticket.id).assignments.at(-1).report.state, 'blocked', 'the fixture must reach the real host unread guard');
  assert.equal(f.notices().length, 1, 'the host-confirmed unread fault must have its own durable notice');
  const notice = f.notices()[0], domain = f.runtime.getDomainTicket(ticket.id), details = f.runtime.getDetailed(ticket.id);
  assert.equal(notice.kind, 'notice'); assert.equal(notice.status, 'sent'); assert.equal(f.sentNotices().length, 1);
  assert.equal(f.sentNotices()[0].path.message_id, 'om_root'); assert.equal(f.sentNotices()[0].data.reply_in_thread, true);
  assert.equal(domain.assignments.at(-1).report.state, 'blocked'); assert.equal(domain.ended, undefined); assert.equal(domain.attention, undefined);
  assert.ok(domain.inputs.filter(input => input.kind === 'trigger').every(input => !input.readAt)); assert.ok(domain.undelivered.length >= 1);
  assert.equal(details.failure.code, WORKER_INPUT_UNREAD_CODE); assert.equal(details.failure.origin, 'host-context-unread'); assert.equal(details.failure.requiresInspection, true);
  assert.doesNotMatch(notice.text, new RegExp(`${inputSecret}|${materialSecret}|exceeded|budget|ready`));
  assert.ok(f.store.getMeta(`host-context-failure:${details.failure.runId}`)); assert.ok(f.store.getMeta(`host-failure-notice:${notice.id}`));
  assert.equal(f.runtime.coordinationStatus().events.find(event => event.references?.runId === details.failure.runId)?.requiresCoordination, false);
  await f.flush(); assert.equal(f.notices().length, 1); assert.equal(f.sentNotices().length, 1); assert.equal(f.state.runs, 1);
});

for (const reportState of ['blocked', 'failed', 'waiting', 'progress', 'ready']) test(`ordinary ${reportState} and model-named host code do not authorize the new notice`, async t => {
  const f = fixture(t, { consume: true, reportState }), ticket = await f.run();
  assert.equal(f.notices().length, 0); assert.equal(f.sentNotices().length, 0);
  assert.notEqual(f.runtime.getDetailed(ticket.id).failure?.origin, 'host-context-unread');
});

test('a consumed real question keeps its existing attention route and is not duplicated by a host notice', async t => {
  const f = fixture(t, { consume: true, reportState: 'waiting' }); f.state.attention = { question: 'Which of the two authorized formats should I use?' }; f.state.summary = f.state.attention.question;
  const ticket = await f.run(); await f.flush();
  assert.equal(f.runtime.getDomainTicket(ticket.id).attention.question, f.state.attention.question); assert.equal(f.notices().length, 0);
  assert.equal(f.calls.filter(call => JSON.parse(call.data.content).text === f.state.attention.question).length, 1);
});

test('a consumed Worker answer retains its original reply path without a second result or host notice', async t => {
  const f = fixture(t, { consume: true }); f.state.answer = true; f.state.summary = 'Verified answer to the original request';
  const ticket = await f.run(); await f.flush();
  assert.equal(f.runtime.get(ticket.id).status, 'completed'); assert.equal(f.notices().length, 0);
  assert.equal(f.calls.filter(call => JSON.parse(call.data.content).text === f.state.summary).length, 1);
});

test('an unread Worker answer is replaced by the fixed host fault rather than disclosing its rejected conclusion', async t => {
  const f = fixture(t); f.state.answer = true; f.state.consumeOriginOnly = true; await f.run(); await f.flush();
  assert.equal(f.notices().length, 1); assert.equal(f.sentNotices().length, 1); assert.equal(f.calls.some(call => call.data.content.includes(materialSecret)), false);
});

test('fixed host fact survives material freshness changes without disclosing the material body', async t => {
  const f = fixture(t, { materials: true, pause: true }), ticket = await f.run();
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].status, 'pending'); assert.equal(f.sentNotices().length, 0);
  assert.ok(f.runtime.getDetailed(ticket.id).materialObservations.length);
  writeFileSync(join(f.root, 'notes.md'), 'new material after rejected ready');
  f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'sent'); assert.equal(f.sentNotices().length, 1);
  assert.doesNotMatch(f.notices()[0].text, new RegExp(materialSecret));
  assert.equal(f.runtime.notifications().filter(message => message.id.startsWith('material-notice:')).length, 0);
});

test('revoked material grants do not suppress a fixed host fact while its original mandate and route remain valid', async t => {
  const f = fixture(t, { materials: true, pause: true }); await f.run(); assert.equal(f.notices().length, 1);
  f.runtime.configureMaterials({ entries: [] }, { expectedRevision: 1 }); f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'sent'); assert.equal(f.sentNotices().length, 1); assert.doesNotMatch(f.notices()[0].text, new RegExp(materialSecret));
  assert.equal(f.runtime.notifications().filter(message => message.id.startsWith('material-notice:')).length, 0);
});

test('revoked original source policy prevents a queued host notice from being sent', async t => {
  const f = fixture(t, { pause: true }); await f.run(); assert.equal(f.notices().length, 1);
  f.runtime.configureCoordinator({ policy: { mode: 'off', rules: [], sourceRows: [{ id: 'group', source: 'feishu', scope: { tenantKey: 'tenant', chatId: 'oc_group' }, actors: [], bots: [], admission: {} }] } }, { expectedRevision: 1 });
  f.runtime.resume(); await f.flush(); assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.sentNotices().length, 0);
});

test('a supplement from another source cannot move or broadcast the original failure route', async t => {
  const f = fixture(t), ticket = await f.start(), domain = f.runtime.getDomainTicket(ticket.id);
  // This fixture starts after authorized attachment; it tests output routing, not
  // whether a second source can authorize a cross-source attachment by itself.
  const trigger = { ...f.store.triggers.get(domain.origin.triggerId), id: 'local:private-supplement', source: 'local',
    actor: { source: 'local', id: 'operator' }, text: inputSecret, threads: [{ source: 'local', id: 'private' }], channel: { source: 'local', thread: 'private', address: {} } };
  f.store.triggers.save(trigger);
  domain.inputs.push({ id: 'private-supplement-input', kind: 'trigger', triggerId: trigger.id, at: trigger.at });
  domain.undelivered.push('private-supplement-input'); domain.channels.push(trigger.channel); f.store.tickets.save(domain);
  await f.runtime.runNext();
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].channel.source, 'feishu'); assert.equal(f.notices()[0].channel.address.chatId, 'oc_group');
  assert.equal(f.sentNotices().length, 1); assert.equal(f.sentNotices()[0].path.message_id, 'om_root'); assert.doesNotMatch(f.notices()[0].text, new RegExp(inputSecret));
});

test('restart and repeated enqueue preserve the original proof, receipt and one delivery', async t => {
  const f = fixture(t, { pause: true }); await f.run(); const original = f.notices()[0]; assert.ok(original);
  const proof = f.store.getMeta(`host-failure-notice:${original.id}`), fault = f.store.getMeta(`host-context-failure:${proof.runId}`);
  await f.reopen(); assert.deepEqual(f.store.getMeta(`host-failure-notice:${original.id}`), proof); assert.deepEqual(f.store.getMeta(`host-context-failure:${proof.runId}`), fault);
  const { status, ...message } = original; new Outbox(f.store, new Effects(f.store)).send({ ...message, text: 'replacement must not overwrite the first receipt' });
  f.runtime.resume(); await f.flush(); await f.flush();
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].text, original.text); assert.equal(f.notices()[0].status, 'sent'); assert.equal(f.sentNotices().length, 1); assert.equal(f.state.runs, 1);
});

for (const field of ['text', 'channel', 'proof']) test(`tampered ${field} cannot exempt material or recursively create a fallback notice`, async t => {
  const f = fixture(t, { materials: true, pause: true }); await f.run(); const notice = f.notices()[0]; assert.ok(notice);
  if (field === 'proof') { const proof = f.store.getMeta(`host-failure-notice:${notice.id}`); proof.route.appId = 'cli_other'; f.store.setMeta(`host-failure-notice:${notice.id}`, proof); }
  else { const { status, ...message } = notice; if (field === 'text') message.text = materialSecret; else message.channel.address.chatId = 'oc_other';
    f.store.db.prepare('UPDATE receipts SET data=? WHERE id=?').run(JSON.stringify(message), notice.id); }
  f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.sentNotices().length, 0); assert.equal(f.calls.some(call => call.data.content.includes(materialSecret)), false);
  assert.equal(f.runtime.notifications().filter(message => message.id.startsWith('material-notice:')).length, 0);
});

test('human stop before the first send drops the notice without rerouting or changing the stopped domain', async t => {
  const f = fixture(t, { pause: true }), ticket = await f.run(); assert.equal(f.notices().length, 1);
  f.runtime.cancel(ticket.id); f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.sentNotices().length, 0); assert.equal(f.runtime.getDomainTicket(ticket.id).ended.by, 'human');
  assert.equal(f.runtime.notifications().filter(message => message.id.startsWith('material-notice:')).length, 0);
});

test('authorization is checked again after remote lookup and before the Feishu write', async t => {
  const f = fixture(t, { pause: true }), ticket = await f.run(); assert.ok(f.calls.length, 'the root acknowledgment must already have been delivered');
  f.state.onGet = async () => { f.state.onGet = null; f.runtime.cancel(ticket.id); };
  f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.sentNotices().length, 0);
  assert.equal(f.store.getMeta(`host-failure-notice-attempt:${f.notices()[0].id}`), undefined);
});

test('remote acceptance during a stop race remains a real delivered fact', async t => {
  const f = fixture(t, { pause: true }), ticket = await f.run();
  f.state.onWrite = async request => { if (JSON.parse(request.data.content).text.startsWith(HOST_FAILURE_NOTICE_TEXT)) f.runtime.cancel(ticket.id); };
  f.runtime.resume(); await f.flush();
  const notice = f.notices()[0]; assert.equal(notice.status, 'sent'); assert.ok(notice.delivery?.id); assert.equal(f.sentNotices().length, 1);
  assert.notEqual(notice.terminal?.status, 'unknown');
  assert.equal(f.runtime.getDomainTicket(ticket.id).ended.by, 'human'); await f.flush(); assert.equal(f.sentNotices().length, 1);
});

for (const patch of [{ appId: 'cli_other' }, { tenantKey: 'tenant-other' }, { botOpenId: 'ou_other_bot' }, { chats: [{ chatId: 'oc_other', type: 'group', mode: 'mentions' }] }]) test(`original route identity change ${Object.keys(patch)[0]} cannot take over a queued notice`, async t => {
  const f = fixture(t, { pause: true }); await f.run(); assert.equal(f.notices().length, 1);
  await f.runtime.stop(); f.runtime.configure({ feishu: patch }); await f.runtime.prepareExecution(); f.runtime.resume(); await f.flush();
  assert.equal(f.notices()[0].status, 'dropped'); assert.equal(f.sentNotices().length, 0);
});

test('explicit recovery supersedes a definitely unsent old fault without deleting history or replaying the model', async t => {
  const f = fixture(t, { pause: true }), ticket = await f.run(), first = f.notices()[0]; assert.ok(first);
  const failure = f.runtime.getDetailed(ticket.id).failure;
  f.runtime.retry(ticket.id); f.state.consume = true; f.state.pause = false; f.runtime.resume(); await f.runtime.runNext(); await f.flush();
  assert.equal(f.runtime.get(ticket.id).status, 'completed'); assert.equal(f.notices()[0].id, first.id); assert.equal(f.notices()[0].status, 'dropped');
  assert.equal(f.sentNotices().length, 0); assert.ok(f.store.getMeta(`host-context-failure:${failure.runId}`)); assert.equal(f.state.runs, 2);
});

test('lost send response retains the original uncertain receipt when a later recovery supersedes the fault', async t => {
  const f = fixture(t); f.state.acceptedThenLost = true; const ticket = await f.run(); assert.equal(f.notices().length, 1);
  const first = f.notices()[0]; assert.equal(first.status, 'pending'); assert.equal(f.sentNotices().length, 1);
  f.runtime.retry(ticket.id); f.state.consume = true; await f.runtime.runNext(); await f.flush();
  assert.equal(f.runtime.get(ticket.id).status, 'completed');
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].id, first.id); assert.notEqual(f.notices()[0].status, 'dropped', 'pending after an attempted send does not mean the remote message was withdrawn');
  assert.equal(f.calls.filter(call => JSON.parse(call.data.content).text === `Unverified model claim ${WORKER_INPUT_UNREAD_CODE} ${materialSecret}`).length, 1, 'an uncertain superseded notice must not indefinitely block the new authorized result');
  assert.equal(f.runtime.notifications().filter(message => message.id.startsWith('material-notice:')).length, 0);
});

test('receipt insert failure rolls back the fault proof and final blocked report together', async t => {
  const f = fixture(t), ticket = await f.start();
  f.store.db.exec("CREATE TRIGGER reject_host_notice BEFORE INSERT ON receipts WHEN NEW.id LIKE 'host-failure-notice-%' BEGIN SELECT RAISE(ABORT, 'synthetic host notice rollback'); END");
  await assert.rejects(f.runtime.runNext(), /synthetic host notice rollback/);
  assert.equal(f.notices().length, 0); assert.equal(f.store.listMeta('host-context-failure:').length, 0); assert.equal(f.store.listMeta('host-failure-notice:').length, 0);
  const domain = f.runtime.getDomainTicket(ticket.id), report = domain.assignments.at(-1).report;
  // The existing outer persistence-failure handler records its own failure only
  // after the rejected result transaction rolls back; it must stay intact.
  assert.equal(report.state, 'failed'); assert.match(report.summary, /Result persistence failed:.*synthetic host notice rollback/);
  assert.equal(domain.ended, undefined); assert.ok(domain.inputs.filter(input => input.kind === 'trigger').every(input => !input.readAt));
  assert.equal(f.sentNotices().length, 0);
  f.store.db.exec('DROP TRIGGER reject_host_notice');
});

test('old blocked reports with no host proof are not backfilled on restart', async t => {
  const f = fixture(t, { consume: true, reportState: 'blocked' }), ticket = await f.run();
  await f.reopen(); await f.flush();
  assert.equal(f.notices().length, 0); assert.equal(f.sentNotices().length, 0); assert.equal(f.state.runs, 1);
  assert.equal(f.runtime.getDomainTicket(ticket.id).assignments.at(-1).report.state, 'blocked');
});

async function seedDirectRequest(f, { operatorNotifications = true } = {}) {
  await f.runtime.prepareExecution();
  const raw = rawMessage('om_dm_root', 'Investigate the original private request'); raw.message.chat_id = 'oc_dm'; raw.message.chat_type = 'p2p'; raw.message.mentions = [];
  f.runtime.receiveSourceEvent('feishu', raw);
  const event = f.runtime.coordinationStatus().events.find(item => item.source?.messageId === 'om_dm_root'); assert.ok(event?.references?.triggerId);
  const ticket = f.runtime.submit({ text: raw.message.content, operatorNotifications });
  const domain = f.runtime.getDomainTicket(ticket.id);
  // Equivalent to the committed coordinator request link; the actual original
  // event and source trigger above still come through Feishu normalization.
  f.store.setMeta(`assessment-origin:${domain.origin.triggerId}`, { eventId: event.id });
  f.store.setMeta(`coordination:event:${event.id}`, { ...event, status: 'completed', completedAt: new Date().toISOString(), receipts: [{ kind: 'request', result: { triggerId: domain.origin.triggerId } }] });
  f.runtime.reply(ticket.id, inputSecret);
  return { ticket, domain, event };
}

test('a coordinator-wrapped DM request returns its host fault to the actual original message once', async t => {
  const f = fixture(t, { operator: true }), { ticket, domain, event } = await seedDirectRequest(f);
  await f.runtime.runNext(); await f.flush();
  assert.equal(f.notices().length, 1); const notice = f.notices()[0], proof = f.store.getMeta(`host-failure-notice:${notice.id}`);
  assert.equal(notice.status, 'sent'); assert.equal(f.sentNotices().length, 1); assert.equal(f.sentNotices()[0].path.message_id, 'om_dm_root'); assert.equal(f.sentNotices()[0].data.reply_in_thread, false);
  assert.equal(proof.requestTriggerId, domain.origin.triggerId); assert.equal(proof.originTriggerId, event.references.triggerId); assert.notEqual(proof.originTriggerId, proof.requestTriggerId);
  assert.equal(f.runtime.coordinationStatus().events.find(item => item.ticketId === ticket.id && item.kind === 'report').requiresCoordination, false);
});

test('a disabled notification preference on a wrapped DM request does not fall back to the current operator', async t => {
  const f = fixture(t, { operator: true }), { ticket } = await seedDirectRequest(f, { operatorNotifications: false });
  await f.runtime.runNext(); await f.flush();
  assert.equal(f.runtime.getDetailed(ticket.id).failure.code, WORKER_INPUT_UNREAD_CODE); assert.equal(f.notices().length, 0); assert.equal(f.sentNotices().length, 0);
  assert.equal(f.runtime.coordinationStatus().events.find(item => item.ticketId === ticket.id && item.kind === 'report').requiresCoordination, false);
});

for (const operatorNotifications of [true, false]) test(`a pure local task with operatorNotifications=${operatorNotifications} never invents a Feishu origin or a model-notification turn`, async t => {
  const f = fixture(t, { operator: true }); await f.runtime.prepareExecution();
  const ticket = f.runtime.submit({ text: 'Local-only request', operatorNotifications }); f.runtime.reply(ticket.id, inputSecret);
  await f.runtime.runNext(); await f.flush();
  assert.equal(f.runtime.getDetailed(ticket.id).failure.code, WORKER_INPUT_UNREAD_CODE); assert.equal(f.sentNotices().length, 0); assert.equal(f.calls.length, 0);
  assert.ok(f.notices().every(notice => notice.channel.source === 'local'));
  assert.equal(f.runtime.coordinationStatus().events.find(item => item.ticketId === ticket.id && item.kind === 'report').requiresCoordination, false);
});

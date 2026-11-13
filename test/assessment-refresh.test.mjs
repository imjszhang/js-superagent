import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { assessmentStatus } from '../src/runtime/assessment-status.mjs';
import { AssessmentContextChanged, recordContextRefresh, refreshState, resetRefreshCycle } from '../src/runtime/assessment-refresh.mjs';
import { runBoundedAssessment } from '../src/context-requests.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'assessment-refresh-'))), attempts = [], sent = [];
  writeFileSync(join(root, 'notes.md'), 'Fictional orchard notes');
  let change = () => {}; const network = { hold: false };
  const api = { list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async input => ({ code: 0, data: { items: [{ message_id: input.path.message_id, chat_id: 'oc_group' }] } }),
    reply: async input => { if (network.hold) throw new Error('fixture response unavailable'); sent.push(input); return { code: 0, data: { message_id: `om_sent_${sent.length}` } }; } };
  const sdk = { Client: class { constructor() { this.im = { message: api }; } },
    EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  const options = { projectRoot: root, feishuSDK: sdk,
    driver: { capabilities: { agentTools: true, boundedMaterialReadsVersion: 1, sessionResume: true },
      async run() { return { version: 2, state: 'waiting', summary: 'Waiting within the approved scope', artifacts: [], attention: null }; } },
    assessor: { async assess(input) {
      attempts.push(input); input.checkpoint({ driver: 'fixture-assessor', id: `attempt-${attempts.length}` });
      await change(input, attempts.length);
      return { kind: 'accept', title: 'Inspect current orchard notes', scope: 'Read authorized notes only', reason: 'Explicit request', rules: [] };
    } } };
  let runtime = createProjectAgent(options).init();
  process.env.REFRESH_FEISHU_SECRET = 'fixture-secret';
  runtime.configure({ feishu: { appId: 'cli_fixture', appSecretEnv: 'REFRESH_FEISHU_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }] } });
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' }, policy: { mode: 'off', rules: [], sourceRows: [
    { id: 'group', source: 'feishu', scope: { tenantKey: 'tenant', chatId: 'oc_group' }, actors: ['ou_reader'], bots: [], admission: {} },
  ] } }, { expectedRevision: 0 });
  runtime.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['notes.md'], views: ['current'],
    readers: [{ source: 'local', id: 'operator' }, { source: 'feishu', id: 'ou_reader' }],
    destinations: [{ source: 'local', id: 'operator' }, { source: 'feishu', id: 'oc_group' }] }],
    defaults: { sources: [{ id: 'project', view: { kind: 'current' } }] } }, { expectedRevision: 0 });
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { await runtime.stop(); runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const receive = (id = 'om_request', rootId) => runtime.receiveSourceEvent('feishu', {
    sender: { sender_id: { open_id: 'ou_reader' }, sender_type: 'user', tenant_key: 'tenant' },
    message: { message_id: id, ...(rootId ? { root_id: rootId } : {}), chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: String(Date.now()),
      content: JSON.stringify({ text: '@_user_1 inspect current project notes' }), mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1' }] },
  });
  const tick = async () => { t.mock.timers.tick(1100); return runtime.runNext(); };
  return { get runtime() { return runtime; }, store, attempts, sent, network, receive, tick, setChange: fn => { change = fn; },
    async reopen() { await runtime.stop(); runtime.close(); runtime = createProjectAgent(options).init(); await runtime.prepareExecution(); } };
}

test('a concurrent material projection change refreshes the same evaluation with a fresh session', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Earlier independent investigation', operatorNotifications: false });
  await f.runtime.runNext();
  f.setChange((_input, attempt) => {
    if (attempt !== 1) return;
    const meta = f.store.getMeta(`ticket:${other.id}`); meta.runId = 'a-new-independent-run'; f.store.setMeta(`ticket:${other.id}`, meta);
  });
  f.receive(); await f.tick();
  const triggerId = 'feishu:tenant:om_request';
  assert.equal(assessmentStatus(f.store, triggerId).status, 'evaluating');
  assert.equal(f.runtime.notifications().filter(row => row.id.startsWith('assessment-result:')).length, 0);
  await f.tick();
  assert.equal(f.attempts.length, 2);
  assert.equal(f.attempts[0].candidate.evalId, f.attempts[1].candidate.evalId);
  assert.notEqual(f.attempts[0].runId, f.attempts[1].runId);
  assert.equal(f.attempts[1].session, undefined);
  assert.ok(f.attempts[1].timeoutMs < f.attempts[0].timeoutMs);
  assert.equal(assessmentStatus(f.store, triggerId).status, 'accepted');
  assert.equal(f.runtime.list().length, 2);
});

test('continuously changing context has a durable two-refresh budget and one terminal original-group receipt', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Independent investigation', operatorNotifications: false }); await f.runtime.runNext();
  f.setChange((_input, attempt) => { const meta = f.store.getMeta(`ticket:${other.id}`); meta.runId = `independent-run-${attempt}`; f.store.setMeta(`ticket:${other.id}`, meta); });
  f.receive();
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(f.attempts.length, 3);
  const status = assessmentStatus(f.store, 'feishu:tenant:om_request');
  assert.equal(status.status, 'failed'); assert.equal(status.code, 'assessment_context_stale_exhausted'); assert.equal(status.retryable, true);
  assert.equal(f.runtime.list().length, 1);
  const notices = f.runtime.notifications().filter(row => row.id.startsWith('assessment-result:'));
  assert.equal(notices.length, 1); assert.equal(notices[0].channel.address.messageId, 'om_request');
  assert.match(notices[0].text, /上下文/);
  await f.runtime.flushNotifications();
  assert.equal(f.sent.filter(row => JSON.parse(row.data.content).text === notices[0].text).length, 1);
});

test('restart preserves refresh allowance; a duplicate or pending reevaluation cannot reset it', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Other investigation', operatorNotifications: false }); await f.runtime.runNext();
  f.setChange((_input, attempt) => { const meta = f.store.getMeta(`ticket:${other.id}`); meta.runId = `changed-${attempt}`; f.store.setMeta(`ticket:${other.id}`, meta); });
  f.receive(); await f.tick();
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 1);
  f.receive(); f.runtime.reevaluate('feishu:tenant:om_request');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 1);
  await f.reopen();
  for (let i = 0; i < 4; i++) await f.tick();
  assert.equal(f.attempts.length, 3);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').code, 'assessment_context_stale_exhausted');
  f.setChange(() => {});
  assert.equal(f.runtime.reevaluate('feishu:tenant:om_request'), true);
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
  await f.tick(); assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
  assert.equal(f.runtime.reevaluate('feishu:tenant:om_request'), false);
});

test('untrusted stale wording is never automatic refresh authorization', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.setChange(() => { throw new Error('Coordination context or policy changed; reassessment required'); });
  f.receive(); for (let i = 0; i < 4; i++) await f.tick();
  assert.equal(f.attempts.length, 1);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').failureKind, 'internal');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
});

test('material authorization revision changes fail closed instead of refreshing', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  // Emulate another writer changing the revision between a read and its commit.
  f.setChange(() => { const settings = f.store.getMeta('materials:settings'); settings.revision++; settings.entries[0].readers = []; f.store.setMeta('materials:settings', settings); });
  f.receive(); for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.attempts.length, 1); assert.equal(f.runtime.list().length, 0);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').failureKind, 'authority');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
});

test('closed assessment callbacks cannot write to a later refreshed attempt', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.setChange((_input, attempt) => { if (attempt === 1) throw new AssessmentContextChanged('read-set-version'); });
  f.receive(); await f.tick(); await f.tick();
  assert.equal(f.attempts.length, 2);
  assert.throws(() => f.attempts[0].checkpoint({ driver: 'fixture-assessor', id: 'late-old-session' }));
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
});

test('a read-set change during bounded lookup propagates to host; arbitrary lookup failures stay semantic unavailable', async () => {
  const candidate = { thread: { key: 'local:thread' }, triggers: [{ id: 'original', threads: [{ source: 'local', id: 'thread' }] }], tickets: [] };
  const input = { candidate, call: async () => ({ kind: 'read', resource: 'triggers', recordId: 'original', offset: 0 }) };
  const changed = new AssessmentContextChanged('record-version');
  await assert.rejects(runBoundedAssessment({ ...input, readContextRecord() { throw changed; } }), error => error === changed);
  const denied = Object.assign(new Error('Denied'), { code: 'MATERIAL_ACCESS_DENIED' });
  await assert.rejects(runBoundedAssessment({ ...input, readContextRecord() { throw denied; } }), error => error === denied);
  const result = await runBoundedAssessment({ ...input, readContextRecord() { throw new Error('Context record changed'); } });
  assert.equal(result.kind, 'unavailable');
});

test('refresh accounting is atomic, idempotent and follows original inputs through batches', t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-budget-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const record = (ids, runId) => recordContextRefresh(store, ids, { runId, evalId: `eval-${runId}`, reason: 'read-set-version', at: '2026-11-13T10:00:00Z' });
  assert.throws(() => store.atomic(() => { record(['a', 'b'], 'rolled-back'); throw new Error('rollback'); }));
  assert.equal(refreshState(store, 'a').refreshesUsed, 0);
  record(['a', 'b'], 'first'); record(['a', 'b'], 'first');
  assert.equal(refreshState(store, 'a').refreshesUsed, 1);
  record(['a'], 'second');
  assert.deepEqual(record(['a', 'b'], 'third').exhausted, ['a']);
  assert.equal(refreshState(store, 'b').refreshesUsed, 1);
  record(['b'], 'fourth'); assert.equal(refreshState(store, 'b').refreshesUsed, 2);
  resetRefreshCycle(store, 'a'); assert.equal(refreshState(store, 'b').refreshesUsed, 2);
});

test('one exhausted batch input is settled alone while its sibling is reassessed without a failure receipt', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.receive('om_first'); f.receive('om_second', 'om_first');
  for (const runId of ['prior-1', 'prior-2']) recordContextRefresh(f.store, ['feishu:tenant:om_first'], { runId, evalId: 'prior', reason: 'read-set-version', at: new Date().toISOString() });
  f.setChange((_input, attempt) => { if (attempt === 1) throw new AssessmentContextChanged('read-set-version'); });
  await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_first').status, 'failed');
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_second').status, 'evaluating');
  const notices = f.runtime.notifications().filter(row => row.id.startsWith('assessment-result:'));
  assert.equal(notices.length, 1); assert.equal(notices[0].channel.address.messageId, 'om_first');
  await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_second').status, 'accepted');
  assert.equal(f.runtime.list().length, 1);
  assert.deepEqual(f.attempts[1].candidate.triggers.map(row => row.id), ['feishu:tenant:om_second']);
});

test('a queued exhausted receipt cannot be sent after original author authority is revoked', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); f.network.hold = true;
  f.setChange(() => { throw new AssessmentContextChanged('read-set-version'); });
  f.receive(); for (let i = 0; i < 3; i++) await f.tick();
  const notice = f.runtime.notifications().find(row => row.id.startsWith('assessment-result:'));
  assert.ok(notice); assert.equal(notice.status, 'pending');
  f.runtime.configureCoordinator({ policy: { mode: 'off', rules: [], sourceRows: [] } }, { expectedRevision: 1 });
  f.network.hold = false; f.store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run();
  await f.runtime.flushNotifications();
  assert.equal(f.runtime.notifications().find(row => row.id === notice.id).status, 'dropped');
  assert.equal(f.sent.length, 0);
});

test('pause and resume preserve pending assessment without consuming refresh allowance', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.setChange((_input, attempt) => { if (attempt === 1) { f.runtime.pause(); throw new AssessmentContextChanged('read-set-version'); } });
  f.receive(); await f.tick(); await f.tick();
  assert.equal(f.attempts.length, 1); assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
  f.runtime.resume(); await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
});

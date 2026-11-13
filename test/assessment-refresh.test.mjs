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
import { executeDshTurn } from '../src/drivers/dsh.mjs';

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
  const receive = (id = 'om_request', rootId, mention = true) => runtime.receiveSourceEvent('feishu', {
    sender: { sender_id: { open_id: 'ou_reader' }, sender_type: 'user', tenant_key: 'tenant' },
    message: { message_id: id, ...(rootId ? { root_id: rootId } : {}), chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: String(Date.now()),
      content: JSON.stringify({ text: mention ? '@_user_1 inspect current project notes' : 'Only read the authorized notes' }), mentions: mention ? [{ id: { open_id: 'ou_bot' }, key: '@_user_1' }] : [] },
  });
  const tick = async () => { t.mock.timers.tick(1100); return runtime.runNext(); };
  return { root, get runtime() { return runtime; }, store, attempts, sent, network, receive, tick, setChange: fn => { change = fn; },
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

for (const handling of ['copied', 'swallowed']) test(`host callback stale evidence survives a ${handling} adapter error`, async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Independent material work', operatorNotifications: false }); await f.runtime.runNext();
  f.setChange((input, attempt) => {
    if (attempt !== 1) return;
    const original = f.store.getMeta(`ticket:${other.id}`);
    f.store.setMeta(`ticket:${other.id}`, { ...original, runId: 'changed-during-native-checkpoint' });
    let caught;
    try { input.checkpoint({ driver: 'fixture-assessor', id: 'invalidated-checkpoint' }); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof AssessmentContextChanged);
    // The projection can return to its old value. A rejected attempt still
    // cannot submit its old result just because the final comparison matches.
    f.store.setMeta(`ticket:${other.id}`, original);
    if (handling === 'copied') throw new Error(caught.message);
  });
  f.receive(); await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'evaluating');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 1);
  assert.equal(f.runtime.list().length, 1);
  await f.tick();
  assert.equal(f.attempts.length, 2);
  assert.equal(f.attempts[0].candidate.evalId, f.attempts[1].candidate.evalId);
  assert.notEqual(f.attempts[0].runId, f.attempts[1].runId);
  assert.equal(f.attempts[1].session, undefined);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
  assert.equal(f.runtime.list().length, 2);
});

test('actual DSH checkpoint redaction cannot erase the host refresh proof', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Other material work', operatorNotifications: false }); await f.runtime.runNext();
  const executable = join(f.root, 'checkpoint-sdk.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import{createInterface}from'node:readline';
if(process.argv.includes('--version')){console.log('0.2.2-alpha.2');process.exit(0);}
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line),answer=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
 if(r.method==='initialize')answer({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});
 else if(r.method==='session/working-directory/get')answer({cwd:process.cwd()});
 else if(r.method==='shutdown'){answer({});process.exit(0);}
 else throw Error('No model prompt may follow a rejected host checkpoint');
}`, { mode: 0o700 });
  const key = 'CALLBACK_DSH_TEST_KEY', previous = process.env[key]; process.env[key] = 'fixture-only-secret';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const pids = [];
  f.setChange(async (input, attempt) => {
    if (attempt !== 1) return;
    await assert.rejects(executeDshTurn({ executable, model: 'fixture', permission: 'read-only', killGraceMs: 30, timeoutMs: 5000,
      backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://example.invalid', apiKeyEnv: key } }, {
      projectRoot: f.root, role: 'coordinator', runId: input.runId, prompt: 'Read-only classifier', signal: input.signal,
      registerProcess(pid) { pids.push(pid); input.registerProcess(pid); },
      checkpoint(session) {
        const original = f.store.getMeta(`ticket:${other.id}`);
        f.store.setMeta(`ticket:${other.id}`, { ...original, runId: 'changed-before-sdk-checkpoint' });
        try { input.checkpoint(session); } finally { f.store.setMeta(`ticket:${other.id}`, original); }
      },
    }), error => {
      // Exercise the real driver catch/redactor, not an imitation in the test.
      assert.equal(error instanceof AssessmentContextChanged, false);
      assert.equal(error.code, undefined);
      assert.match(error.message, /Coordination context/);
      throw error;
    });
  });
  f.receive(); await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'evaluating');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 1);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  await f.tick();
  assert.equal(f.attempts.length, 2);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
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

for (const forgedCode of [false, true]) test(`untrusted stale ${forgedCode ? 'code' : 'wording'} is never automatic refresh authorization`, async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.setChange(() => { throw Object.assign(new Error('Coordination context or policy changed; reassessment required'),
    forgedCode ? { code: 'assessment_context_changed', reason: 'material-session' } : {}); });
  f.receive(); for (let i = 0; i < 4; i++) await f.tick();
  assert.equal(f.attempts.length, 1);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').failureKind, 'internal');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
});

function rejectStaleCheckpoint(f, other, input) {
  const original = f.store.getMeta(`ticket:${other.id}`);
  f.store.setMeta(`ticket:${other.id}`, { ...original, runId: 'temporary-invalidated-material-run' });
  try { assert.throws(() => input.checkpoint({ driver: 'fixture-assessor', id: 'rejected-session' }), AssessmentContextChanged); }
  finally { f.store.setMeta(`ticket:${other.id}`, original); }
}

test('a known input authority rejection wins over earlier stale proof after authority is restored', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Earlier material work', operatorNotifications: false }); await f.runtime.runNext();
  let rejectedInput;
  f.setChange((input, attempt) => {
    if (attempt === 2) {
      assert.throws(() => rejectedInput.checkpoint({ driver: 'fixture-assessor', id: 'late-old-session' }));
      return;
    }
    rejectedInput = input;
    rejectStaleCheckpoint(f, other, input);
    const original = f.store.triggers.get('feishu:tenant:om_supplement');
    f.store.triggers.save({ ...original, actor: { ...original.actor, id: 'ou_unlisted' } });
    try {
      assert.throws(() => input.checkpoint({ driver: 'fixture-assessor', id: 'revoked-session' }),
        error => error.code === 'assessment_authority' && error.triggerId === original.id);
    } finally { f.store.triggers.save(original); }
    // Both callbacks were swallowed and current authority is restored. The old
    // attempt must still fail only its rejected input, without a fresh budget.
  });
  f.receive(); f.receive('om_supplement', 'om_request', false); await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_supplement').failureKind, 'authority');
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'evaluating');
  for (const id of ['om_request', 'om_supplement']) assert.equal(refreshState(f.store, `feishu:tenant:${id}`).refreshesUsed, 0);
  assert.equal(f.runtime.list().length, 1);
  await f.tick();
  assert.deepEqual(f.attempts[1].candidate.triggers.map(row => row.id), ['feishu:tenant:om_request']);
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
  assert.equal(f.runtime.list().length, 2);
});

for (const resource of ['checkpoint', 'sources']) for (const failureFirst of [false, true]) {
  test(`ordinary ${resource} callback failure ${failureFirst ? 'before' : 'after'} stale cannot be erased or leak its text`, async t => {
    const f = fixture(t); await f.runtime.prepareExecution();
    const other = f.runtime.submit({ text: 'Earlier material work', operatorNotifications: false }); await f.runtime.runNext();
    const secret = 'fixture-sensitive-callback-detail';
    f.setChange(async input => {
      const fail = async () => {
        if (resource === 'checkpoint') {
          const session = { get driver() { throw new Error(secret); }, id: 'unusable' };
          assert.throws(() => input.checkpoint(session), error => error.message === secret);
        } else await assert.rejects(input.readContextRecord('sources', secret));
      };
      if (failureFirst) await fail();
      rejectStaleCheckpoint(f, other, input);
      if (!failureFirst) await fail();
    });
    f.receive(); await f.tick();
    const status = assessmentStatus(f.store, 'feishu:tenant:om_request');
    assert.equal(status.status, 'failed'); assert.equal(status.failureKind, 'internal');
    assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
    const record = f.store.getMeta(`assessment:${f.attempts[0].candidate.evalId}`);
    assert.match(JSON.stringify(record), /Assessment host callback failed/);
    assert.equal(JSON.stringify(record).includes(secret), false);
    assert.equal(f.runtime.list().length, 1);
  });
}

test('a copied stale callback error cannot refresh beyond the original evaluation deadline', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Earlier material work', operatorNotifications: false }); await f.runtime.runNext();
  let expired = false;
  f.setChange(input => {
    rejectStaleCheckpoint(f, other, input);
    const deadline = f.store.threads.get(input.candidate.thread.key).evaluating.deadline;
    t.mock.timers.tick(Date.parse(deadline) - Date.now() + 1);
    expired = deadline <= new Date().toISOString();
    throw new Error('Copied adapter exception');
  });
  f.receive(); await f.tick();
  assert.equal(expired, true);
  assert.equal(f.attempts.length, 1);
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
  assert.equal(f.runtime.list().length, 1);
});

test('a recorded owner refusal cannot be erased by restoring the owner after a stale checkpoint', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const other = f.runtime.submit({ text: 'Earlier material work', operatorNotifications: false }); await f.runtime.runNext();
  f.setChange(input => {
    rejectStaleCheckpoint(f, other, input);
    const owner = f.store.getMeta('coordinator:owner');
    f.store.setMeta('coordinator:owner', { ...owner, token: 'other-attempt-owner' });
    try { assert.throws(() => input.checkpoint({ driver: 'fixture-assessor', id: 'refused-owner' }), /Stale coordinator callback/); }
    finally { f.store.setMeta('coordinator:owner', owner); }
  });
  f.receive(); await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'failed');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
  assert.equal(f.runtime.list().length, 1);
});

test('an ordinary source lookup failure without stale proof preserves assessor handling', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.setChange(async input => { await assert.rejects(input.readContextRecord('sources', 'not-configured')); });
  f.receive(); await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
  assert.equal(refreshState(f.store, 'feishu:tenant:om_request').refreshesUsed, 0);
  assert.equal(f.runtime.list().length, 1);
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

for (const readerFailure of [false, true]) test(`an invalidated supplement cannot discard its valid primary request (${readerFailure ? 'read failure' : 'commit guard'})`, async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  f.receive('om_request'); f.receive('om_supplement', 'om_request', false);
  f.setChange((_input, attempt) => {
    if (attempt !== 1) return;
    const trigger = f.store.triggers.get('feishu:tenant:om_supplement');
    trigger.actor.id = 'ou_unlisted'; f.store.triggers.save(trigger);
    if (readerFailure) throw new AssessmentContextChanged('read-set-version');
  });
  await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_supplement').status, 'failed');
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'evaluating');
  await f.tick();
  assert.equal(assessmentStatus(f.store, 'feishu:tenant:om_request').status, 'accepted');
  assert.equal(f.runtime.list().length, 1);
  assert.deepEqual(f.attempts[1].candidate.triggers.map(row => row.id), ['feishu:tenant:om_request']);
});

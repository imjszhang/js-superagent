import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { assessmentStatus } from '../src/runtime/assessment-status.mjs';

const committed = 'FICTIONAL_ORCHARD_COMMITTED';
const current = 'FICTIONAL_ORCHARD_UNCOMMITTED';
const untracked = 'FICTIONAL_ORCHARD_UNTRACKED';
const reader = { source: 'feishu', id: 'ou_alice' };
const destination = { source: 'feishu', id: 'oc_orchard' };
const defaults = { sources: [{ id: 'project', view: { kind: 'current' } }] };
function fixture(t, { semantic = true, grant = 'destination', hasDefaults = true, failDelivery = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-admission-'))), sent = [], runs = [], assessments = [];
  writeFileSync(join(root, 'notes.md'), committed);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture');
  writeFileSync(join(root, 'notes.md'), current); writeFileSync(join(root, 'new.md'), untracked);
  const network = { fail: failDelivery };
  const api = { list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async request => ({ code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: 'oc_orchard' }] } }),
    reply: async request => { if (network.fail) throw new Error('fixture delivery pending'); sent.push(request); return { code: 0, data: { message_id: `om_result_${sent.length}` } }; } };
  const sdk = { Client: class { constructor() { this.im = { message: api }; } }, EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  const runtime = createProjectAgent({ projectRoot: root, workspace: { mode: 'worktree' }, feishuSDK: sdk, execution: { driver: 'fixture', enableAgentTools: true },
    driver: { capabilities: { agentTools: true, boundedMaterialReadsVersion: 1, sessionResume: true }, async run(input) {
      const observed = { cwdText: readFileSync(join(input.projectRoot, 'notes.md'), 'utf8') }; runs.push(observed);
      const sessionId = `material-worker-${input.runId}`; input.checkpoint({ driver: 'fixture', id: sessionId }); let n = 0;
      const refs = () => input.agentTools.contextResources().filter(ref => ref.resource === 'materials');
      const read = ref => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id }, callId: `read-${++n}`, sessionId, turnId: 'material-turn' });
      let summary = 'ordinary execution';
      if (refs().length) {
        await read(refs().find(ref => ref.value.kind === 'directory' && ref.value.path === '.'));
        observed.notes = JSON.parse((await read(refs().find(ref => ref.value.kind === 'file' && ref.value.path === 'notes.md'))).text).text;
        observed.newFile = JSON.parse((await read(refs().find(ref => ref.value.kind === 'file' && ref.value.path === 'new.md'))).text).text;
        summary = `${observed.notes}\n${observed.newFile}`;
      }
      return { version: 2, state: 'ready', summary, artifacts: [], attention: null, answers: input.domainTicket.origin.triggerId };
    } }, assessor: { async assess(input) {
      assessments.push(input.candidate);
      return { kind: 'accept', title: 'Inspect fictional orchard', scope: 'Read current orchard files and report', reason: 'Explicit group mention', rules: [] };
    } } }).init();
  const previousSecret = process.env.MATERIAL_ADMISSION_SECRET; process.env.MATERIAL_ADMISSION_SECRET = 'fictional-fixture-secret';
  runtime.configure({ feishu: { appId: 'cli_orchard', appSecretEnv: 'MATERIAL_ADMISSION_SECRET', botOpenId: 'ou_bot', tenantKey: 'fictional', chats: [{ chatId: 'oc_orchard', type: 'group', mode: 'mentions' }] } });
  const policy = actors => ({ mode: 'off', rules: [], sourceRows: [{ id: 'orchard', source: 'feishu', scope: { tenantKey: 'fictional', chatId: 'oc_orchard' }, actors, bots: [], admission: {} }] });
  runtime.configureCoordinator({ policy: policy(['ou_alice', 'ou_bob']), ...(semantic ? { assessor: { driver: 'fixture-assessor' } } : {}) }, { expectedRevision: 0 });
  const materials = mode => ({ entries: [{ id: 'project', project: 'self', include: ['.'], views: ['current'],
    readers: mode === 'reader' ? [{ source: 'feishu', id: 'ou_else' }] : [reader],
    destinations: mode === 'destination' ? [{ source: 'feishu', id: 'operator' }] : [destination] }], ...(hasDefaults ? { defaults } : {}) });
  runtime.configureMaterials(materials(grant), { expectedRevision: 0 });
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { store.close(); await runtime.stop(); runtime.close();
    if (previousSecret === undefined) delete process.env.MATERIAL_ADMISSION_SECRET; else process.env.MATERIAL_ADMISSION_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const mention = (id, actor = 'ou_alice', rootId) => runtime.receiveSourceEvent('feishu', {
    sender: { sender_id: { open_id: actor }, sender_type: 'user', tenant_key: 'fictional' },
    message: { message_id: id, chat_id: 'oc_orchard', chat_type: 'group', message_type: 'text', create_time: '1793491200000',
      content: JSON.stringify({ text: '@_user_1 investigate current orchard files' }), mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1', name: 'Orchard' }], ...(rootId ? { root_id: rootId } : {}) } });
  const flush = async () => { network.fail = false; store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run(); await runtime.flushNotifications(); };
  return { root, runtime, store, sent, runs, assessments, mention, materials, policy, flush };
}

function assertRefused(f, triggerId, code) {
  const status = assessmentStatus(f.store, triggerId);
  assert.equal(status.status, 'failed'); assert.equal(status.code, code); assert.equal(status.failureKind, 'authority'); assert.equal(status.retryable, false);
  assert.equal(f.runtime.list().length, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM domain_tickets').get().count, 0); assert.equal(f.runs.length, 0);
  assert.equal(new Effects(f.store).list().some(effect => !effect.cancelled && ['launch', 'assessment'].includes(effect.kind)), false);
  const replies = f.runtime.notifications(); assert.equal(replies.length, 1); assert.equal(replies[0].ticketId, undefined);
  assert.match(replies[0].text, /建单未完成.*请求已保留.*尚未开始执行/);
  assert.ok(!JSON.stringify(replies).includes(current)); assert.ok(!JSON.stringify(replies).includes(untracked));
  assert.ok(!JSON.stringify(f.sent).includes(current)); assert.ok(!JSON.stringify(f.sent).includes(untracked));
  assert.ok(!replies.some(reply => /已接单|已建立工单/.test(reply.text)));
  return replies[0];
}

for (const semantic of [true, false]) for (const grant of ['reader', 'destination']) test(`${semantic ? 'assessed' : 'direct'} group binding denies missing ${grant} without ticket, Worker or success receipt`, async t => {
  const f = fixture(t, { semantic, grant }); await f.runtime.prepareExecution();
  const received = f.mention('om_denied'); await f.runtime.runNext();
  const reply = assertRefused(f, received.triggerId, grant === 'reader' ? 'MATERIAL_ACCESS_DENIED' : 'MATERIAL_DESTINATION_DENIED');
  assert.equal(reply.status, 'sent'); assert.equal(f.sent[0].path.message_id, 'om_denied'); assert.equal(f.sent[0].data.reply_in_thread, true);
  assert.equal(f.mention('om_denied').status, 'duplicate');
  for (let i = 0; i < 3; i++) await f.runtime.runNext();
  assert.equal(f.assessments.length, semantic ? 1 : 0); assert.equal(f.sent.length, 1); assert.equal(f.runs.length, 0);
});

test('fixing grants and explicitly reevaluating the original group request reads dirty and untracked current files', async t => {
  const f = fixture(t); await f.runtime.prepareExecution(); const received = f.mention('om_recover'); await f.runtime.runNext();
  assertRefused(f, received.triggerId, 'MATERIAL_DESTINATION_DENIED');
  f.runtime.configureMaterials(f.materials('allowed'), { expectedRevision: 1 });
  writeFileSync(join(f.root, 'notes.md'), `${current}_AFTER_RECOVERY`);
  assert.equal(f.runtime.reevaluate(received.triggerId), true); await f.runtime.runNext(); await f.runtime.flushNotifications();
  const tickets = f.runtime.list(); assert.equal(tickets.length, 1); assert.equal(tickets[0].status, 'completed');
  assert.equal(f.runtime.getDomainTicket(tickets[0].id).origin.triggerId, received.triggerId);
  const detail = f.runtime.getDetailed(tickets[0].id); assert.equal(detail.materialBinding.revision, 2); assert.equal(detail.materialBinding.access, 'host-only');
  assert.equal(detail.materialBinding.sources[0].view.kind, 'current'); assert.equal(detail.materialObservations.length, 3);
  assert.deepEqual(f.runs, [{ cwdText: committed, notes: `${current}_AFTER_RECOVERY`, newFile: untracked }]);
  const result = f.sent.find(request => request.data.content.includes(`${current}_AFTER_RECOVERY`));
  assert.ok(result); assert.ok(result.data.content.includes(untracked)); assert.equal(result.path.message_id, 'om_recover');
  assert.equal(f.runtime.reevaluate(received.triggerId), false);
});

test('direct admission retains the original refusal and recovery still requires the existing semantic assessor', async t => {
  const f = fixture(t, { semantic: false }); await f.runtime.prepareExecution();
  const received = f.mention('om_direct_recovery'); assertRefused(f, received.triggerId, 'MATERIAL_DESTINATION_DENIED');
  f.runtime.configureMaterials(f.materials('allowed'), { expectedRevision: 1 });
  assert.equal(f.runtime.reevaluate(received.triggerId), true); await f.runtime.runNext();
  assert.equal(assessmentStatus(f.store, received.triggerId).code, 'assessment_configuration');
  assert.equal(f.runtime.list().length, 0); assert.equal(f.runs.length, 0);
  f.runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 1 });
  assert.equal(f.runtime.reevaluate(received.triggerId), true); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1);
  assert.equal(f.runtime.getDomainTicket(f.runtime.list()[0].id).origin.triggerId, received.triggerId);
  assert.equal(f.runtime.list()[0].status, 'completed');
});

test('an authorized group mention with no material defaults keeps ordinary execution', async t => {
  const f = fixture(t, { hasDefaults: false, grant: 'reader' }); await f.runtime.prepareExecution(); f.mention('om_ordinary'); await f.runtime.runNext();
  assert.equal(f.runtime.list().length, 1); assert.equal(f.runtime.getDetailed(f.runtime.list()[0].id).materialBinding, null);
  assert.deepEqual(f.runs, [{ cwdText: committed }]); assert.ok(f.sent.some(request => request.data.content.includes('ordinary execution')));
});

test('a merged candidate cannot substitute ordinary execution for the second author missing a material grant', async t => {
  const f = fixture(t, { grant: 'allowed' }); await f.runtime.prepareExecution();
  f.mention('om_alice', 'ou_alice', 'om_topic'); const denied = f.mention('om_bob', 'ou_bob', 'om_topic'); await f.runtime.runNext();
  assert.equal(f.assessments[0].triggers.length, 2);
  assert.equal(f.runtime.list().length, 0); assert.equal(f.runs.length, 0);
  assert.equal(assessmentStatus(f.store, denied.triggerId).code, 'MATERIAL_ACCESS_DENIED');
  const reply = f.runtime.notifications().find(item => item.id.endsWith(`:${denied.triggerId}`)); assert.ok(reply); assert.equal(reply.ticketId, undefined);
  assert.equal(f.sent[0].path.message_id, 'om_topic'); assert.ok(!JSON.stringify(f.sent).includes(current));
});

for (const revoked of ['actor', 'route', 'message']) test(`queued material refusal is withdrawn if its original ${revoked} changes`, async t => {
  const f = fixture(t, { failDelivery: true }); await f.runtime.prepareExecution(); const received = f.mention('om_wait'); await f.runtime.runNext();
  const reply = assertRefused(f, received.triggerId, 'MATERIAL_DESTINATION_DENIED'); assert.equal(reply.status, 'pending');
  if (revoked === 'actor') f.runtime.configureCoordinator({ policy: f.policy(['ou_bob']) }, { expectedRevision: 1 });
  if (revoked === 'route') { await f.runtime.stop(); f.runtime.configureV2({ feishu: { appId: 'cli_changed' } }); await f.runtime.prepareExecution(); }
  if (revoked === 'message') { const edited = { ...reply, text: current }; delete edited.status; f.store.db.prepare('UPDATE receipts SET data=? WHERE id=?').run(JSON.stringify(edited), reply.id); }
  await f.flush(); const settled = f.runtime.notifications().find(item => item.id === reply.id);
  assert.equal(settled.status, 'dropped'); assert.equal(f.sent.length, 0);
});

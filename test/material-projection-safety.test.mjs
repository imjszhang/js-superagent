import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';

const principal = { source: 'local', id: 'operator' };
const staleCanary = 'PRIVATE_STALE_PROJECTION_CANARY';
const currentCanary = 'CURRENT_PROJECTION_CANARY';

function fixture(t, { feishu = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-projection-safety-')));
  const file = join(root, 'notes.md'), events = [], runs = [], sent = [], network = { fail: true };
  writeFileSync(file, staleCanary);
  const api = {
    list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    get: async request => ({ code: 0, data: { items: [{ message_id: request.path.message_id, chat_id: 'oc_dm' }] } }),
    reply: async request => { if (network.fail) throw new Error('fixture delivery pending'); sent.push(request); return { code: 0, data: { message_id: `om_sent_${sent.length}` } }; },
    create: async request => { if (network.fail) throw new Error('fixture delivery pending'); sent.push(request); return { code: 0, data: { message_id: `om_sent_${sent.length}`, chat_id: 'oc_dm' } }; },
  };
  const feishuSDK = { Client: class { constructor() { this.im = { message: api }; } }, EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  let callback = () => ({ summary: 'Observed host state', actions: [] });
  const runtime = createProjectAgent({ projectRoot: root, ...(feishu ? { feishuSDK } : {}),
    execution: { driver: 'fixture', enableAgentTools: true },
    driver: { capabilities: { agentTools: true, boundedMaterialReadsVersion: 1, sessionResume: true }, async run(input) {
      runs.push(input.ticketId);
      input.checkpoint({ driver: 'fixture', id: `worker-${input.ticketId}` });
      const directory = input.agentTools.contextResources().find(ref => ref.resource === 'materials' && ref.value.kind === 'directory');
      if (directory) {
        let n = 0;
        const read = ref => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id }, callId: `read-${++n}`, sessionId: `worker-${input.ticketId}`, turnId: 'turn-one' });
        await read(directory);
        await read(input.agentTools.contextResources().find(ref => ref.resource === 'materials' && ref.value.kind === 'file'));
      }
      return { version: 2, state: 'waiting', summary: directory ? readFileSync(file, 'utf8') : 'Unbound task remains waiting', artifacts: [], attention: null };
    } },
    assessor: { async assess() { return { kind: 'ignore', reason: 'No new work', rules: [] }; }, async handleEvent(input) {
      events.push(input); input.checkpoint({ driver: 'fixture-assessor', id: input.session?.id ?? `coordinator-${events.length}` }); return callback(input);
    } },
  }).init();
  if (feishu) {
    process.env.MATERIAL_PROJECTION_FEISHU_SECRET = 'fixture-secret';
    runtime.configure({ feishu: { appId: 'cli_fixture', appSecretEnv: 'MATERIAL_PROJECTION_FEISHU_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant', chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], operator: { openId: 'ou_alice' } } });
  }
  runtime.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['notes.md'], views: ['current'], readers: [principal],
    destinations: [principal, ...(feishu ? [{ source: 'feishu', id: 'operator' }] : [])] }] }, { expectedRevision: 0 });
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' }, workflowMode: 'continuous' }, { expectedRevision: 0 });
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { store.close(); await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const submit = () => runtime.submit({ text: 'Inspect synthetic project notes', materials: { sources: [{ id: 'project', view: { kind: 'current' } }] } });
  const coordinate = async (id, text = 'Report the recorded task status') => {
    if (feishu) runtime.receiveSourceEvent('feishu', { sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 'tenant' }, message: {
      message_id: `om_${id.replaceAll('-', '_')}`, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '1793491200000', content: JSON.stringify({ text }),
    } });
    else runtime.coordinate({ id, text });
    await runtime.runNext();
  };
  return { root, file, runtime, events, runs, store, submit, coordinate, sent, network, setCallback: value => { callback = value; } };
}

test('stale material cannot return through a prior native session, recent event, ticket search or raw record', async t => {
  const f = fixture(t), old = f.submit(); await f.runtime.runNext();
  f.setCallback(() => ({ summary: staleCanary, actions: [{ kind: 'reply', ticketId: null, text: staleCanary }] }));
  await f.coordinate('seed-visible-history');
  await f.coordinate('resume-visible-history');
  assert.ok(f.events.at(-1).session, 'fresh history previously reused a native session');
  writeFileSync(f.file, currentCanary);
  f.setCallback(input => {
    assert.equal(input.session, undefined, 'freshness alone must rotate the native session, without a new ticket or grant');
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(staleCanary));
    return { summary: 'Historical material is now stale', actions: [] };
  });
  await f.coordinate('stale-transition');
  const transition = f.runtime.coordinationStatus().events.find(event => event.id === 'stale-transition');
  assert.equal(transition.status, 'completed', transition.error);
  const current = f.submit(); await f.runtime.runNext();
  f.setCallback(input => {
    assert.equal(input.session, undefined, 'stale transition cannot restore a native session containing the old body');
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(staleCanary));
    assert.match(JSON.stringify(input.context), new RegExp(currentCanary));
    assert.ok(input.context.tickets.some(card => card.id === old.id), 'the historical task remains discoverable as host metadata');
    assert.ok(input.context.tickets.some(card => card.id === current.id));
    const historical = input.readContext({ resource: 'tickets', recordId: old.id });
    assert.equal(historical.missing, undefined);
    assert.doesNotMatch(JSON.stringify(historical), new RegExp(staleCanary));
    const search = input.readContext({ resource: 'tickets', query: staleCanary });
    assert.equal(search.total, 0, 'search matches only projected values, not hidden material bodies');
    return { summary: 'Current report and historical status inspected', actions: [{ kind: 'reply', ticketId: null, text: currentCanary }] };
  });
  await f.coordinate('after-material-changed');
  const event = f.runtime.coordinationStatus().events.find(event => event.id === 'after-material-changed');
  assert.equal(event.status, 'completed', event.error);
  await f.runtime.flushNotifications();
  const answer = f.runtime.notifications().find(message => message.text === currentCanary);
  assert.equal(answer?.status, 'sent', 'an unrelated stale historical record cannot suppress the current report');
  const proof = f.store.getMeta(`material-message:${answer.id}`);
  assert.deepEqual([...proof.ticketIds].sort(), [old.id, current.id].sort(), 'legacy proof readers still see every disclosure dependency');
  assert.deepEqual(proof.freshTicketIds, [current.id]);
});

test('metadata-only replies retain disclosure authorization when a source grant is revoked before delivery', async t => {
  const f = fixture(t, { feishu: true }), source = f.submit(); await f.runtime.runNext();
  await f.runtime.prepareExecution();
  writeFileSync(f.file, currentCanary);
  const text = 'Only the historical task status is available; its former material report is stale.';
  f.setCallback(input => {
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(staleCanary));
    return { summary: 'Historical host status', actions: [{ kind: 'reply', ticketId: null, text }] };
  });
  await f.coordinate('metadata-before-revocation');
  const event = f.runtime.coordinationStatus().events.find(event => event.source?.messageId === 'om_metadata_before_revocation');
  assert.equal(event?.status, 'completed', event?.error);
  const queued = f.runtime.notifications().find(message => message.text === text);
  assert.ok(queued);
  assert.notEqual(queued.status, 'dropped', 'stale material permits a clean host-metadata reply');
  const proof = f.store.getMeta(`material-message:${queued.id}`);
  assert.deepEqual(proof.ticketIds, [source.id], 'an older writer cannot silently drop the metadata disclosure dependency');
  assert.deepEqual(proof.freshTicketIds, []);
  f.runtime.configureMaterials({ entries: [] }, { expectedRevision: 1 });
  f.network.fail = false; f.store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run();
  await f.runtime.flushNotifications();
  assert.equal(f.runtime.notifications().find(message => message.id === queued.id).status, 'dropped');
  assert.equal(f.sent.filter(message => message.data?.content?.includes(text)).length, 0, 'metadata proof never bypasses revoked source authority');
});

test('a ticket that really received material-derived context is projected as stale with its dependency', async t => {
  const f = fixture(t), source = f.submit(); await f.runtime.runNext();
  const target = f.runtime.submit({ text: 'Unbound task receiving a factual note' });
  f.setCallback(() => ({ summary: 'Transfer the authorized source context', actions: [{ kind: 'note', ticketId: target.id, text: staleCanary }] }));
  await f.coordinate('transfer-material-context');
  assert.deepEqual(f.store.getMeta(`ticket:${target.id}`).materialContextSources, [source.id]);
  writeFileSync(f.file, currentCanary);
  f.setCallback(input => {
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(staleCanary));
    const record = input.readContext({ resource: 'tickets', recordId: target.id });
    assert.equal(record.missing, undefined);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(staleCanary));
    assert.equal(input.readContext({ resource: 'tickets', query: staleCanary }).total, 0);
    return { summary: 'Dependent task metadata only', actions: [{ kind: 'reply', ticketId: null, text: 'The task history is stale and requires fresh investigation.' }] };
  });
  await f.coordinate('dependent-material-changed');
  const event = f.runtime.coordinationStatus().events.find(event => event.id === 'dependent-material-changed');
  assert.equal(event.status, 'completed', event.error);
});

test('metadata-derived notes retain all source dependencies in the legacy ticket field', async t => {
  const f = fixture(t), source = f.submit(); await f.runtime.runNext();
  writeFileSync(f.file, currentCanary);
  const target = f.runtime.submit({ text: 'Task receiving only the historical host status' });
  f.setCallback(input => {
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(staleCanary));
    return { summary: 'Transfer host status only', actions: [{ kind: 'note', ticketId: target.id, text: 'The historical report is stale; it does not establish current project facts.' }] };
  });
  await f.coordinate('transfer-host-metadata');
  const event = f.runtime.coordinationStatus().events.find(event => event.id === 'transfer-host-metadata');
  assert.equal(event.status, 'completed', event.error);
  const meta = f.store.getMeta(`ticket:${target.id}`);
  assert.deepEqual(meta.materialContextSources, [source.id], 'old runtimes conservatively enforce the metadata-derived authorization dependency');
  assert.equal(meta.materialContextProjectionVersion, 1);
  assert.deepEqual(meta.materialContextFreshSources, []);
  const dispatched = f.runs.length;
  f.runtime.note(target.id, 'Continue the existing task after checking its authorization');
  f.runtime.configureMaterials({ entries: [] }, { expectedRevision: 1 });
  await f.runtime.runNext();
  assert.equal(f.runs.length, dispatched, 'revocation fences recipient Worker dispatch even for metadata-only inherited sources');
  assert.equal(f.runtime.get(target.id).status, 'failed');
});

test('freshness changes during coordination fence reads, native checkpoints and result commit', async t => {
  const f = fixture(t), source = f.submit(); await f.runtime.runNext();
  let fencedReads = false, fencedCheckpoint = false, recovered = false;
  f.setCallback(input => {
    writeFileSync(f.file, currentCanary);
    assert.throws(() => input.readContext({ resource: 'tickets', recordId: source.id }), /context or policy changed/i);
    fencedReads = true;
    assert.throws(() => input.checkpoint({ driver: 'fixture-assessor', id: 'must-not-checkpoint-stale-body' }), /context or policy changed/i);
    fencedCheckpoint = true;
    return { summary: 'Invalidated turn', actions: [{ kind: 'reply', ticketId: null, text: 'This invalidated response must never be queued.' }] };
  });
  await f.coordinate('freshness-changed-during-turn');
  assert.equal(fencedReads, true); assert.equal(fencedCheckpoint, true);
  assert.equal(f.runtime.notifications().some(message => message.text === 'This invalidated response must never be queued.'), false);
  const invalidated = f.runtime.coordinationStatus().events.find(event => event.id === 'freshness-changed-during-turn');
  assert.equal(invalidated.status, 'pending', invalidated.error);
  f.setCallback(input => {
    assert.equal(input.session, undefined, 'retry enters a clean native session for the stale projection');
    assert.doesNotMatch(JSON.stringify(input.context), new RegExp(staleCanary));
    recovered = true;
    return { summary: 'Safe host status after source changed', actions: [] };
  });
  await f.runtime.runNext();
  assert.equal(recovered, true);
  const event = f.runtime.coordinationStatus().events.find(event => event.id === 'freshness-changed-during-turn');
  assert.equal(event.status, 'completed', event.error);
});

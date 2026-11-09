import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { normalizeAttentionSnapshotPaths, captureAttentionFiles } from '../src/runtime/attention-snapshots.mjs';

const file = 'review/candidates.jsonl';
const original = '{"id":"C0001","title":"Source under review","status":"pending"}\n';
const decision = { items: [{ id: 'C0001', title: 'Source under review', url: 'https://example.com/source' }],
  options: [{ id: 'adopted', label: '采纳' }, { id: 'later', label: '稍后' }], reason: 'required' };
const waiting = { version: 2, state: 'waiting', summary: 'Review the source', attention: { question: 'Decide this source.', decision } };

function fixture(t, { missing = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'attention-snapshot-'))), requests = [];
  let runtime, runs = 0, ticket;
  const registry = createHarnessRegistry({ adapters: [{ id: 'snapshot-fixture', version: '1', roles: ['worker'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, async run(input) {
      input.checkpoint({ driver: 'snapshot-fixture', id: 'same-session' });
      mkdirSync(join(input.projectRoot, 'review'), { recursive: true });
      if (++runs === 1) { if (!missing) writeFileSync(join(input.projectRoot, file), original); return waiting; }
      writeFileSync(join(input.projectRoot, file), original.replace('pending', 'later'));
      return { version: 2, state: 'ready', summary: 'Decision recorded', attention: null };
    } }) }] });
  const sdk = { Client: class { constructor() { this.im = { message: {
    create: async request => {
      assert.equal(runtime.listAttentionSnapshots(ticket.id).length, 1, 'snapshot is durable before the remote card is sent');
      requests.push(request); return { code: 0, data: { message_id: 'om_snapshot', chat_id: 'oc_operator' } };
    },
    list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    reply: async () => ({ code: 0, data: { message_id: 'om_reply' } }),
    get: async () => ({ code: 0, data: { items: [] } }),
  } }; } }, EventDispatcher: class { register() { return this; } }, WSClient: class { async start() {} close() {} } };
  process.env.TEST_ATTENTION_SNAPSHOT_SECRET = 'fixture-secret';
  const open = () => createProjectAgent({ projectRoot: root, harnessRegistry: registry, feishuSDK: sdk }).init();
  runtime = open();
  runtime.configure({ feishu: { appId: 'cli_snapshot', appSecretEnv: 'TEST_ATTENTION_SNAPSHOT_SECRET', botOpenId: 'ou_bot', tenantKey: 'tenant',
    chats: [{ chatId: 'oc_group', type: 'group', mode: 'mentions' }], operator: { openId: 'ou_operator' } } });
  runtime.configureExecutor({ driver: 'snapshot-fixture' }, { expectedRevision: 0 });
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, requests, get runtime() { return runtime; },
    submit() { ticket = runtime.submit({ text: 'Review one local source', attentionSnapshotPaths: [file] }); return ticket; },
    async reopen() { await runtime.stop(); runtime.close(); runtime = open(); await runtime.prepareExecution(); },
    callback() {
      const card = JSON.parse(requests[0].data.content);
      const value = card.body.elements.find(element => element.tag === 'form').elements.at(-1).behaviors[0].value;
      return { schema: '2.0', header: { event_type: 'card.action.trigger', tenant_key: 'tenant' }, event: { operator: { open_id: 'ou_operator' },
        context: { open_message_id: 'om_snapshot', open_chat_id: 'oc_operator' }, action: { value, form_value: { o0: 'later', r0: 'Test only' } } } };
    } };
}

test('a card may be submitted immediately: original files and choices remain frozen across Worker continuation and restart', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const ticket = f.submit();
  assert.equal((await f.runtime.runNext()).status, 'waiting');
  await f.runtime.flushNotifications();
  assert.equal(f.requests.length, 1);
  const [snapshot] = f.runtime.listAttentionSnapshots(ticket.id);
  assert.deepEqual(snapshot.files, [{ path: file, content: original, sha256: createHash('sha256').update(original).digest('hex') }]);
  assert.deepEqual(snapshot.decision, decision);
  assert.equal(snapshot.attentionId, f.runtime.getDetailed(ticket.id).attention.id);
  assert.equal(f.runtime.receiveFeishuCardAction(f.callback()).toast.type, 'success');
  assert.equal((await f.runtime.runNext()).status, 'completed');
  await f.reopen();
  assert.deepEqual(f.runtime.listAttentionSnapshots(ticket.id), [snapshot]);
  assert.equal(f.runtime.listAnswers(ticket.id)[0].via, 'feishu-card');
});

test('missing review evidence blocks card delivery and both answer forms; unanswered evidence can recover after restart', async t => {
  const f = fixture(t, { missing: true }); await f.runtime.prepareExecution();
  const ticket = f.submit();
  assert.equal((await f.runtime.runNext()).status, 'waiting');
  await f.runtime.flushNotifications();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.runtime.listAttentionSnapshots(ticket.id), []);
  assert.match(f.runtime.getDetailed(ticket.id).attention.snapshotError, /ENOENT/);
  assert.throws(() => f.runtime.answer(ticket.id, { answers: { C0001: { option: 'later', reason: 'test' } } }), /Review evidence is not ready/);
  assert.throws(() => f.runtime.reply(ticket.id, 'Later, test only'), /Review evidence is not ready/);
  assert.deepEqual(f.runtime.listAnswers(ticket.id), []);
  writeFileSync(join(f.runtime.getWorkspace(ticket.id).path, file), original);
  await f.reopen(); await f.runtime.flushNotifications();
  assert.equal(f.requests.length, 1);
  assert.equal(f.runtime.getDetailed(ticket.id).attention.snapshotError, undefined);
  assert.equal(f.runtime.receiveFeishuCardAction(f.callback()).toast.type, 'success');
});

test('an answered question can never receive a replacement snapshot from later workspace contents', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const ticket = f.submit(); await f.runtime.runNext(); await f.runtime.flushNotifications();
  const attentionId = f.runtime.listAttentionSnapshots(ticket.id)[0].attentionId;
  f.runtime.receiveFeishuCardAction(f.callback());
  // Simulate state imported from an old writer that accepted an answer without this evidence.
  const db = new DatabaseSync(join(projectStateDirectory(f.root), 'state.sqlite'));
  try { db.prepare('DELETE FROM kv WHERE key = ?').run(`attention-snapshot:${attentionId}`); } finally { db.close(); }
  writeFileSync(join(f.runtime.getWorkspace(ticket.id).path, file), 'changed after answer');
  await f.runtime.flushNotifications();
  assert.deepEqual(f.runtime.listAttentionSnapshots(ticket.id), []);
  assert.match(f.runtime.getDetailed(ticket.id).attention.snapshotError, /after its answer/);
});

test('snapshot check, file capture and persistence exclude a competing database writer, and later capture never replaces the first evidence', async t => {
  const f = fixture(t); await f.runtime.prepareExecution();
  const ticket = f.submit(), databasePath = join(projectStateDirectory(f.root), 'state.sqlite');
  const contender = new DatabaseSync(databasePath);
  contender.exec('PRAGMA busy_timeout = 0');
  const readMeta = Store.prototype.getMeta;
  let checks = 0;
  const mock = t.mock.method(Store.prototype, 'getMeta', function(key) {
    if (this.path === databasePath && key.startsWith('attention-snapshot:')) {
      checks++;
      assert.equal(this.inTransaction, true, 'the first-read check is already inside the writer transaction');
      assert.throws(() => contender.prepare('INSERT OR REPLACE INTO kv(key, data) VALUES (?, ?)').run(key, '{"files":[]}'), /locked|busy/i,
        'a second process/connection cannot win between check and capture');
    }
    return readMeta.call(this, key);
  });
  try {
    await f.runtime.runNext(); await f.runtime.flushNotifications();
    assert.ok(checks > 0);
    const [first] = f.runtime.listAttentionSnapshots(ticket.id);
    writeFileSync(join(f.runtime.getWorkspace(ticket.id).path, file), 'a later version must not replace the frozen review');
    await f.runtime.flushNotifications();
    assert.equal(f.runtime.receiveFeishuCardAction(f.callback()).toast.type, 'success');
    assert.deepEqual(f.runtime.listAttentionSnapshots(ticket.id), [first]);
    assert.equal(first.files[0].content, original);
  } finally { mock.mock.restore(); contender.close(); }
});

test('snapshot inputs reject traversal, duplicates, sensitive paths and oversized selections', t => {
  for (const paths of [[], Array(11).fill('file'), ['../secret'], ['/secret'], ['a/../secret'], ['a\\secret'], ['a//b'], ['a', 'a'], ['.env'], ['a/.git/config']]) {
    assert.throws(() => normalizeAttentionSnapshotPaths(paths));
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'snapshot-paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'review'));
  writeFileSync(join(root, 'outside'), 'do not read');
  symlinkSync(join(root, 'outside'), join(root, 'review/link'));
  assert.throws(() => captureAttentionFiles(root, ['review/link']), /symbolic link/);
  symlinkSync(join(root, 'review'), join(root, 'linked-directory'));
  assert.throws(() => captureAttentionFiles(root, ['linked-directory/link']), /symbolic link/);
  writeFileSync(join(root, 'large'), Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => captureAttentionFiles(root, ['large']), /exceeds/);
  writeFileSync(join(root, 'binary'), Buffer.from([0xff]));
  assert.throws(() => captureAttentionFiles(root, ['binary']), /UTF-8/);
});

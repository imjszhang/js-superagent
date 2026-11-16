import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';
import { MATERIAL_NOTICE_TEXT, materialWithdrawalNotice, verifyMaterialWithdrawalNotice } from '../src/runtime/material-notice.mjs';

const LEGACY_TEXT = '材料或权限已变化，原结果未发送。请重新调查，或由项目维护者检查配置。';
const NEUTRAL_TEXT = '一条消息未通过材料或权限校验，已停止继续发送。此提示不表示工单执行失败。';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const original = kind => ({ id: `original-${kind}`, kind, ticketId: 'ticket', text: 'Synthetic original message',
  channel: { source: 'fixture', thread: 'original-thread', address: { id: 'original-destination' } } });
const legacyNotice = () => {
  const source = original('acknowledgement');
  const message = { id: `material-notice:${digest(source.id)}`, kind: 'notice', ticketId: source.ticketId,
    channel: structuredClone(source.channel), text: LEGACY_TEXT };
  return { message, proof: { version: 1, template: 'material-output-withdrawn-v1', originalId: source.id,
    originalDigest: digest(source), messageDigest: digest(message), ticketIds: ['ticket'], route: { source: 'fixture', id: 'original-destination' } } };
};

test('new material withdrawal notices do not classify an acknowledgement or reply as a failed ticket', () => {
  assert.equal(MATERIAL_NOTICE_TEXT, NEUTRAL_TEXT);
  for (const kind of ['acknowledgement', 'reply', 'notice']) {
    const source = original(kind), notice = materialWithdrawalNotice(source, ['ticket'], { source: 'fixture', id: 'original-destination' });
    assert.equal(notice.message.text, NEUTRAL_TEXT);
    assert.equal(notice.message.id, `material-notice:${digest(source.id)}`);
    assert.equal(notice.proof.version, 1);
    assert.equal(notice.proof.template, 'material-output-withdrawn-v1');
    assert.deepEqual(Object.keys(notice.proof).sort(), ['version', 'template', 'originalId', 'originalDigest', 'messageDigest', 'ticketIds', 'route'].sort());
    assert.equal(verifyMaterialWithdrawalNotice(notice.message, notice.proof), true);
  }
});

test('material notice verification accepts only exact legacy or neutral text with its matching retained proof', () => {
  for (const notice of [legacyNotice(), materialWithdrawalNotice(original('reply'), ['ticket'], { source: 'fixture', id: 'original-destination' })]) {
    assert.equal(verifyMaterialWithdrawalNotice(notice.message, notice.proof), true);
    for (const text of [LEGACY_TEXT, NEUTRAL_TEXT, `${NEUTRAL_TEXT} `, 'SYNTHETIC_MATERIAL_CONTENT']) {
      if (text !== notice.message.text) assert.equal(verifyMaterialWithdrawalNotice({ ...notice.message, text }, notice.proof), false);
    }
    const arbitrary = { ...notice.message, text: 'SYNTHETIC_MATERIAL_CONTENT' };
    assert.equal(verifyMaterialWithdrawalNotice(arbitrary, { ...notice.proof, messageDigest: digest(arbitrary) }), false);
    assert.equal(verifyMaterialWithdrawalNotice({ ...notice.message, kind: 'reply' }, notice.proof), false);
    assert.equal(verifyMaterialWithdrawalNotice({ ...notice.message, channel: { ...notice.message.channel, thread: 'other' } }, notice.proof), false);
    assert.equal(verifyMaterialWithdrawalNotice(notice.message, { ...notice.proof, originalId: 'another-original' }), false);
  }
});

test('a retained legacy pending notice sends its original text once after reopen and a sent notice is not replayed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'material-notice-reopen-')), path = join(dir, 'state.sqlite'), sent = [];
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const notice = legacyNotice(), key = `material-host-notice:${notice.message.id}`;
  store.setMeta(key, notice.proof);
  new Outbox(store, new Effects(store)).send(notice.message);
  assert.equal(new Outbox(store, new Effects(store)).status(notice.message.id), 'pending');
  store.close(); store = new Store(path);
  const outbox = () => new Outbox(store, new Effects(store), {
    authorize: message => assert.equal(verifyMaterialWithdrawalNotice(message, store.getMeta(`material-host-notice:${message.id}`)), true),
    deliver: async message => { sent.push(structuredClone(message)); return { id: 'fixture-receipt', url: '' }; }
  });
  await outbox().deliver({}, notice.message.id);
  assert.equal(outbox().status(notice.message.id), 'sent');
  assert.deepEqual(sent, [notice.message]);
  assert.equal(sent[0].text, LEGACY_TEXT);
  assert.deepEqual(store.getMeta(key), notice.proof);
  store.close(); store = new Store(path);
  outbox().send(materialWithdrawalNotice(original('acknowledgement'), ['ticket'], notice.proof.route).message);
  await outbox().deliver({}, notice.message.id);
  assert.equal(sent.length, 1);
  assert.deepEqual(outbox().list()[0].text, LEGACY_TEXT);
  assert.deepEqual(store.getMeta(key), notice.proof);
});

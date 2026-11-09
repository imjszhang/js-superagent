import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { Effects, Later } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-effects-'));
  const stores = [new Store(join(root, 'state.sqlite')), new Store(join(root, 'state.sqlite'))];
  t.after(() => { stores.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });
  return stores;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('effects dispatch only committed work and never invoke handlers inside transactions', async t => {
  const [store] = fixture(t), effects = new Effects(store);
  assert.throws(() => store.atomic(() => { effects.enqueue('launch', 'a', {}); throw new Error('rollback'); }));
  let calls = 0;
  assert.equal(await effects.runNext({ launch: async () => { calls++; } }), false);
  let refusal;
  store.atomic(() => { effects.enqueue('launch', 'a', {}); refusal = effects.runNext({ launch: async () => { calls++; } }); });
  await assert.rejects(refusal, /inside a transaction/);
  assert.equal(calls, 0);
  assert.equal(await effects.runNext({ launch: async () => { calls++; assert.equal(store.inTransaction, false); } }), true);
  assert.equal(calls, 1);
  assert.equal(effects.pending('launch'), false);
});

test('failures and deferrals persist with bounded backoff across instances', async t => {
  const [store, other] = fixture(t);
  let time = 100;
  const options = { now: () => time, retryMs: 10, maxRetryMs: 20 };
  const effects = new Effects(store, options), reopened = new Effects(other, options);
  effects.enqueue('work', 'a', { n: 1 });
  const fail = { work: async () => { throw new Error('offline'); } };
  await effects.runNext(fail);
  assert.equal(reopened.list()[0].attempts, 1);
  assert.equal(reopened.list()[0].due, 110);
  assert.equal(await reopened.runNext(fail), false);
  time = 110; await reopened.runNext(fail);
  assert.equal(effects.list()[0].due, 130);
  time = 130; await effects.runNext({ work: async () => { throw new Later('waiting'); } });
  assert.equal(effects.list()[0].attempts, 2);
  assert.equal(effects.list()[0].due, 140);
  time = 140; await effects.runNext({ work: async () => {} });
  assert.equal(effects.list().length, 0);
});

test('cross-instance claims prevent duplicate execution and preserve new generations', async t => {
  const [store, other] = fixture(t), first = new Effects(store), second = new Effects(other), gate = deferred();
  first.enqueue('work', 'a', { version: 1 });
  let calls = 0;
  const active = first.runNext({ work: async payload => { calls++; assert.equal(payload.version, 1); await gate.promise; } });
  assert.equal(await second.runNext({ work: async () => { calls++; } }), false);
  second.enqueue('work', 'a', { version: 2 });
  assert.equal(await second.runNext({ work: async () => { calls++; } }), false);
  gate.resolve(); await active;
  assert.equal(second.list()[0].payload.version, 2);
  assert.equal(second.list()[0].token, null);
  await second.runNext({ work: async payload => { calls++; assert.equal(payload.version, 2); } });
  assert.equal(calls, 2);
  assert.equal(first.list().length, 0);
});

test('cancel and requeue during execution cannot let an old attempt remove new work', async t => {
  const [store, other] = fixture(t), first = new Effects(store), second = new Effects(other), gate = deferred();
  first.enqueue('work', 'a', { version: 1 });
  const active = first.runNext({ work: async () => { await gate.promise; throw new Error('old error'); } });
  second.cancel('work', 'a');
  assert.equal(second.pending('work', 'a'), false);
  second.enqueue('work', 'a', { version: 2 });
  assert.equal(await second.runNext({ work: async () => {} }), false);
  gate.resolve(); await active;
  assert.equal(second.list()[0].attempts, 0);
  assert.equal(second.list()[0].error, '');
  assert.equal(await second.runNext({ work: async () => {} }), true);
  assert.equal(second.list().length, 0);
});

test('crash recovery releases only a demonstrably dead local owner', async t => {
  const [store] = fixture(t), effects = new Effects(store);
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  effects.enqueue('work', 'dead', {}); effects.enqueue('work', 'live', {}); effects.enqueue('work', 'remote', {});
  for (const [key, owner] of [['dead', { host: hostname(), pid: deadPid }], ['live', { host: hostname(), pid: process.pid }], ['remote', { host: 'unrelated-machine', pid: deadPid }]]) {
    store.db.prepare('UPDATE effects SET token = ?, owner = ? WHERE key = ?').run(key, JSON.stringify(owner), key);
  }
  assert.equal(effects.recover(), 1);
  assert.equal(effects.list()[0].token, null);
  assert.equal(effects.list()[1].token, 'live');
  assert.equal(effects.list()[2].token, 'remote');
});

test('outbox receipts are atomic, idempotent, withdrawable and local-only', async t => {
  const [store, other] = fixture(t), effects = new Effects(store), outbox = new Outbox(store, effects);
  const message = { id: 'm', kind: 'reply', channel: { source: 'local', thread: 't', address: {} }, text: 'hello' };
  outbox.send(message); outbox.send({ ...message, text: 'duplicate must not overwrite' });
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0].text, 'hello');
  assert.equal(new Outbox(other, new Effects(other)).status('m'), 'pending');
  await effects.runNext({ reply: (payload, id) => outbox.deliver(payload, id) });
  assert.equal(outbox.status('m'), 'sent');
  outbox.send({ ...message, id: 'withdraw' }); outbox.withdraw('withdraw');
  assert.equal(outbox.status('withdraw'), 'dropped');
  assert.equal(effects.pending('reply', 'withdraw'), false);
  outbox.send({ ...message, id: 'remote', channel: { ...message.channel, source: 'github' } });
  await effects.runNext({ reply: (payload, id) => outbox.deliver(payload, id) });
  assert.equal(outbox.status('remote'), 'pending');
  assert.equal(effects.list()[0].attempts, 0);
});

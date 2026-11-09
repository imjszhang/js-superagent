import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { watchStateChanges } from '../src/runtime/state-watch.mjs';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('State change was not observed');
    await delay(10);
  }
}
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'state-watch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('SDK watcher sees another process commit without starting another execution loop', async t => {
  const root = temporary(t), runtime = createProjectAgent({ projectRoot: root }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); });
  const ticket = runtime.submit({ text: 'Observe cancellation' });
  let observed, calls = 0;
  const unsubscribe = runtime.watchChanges(() => { calls++; observed = runtime.get(ticket.id).status; });
  const module = new URL('./helpers/runtime-fixture.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import {createProjectAgent} from ${JSON.stringify(module)};
    const r=createProjectAgent({projectRoot:${JSON.stringify(root)}}).init();
    r.cancel(${JSON.stringify(ticket.id)});await r.stop();r.close();`], { encoding: 'utf8' });
  await until(() => observed === 'cancelled');
  assert.equal(runtime.status().running, false);
  unsubscribe(); unsubscribe();
  const before = calls;
  runtime.submit({ text: 'Unsubscribed' });
  await delay(80);
  assert.equal(calls, before);
});

test('SDK watcher observes completed work and close releases subscriptions', async t => {
  const root = temporary(t);
  const writer = createProjectAgent({ projectRoot: root, driver: { async run() { return { status: 'completed', summary: 'Ready' }; } } }).init();
  const reader = createProjectAgent({ projectRoot: root }).init();
  t.after(async () => { await reader.stop(); reader.close(); await writer.stop(); writer.close(); });
  const ticket = writer.submit({ text: 'Complete one local job' });
  let completed = false, calls = 0;
  reader.watchChanges(() => { calls++; completed ||= reader.get(ticket.id).status === 'completed'; });
  await writer.runNext();
  await until(() => completed);
  reader.close();
  const before = calls;
  writer.submit({ text: 'No more callbacks' });
  await delay(80);
  assert.equal(calls, before);
});

test('directory watch follows WAL changes and requests reopen on database replacement', async t => {
  const root = temporary(t), database = join(root, 'state.sqlite');
  writeFileSync(database, 'original');
  let calls = 0;
  const errors = [];
  const close = watchStateChanges(database, () => { calls++; }, { onError: error => errors.push(error) }); t.after(close);
  // macOS can deliver a file's creation event after the watch is attached.
  await delay(80); calls = 0;
  writeFileSync(join(root, 'unrelated.json'), '{}');
  await delay(80); assert.equal(calls, 0);
  writeFileSync(`${database}-wal`, 'commit');
  await until(() => calls > 0);
  const first = calls;
  writeFileSync(join(root, 'replacement'), 'replacement');
  renameSync(join(root, 'replacement'), database);
  await until(() => errors.length > 0);
  assert.equal(errors[0].code, 'WATCH_REOPEN_REQUIRED');
  assert.equal(calls, first);
});

test('async readers serialize, retain a trailing invalidation, and report errors', async t => {
  const root = temporary(t), database = join(root, 'state.sqlite');
  writeFileSync(database, 'original');
  let calls = 0, active = 0, maximum = 0, release;
  const errors = [], blocked = new Promise(resolve => { release = resolve; });
  const close = watchStateChanges(database, async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    try { if (calls === 1) { await blocked; throw new Error('Reader failed'); } }
    finally { active--; }
  }, { onError: error => errors.push(error.message) }); t.after(close);
  writeFileSync(`${database}-wal`, 'first');
  await until(() => calls === 1);
  writeFileSync(`${database}-wal`, 'second');
  await delay(50); assert.equal(calls, 1);
  release(); await until(() => calls === 2);
  assert.equal(maximum, 1); assert.deepEqual(errors, ['Reader failed']);
});

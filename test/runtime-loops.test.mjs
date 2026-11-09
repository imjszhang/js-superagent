import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const event = (id, text) => ({ id: `github:fixture/project:comment:${id}`, repository: 'fixture/project', issueNumber: 7, issueId: 700,
  kind: 'comment', text, title: 'Task', actor: { login: 'alice', id: '10', type: 'User' }, createdAt: new Date().toISOString(),
  url: 'https://github.com/fixture/project/issues/7', issueState: 'open' });
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await delay(10); } assert.fail('timed out'); }
function setup(t, driver, channel) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-loops-')));
  const options = { projectRoot: root, driver, github: { repository: 'fixture/project', allowedActors: ['alice'], issues: [7], pollIntervalMs: 1000 }, githubChannel: channel };
  const runtime = createProjectAgent(options).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, runtime, options };
}
test('source loop receives and cancels a running worker without waiting for its turn', { timeout: 10000 }, async t => {
  let polls = 0, runs = 0; const started = deferred();
  const initial = event(1, '/js-superagent Perform a long operation');
  const feedback = event(2, 'Keep all changes local'); const cancel = event(3, '/js-superagent cancel');
  const { runtime } = setup(t, { async run({ signal }) {
    runs++; started.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'completed', summary: 'Cancelled before delivery' };
  } }, { async poll() { polls++; return polls === 1 ? [initial] : polls === 2 ? [initial, feedback] : [initial, feedback, cancel]; }, async deliver() { return { id: '1', url: 'https://github.com/fixture/project/issues/7#issuecomment-1' }; } });
  runtime.start({ intervalMs: 10 }); await started.promise;
  await until(() => runtime.list()[0].messages.length === 2);
  assert.equal(runtime.status().active, true); assert.equal(runs, 1);
  await until(() => runtime.list()[0].status === 'cancelled');
  assert.ok(polls >= 3); assert.equal(runs, 1); assert.equal(runtime.list().length, 1);
});
test('slow notification delivery does not hold the source lease', { timeout: 10000 }, async t => {
  let polls = 0; const release = deferred();
  const { runtime } = setup(t, { async run() { return { status: 'waiting', summary: 'Question' }; } }, {
    async poll() { polls++; return [event(1, '/js-superagent Work')]; }, async deliver() { await release.promise; return { id: '1', url: 'https://github.com/fixture/project/issues/7#issuecomment-1' }; }
  });
  t.after(() => release.resolve()); runtime.start({ intervalMs: 10 });
  try { await until(() => polls >= 2); assert.ok(runtime.notifications().some(n => n.status === 'pending')); }
  finally { release.resolve(); }
});
test('pause is durable, permits intake and suppresses model work and business messages', async t => {
  let runs = 0, sends = 0;
  const { runtime, options } = setup(t, { async run() { runs++; return { status: 'completed', summary: 'Done' }; } }, {
    async poll() { return [event(1, '/js-superagent Work')]; }, async deliver() { sends++; return { id: '1', url: 'https://github.com/fixture/project/issues/7#issuecomment-1' }; }
  });
  runtime.pause(); await runtime.syncGitHub(); assert.equal(runtime.list().length, 1);
  assert.equal(await runtime.runNext(), null); assert.equal(runs, 0); assert.equal(sends, 0);
  const second = createProjectAgent(options).init();
  try { assert.equal(second.isPaused(), true); second.resume(); }
  finally { second.close(); }
  assert.equal((await runtime.runNext()).status, 'completed'); assert.equal(runs, 1); assert.ok(sends > 0);
});
test('pause does not fabricate cancellation of an outbound request already sent', async t => {
  const started = deferred(), release = deferred();
  const { runtime } = setup(t, { async run() { return { status: 'completed', summary: 'Done' }; } }, {
    async poll() { return [event(1, '/js-superagent Work')]; }, async deliver() { started.resolve(); await release.promise; return { id: 'remote-success', url: 'https://github.com/fixture/project/issues/7#issuecomment-2' }; }
  });
  const sync = runtime.syncGitHub(); await started.promise; runtime.pause(); release.resolve(); await sync;
  assert.ok(runtime.notifications().some(n => n.status === 'sent')); assert.equal(runtime.isPaused(), true);
});

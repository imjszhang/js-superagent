import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

test('a preopened legacy reply dispatcher leaves new-schema coordinator answers for the new runtime', async t => {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-answer-old-writer-'));
  const repository = 'fixture/legacy-answer', runtimes = []; let legacyStore;
  let transportAvailable = false, sent = 0, legacySends = 0, workerRuns = 0;
  const options = { projectRoot: root, github: { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 86400000 },
    githubChannel: { async poll() { return []; }, async probe() { return { repository, repositoryId: 55 }; },
      async deliver(message, { authorizeSend }) {
        if (!transportAvailable) throw new Error('Fixture transport unavailable before any write');
        await authorizeSend({ kind: 'conversation' });
        sent++; return { id: String(sent), url: `https://github.com/${repository}/issues/7#issuecomment-${sent}` };
      } },
    driver: { async run() { workerRuns++; throw new Error('No Worker is required'); } },
    assessor: { async assess({ candidate }) { return { kind: 'answer', triggerId: candidate.triggers[0].id,
      answer: 'There is no active Worker for this question.', reason: 'The supplied records answer the question.', rules: [] }; } },
  };
  const open = () => { const runtime = createProjectAgent(options).init(); runtimes.push(runtime); return runtime; };
  t.after(async () => {
    for (const runtime of runtimes.reverse()) { try { await runtime.stop(); runtime.close(); } catch {} }
    legacyStore?.close(); rmSync(root, { recursive: true, force: true });
  });
  let runtime = open();
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 0 });
  // Freeze the pre-answer storage version before opening the old, idle connection.
  const path = join(stateDir(root), 'state.sqlite'), seed = new Store(path);
  seed.db.exec('PRAGMA user_version=10'); seed.setMeta('runtime:minimum-version', '0.9.0-alpha.0'); seed.close();
  legacyStore = new Store(path);
  assert.equal(legacyStore.db.prepare('PRAGMA user_version').get().user_version, 10);
  const legacyEffects = new Effects(legacyStore);
  // v0.9's dispatcher registered only this message kind. Keep this contract fixed
  // instead of reading git or loading a second package during the test.
  const legacyHandlers = { reply() { legacySends++; } };
  assert.equal(runtime.upgradeRuntime().schemaVersion, 14);
  assert.equal(legacyStore.db.prepare('PRAGMA user_version').get().user_version, 14);
  runtime.receiveGitHubEvent({ kind: 'comment', id: `github:${repository}:comment:11`, repository,
    issueNumber: 7, issueId: 7, issueState: 'open', actor: { login: 'alice', id: 10, type: 'User' },
    text: '/js-superagent Is a Worker active for this question?', createdAt: new Date().toISOString() });
  await runtime.runNext();
  assert.equal(sent, 0); assert.equal(workerRuns, 0); assert.equal(runtime.list().length, 0);
  const reply = runtime.notifications()[0]; assert.equal(reply.status, 'pending');
  legacyStore.db.prepare("UPDATE effects SET due=0 WHERE key=?").run(reply.id);
  const saved = legacyEffects.list().find(effect => effect.key === reply.id);
  assert.equal(saved.kind, 'coordinator-answer'); assert.equal(legacyEffects.pending('reply', reply.id), false);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await legacyEffects.runNext(legacyHandlers), false);
    legacyEffects.recover(); legacyEffects.cancel('reply', reply.id);
  }
  assert.equal(legacySends, 0); assert.equal(sent, 0);
  assert.deepEqual(legacyEffects.list().find(effect => effect.key === reply.id), saved);
  assert.equal(runtime.notifications()[0].status, 'pending');
  await runtime.stop(); runtime.close(); runtime = open(); transportAvailable = true;
  await runtime.flushNotifications();
  assert.equal(sent, 1); assert.equal(runtime.notifications()[0].status, 'sent');
  assert.equal(legacyEffects.pending('coordinator-answer', reply.id), false);
  assert.equal(await legacyEffects.runNext(legacyHandlers), false);
  await runtime.flushNotifications();
  assert.equal(sent, 1); assert.equal(legacySends, 0); assert.equal(workerRuns, 0);
});

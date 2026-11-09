import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { inspectDatabase } from '../src/database-maintenance.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

test('schema 12 upgrades with a preserved backup and old dispatchers leave Worker answers for the new runtime', async t => {
  const root = mkdtempSync(join(tmpdir(), 'worker-answer-upgrade-')), repository = 'fixture/worker-upgrade';
  const answer = 'The existing Worker preserved the requested newline.', runtimes = [];
  let oldStore, transportAvailable = false, answerSends = 0, legacySends = 0, workerRuns = 0;
  const options = { projectRoot: root, github: { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 86400000 },
    githubChannel: { async poll() { return []; }, async probe() { return { repository, repositoryId: 55 }; },
      async deliver(message, { authorizeSend }) {
        if (message.text === answer && !transportAvailable) throw new Error('Transport unavailable before sending');
        await authorizeSend({ kind: 'conversation' });
        if (message.text === answer) answerSends++;
        return { id: message.id, url: `https://github.com/${repository}/issues/7#issuecomment-100` };
      } },
    driver: { async run(input) {
      workerRuns++; input.checkpoint({ driver: 'fixture', id: 'worker-upgrade-session' });
      return { version: 2, state: 'waiting', summary: answer, artifacts: [], attention: null,
        answers: input.domainTicket.origin.triggerId };
    } },
  };
  const open = () => { const value = createProjectAgent(options).init(); runtimes.push(value); return value; };
  t.after(async () => {
    for (const value of runtimes.reverse()) { try { await value.stop(); value.close(); } catch {} }
    oldStore?.close(); rmSync(root, { recursive: true, force: true });
  });
  let runtime = open();
  const path = join(stateDir(root), 'state.sqlite');
  const event = { kind: 'comment', id: `github:${repository}:comment:11`, repository,
    issueNumber: 7, issueId: 7, issueState: 'open', actor: { login: 'alice', id: 10, type: 'User' },
    text: '/js-superagent Explain whether the parser preserves a newline.', createdAt: new Date().toISOString() };
  const received = runtime.receiveGitHubEvent(event); assert.ok(received.ticketId);
  // Seed a v0.11-compatible pending request, then freeze its schema before the upgrade.
  const seed = new Store(path);
  seed.db.exec('PRAGMA user_version=12');
  seed.db.exec('DELETE FROM schema_migrations WHERE to_version>=13');
  seed.setMeta('runtime:minimum-version', '0.11.0-alpha.0');
  seed.setMeta('upgrade:preserved', { revision: 1, original: 'pre-upgrade state' }); seed.close();
  oldStore = new Store(path); const oldEffects = new Effects(oldStore);
  assert.equal(oldStore.db.prepare('PRAGMA user_version').get().user_version, 12);
  // This freezes the previously shipped dispatch contract, without loading git history.
  const oldHandlers = { reply() { legacySends++; }, 'coordinator-answer'() { legacySends++; } };
  assert.equal(runtime.upgradeRuntime().schemaVersion, 14);
  assert.equal(oldStore.db.prepare('PRAGMA user_version').get().user_version, 14);
  assert.equal(oldStore.getMeta('runtime:minimum-version'), '0.13.0-alpha.0');
  assert.deepEqual(oldStore.getMeta('upgrade:preserved'), { revision: 1, original: 'pre-upgrade state' });
  const history = inspectDatabase(path).migrations;
  assert.deepEqual(history.filter(row => row.toVersion === 13).map(({ id, fromVersion, toVersion }) => ({ id, fromVersion, toVersion })),
    [{ id: 'worker-answers-and-pr-redelivery-v12', fromVersion: 12, toVersion: 13 }]);
  assert.deepEqual(history.filter(row => row.toVersion === 14).map(({ id, fromVersion, toVersion }) => ({ id, fromVersion, toVersion })),
    [{ id: 'host-alignment-v13', fromVersion: 13, toVersion: 14 }]);
  const backups = readdirSync(stateDir(root)).filter(name => /^state\.sqlite\.v12-.*\.backup$/.test(name));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(stateDir(root), backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(JSON.parse(backup.prepare('SELECT data FROM kv WHERE key=?').get('runtime:minimum-version').data), '0.11.0-alpha.0');
    assert.equal(JSON.parse(backup.prepare('SELECT data FROM domain_triggers WHERE id=?').get(event.id).data).text.includes('preserves a newline'), true);
  } finally { backup.close(); }
  await runtime.runNext();
  assert.equal(workerRuns, 1); assert.equal(answerSends, 0); assert.equal(runtime.get(received.ticketId).status, 'waiting');
  const reply = runtime.notifications().find(message => message.text === answer);
  assert.ok(reply); assert.equal(reply.status, 'pending');
  oldStore.db.prepare('UPDATE effects SET due=0 WHERE key=?').run(reply.id);
  const queued = oldEffects.list().find(effect => effect.key === reply.id);
  assert.equal(queued.kind, 'worker-answer'); assert.equal(oldEffects.pending('reply', reply.id), false);
  assert.equal(oldEffects.pending('coordinator-answer', reply.id), false);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await oldEffects.runNext(oldHandlers), false);
    oldEffects.recover(); oldEffects.cancel('reply', reply.id); oldEffects.cancel('coordinator-answer', reply.id);
  }
  assert.equal(legacySends, 0); assert.deepEqual(oldEffects.list().find(effect => effect.key === reply.id), queued);
  await runtime.stop(); runtime.close(); runtime = open(); transportAvailable = true;
  await runtime.flushNotifications();
  assert.equal(answerSends, 1); assert.equal(runtime.notifications().find(message => message.id === reply.id).status, 'sent');
  assert.equal(oldEffects.pending('worker-answer', reply.id), false); assert.equal(await oldEffects.runNext(oldHandlers), false);
  await runtime.flushNotifications(); assert.equal(answerSends, 1); assert.equal(workerRuns, 1); assert.equal(legacySends, 0);
  assert.equal(readdirSync(stateDir(root)).filter(name => /^state\.sqlite\.v12-.*\.backup$/.test(name)).length, 1);
});

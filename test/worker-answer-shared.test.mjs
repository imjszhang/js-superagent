import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { Store } from '../src/store.mjs';
import { normalizeGitHubEvent } from '../src/github-intake.mjs';

test('two owning Workers sharing the same answer preserve the first pending proof and send once after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-worker-answer-shared-')), repository = 'fixture/shared-answer';
  const user = { id: 10, login: 'alice', type: 'User' }, bot = { id: 20, login: 'helper', type: 'User' }, posted = [];
  const text = 'SHARED ANSWER: both changes preserve the parser newline.';
  let sequence = 100, clock = Date.now(), runtime, question, hold = true;
  const native = createGitHubChannel({ repository, allowedActors: ['alice'], issues: [7, 8] }, { async request(path, options) {
    if (path === '/user') return bot;
    if (path === `/repos/${repository}`) return { id: 99, full_name: repository, has_issues: true };
    const destination = /\/issues\/(7|8)\/comments/.exec(path);
    if (destination) {
      const issueNumber = Number(destination[1]);
      if (options.method !== 'POST') return posted.filter(comment => comment.issueNumber === issueNumber);
      const id = 1000 + posted.length, comment = { id, user: bot, body: options.body.body,
        issueNumber, html_url: `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${id}` };
      posted.push(comment); return comment;
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  } });
  const channel = { ...native, async poll() { return []; }, async deliver(message, context) {
    if (hold && message.text === text) throw new Error('Temporary transport failure before posting');
    return native.deliver(message, context);
  } };
  const options = { projectRoot: root, workspace: 'copy', github: { repository, allowedActors: ['alice'], issues: [7, 8], pollIntervalMs: 86_400_000 }, githubChannel: channel,
    driver: { async run() { return { version: 2, state: 'waiting', summary: question ? text : 'Waiting for the next question', attention: null,
      ...(question ? { answers: question.id } : {}) }; } } };
  const open = () => runtime = createProjectAgent(options).init();
  open();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const inspect = fn => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return fn(store); } finally { store.close(); } };
  const event = (message, issueNumber = 7) => { const at = new Date(clock += 1000).toISOString(); return normalizeGitHubEvent({ id: `github:${repository}:comment:${++sequence}`,
    repository, kind: 'comment', issueNumber, issueId: issueNumber * 100, issueState: 'open', title: 'Shared discussion', actor: user, text: message, createdAt: at, updatedAt: at }); };

  const first = runtime.receiveGitHubEvent(event('/js-superagent First change')); await runtime.runNext();
  const second = runtime.receiveGitHubEvent(event('/js-superagent Another independent change', 8)); await runtime.runNext();
  assert.equal(runtime.list().length, 2);
  // Seed the same owning subscription state as two accepted tasks sharing one
  // discussion. Intake, both Worker runs, proof persistence and sending are real.
  inspect(store => { const thread = store.threads.get(`github:${repository}#7`);
    thread.subscriptions.push(runtime.getDomainTicket(second.ticketId).id); store.threads.save(thread); });
  question = event('For both changes, is the original newline preserved?');
  assert.equal(runtime.receiveGitHubEvent(question).ticketIds.length, 2);
  await runtime.runNext();
  const replies = () => runtime.notifications().filter(message => message.kind === 'reply' && message.text === text);
  assert.equal(replies().length, 1); assert.equal(replies()[0].status, 'pending');
  const originalProof = inspect(store => store.getMeta(`worker-answer-reply:${replies()[0].id}`));
  await runtime.runNext();
  assert.equal(replies().length, 1); assert.equal(replies()[0].status, 'pending');
  assert.deepEqual(inspect(store => store.getMeta(`worker-answer-reply:${replies()[0].id}`)), originalProof);
  const proofs = inspect(store => store.listMeta('worker-answer:').map(row => row.value));
  assert.equal(proofs.length, 2); assert.ok(proofs.some(proof => proof.reusedFromTicketId === originalProof.ticketId));
  assert.ok(proofs.every(proof => proof.replyId === replies()[0].id));
  assert.equal(posted.filter(comment => comment.body.includes(text)).length, 0);

  await runtime.stop(); runtime.close(); open(); hold = false;
  inspect(store => store.db.prepare("UPDATE effects SET due=0 WHERE kind='worker-answer'").run());
  await runtime.flushNotifications(); await runtime.flushNotifications();
  assert.equal(replies()[0].status, 'sent'); assert.equal(posted.filter(comment => comment.body.includes(text)).length, 1);
  assert.deepEqual(inspect(store => store.getMeta(`worker-answer-reply:${replies()[0].id}`)), originalProof);
  await runtime.stop(); runtime.close(); open(); await runtime.flushNotifications();
  assert.equal(replies()[0].status, 'sent'); assert.equal(posted.filter(comment => comment.body.includes(text)).length, 1);
});

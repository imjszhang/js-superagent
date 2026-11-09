import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';
import { GitHubSyncState } from '../src/runtime/github-sync-state.mjs';
import { GitHubRequestError } from '../src/channels/github-errors.mjs';
import { webhookConfigurationKey, webhookRoute } from '../src/github-webhook-inbox.mjs';

const repository = 'fixture/continuity';
const github = { repository, allowedActors: ['alice'], issues: [1, 2, 3], pollIntervalMs: 1000 };
function issue(number) { return { id: `github:${repository}:issue:${number * 100}`, repository, kind: 'issue', issueNumber: number, issueId: number * 100,
  title: `Task ${number}`, text: `/js-superagent Complete task ${number}`, actor: { login: 'alice', id: '1', type: 'User' }, createdAt: '2026-11-01T00:00:00Z',
  url: `https://github.com/${repository}/issues/${number}`, issueState: 'open' }; }

test('W15 healthy issue progresses while other objects fail; recovery and repository errors remain scoped', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-w15-')), executed = [];
  let failed = true, repositoryError = false;
  const channel = { async poll() {
    return { version: 1, repository, discovery: { complete: true }, events: repositoryError ? [] : [issue(1), ...(!failed ? [issue(2)] : [])],
      objects: repositoryError ? [] : [{ kind: 'issue', number: 1, status: 'ok' }, { kind: 'issue', number: 2, status: failed ? 'failed' : 'ok', error: { category: 'not-found', message: 'Temporary not found' } }, { kind: 'issue', number: 3, status: 'failed', error: { category: 'invalid', message: 'Invalid object' } }],
      errors: repositoryError ? [{ scope: 'repository', error: { category: 'auth', message: 'Authentication unavailable' } }] : [] };
  }, async deliver(message) { return { id: message.id, url: `https://github.com/${repository}/issues/1#issuecomment-1` }; } };
  let runtime = createProjectAgent({ projectRoot: root, github, githubChannel: channel, driver: { async run(input) { executed.push(input.ticket.id); return { status: 'completed', summary: 'Done' }; } } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  runtime.receiveGitHubEvent(issue(2));
  await runtime.syncGitHub();
  assert.equal(runtime.githubStatus().synchronization.state, 'degraded');
  assert.equal(runtime.githubStatus().lastError, null);
  await runtime.runNext();
  const a = runtime.list().find(row => row.text.includes('Task 1'));
  const b = runtime.list().find(row => row.text.includes('Task 2'));
  assert.equal(runtime.get(a.id).status, 'completed');
  assert.equal(runtime.get(b.id).status, 'queued');
  assert.equal(executed.length, 1);
  runtime.close();
  runtime = createProjectAgent({ projectRoot: root, github, githubChannel: channel, driver: { async run(input) { executed.push(input.ticket.id); return { status: 'completed', summary: 'Recovered B' }; } } }).init();
  failed = false; repositoryError = true;
  assert.equal(await runtime.runNext(), null); assert.equal(executed.length, 1);
  repositoryError = false;
  await runtime.syncGitHub();
  const store = new Store(join(stateDir(root), 'state.sqlite')); store.db.exec('UPDATE effects SET due=0'); store.close();
  await runtime.runNext();
  assert.equal(runtime.list().length, 2); assert.equal(runtime.get(b.id).status, 'completed'); assert.equal(executed.length, 2);
});

test('W15 webhook scopes and observation freshness do not clear a failed neighbour', t => {
  const root = mkdtempSync(join(tmpdir(), 'js-w15-state-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let clock = Date.parse('2026-11-02T00:00:00Z');
  const state = new GitHubSyncState(store, github, { now: () => clock });
  const envelope = number => ({ configurationKey: webhookConfigurationKey(github), receivedAt: new Date(clock).toISOString(), selector: { kind: 'issue', number } });
  const first = envelope(1), second = envelope(2);
  state.save({ discovery: { complete: true }, errors: [], objects: [{ kind: 'issue', number: 1, status: 'ok' }, { kind: 'issue', number: 2, status: 'failed', error: { category: 'not-found' } }] });
  assert.equal(state.reconciled(first, []), true); assert.equal(state.reconciled(second, []), false);
  clock += 31000; assert.equal(state.blocked([{ kind: 'issue', number: 1 }]), true);
  for (const event of ['issue_comment', 'pull_request_review_comment']) {
    const routed = webhookRoute({ event, payload: { action: 'edited', repository: { full_name: repository },
      issue: { number: 1 }, pull_request: { number: 9 } } }, github, [{ repository, number: 9 }]);
    assert.equal(routed.accepted, true); assert.equal(routed.selector.kind, event === 'issue_comment' ? 'issue' : 'pull');
  }
  state.save({ discovery: { complete: true }, objects: [], errors: [{ scope: 'repository', error: { category: 'auth', message: 'Authentication unavailable' } }] });
  state.save({ discovery: { complete: true }, objects: [], errors: [], repositoryVerified: false });
  assert.equal(state.globalBlocked(), true, 'Skipping failed objects is not evidence of authentication recovery');
  state.save({ discovery: { complete: true }, objects: [{ kind: 'issue', number: 1, status: 'ok' }], errors: [] });
  assert.equal(state.globalBlocked(), false);
});

test('W15 discovery authentication failure blocks cached work and public-ticket receipts revalidate their mandate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-w15-auth-')); let failed = true, runs = 0;
  const denied = [], sent = [], channel = {
    async poll() { return [issue(1)]; },
    async deliver(message, context) {
      try { await context.authorizeSend(); } catch (error) { denied.push(error.message); throw error; }
      sent.push(message.id); return { id: message.id, url: `https://github.com/${repository}/issues/1#issuecomment-1` };
    },
  };
  const runtime = createProjectAgent({ projectRoot: root, githubChannel: channel,
    repositoryRequest: async () => { if (failed) throw new GitHubRequestError(401); return { full_name: repository, default_branch: 'main' }; },
    driver: { async run() { runs++; return { status: 'completed', summary: 'Done' }; } } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  runtime.configure({ github });
  runtime.configureRepositorySource({ enabled: true }, { expectedRevision: 0 });
  assert.equal(await runtime.runNext(), null); assert.equal(runs, 0);
  assert.equal(runtime.sourceStatus()[0].error[0].repositoryFailure, true);
  assert.equal(runtime.githubStatus().synchronization.state, 'unavailable');
  assert.equal(runtime.githubStatus().synchronization.errors.at(-1).error.category, 'auth');
  assert.ok(runtime.githubStatus().lastError);
  const store = new Store(join(stateDir(root), 'state.sqlite'));
  try {
    failed = false;
    const stateKey = `source:github-repository:${repository.replace('/', ':')}:state`;
    store.setMeta(stateKey, { ...store.getMeta(stateKey), lastAttempt: null });
    store.db.exec('UPDATE effects SET due=0');
    const ticket = await runtime.runNext(); assert.equal(ticket.status, 'completed'); assert.equal(runs, 1);
    assert.equal(runtime.githubStatus().synchronization.state, 'ready');
    runtime.configure({ github: { ...github, allowedActors: ['bob'] } });
    await runtime.syncGitHub();
    const message = { id: 'public-ticket-revoked', ticketId: ticket.id, kind: 'reply', text: 'Do not send after revocation',
      channel: { source: 'github', thread: `${repository}#1`, address: { repository, issueNumber: '1' } } };
    store.db.prepare('INSERT INTO receipts(id,data,status) VALUES(?,?,?)').run(message.id, JSON.stringify(message), 'pending');
    store.db.prepare("INSERT INTO effects(kind,key,payload,due) VALUES('reply',?,'{}',0)").run(message.id);
    await runtime.flushNotifications();
    assert.equal(sent.includes(message.id), false); assert.ok(denied.includes('GitHub reply authorization changed'));
    assert.equal(runtime.notifications().find(item => item.id === message.id).status, 'pending');
  } finally { store.close(); }
});

test('W16 per-discussion ordering, bounded bypass and permanent settlement preserve receipts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-w16-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let time = 0; const effects = new Effects(store, { now: () => time, retryMs: 1 });
  const delivered = [], outbox = new Outbox(store, effects, { deliver: async message => {
    delivered.push(message.id);
    if (message.id === 'a') throw new Error('Temporary failure');
    if (message.id === 'gone') return { status: 'gone', reason: 'locked' };
    return { id: message.id, url: `https://github.com/${repository}/issues/1` };
  } });
  const send = (id, ticketId = 't1') => outbox.send({ id, ticketId, kind: 'reply', text: id, channel: { source: 'github', thread: 'one', address: {} } });
  store.setMeta('public:domain-t1', 't1');
  send('a', 'domain-t1'); send('b'); send('other', 't2'); send('gone', 't3');
  const handlers = { reply: (payload, id) => outbox.deliver(payload, id) };
  for (let i = 0; i < 4; i++) await effects.runNext(handlers);
  assert.deepEqual(delivered, ['a', 'other', 'gone']);
  assert.equal(outbox.status('b'), 'pending'); assert.equal(outbox.status('gone'), 'dropped');
  assert.equal(effects.pending('reply', 'gone'), false);
  time = 1; await effects.runNext(handlers); await effects.runNext(handlers);
  time = 3; await effects.runNext(handlers); await effects.runNext(handlers);
  assert.equal(outbox.status('b'), 'sent');
  assert.deepEqual(outbox.list().find(item => item.id === 'b').ordering.skipped, ['a']);
  assert.equal(outbox.list().find(item => item.id === 'gone').terminal.reason, 'locked');
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/project', secret = 'webhook-runtime-fixture-secret-not-real', head = 'a'.repeat(40);
const options = { timeout: 15_000 };
const actor = { login: 'alice', id: 10, type: 'User' };
function canonicalIssue() {
  return { id: `github:${repository}:issue:700`, repository, issueNumber: 7, issueId: 700,
    kind: 'issue', text: '/js-superagent Fix the canonical pricing task and related feedback', title: 'Canonical task', actor,
    createdAt: '2026-11-01T00:00:00.000Z', url: `https://github.com/${repository}/issues/7`, issueState: 'open' };
}
function payload(rest = {}) {
  return { action: 'opened', repository: { id: 1, full_name: repository, name: 'project', owner: { login: 'fixture' } },
    installation: { id: 55 }, sender: actor,
    issue: { id: 700, number: 7, title: 'Raw title', body: 'UNTRUSTED-WEBHOOK-BODY must never be persisted', state: 'open', user: actor }, ...rest };
}
function envelope(value = payload(), event = 'issues', deliveryId = randomUUID()) {
  const body = Buffer.from(JSON.stringify(value));
  return { body, headers: { 'x-github-event': event, 'x-github-delivery': deliveryId,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, { events = [canonicalIssue()], app = true, ci } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-webhook-runtime-'))), runtimes = new Set();
  const secretPath = join(root, 'secret.txt'); writeFileSync(secretPath, secret, { mode: 0o600 });
  const config = { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 86_400_000,
    webhook: { secretPath, port: 0 }, ...(app ? { app: { appId: '123', installationId: 55, privateKeyPath: join(root, 'unused-key.pem') } } : {}), ...(ci ? { ci } : {}) };
  const calls = [], sent = new Map(); let initialized = false, failure = false, barrier;
  const channel = {
    async poll(input) { calls.push(structuredClone(input)); if (barrier) { barrier.entered.resolve(); await barrier.release.promise; }
      if (failure) throw new Error('Canonical GitHub is temporarily unavailable'); return structuredClone(events); },
    async getPullRequest(number) { return { repository, number, id: 900, headSha: head, headRef: 'codex/fixture', headRepository: repository,
      state: 'open', merged: false, url: `https://github.com/${repository}/pull/${number}`, title: 'Pricing changes' }; },
    async deliver(message) { if (!sent.has(message.id)) sent.set(message.id, structuredClone(message));
      return { id: String(1000 + [...sent.keys()].indexOf(message.id)), url: `https://github.com/${repository}/issues/7#issuecomment-${1000 + [...sent.keys()].indexOf(message.id)}` }; },
  };
  t.after(async () => { for (const runtime of runtimes) { await runtime.stop(); runtime.close(); } rmSync(root, { recursive: true, force: true }); });
  const inspect = callback => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return callback(store); } finally { store.close(); } };
  return { root, config, calls, sent, events, inspect,
    fail(value) { failure = value; }, hold(value) { barrier = value; },
    makeDue() { inspect(store => store.db.exec('UPDATE effects SET due = 0')); },
    close(runtime) { runtime.close(); runtimes.delete(runtime); },
    open(driver = { async run() { return { status: 'completed', summary: 'Verified canonical task' }; } }) {
      const runtime = createProjectAgent({ projectRoot: root, githubChannel: channel, driver }).init(); runtimes.add(runtime);
      if (!initialized) { runtime.configure({ github: config }); initialized = true; }
      return runtime;
    },
  };
}

test('signed webhook acknowledgment persists selectors without network, model, raw payload or secrets', options, async t => {
  const f = fixture(t); let runs = 0;
  const runtime = f.open({ async run() { runs++; return { status: 'completed', summary: 'Verified' }; } });
  const input = envelope(), result = runtime.receiveGitHubWebhook(input);
  assert.equal(result.status, 'accepted'); assert.equal(result.deliveryId, input.headers['x-github-delivery']);
  assert.equal(typeof result.then, 'undefined'); assert.equal(f.calls.length, 0); assert.equal(runs, 0); assert.equal(runtime.list().length, 0);
  assert.equal(runtime.githubWebhookStatus().pending, 1);
  const saved = f.inspect(store => JSON.stringify({ entries: store.listMeta('github:webhook:'), effects: store.db.prepare('SELECT * FROM effects').all() }));
  assert.doesNotMatch(saved, /UNTRUSTED-WEBHOOK-BODY/); assert.ok(!saved.includes(secret)); assert.ok(!saved.includes(input.headers['x-hub-signature-256']));
  assert.equal((await runtime.processGitHubWebhooks()).processed, 1); assert.equal(f.calls.length, 1);
  assert.match(runtime.list()[0].text, /canonical pricing/); assert.doesNotMatch(runtime.list()[0].text, /UNTRUSTED/);
  assert.equal(runs, 0); assert.equal((await runtime.runNext()).status, 'completed'); assert.equal(runs, 1);
});

test('redelivery deduplicates receipt identity while a burst reconciles canonical events once', options, async t => {
  const f = fixture(t), runtime = f.open(), first = envelope();
  assert.equal(runtime.receiveGitHubWebhook(first).status, 'accepted');
  assert.equal(runtime.receiveGitHubWebhook(first).status, 'duplicate');
  assert.equal(runtime.receiveGitHubWebhook(envelope()).status, 'accepted');
  assert.equal(runtime.githubWebhookStatus().pending, 2);
  const processed = await runtime.processGitHubWebhooks(); assert.equal(processed.processed, 2); assert.equal(f.calls.length, 1);
  assert.equal(runtime.list().length, 1); assert.equal(runtime.list()[0].messages.length, 1);
  assert.equal(runtime.receiveGitHubWebhook(first).status, 'duplicate');
  await runtime.syncGitHub(); assert.equal(runtime.list().length, 1); assert.equal(runtime.list()[0].messages.length, 1);
  assert.equal(runtime.githubWebhookStatus().processed, 2);
});

test('signature failures, malformed JSON and delivery identity conflicts cannot alter queued work', options, async t => {
  const f = fixture(t), runtime = f.open(), first = envelope();
  const tampered = { ...first, body: Buffer.from('tampered bytes') };
  assert.throws(() => runtime.receiveGitHubWebhook(tampered), error => error.statusCode === 401);
  const invalidBody = Buffer.from('not json');
  assert.throws(() => runtime.receiveGitHubWebhook({ body: invalidBody, headers: { ...first.headers,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(invalidBody).digest('hex')}` } }), error => error.statusCode === 400);
  assert.equal(runtime.githubWebhookStatus().pending, 0);
  runtime.receiveGitHubWebhook(first);
  assert.throws(() => runtime.receiveGitHubWebhook(envelope(payload({ action: 'closed' }), 'issues', first.headers['x-github-delivery'])), error => error.statusCode === 409);
  assert.throws(() => runtime.receiveGitHubWebhook({ ...first, headers: { ...first.headers, 'x-github-event': 'issue_comment' } }), error => error.statusCode === 409);
  assert.equal(runtime.githubWebhookStatus().pending, 1); assert.equal(f.calls.length, 0);
});

test('repository, installation, action and source selectors reject unrelated deliveries', options, async t => {
  const f = fixture(t), runtime = f.open();
  const inputs = [
    envelope(payload({ repository: { id: 2, full_name: 'other/project' } })),
    envelope(payload({ installation: { id: 99 } })),
    envelope(payload({ installation: undefined })),
    envelope(payload({ issue: { id: 800, number: 8 } })),
    envelope(payload({ action: 'edited' })),
    envelope(payload(), 'release'),
    envelope({ zen: 'Keep the endpoint small' }, 'ping'),
  ];
  for (const input of inputs) assert.equal(runtime.receiveGitHubWebhook(input).status, 'ignored');
  assert.equal(runtime.githubWebhookStatus().pending, 0); assert.equal((await runtime.processGitHubWebhooks()).processed, 0);
  assert.equal(f.calls.length, 0); assert.equal(runtime.list().length, 0);
});

test('native gh polling remains available with a repository webhook and no App configuration', options, async t => {
  const f = fixture(t, { app: false }), runtime = f.open();
  assert.equal(runtime.receiveGitHubWebhook(envelope(payload({ installation: undefined }))).status, 'accepted');
  assert.equal((await runtime.processGitHubWebhooks()).processed, 1); assert.equal(runtime.list().length, 1);
  assert.equal((await runtime.runNext()).status, 'completed');
  await runtime.syncGitHub(); assert.equal(runtime.list().length, 1);
});

test('acknowledged deliveries survive closing and reopening before reconciliation', options, async t => {
  const f = fixture(t); let runtime = f.open(); const input = envelope();
  runtime.receiveGitHubWebhook(input); f.close(runtime);
  runtime = f.open(); assert.equal(runtime.githubWebhookStatus().pending, 1);
  assert.equal(runtime.receiveGitHubWebhook(input).status, 'duplicate');
  assert.equal((await runtime.processGitHubWebhooks()).processed, 1);
  assert.equal(runtime.list().length, 1); assert.equal(runtime.githubWebhookStatus().pending, 0);
});

test('receipt and reconciliation queue insertion roll back together on a storage failure', options, async t => {
  const f = fixture(t), runtime = f.open(), input = envelope();
  f.inspect(store => store.db.exec("CREATE TRIGGER reject_webhook_queue BEFORE INSERT ON effects WHEN NEW.kind = 'github-webhook' BEGIN SELECT RAISE(ABORT, 'queue persistence fault'); END"));
  assert.throws(() => runtime.receiveGitHubWebhook(input));
  assert.equal(runtime.githubWebhookStatus().pending, 0);
  assert.equal(f.inspect(store => store.listMeta('github:webhook:').length), 0);
  f.inspect(store => store.db.exec('DROP TRIGGER reject_webhook_queue'));
  assert.equal(runtime.receiveGitHubWebhook(input).status, 'accepted');
  assert.equal((await runtime.processGitHubWebhooks()).processed, 1);
});

test('canonical network failures retain acknowledged work, retry without replay and allow local tasks', options, async t => {
  const f = fixture(t), seen = [];
  const runtime = f.open({ async run(input) { seen.push(input.ticket.text); return { status: 'completed', summary: 'Verified' }; } });
  f.fail(true); runtime.receiveGitHubWebhook(envelope());
  assert.equal((await runtime.processGitHubWebhooks()).processed, 0); assert.equal(runtime.githubWebhookStatus().pending, 1);
  assert.ok(runtime.githubWebhookStatus().lastError);
  const local = runtime.submit({ text: 'Do the explicitly local task' });
  assert.equal((await runtime.runNext()).id, local.id); assert.equal(seen.length, 1);
  f.fail(false); f.makeDue(); assert.equal((await runtime.processGitHubWebhooks()).processed, 1);
  const remote = await runtime.runNext(); assert.notEqual(remote.id, local.id); assert.equal(seen.length, 2);
  assert.equal(await runtime.runNext(), null); assert.equal(seen.length, 2);
});

test('configuration changes cannot reinterpret pending deliveries as authorization for a different source', options, async t => {
  const f = fixture(t), runtime = f.open();
  runtime.receiveGitHubWebhook(envelope()); runtime.configure({ github: { repository: 'other/project' } });
  const result = await runtime.processGitHubWebhooks(); assert.equal(result.processed, 0); assert.equal(result.ignored, 1);
  assert.equal(f.calls.length, 0); assert.equal(runtime.list().length, 0); assert.equal(runtime.githubWebhookStatus().pending, 0);
});

test('two runtimes cannot process the same claimed delivery batch concurrently', options, async t => {
  const f = fixture(t), runtime = f.open(), peer = f.open(), barrier = { entered: deferred(), release: deferred() };
  runtime.receiveGitHubWebhook(envelope()); f.hold(barrier);
  const work = runtime.processGitHubWebhooks(); await barrier.entered.promise;
  const other = await peer.processGitHubWebhooks(); assert.equal(other.processed, 0); assert.equal(f.calls.length, 1);
  barrier.release.resolve(); assert.equal((await work).processed, 1);
  assert.equal(peer.githubWebhookStatus().pending, 0); assert.equal(peer.list().length, 1);
});

test('a delivery arriving during reconciliation is retained for the next generation', options, async t => {
  const f = fixture(t), runtime = f.open(), barrier = { entered: deferred(), release: deferred() };
  runtime.receiveGitHubWebhook(envelope()); f.hold(barrier);
  const work = runtime.processGitHubWebhooks(); await barrier.entered.promise;
  const next = envelope(); assert.equal(runtime.receiveGitHubWebhook(next).status, 'accepted');
  barrier.release.resolve(); await work; f.hold(undefined);
  await runtime.processGitHubWebhooks(); assert.equal(runtime.githubWebhookStatus().pending, 0);
  assert.equal(runtime.githubWebhookStatus().processed, 2); assert.equal(runtime.list().length, 1);
});

test('stop waits for in-flight reconciliation and preserves deliveries not committed before shutdown', options, async t => {
  const f = fixture(t), runtime = f.open(), barrier = { entered: deferred(), release: deferred() };
  runtime.receiveGitHubWebhook(envelope()); f.hold(barrier);
  const work = runtime.processGitHubWebhooks(); await barrier.entered.promise;
  let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
  assert.throws(() => runtime.receiveGitHubWebhook(envelope()), error => error.statusCode === 503);
  assert.throws(() => runtime.close()); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  barrier.release.resolve(); await work; await stopping; f.hold(undefined);
  assert.equal(runtime.list().length, 0); assert.equal(runtime.githubWebhookStatus().pending, 1);
  f.makeDue(); assert.equal((await runtime.processGitHubWebhooks()).processed, 1); assert.equal(runtime.list().length, 1);
});

test('installation changes request fresh canonical validation without trusting their raw repository contents', options, async t => {
  const f = fixture(t, { events: [] }), runtime = f.open();
  const input = envelope({ action: 'deleted', installation: { id: 55 }, sender: actor }, 'installation');
  assert.equal(runtime.receiveGitHubWebhook(input).status, 'accepted');
  assert.equal((await runtime.processGitHubWebhooks()).processed, 1); assert.equal(f.calls.length, 1); assert.equal(runtime.list().length, 0);
  const changed = envelope({ action: 'removed', installation: { id: 55 }, sender: actor,
    repositories_removed: [{ id: 1, full_name: repository }] }, 'installation_repositories');
  assert.equal(runtime.receiveGitHubWebhook(changed).status, 'accepted');
});

test('PR review webhook selects only an explicitly linked PR and canonical feedback resumes the original ticket', options, async t => {
  const f = fixture(t), runtime = f.open(); await runtime.syncGitHub(); const ticket = runtime.list()[0]; await runtime.runNext();
  const reviewPayload = payload({ action: 'submitted', issue: undefined,
    pull_request: { id: 900, number: 9, state: 'open', head: { sha: head, repo: { full_name: repository } }, base: { repo: { full_name: repository } } },
    review: { id: 901, state: 'commented', commit_id: head, body: 'untrusted review copy', user: actor } });
  assert.equal(runtime.receiveGitHubWebhook(envelope(reviewPayload, 'pull_request_review')).status, 'ignored');
  await runtime.linkGitHubPullRequest(ticket.id, { number: 9 });
  assert.equal(runtime.receiveGitHubWebhook(envelope(reviewPayload, 'pull_request_review')).status, 'accepted');
  f.events.push({ id: `github:${repository}:review:901`, repository, kind: 'review', pullNumber: 9, headSha: head, pullState: 'open',
    actor, createdAt: '2026-11-01T00:01:00.000Z', text: 'Canonical PR review: add the regression', url: `https://github.com/${repository}/pull/9`, state: 'COMMENTED', commitId: head });
  await runtime.processGitHubWebhooks(); const result = await runtime.runNext();
  assert.equal(result.id, ticket.id); assert.equal(runtime.list().length, 1); assert.match(result.messages.at(-1).text, /Canonical PR review/);
  assert.doesNotMatch(result.messages.at(-1).text, /untrusted review copy/);
});

test('configured credential files inside a source project are excluded from copied execution workspaces', options, async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'unused-key.pem'), 'fixture-private-key-material'); let called = false;
  const runtime = f.open({ async run(input) {
    called = true; assert.notEqual(input.projectRoot, f.root);
    assert.equal(existsSync(join(input.projectRoot, 'secret.txt')), false);
    assert.equal(existsSync(join(input.projectRoot, 'unused-key.pem')), false);
    return { status: 'completed', summary: 'Workspace credential exclusions verified' };
  } });
  runtime.configure({ workspace: { mode: 'copy' } }); runtime.receiveGitHubWebhook(envelope());
  await runtime.processGitHubWebhooks(); assert.equal((await runtime.runNext()).status, 'completed'); assert.equal(called, true);
  assert.equal(existsSync(join(f.root, 'secret.txt')), true); assert.equal(existsSync(join(f.root, 'unused-key.pem')), true);
});

test('a reused workspace containing a newly configured credential path cannot be handed back to a worker', options, async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'next-secret.txt'), 'ordinary fixture text before credential configuration'); let calls = 0;
  const runtime = f.open({ async run() { calls++; return { status: 'completed', summary: 'Verified' }; } });
  runtime.configure({ workspace: { mode: 'copy' } }); runtime.receiveGitHubWebhook(envelope()); await runtime.processGitHubWebhooks();
  const first = await runtime.runNext(); assert.equal(first.status, 'completed');
  assert.equal(existsSync(join(runtime.getWorkspace(first.id).path, 'next-secret.txt')), true);
  writeFileSync(join(f.root, 'next-secret.txt'), secret);
  runtime.configure({ github: { webhook: { secretPath: join(f.root, 'next-secret.txt'), port: 0 } } });
  runtime.reply(first.id, 'Verify the related edge case after checking the workspace');
  await runtime.syncGitHub();
  const store = new Store(join(stateDir(f.root), 'state.sqlite')); try { store.db.exec('UPDATE effects SET due = 0'); } finally { store.close(); }
  const next = await runtime.runNext(); assert.equal(next.status, 'failed'); assert.equal(calls, 1);
  assert.match(next.reports.at(-1).summary, /credential|secret/i);
});

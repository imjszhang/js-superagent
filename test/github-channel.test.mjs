import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubChannel, isGitHubReceipt } from '../src/channels/github.mjs';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';

const options = { repository: 'Owner/Repo', allowedActors: ['Operator'] };
const user = { login: 'Operator', id: 42, type: 'User' };
function issue(n = 1, rest = {}) {
  return { id: n + 1000, number: n, title: `Task ${n}`, body: '/js-superagent fix this', user,
    html_url: `https://github.com/owner/repo/issues/${n}`, created_at: '2026-11-01T00:00:00Z', state: 'open', ...rest };
}
function comment(id, rest = {}) {
  return { id, body: `reply ${id}`, user, html_url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`,
    created_at: '2026-11-01T00:01:00Z', ...rest };
}
function message(rest = {}) {
  return { id: 'message-1', ticketId: 'ticket-1', kind: 'reply', text: 'Verified the code',
    channel: { source: 'github', thread: 'owner/repo#1', address: { repository: 'owner/repo', issueNumber: '1' } }, ...rest };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-github-channel-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('poll normalizes native identity and completes pagination without treating PRs as issues', async () => {
  const calls = [];
  const firstComments = Array.from({ length: 100 }, (_, index) => comment(index + 1));
  const channel = createGitHubChannel(options, { request: async endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('/issues?')) return [issue(), issue(2, { pull_request: { url: 'pull' } })];
    if (endpoint.includes('/comments?')) return endpoint.endsWith('page=1') ? firstComments : [comment(101)];
    throw new Error(`unexpected ${endpoint}`);
  } });
  const { events } = await channel.poll();
  assert.equal(events.length, 102);
  assert.equal(events[0].id, 'github:owner/repo:issue:1001');
  assert.deepEqual(events[0].actor, { login: 'operator', id: '42', type: 'User' });
  assert.equal(events.at(-1).id, 'github:owner/repo:comment:101');
  assert.equal(events.at(-1).createdAt, '2026-11-01T00:01:00.000Z');
  assert.equal(calls.some(value => value.includes('/issues/2')), false);
  assert.equal(calls.some(value => value.endsWith('page=2')), true);
});

test('configured issue boundary excludes unrelated tracked issues and includes closed snapshots', async () => {
  const calls = [];
  const channel = createGitHubChannel({ ...options, issues: [1] }, { request: async endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('/comments?')) return [];
    return issue(1, { state: 'closed' });
  } });
  const { events } = await channel.poll({ trackedIssues: [1, 99] });
  assert.equal(events.length, 1);
  assert.equal(events[0].issueState, 'closed');
  assert.equal(calls.some(value => value.includes('/99')), false);
  assert.equal(calls.some(value => value.includes('/issues?')), false);
});

test('poll isolates object pagination/resource failures and preserves immutable event IDs across edits', async () => {
  let edited = false;
  const channel = createGitHubChannel({ ...options, issues: [1] }, { request: async endpoint =>
    endpoint.includes('/comments?') ? [comment(1, { body: edited ? 'edited reply' : 'original reply' })] : issue() });
  const { events: original } = await channel.poll(); edited = true; const { events: after } = await channel.poll();
  assert.deepEqual(original.map(x => x.id), after.map(x => x.id));
  assert.notEqual(original[1].text, after[1].text);
  const broken = createGitHubChannel({ ...options, issues: [1] }, { request: async endpoint => {
    if (!endpoint.includes('/comments?')) return issue();
    if (endpoint.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => comment(i + 1));
    throw new Error('network gone');
  } });
  assert.equal((await broken.poll()).objects[0].status, 'failed');
  const wrong = createGitHubChannel({ ...options, issues: [1] }, { request: async () => issue(1, { html_url: 'https://example.com/issues/1' }) });
  assert.equal((await wrong.poll()).objects[0].error.category, 'invalid');
});

test('POST response loss is reconciled by stable marker and authenticated author on retry', async () => {
  const comments = []; let posts = 0;
  const channel = createGitHubChannel(options, { request: async (endpoint, init) => {
    if (endpoint === '/user') return user;
    if (init.method === 'GET') return comments;
    posts++;
    comments.push(comment(7, { body: init.body.body }));
    throw new Error('connection lost after server accepted');
  } });
  await assert.rejects(channel.deliver(message(), { projectId: 'project-1' }), /connection lost/);
  const delivered = await channel.deliver(message(), { projectId: 'project-1' });
  assert.deepEqual(delivered, { id: '7', url: 'https://github.com/owner/repo/issues/1#issuecomment-7' });
  assert.equal(posts, 1);
  assert.equal(isGitHubReceipt(comments[0].body, 'project-1'), true);
  assert.equal(isGitHubReceipt(comments[0].body, 'project-2'), false);
  assert.equal(isGitHubReceipt(comments[0].body), true, 'Other project receipts cannot become cross-instance feedback loops');
});

test('another author cannot spoof receipt reconciliation; delivery redacts local project paths', async () => {
  const comments = [comment(8, { user: { ...user, id: 88 }, body: '<!-- js-superagent:project-1:message-1 -->' })];
  let body;
  const channel = createGitHubChannel(options, { request: async (endpoint, init) => {
    if (endpoint === '/user') return user;
    if (init.method === 'GET') return comments;
    body = init.body.body; return comment(9, { body });
  } });
  const receipt = await channel.deliver(message({ text: 'Checked /private/test-project/file.py' }), { projectId: 'project-1', sourceProjectRoot: '/private/test-project' });
  assert.equal(receipt.id, '9');
  assert.match(body, /\[project\]\/file.py/);
  assert.doesNotMatch(body, /private\/test-project/);
  assert.match(body, /Ticket: `ticket-1`/);
});

test('delivery rejects unconfigured targets, unsafe identities and oversized text before API calls', async () => {
  let calls = 0;
  const channel = createGitHubChannel({ ...options, issues: [1] }, { request: async () => { calls++; return user; } });
  await assert.rejects(channel.deliver(message({ channel: { source: 'github', thread: 'owner/repo#2', address: { repository: 'owner/repo', issueNumber: '2' } } }), { projectId: 'project' }), /outside/);
  await assert.rejects(channel.deliver(message(), { projectId: 'project--><script>' }), /identity/);
  await assert.rejects(channel.deliver(message({ text: 'x'.repeat(61 * 1024) }), { projectId: 'project' }), /60 KiB/);
  assert.equal(calls, 0);
  assert.throws(() => createGitHubChannel({ ...options, repository: 'owner/repo/escape' }), /owner\/repo/);
  assert.throws(() => createGitHubChannel({ ...options, allowedActors: [] }), /allowedActors/);
  assert.throws(() => createGitHubChannel({ ...options, issues: [-1] }), /positive/);
});

test('native gh invocation pins hostname/API version, sends JSON on stdin, and redacts error output', async t => {
  const root = fixture(t), executable = join(root, 'fake-gh.mjs'), recorded = join(root, 'record.jsonl');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2); let input=''; for await(const chunk of process.stdin) input+=chunk;
appendFileSync(${JSON.stringify(recorded)},JSON.stringify({args,input})+'\\n');
const endpoint=args.find(x=>x.startsWith('/'));
if(endpoint==='/user') console.log(JSON.stringify(${JSON.stringify(user)}));
else if(endpoint.includes('comments?')) console.log('[]');
else if(endpoint.endsWith('/comments')) console.log(JSON.stringify(${JSON.stringify(comment(10))}));
else { console.error('private-account-secret Authorization secret (HTTP 403)');process.exitCode=1; }
`, { mode: 0o700 });
  const channel = createGitHubChannel({ ...options, executable, issues: [1] });
  const delivered = await channel.deliver(message(), { projectId: 'project' });
  assert.equal(delivered.id, '10');
  const calls = readFileSync(recorded, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(call => call.args.includes('github.com') && call.args.includes('X-GitHub-Api-Version: 2026-03-10')));
  const post = calls.find(call => call.args.includes('POST'));
  assert.ok(post.args.includes('--input')); assert.match(JSON.parse(post.input).body, /Verified the code/);
  const failed = (await channel.poll()).objects[0].error;
  assert.equal(failed.statusCode, 403); assert.doesNotMatch(failed.message, /private|secret|Authorization/);
});

test('external outbox sends outside transactions and retains pending receipt after failure', async t => {
  const root = fixture(t), store = new Store(join(root, 'state.sqlite'));
  t.after(() => store.close());
  let time = 0, calls = 0;
  const effects = new Effects(store, { now: () => time, retryMs: 1 });
  const outbox = new Outbox(store, effects, { deliver: async () => {
    assert.equal(store.inTransaction, false); calls++;
    if (calls === 1) throw new Error('offline');
    return { id: '10', url: 'https://github.com/owner/repo/issues/1#issuecomment-10' };
  } });
  outbox.send(message());
  await effects.runNext({ reply: (payload, id) => outbox.deliver(payload, id) });
  assert.equal(outbox.status('message-1'), 'pending'); assert.equal(effects.list()[0].attempts, 1);
  time = 1; await effects.runNext({ reply: (payload, id) => outbox.deliver(payload, id) });
  assert.equal(outbox.status('message-1'), 'sent'); assert.equal(outbox.list()[0].delivery.id, '10');
  assert.equal(effects.pending('reply'), false);
});

test('outbox withdrawal race preserves remote delivery fact without changing dropped status', async t => {
  const root = fixture(t), store = new Store(join(root, 'state.sqlite')); t.after(() => store.close());
  const effects = new Effects(store); let resolve;
  const outbox = new Outbox(store, effects, { deliver: () => new Promise(done => { resolve = done; }) });
  outbox.send(message());
  const active = effects.runNext({ reply: (payload, id) => outbox.deliver(payload, id) });
  outbox.withdraw('message-1'); resolve({ id: '11', url: 'https://github.com/owner/repo/issues/1#issuecomment-11' });
  await active;
  assert.equal(outbox.status('message-1'), 'dropped');
  assert.equal(outbox.list()[0].delivery.id, '11');
  assert.equal(effects.pending('reply'), false);
});

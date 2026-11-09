import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareWorkspace } from '../src/workspaces.mjs';
import { runVerification } from '../src/verification.mjs';
import { createDeliveryService, createGitHubDeliveryTransport } from '../src/delivery.mjs';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture(t, { sparse = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'other.js'), 'untouched');
  if (sparse) { mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside', 'keep.txt'), 'must remain committed, absent from sparse worktree'); mkdirSync(join(root, 'selected')); writeFileSync(join(root, 'selected', 'keep.txt'), 'selected'); }
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  if (sparse) git(root, 'sparse-checkout', 'set', '--cone', 'selected');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const workspace = prepareWorkspace({ projectRoot: root, ticketId: 'deliver', config: { mode: 'worktree' }, persist() {} });
  writeFileSync(join(workspace.path, 'source.js'), 'export const value = 2;\n');
  const verification = await verify(root, workspace);
  const remote = join(root, 'bare.git'); mkdirSync(remote); git(remote, 'init', '--bare');
  const journal = new Map(), pulls = []; let saves, pushCount = 0, postCount = 0, afterPush, afterPost;
  const transport = {
    repository: 'test/project',
    async readHead(branch) {
      const result = spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    async push({ cwd, branch, commitSha, expectedHead }) {
      assert.equal(await this.readHead(branch), expectedHead);
      git(cwd, 'push', remote, `${commitSha}:refs/heads/${branch}`); pushCount++;
      for (const pull of pulls) pull.head.sha = commitSha;
      afterPush?.();
    },
    async request(endpoint, options = {}) {
      if (/\/pulls\/\d+$/.test(endpoint)) {
        const pull = pulls.find(pull => endpoint.endsWith(`/${pull.number}`));
        if (options.method === 'PATCH') Object.assign(pull, options.body);
        return structuredClone(pull);
      }
      if (options.method !== 'POST') return structuredClone(pulls);
      postCount++;
      const pull = { number: 1, html_url: 'https://github.com/test/project/pull/1', state: 'open', draft: true,
        title: options.body.title, body: options.body.body, head: { sha: await this.readHead(options.body.head), ref: options.body.head, repo: { full_name: 'test/project' } },
        base: { ref: 'main', repo: { full_name: 'test/project' } } };
      pulls.push(pull); afterPost?.(); return structuredClone(pull);
    },
  };
  const service = createDeliveryService({ projectRoot: root, projectId: 'project-1', load: key => structuredClone(journal.get(key)),
    save(key, value) { saves?.(key, value); journal.set(key, structuredClone(value)); }, withLock: async (_key, work) => work(), transport });
  const input = { workspace, verification, runId: 'run-1', mode: 'draft-pr', repository: 'test/project', base: 'main', title: 'Update value', body: 'Verified source update', allowedPaths: ['source.js'] };
  return { root, workspace, verification, remote, journal, pulls, transport, service, input, baseCommit,
    counts: () => ({ pushCount, postCount }), fault: value => saves = value, afterPush: value => afterPush = value, afterPost: value => afterPost = value };
}
function verify(root, workspace) { return runVerification({ projectRoot: root, workspace, profile: { id: 'syntax', version: '1', command: process.execPath, args: ['--check', 'source.js'], environment: 'host', allowHostExecution: true }, persist() {} }); }

async function stalePullFixture(t) {
  const f = await fixture(t), first = await f.service.deliver(f.input);
  writeFileSync(join(f.workspace.path, 'source.js'), 'export const value = 3;\n');
  const nextInput = { ...f.input, runId: 'run-2', verification: await verify(f.root, f.workspace), title: 'Address review' };
  f.afterPush(() => { f.pulls[0].head.sha = first.commitSha; });
  return { ...f, first, nextInput };
}

test('local delivery is the default and does not create commits or require credentials', async t => {
  const f = await fixture(t);
  const result = await f.service.deliver({ workspace: f.workspace });
  assert.equal(result.status, 'local'); assert.equal(result.changes.length, 1);
  assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.deepEqual(f.counts(), { pushCount: 0, postCount: 0 });
});

test('verified owned worktree commits, pushes and creates one draft PR, preserving source index', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'other.js'), 'user staged change'); git(f.root, 'add', 'other.js');
  const staged = git(f.root, 'diff', '--cached');
  const delivered = await f.service.deliver(f.input);
  assert.equal(delivered.state, 'delivered'); assert.equal(delivered.pullRequest.draft, true);
  assert.equal(delivered.pullRequest.headSha, git(f.workspace.path, 'rev-parse', 'HEAD'));
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(git(f.root, 'diff', '--cached'), staged);
  assert.equal(git(f.workspace.path, 'diff', '--cached'), '');
  const again = await f.service.deliver(f.input);
  assert.equal(again.commitSha, delivered.commitSha);
  assert.deepEqual(f.counts(), { pushCount: 1, postCount: 1 });
});

test('commit journal failures and unrecorded successful pushes reconcile without duplicate commits', async t => {
  const f = await fixture(t); let failed = false;
  f.fault((_key, value) => { if (!failed && value.state === 'committed') { failed = true; throw new Error('disk failure after commit'); } });
  await assert.rejects(f.service.deliver(f.input), /disk failure/);
  const committed = git(f.workspace.path, 'rev-parse', 'HEAD'); assert.notEqual(committed, f.baseCommit);
  f.fault(null);
  f.afterPush(() => { f.afterPush(null); throw new Error('connection lost after push'); });
  await assert.rejects(f.service.deliver(f.input), /connection lost/);
  const result = await f.service.deliver(f.input);
  assert.equal(result.commitSha, committed);
  assert.deepEqual(f.counts(), { pushCount: 1, postCount: 1 });
});

test('PR response loss reconciles by saved ownership marker and never creates a second PR', async t => {
  const f = await fixture(t);
  f.afterPost(() => { f.afterPost(null); throw new Error('response lost'); });
  await assert.rejects(f.service.deliver(f.input), /response lost/);
  assert.equal(f.pulls.length, 1);
  const result = await f.service.deliver(f.input);
  assert.equal(result.pullRequest.number, 1); assert.equal(f.counts().postCount, 1);
});

test('subsequent turns update the owned branch and retain the original PR', async t => {
  const f = await fixture(t);
  const first = await f.service.deliver(f.input);
  writeFileSync(join(f.workspace.path, 'source.js'), 'export const value = 3;\n');
  const verification = await verify(f.root, f.workspace);
  const next = await f.service.deliver({ ...f.input, runId: 'run-2', verification, title: 'Address review' });
  assert.notEqual(next.commitSha, first.commitSha);
  assert.equal(next.parentSha, first.commitSha); assert.equal(next.pullRequest.number, first.pullRequest.number);
  assert.deepEqual(f.counts(), { pushCount: 2, postCount: 1 });
});

test('an owned stale PR head is reread by number until the pushed commit becomes visible', async t => {
  const f = await stalePullFixture(t), request = f.transport.request; let reads = 0;
  f.transport.request = async (endpoint, options) => {
    if (endpoint === '/repos/test/project/pulls/1' && await f.transport.readHead(f.workspace.branch) !== f.first.commitSha) {
      assert.ok(options.signal instanceof AbortSignal);
      if (++reads === 2) f.pulls[0].head.sha = await f.transport.readHead(f.workspace.branch);
    }
    return request.call(f.transport, endpoint, options);
  };
  const result = await f.service.deliver(f.nextInput);
  assert.equal(result.state, 'delivered'); assert.ok(reads >= 2);
  assert.equal(result.expectedRemoteHead, f.first.commitSha);
  assert.equal(result.pullRequest.number, f.first.pullRequest.number);
  assert.equal(result.pullRequest.headSha, await f.transport.readHead(f.workspace.branch));
  assert.deepEqual(f.counts(), { pushCount: 2, postCount: 1 });
});

test('PR reconciliation rejects a branch changed during its number lookup even if the PR reports the intended commit', async t => {
  const f = await stalePullFixture(t), request = f.transport.request; let reads = 0;
  f.transport.request = async (endpoint, options) => {
    if (endpoint === '/repos/test/project/pulls/1') {
      reads++; f.pulls[0].head.sha = await f.transport.readHead(f.workspace.branch);
      git(f.remote, 'update-ref', `refs/heads/${f.workspace.branch}`, f.baseCommit);
    }
    return request.call(f.transport, endpoint, options);
  };
  await assert.rejects(f.service.deliver(f.nextInput), /Remote head changed or branch is not owned/);
  assert.equal(reads, 1); assert.deepEqual(f.counts(), { pushCount: 1, postCount: 1 });
  const record = [...f.journal.values()].find(value => value.runId === 'run-2');
  assert.equal(record, undefined);
  assert.equal([...f.journal.values()].find(value => value.headSha)?.headSha, f.first.commitSha);
});

test('unknown PR heads and changed ownership, branch, base, lifecycle or number are never retried', async t => {
  for (const change of ['head', 'marker', 'branch', 'base', 'closed', 'number']) await t.test(change, async t => {
    const f = await stalePullFixture(t), request = f.transport.request; let reads = 0;
    f.transport.request = async (endpoint, options) => {
      const result = await request.call(f.transport, endpoint, options);
      if (endpoint === '/repos/test/project/pulls/1') {
        reads++;
        if (change === 'head') result.head.sha = f.baseCommit;
        if (change === 'marker') result.body = 'Ownership removed';
        if (change === 'branch') result.head.ref = 'another-branch';
        if (change === 'base') result.base.ref = 'another-base';
        if (change === 'closed') result.state = 'closed';
        if (change === 'number') { result.number = 2; result.html_url = 'https://github.com/test/project/pull/2'; }
      }
      return result;
    };
    await assert.rejects(f.service.deliver(f.nextInput), /ownership|head does not match|PR is closed|branch is not owned|Remote head changed/);
    assert.equal(reads, 1); assert.deepEqual(f.counts(), { pushCount: 1, postCount: 1 });
  });
});

test('PR reconciliation stops on cancellation, revoked authorization or a real transport error without another write', async t => {
  for (const change of ['cancel', 'revoke', 'http-error']) await t.test(change, async t => {
    const f = await stalePullFixture(t), request = f.transport.request, controller = new AbortController(); let allowed = true, reads = 0;
    f.transport.request = async (endpoint, options) => {
      if (endpoint === '/repos/test/project/pulls/1') {
        reads++;
        if (change === 'cancel') { controller.abort(); return new Promise(() => {}); }
        if (change === 'revoke') allowed = false;
        if (change === 'http-error') throw new Error('GitHub delivery request failed (HTTP 403)');
      }
      return request.call(f.transport, endpoint, options);
    };
    await assert.rejects(f.service.deliver({ ...f.nextInput, signal: controller.signal, authorize: () => allowed }), change === 'http-error' ? /HTTP 403/ : /cancelled or no longer authorized/);
    assert.equal(reads, 1); assert.deepEqual(f.counts(), { pushCount: 1, postCount: 1 });
  });
});

test('permanently stale and nonresponsive PR projections are bounded by the same ten-second deadline', { timeout: 20_000 }, async t => {
  await Promise.all(['stale', 'nonresponsive'].map(async kind => {
    const f = await stalePullFixture(t), request = f.transport.request; let reads = 0, signal;
    f.transport.request = async (endpoint, options) => {
      if (endpoint === '/repos/test/project/pulls/1') {
        reads++; signal = options.signal;
        if (kind === 'nonresponsive') return new Promise(() => {});
      }
      return request.call(f.transport, endpoint, options);
    };
    const started = Date.now();
    await assert.rejects(f.service.deliver(f.nextInput), /Timed out waiting for owned PR head/);
    assert.ok(Date.now() - started >= 10_000); assert.ok(Date.now() - started < 15_000);
    assert.equal(signal.aborted, true); assert.ok(kind === 'stale' ? reads > 1 : reads === 1);
    assert.deepEqual(f.counts(), kind === 'stale' ? { pushCount: 2, postCount: 1 } : { pushCount: 1, postCount: 1 });
    const second = [...f.journal.values()].find(value => value.runId === 'run-2');
    if (kind === 'stale') assert.equal(second.state, 'pushed');
    else assert.equal(second, undefined);
  }));
});

test('the GitHub HTTP transport passes caller cancellation through its thirty-second timeout for PR and ref reads', async () => {
  for (const kind of ['pull', 'ref']) {
    const controller = new AbortController(); let received;
    const transport = createGitHubDeliveryTransport({ repository: 'test/project', credential: () => 'host-only-credential', fetch: async (_url, options) => {
      received = options.signal; controller.abort(); assert.equal(received.aborted, true); throw new Error('Request aborted');
    } });
    await assert.rejects(kind === 'pull' ? transport.request('/repos/test/project/pulls/1', { signal: controller.signal }) : transport.readHead('work', { signal: controller.signal }), /Request aborted/);
    assert.equal(received.aborted, true);
  }
});

test('stale verification, path expansion, unowned branches and external head changes fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.deliver({ ...f.input, allowedPaths: ['other.js'] }), /outside delivery scope/);
  writeFileSync(join(f.workspace.path, 'source.js'), 'export const value = 3;');
  await assert.rejects(f.service.deliver(f.input), /passing verification/);
  writeFileSync(join(f.workspace.path, 'source.js'), 'export const value = 2;\n');
  git(f.root, 'push', f.remote, `HEAD:refs/heads/${f.workspace.branch}`);
  await assert.rejects(f.service.deliver(f.input), /not owned/);
  assert.deepEqual(f.counts(), { pushCount: 0, postCount: 0 });
});

test('closed or unowned PRs and changed delivery intent cannot be silently reused', async t => {
  const f = await fixture(t);
  await f.service.deliver(f.input);
  await assert.rejects(f.service.deliver({ ...f.input, title: 'Different intent' }), /intent changed/);
  f.pulls[0].state = 'closed';
  await assert.rejects(f.service.deliver(f.input), /PR is closed/);
  assert.equal(f.counts().postCount, 1);
});

test('authorization is rechecked after network reads and remote writes need a cross-process lock', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = f.transport.readHead;
  f.transport.readHead = async (...args) => { const value = await original.apply(f.transport, args); controller.abort(); return value; };
  await assert.rejects(f.service.deliver({ ...f.input, signal: controller.signal }), /cancelled/);
  assert.deepEqual(f.counts(), { pushCount: 0, postCount: 0 });
  const unlocked = createDeliveryService({ projectRoot: f.root, projectId: 'project-1', load: () => undefined, save() {}, transport: f.transport });
  await assert.rejects(unlocked.deliver(f.input), /cross-process ownership lock/);
});

test('host transport pins repository, restricts writes and rejects history rewrites before reading credentials', async t => {
  const f = await fixture(t); let reads = 0;
  const transport = createGitHubDeliveryTransport({ repository: 'test/project', credential: () => { reads++; return 'secret'; }, request: async () => ({}) });
  await assert.rejects(transport.request('/repos/test/project/../../other/pulls'), /outside allowed/);
  await assert.rejects(transport.request('/repos/test/project/issues/1/comments', { method: 'POST' }), /outside allowed/);
  git(f.root, 'checkout', '--orphan', 'unrelated'); git(f.root, 'commit', '--allow-empty', '-m', 'unrelated');
  const unrelated = git(f.root, 'rev-parse', 'HEAD');
  await assert.rejects(transport.push({ cwd: f.workspace.path, branch: f.workspace.branch, commitSha: f.baseCommit, expectedHead: unrelated }), /Git delivery operation failed/);
  assert.equal(reads, 0);
});


test('all delivered changes must be covered by verification scope, including exclusions', async t => {
  const f = await fixture(t);
  const verification = await runVerification({ projectRoot: f.root, workspace: f.workspace, profile: { id: 'scoped', version: '1', paths: ['source.js'], command: process.execPath, args: ['--check', 'source.js'], environment: 'host', allowHostExecution: true }, persist() {} });
  writeFileSync(join(f.workspace.path, 'other.js'), 'changed outside verification scope');
  await assert.rejects(f.service.deliver({ ...f.input, verification, allowedPaths: ['source.js', 'other.js'] }), /outside verified paths/);
  assert.deepEqual(f.counts(), { pushCount: 0, postCount: 0 });
});

test('first delivery refuses commits made outside the host journal even when the final diff is allowed', async t => {
  const f = await fixture(t);
  git(f.workspace.path, 'add', 'source.js'); git(f.workspace.path, 'commit', '-m', 'unjournaled worker commit');
  await assert.rejects(f.service.deliver(f.input), /unowned commits/);
  assert.deepEqual(f.counts(), { pushCount: 0, postCount: 0 });
});


test('successive deliveries preserve sparse checkout index flags and do not invent out-of-scope deletions', async t => {
  const f = await fixture(t, { sparse: true });
  assert.match(git(f.workspace.path, 'ls-files', '-v', 'outside/keep.txt'), /^S /);
  const first = await f.service.deliver(f.input);
  assert.match(git(f.workspace.path, 'ls-files', '-v', 'outside/keep.txt'), /^S /);
  assert.equal(git(f.workspace.path, 'diff', '--name-only'), '');
  writeFileSync(join(f.workspace.path, 'source.js'), 'export const value = 3;\n');
  const next = await f.service.deliver({ ...f.input, runId: 'run-2', verification: await verify(f.root, f.workspace) });
  assert.notEqual(next.commitSha, first.commitSha);
  assert.match(git(f.workspace.path, 'ls-files', '-v', 'outside/keep.txt'), /^S /);
  assert.equal(git(f.workspace.path, 'diff', f.baseCommit, '--name-only'), 'source.js');
  assert.equal(git(f.workspace.path, 'show', `${next.commitSha}:outside/keep.txt`), 'must remain committed, absent from sparse worktree');
});

test('W30 subsequent delivery synchronizes current description and preserves human text outside the managed section', async t => {
  const f = await fixture(t), first = await f.service.deliver(f.input);
  f.pulls[0].body += '\n\nHuman rollout note';
  writeFileSync(join(f.workspace.path, 'source.js'), 'export const value = 3;\n');
  const next = await f.service.deliver({ ...f.input, runId:'run-2', verification:await verify(f.root,f.workspace), title:'Current solution', body:'New implementation and verified limitations' });
  assert.equal(next.description.status,'synced'); assert.equal(f.pulls[0].title,'Current solution');
  assert.match(f.pulls[0].body,/New implementation/); assert.match(f.pulls[0].body,/Human rollout note/);
  assert.doesNotMatch(f.pulls[0].body,/Verified source update/); assert.equal(next.pullRequest.number,first.pullRequest.number);
  assert.deepEqual(f.counts(),{pushCount:2,postCount:1});
});

test('W30 human metadata edits conflict after a push without overwriting them or repushing on reconciliation', async t => {
  const f=await fixture(t); await f.service.deliver(f.input); f.pulls[0].title='Human-owned title';
  writeFileSync(join(f.workspace.path,'source.js'),'export const value = 3;\n');
  const input={...f.input,runId:'run-2',verification:await verify(f.root,f.workspace),title:'New title'};
  await assert.rejects(f.service.deliver(input),/conflicts with human edits/);
  const record=[...f.journal.values()].find(row=>row.runId==='run-2');
  assert.equal(record.state,'pushed'); assert.equal(record.description.status,'conflict'); assert.equal(f.pulls[0].title,'Human-owned title');
  await assert.rejects(f.service.deliver(input),/conflicts with human edits/); assert.deepEqual(f.counts(),{pushCount:2,postCount:1});
});

test('W30 an applied description PATCH with a lost response is read back without another PATCH', async t => {
  const f=await fixture(t); await f.service.deliver(f.input);
  writeFileSync(join(f.workspace.path,'source.js'),'export const value = 3;\n');
  const input={...f.input,runId:'run-2',verification:await verify(f.root,f.workspace),title:'New title',body:'New solution'};
  const request=f.transport.request; let patches=0;
  f.transport.request=async(endpoint,options)=>{const result=await request.call(f.transport,endpoint,options);if(options?.method==='PATCH'&&++patches===1)throw new Error('PATCH response lost');return result;};
  await assert.rejects(f.service.deliver(input),/response lost/);
  assert.equal((await f.service.deliver(input)).description.status,'synced'); assert.equal(patches,1); assert.deepEqual(f.counts(),{pushCount:2,postCount:1});
});

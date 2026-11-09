import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCandidateSourceContext } from '../src/runtime/source-context.mjs';
import { runBoundedAssessment } from '../src/context-requests.mjs';

const repository = 'owner/repo', prefix = `/repos/${repository}`;
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), subtree = 'c'.repeat(40);
const candidate = { thread: { key: `github:${repository}#1` }, triggers: [{ id: 't1', source: 'github', threads: [{ source: 'github', id: `${repository}#1` }], meta: { repository, issueNumber: 1 } }], tickets: [] };
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'issue-code-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Context Test'); git('config', 'user.email', 'context@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  return { root, git };
}
function fixture() {
  const content = Buffer.from('export const answer = 42;\n');
  const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const data = new Map([
    [prefix, { id: 17, full_name: repository, default_branch: 'release/main' }],
    [`${prefix}/git/ref/heads/release/main`, { ref: 'refs/heads/release/main', object: { type: 'commit', sha: commit } }],
    [`${prefix}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }],
    [`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [
      { path: 'src', type: 'tree', mode: '040000', sha: subtree },
      { path: '.env', type: 'blob', mode: '100644', sha: blob },
      { path: 'outside', type: 'blob', mode: '120000', sha: blob },
      { path: 'submodule', type: 'commit', mode: '160000', sha: commit },
      { path: 'private.pem', type: 'blob', mode: '100644', sha: blob },
    ] }],
    [`${prefix}/git/trees/${subtree}`, { sha: subtree, truncated: false, tree: [{ path: 'answer.mjs', type: 'blob', mode: '100644', sha: blob }] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, encoding: 'base64', size: content.length, content: content.toString('base64') }],
  ]);
  const calls = [];
  const request = async (endpoint, options) => {
    calls.push(endpoint); assert.equal(options.method, 'GET');
    assert.ok(data.has(endpoint), `Unexpected endpoint: ${endpoint}`);
    return structuredClone(data.get(endpoint));
  };
  return { data, calls, request, blob };
}
const repositoryReference = context => context.contextReferences.find(ref => ref.resource === 'repository');
const read = async (context, ref) => JSON.parse((await context.readContextRecord(ref.resource, ref.id)).text);

test('ordinary Issue lazily freezes the default branch and reads missing local objects through scoped remote references', async t => {
  const { root } = project(t), remote = fixture();
  const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request });
  const ref = repositoryReference(context); assert.ok(ref); assert.deepEqual(remote.calls, []);
  const first = await read(context, ref);
  assert.equal(first.sha, commit); assert.deepEqual(first.entries.map(entry => entry.name), ['src']);
  remote.data.get(`${prefix}/git/ref/heads/release/main`).object.sha = 'd'.repeat(40);
  const dir = await read(context, first.entries[0].reference);
  const file = await read(context, dir.entries[0].reference);
  assert.equal(file.text, 'export const answer = 42;\n'); assert.equal(file.sha, commit);
  assert.deepEqual(await read(context, ref), first);
  assert.equal(remote.calls.filter(path => path === `${prefix}/git/ref/heads/release/main`).length, 1);
  const before = remote.calls.length;
  await assert.rejects(context.readContextRecord('repository', `${prefix}/git/blobs/${remote.blob}`), /outside/);
  await assert.rejects(context.readContextRecord('repository', 'https://evil.example/secrets'), /outside/);
  assert.equal(remote.calls.length, before);
});

test('default-branch Issue reads a fixed local commit and ignores dirty working files', async t => {
  const { root, git } = project(t);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/answer.mjs'), 'committed value');
  git('add', '.'); git('commit', '-m', 'baseline'); const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/answer.mjs'), 'dirty changed value');
  const remote = fixture(); remote.data.get(`${prefix}/git/ref/heads/release/main`).object.sha = sha;
  const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request });
  const initial = await read(context, repositoryReference(context));
  const directory = await read(context, initial.entries[0].reference);
  assert.equal((await read(context, directory.entries[0].reference)).text, 'committed value');
  assert.deepEqual(remote.calls, [prefix, `${prefix}/git/ref/heads/release/main`]);
});

test('fixed PR commit can use remote fallback without consulting the current default branch', async t => {
  const { root } = project(t), remote = fixture(), pull = structuredClone(candidate);
  pull.triggers[0].meta.headSha = commit;
  const context = createCandidateSourceContext({ candidate: pull, projectRoot: root, repository, request: remote.request });
  const initial = await read(context, repositoryReference(context));
  assert.equal(initial.sha, commit); assert.equal(remote.calls[1], `${prefix}/git/commits/${commit}`);
  assert.ok(!remote.calls.some(path => path.includes('/git/ref/')));
});

test('only direct Issue candidates receive a default tree; related Issues cannot authorize PR fallback', () => {
  for (const marker of ['fork', 'missing-head', 'pull-event', 'mixed']) {
    const value = structuredClone(candidate);
    value.triggers[0].threads = [{ source: 'github', id: `${repository}#pr:2` }];
    if (marker === 'fork') value.triggers[0].meta.pullRequest = { headSha: commit, headRepository: 'other/repo' };
    if (marker === 'pull-event') {
      value.triggers[0].threads = [{ source: 'github', id: `${repository}#2` }];
      value.triggers[0].meta.pullEvent = { kind: 'pr_comment' };
    }
    if (marker === 'mixed') value.triggers.push(candidate.triggers[0]);
    value.tickets = [{ follows: [{ thread: `github:${repository}#1` }], threads: [{ source: 'github', id: `${repository}#3` }] }];
    const context = createCandidateSourceContext({ candidate: value, projectRoot: '/unused', repository, request: async () => { throw new Error('Unexpected request'); } });
    assert.equal(context.contextReferences.filter(ref => ref.resource === 'repository').length, 0, marker);
  }
});

test('repository replacement is rejected before reading a subsequent remote tree', async t => {
  const { root } = project(t), remote = fixture();
  const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request });
  const initial = await read(context, repositoryReference(context));
  remote.data.get(prefix).id = 18;
  await assert.rejects(read(context, initial.entries[0].reference), /repository identity/);
  assert.ok(!remote.calls.includes(`${prefix}/git/trees/${subtree}`));
});

test('dedicated account is verified for remote code reads and ambient tokens cannot override it', async t => {
  const { root } = project(t), remote = fixture(), executable = join(root, 'fake-gh');
  const responses = join(root, 'responses.json'), identity = join(root, 'identity.json'), log = join(root, 'calls.jsonl');
  writeFileSync(responses, JSON.stringify(Object.fromEntries(remote.data)));
  writeFileSync(identity, JSON.stringify({ login: 'helper', id: 23, type: 'User' }));
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
const extra = ['GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'];
if (extra.some(key => process.env[key])) process.exit(3);
if (args[0] === 'auth') {
  if (process.env.GH_TOKEN || args[args.indexOf('--user') + 1] !== 'helper') process.exit(4);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:'auth'})+'\\n');
  console.log('selected-test-token');
} else {
  if (process.env.GH_TOKEN !== 'selected-test-token' || args[args.indexOf('--method') + 1] !== 'GET') process.exit(5);
  const endpoint = args.at(-1);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:'api',endpoint})+'\\n');
  const result = endpoint === '/user' ? JSON.parse(fs.readFileSync(${JSON.stringify(identity)},'utf8')) : JSON.parse(fs.readFileSync(${JSON.stringify(responses)},'utf8'))[endpoint];
  if (!result) process.exit(6);
  console.log(JSON.stringify(result));
}
`, { mode: 0o755 });
  const tokenKeys = ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'];
  const saved = Object.fromEntries(tokenKeys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const key of tokenKeys) process.env[key] = 'ambient-test-token';
  const context = createCandidateSourceContext({ candidate, projectRoot: root, github: { repository, executable, account: { login: 'helper' }, allowedActors: ['owner'] } });
  const initial = await read(context, repositoryReference(context));
  assert.equal(initial.sha, commit);
  const before = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(before.some(entry => entry.endpoint === '/user'));
  assert.ok(before.some(entry => entry.endpoint === `${prefix}/git/trees/${tree}`));
  writeFileSync(identity, JSON.stringify({ login: 'wrong-account', id: 24, type: 'User' }));
  await assert.rejects(read(context, initial.entries[0].reference), /account identity/);
  const after = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(after.slice(before.length), [{kind:'auth'}, {kind:'api',endpoint:'/user'}]);
});

test('lazy snapshot stays on its resolved commit when a tree read fails and is retried', async t => {
  const { root } = project(t), remote = fixture(); let fail = true;
  const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: async (...args) => {
    if (fail && args[0] === `${prefix}/git/trees/${tree}`) { fail = false; throw new Error('Temporary transport failure'); }
    return remote.request(...args);
  } });
  const ref = repositoryReference(context);
  await assert.rejects(read(context, ref), /Temporary/);
  remote.data.get(`${prefix}/git/ref/heads/release/main`).object.sha = 'd'.repeat(40);
  assert.equal((await read(context, ref)).sha, commit);
  assert.equal(remote.calls.filter(path => path === `${prefix}/git/ref/heads/release/main`).length, 1);
});

test('concurrent initial reads share a snapshot and cached facts still check authorization', async t => {
  const { root } = project(t), remote = fixture(); let active = true;
  const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request,
    assertActive() { if (!active) throw new Error('Policy changed'); } });
  const ref = repositoryReference(context), [first, second] = await Promise.all([read(context, ref), read(context, ref)]);
  assert.deepEqual(first, second); assert.equal(remote.calls.filter(path => path === `${prefix}/git/ref/heads/release/main`).length, 1);
  active = false;
  await assert.rejects(read(context, ref), /Policy changed/);
});

test('repository identity, branch reference and tree identities fail closed', async t => {
  const { root } = project(t);
  for (const change of [
    remote => { remote.data.get(prefix).full_name = 'other/repo'; },
    remote => { remote.data.get(prefix).default_branch = '../../other/repo'; },
    remote => { remote.data.get(`${prefix}/git/ref/heads/release/main`).ref = 'refs/heads/other'; },
    remote => { remote.data.get(`${prefix}/git/commits/${commit}`).sha = 'e'.repeat(40); },
    remote => { remote.data.get(`${prefix}/git/trees/${tree}`).truncated = true; },
    remote => { remote.data.get(`${prefix}/git/trees/${tree}`).tree[0].path = '../escape'; },
    remote => { remote.data.get(`${prefix}/git/trees/${tree}`).tree[0].path = ''; },
  ]) {
    const remote = fixture(); change(remote);
    const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request });
    await assert.rejects(read(context, repositoryReference(context)), /identity|branch|different|incomplete|Malformed/);
    assert.ok(remote.calls.every(path => path === prefix || path.startsWith(`${prefix}/`)));
  }
});

test('remote file content is bounded, text-only and bound to its Git blob identity', async t => {
  const { root } = project(t);
  for (const change of [
    blob => { blob.size = 256 * 1024 + 1; },
    blob => { blob.encoding = 'utf8'; },
    blob => { blob.content = '!!!!'; },
    blob => { blob.content = Buffer.alloc(blob.size, 'x').toString('base64'); },
  ]) {
    const remote = fixture(); change(remote.data.get(`${prefix}/git/blobs/${remote.blob}`));
    const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request });
    const initial = await read(context, repositoryReference(context)), directory = await read(context, initial.entries[0].reference);
    await assert.rejects(read(context, directory.entries[0].reference), /budget|encoding|identity/);
  }
  for (const content of [Buffer.from([0]), Buffer.from([255])]) {
    const remote = fixture(), blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    remote.data.get(`${prefix}/git/trees/${subtree}`).tree[0].sha = blob;
    remote.data.set(`${prefix}/git/blobs/${blob}`, { sha: blob, encoding: 'base64', size: content.length, content: content.toString('base64') });
    const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: remote.request });
    const initial = await read(context, repositoryReference(context)), directory = await read(context, initial.entries[0].reference);
    await assert.rejects(read(context, directory.entries[0].reference), /not UTF-8 text/);
  }
});

test('repository reads retain cancellation, reference budgets and bounded-assessment discovery', async t => {
  const { root } = project(t), remote = fixture(), controller = new AbortController();
  const context = createCandidateSourceContext({ candidate, projectRoot: root, repository, signal: controller.signal, request: async (...args) => {
    const value = await remote.request(...args); if (args[0] === prefix) controller.abort(); return value;
  } });
  await assert.rejects(read(context, repositoryReference(context)), /cancelled/);
  assert.deepEqual(remote.calls, [prefix]);
  const bounded = createCandidateSourceContext({ candidate, projectRoot: root, repository, maxRecords: 3, request: fixture().request });
  await assert.rejects(read(bounded, repositoryReference(bounded)), /reference budget/);
  const usable = createCandidateSourceContext({ candidate, projectRoot: root, repository, request: fixture().request });
  const result = await runBoundedAssessment({ candidate, contextReferences: usable.contextReferences, readContextRecord: usable.readContextRecord, maxReads: 3,
    call: async ({ turn, facts, contextReferences }) => {
      if (turn === 3) { assert.match(facts[2].text, /answer = 42/); return { kind: 'ignore', reason: 'Read current code' }; }
      const ref = turn === 0 ? repositoryReference(usable) : facts[turn - 1].references[0];
      assert.ok(contextReferences.some(item => item.id === ref.id));
      return { kind: 'read', resource: ref.resource, recordId: ref.id, offset: 0 };
    } });
  assert.equal(result.kind, 'ignore');
});

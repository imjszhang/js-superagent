import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCandidateSourceContext } from '../src/runtime/source-context.mjs';
import { runBoundedAssessment } from '../src/context-requests.mjs';

const repository = 'owner/repo';
const candidate = { thread: { key: 'github:owner/repo#1', ref: { source: 'github', id: 'owner/repo#1' } }, triggers: [{ id: 't1', source: 'github', threads: [{ source: 'github', id: 'owner/repo#1' }], meta: { repository } }], tickets: [] };
const item = (id, text = `message ${id}`) => ({ id, number: 1, body: text, html_url: `https://github.com/owner/repo/issues/1${id > 1 ? `#issuecomment-${id}` : ''}`, title: 'Original issue', user: { login: 'alice' } });

test('candidate source reads derive fixed endpoints and reject outside references without transport calls', async () => {
  const requests = [];
  const context = createCandidateSourceContext({ candidate, projectRoot: '/unused', repository, request: async (endpoint, options) => { requests.push({ endpoint, options }); return item(1); } });
  assert.equal(context.contextReferences.length, 3);
  const reference = context.contextReferences[0], record = await context.readContextRecord(reference.resource, reference.id);
  assert.equal(JSON.parse(record.text).text, 'message 1'); assert.equal(requests[0].endpoint, '/repos/owner/repo/issues/1'); assert.equal(requests[0].options.method, 'GET');
  await assert.rejects(context.readContextRecord('sources', 'https://evil.example/private'), /outside/);
  await assert.rejects(context.readContextRecord('repository', reference.id), /outside/);
  assert.equal(requests.length, 1);
});
test('source pages advertise host-derived continuation references accepted by bounded assessment', async () => {
  const context = createCandidateSourceContext({ candidate, projectRoot: '/unused', repository, request: async endpoint => endpoint.includes('page=1') ? Array.from({ length: 30 }, (_, n) => item(n + 2)) : [item(32, 'Important parent fact')] });
  const first = context.contextReferences[1]; let second;
  const result = await runBoundedAssessment({ candidate, contextReferences: context.contextReferences, maxBytes: 128 * 1024, readContextRecord: context.readContextRecord,
    call: async ({ turn, facts, contextReferences }) => {
      if (turn === 0) return { kind: 'read', resource: first.resource, recordId: first.id, offset: 0 };
      if (turn === 1) { second = facts[0].references[0]; assert.ok(contextReferences.some(ref => ref.id === second.id)); return { kind: 'read', resource: second.resource, recordId: second.id, offset: 0 }; }
      assert.match(facts[1].text, /Important parent fact/); return { kind: 'accept', reason: 'Read parent context', rules: [] };
    } });
  assert.equal(result.kind, 'accept'); assert.ok(second);
});
test('source context rechecks current authorization after remote I/O and cached reads', async () => {
  let allowed = true;
  const context = createCandidateSourceContext({ candidate, projectRoot: '/unused', repository, assertActive() { if (!allowed) throw new Error('Policy changed'); }, request: async () => { allowed = false; return item(1); } });
  const reference = context.contextReferences[0]; await assert.rejects(context.readContextRecord(reference.resource, reference.id), /Policy changed/);
});
test('wrong thread links and malformed source bodies are rejected', async () => {
  for (const value of [{ ...item(1), html_url: 'https://github.com/owner/other/issues/1' }, { ...item(1), body: 'x'.repeat(256 * 1024 + 1) }]) {
    const context = createCandidateSourceContext({ candidate, projectRoot: '/unused', repository, request: async () => value });
    const reference = context.contextReferences[0]; await assert.rejects(context.readContextRecord(reference.resource, reference.id), /outside|budget/);
  }
});
test('fixed commit directory traversal only exposes safe regular files from the configured origin', async t => {
  const root = mkdtempSync(join(tmpdir(), 'source-context-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Context Test'); git('config', 'user.email', 'context@example.invalid'); git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/example.mjs'), 'export const answer = 42;'); writeFileSync(join(root, '.env'), 'SECRET=never_read'); symlinkSync('/etc/passwd', join(root, 'outside'));
  git('add', '.'); git('commit', '-m', 'fixture'); const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/example.mjs'), 'uncommitted changed value');
  const value = structuredClone(candidate); value.triggers[0].meta.headSha = sha;
  const context = createCandidateSourceContext({ candidate: value, projectRoot: root, repository, request: async () => item(1) });
  const initial = context.contextReferences.find(ref => ref.resource === 'repository');
  const rootRecord = await context.readContextRecord(initial.resource, initial.id), tree = JSON.parse(rootRecord.text);
  assert.deepEqual(tree.entries.map(entry => entry.name), ['src']);
  const sub = tree.entries[0].reference, child = JSON.parse((await context.readContextRecord(sub.resource, sub.id)).text);
  const file = child.entries[0].reference, record = JSON.parse((await context.readContextRecord(file.resource, file.id)).text);
  assert.equal(record.text, 'export const answer = 42;'); assert.equal(record.sha, sha);
  git('remote', 'set-url', 'origin', 'https://github.com/another/repo.git');
  const other = createCandidateSourceContext({ candidate: value, projectRoot: root, repository, request: async () => item(1) });
  const ref = other.contextReferences.find(ref => ref.resource === 'repository'); await assert.rejects(other.readContextRecord(ref.resource, ref.id), /origin/);
});

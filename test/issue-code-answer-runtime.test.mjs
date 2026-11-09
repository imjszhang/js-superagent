import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { runBoundedAssessment } from '../src/context-requests.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/code-answers', prefix = `/repos/${repository}`;
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), user = { id: 20, login: 'helper', type: 'User' };

function fixture(t, { failDefaultRead = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'issue-code-answer-runtime-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
  // An uncommitted local answer must never replace the remotely fixed commit.
  writeFileSync(join(root, 'settings.mjs'), 'export const retryLimit = 999;\n');
  const contents = Buffer.from('export const retryLimit = 17;\n');
  const blob = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
  const remote = new Map([
    [prefix, { id: 55, full_name: repository, default_branch: 'main' }],
    [`${prefix}/git/ref/heads/main`, { ref: 'refs/heads/main', object: { type: 'commit', sha: commit } }],
    [`${prefix}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }],
    [`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: 'settings.mjs', mode: '100644', type: 'blob', sha: blob }] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, size: contents.length, encoding: 'base64', content: contents.toString('base64') }],
  ]);
  const reads = [], comments = [], observedFacts = [];
  let workerRuns = 0, assessments = 0, posts = 0;
  const native = createGitHubChannel({ repository, allowedActors: ['alice'], issues: [7] }, { request: async (path, options) => {
    if (path === prefix) return { id: 55, full_name: repository, has_issues: true, permissions: { push: true } };
    if (path === '/user') return user;
    if (path.startsWith(`${prefix}/issues/7/comments?`)) { assert.equal(options.method, 'GET'); return comments; }
    if (path === `${prefix}/issues/7/comments` && options.method === 'POST') {
      const comment = { id: 1000 + ++posts, body: options.body.body, user, html_url: `https://github.com/${repository}/issues/7#issuecomment-${1000 + posts}` };
      comments.push(comment); return comment;
    }
    throw new Error(`Unexpected channel fixture request: ${path}`);
  } });
  const runtime = createProjectAgent({ projectRoot: root,
    github: { repository, allowedActors: ['alice'], issues: [7], pollIntervalMs: 86_400_000 },
    githubChannel: { ...native, async poll() { return []; } },
    repositoryRequest: async (path, options) => {
      assert.equal(options.method, 'GET'); reads.push(path);
      if (failDefaultRead && path === `${prefix}/git/ref/heads/main`) throw new Error('Default branch could not be read');
      assert.ok(remote.has(path), `Unexpected repository fixture request: ${path}`);
      return structuredClone(remote.get(path));
    },
    driver: { async run() { workerRuns++; throw new Error('This question must not start a worker'); } },
    assessor: { async assess(input) {
      assessments++;
      return runBoundedAssessment({ candidate: input.candidate, contextReferences: input.contextReferences,
        readContextRecord: input.readContextRecord, signal: input.signal, maxReads: 2,
        call: async ({ turn, facts, contextReferences }) => {
          if (turn === 0) {
            const ref = contextReferences.find(value => value.resource === 'repository');
            assert.ok(ref, 'An ordinary Issue must expose a repository context reference');
            return { kind: 'read', resource: ref.resource, recordId: ref.id, offset: 0 };
          }
          const directory = JSON.parse(facts[0].text);
          assert.equal(directory.sha, commit);
          if (turn === 1) {
            // Changing the default branch now must not change the exposed file reference.
            remote.get(`${prefix}/git/ref/heads/main`).object.sha = 'c'.repeat(40);
            const ref = directory.entries.find(entry => entry.name === 'settings.mjs')?.reference;
            assert.ok(ref); assert.ok(contextReferences.some(value => value.id === ref.id));
            return { kind: 'read', resource: ref.resource, recordId: ref.id, offset: 0 };
          }
          const file = JSON.parse(facts[1].text), match = /retryLimit\s*=\s*(\d+)/.exec(file.text);
          assert.ok(match); assert.equal(file.sha, directory.sha); observedFacts.push(...facts);
          return { kind: 'answer', triggerId: input.candidate.triggers[0].id,
            answer: `The retry limit is ${match[1]}, defined in ${file.path} at commit ${file.sha}.`,
            reason: 'The fixed repository file directly answers the question; no code changes are requested.', rules: [] };
        } });
    } },
  }).init();
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 0 });
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const event = { kind: 'comment', id: `github:${repository}:comment:101`, repository, issueNumber: 7, issueId: 70, issueState: 'open',
    actor: { id: 10, login: 'alice', type: 'User' }, text: '/js-superagent What retry limit is configured in settings.mjs?',
    createdAt: '2026-11-03T01:00:00.000Z', updatedAt: '2026-11-03T01:00:00.000Z' };
  return { root, runtime, event, reads, comments, observedFacts, blob,
    get workerRuns() { return workerRuns; }, get assessments() { return assessments; }, get posts() { return posts; } };
}

test('an ordinary Issue question reads fixed code and receives one source-bound answer with no worker or ticket', async t => {
  const f = fixture(t);
  f.runtime.receiveGitHubEvent(f.event); await f.runtime.runNext();
  assert.equal(f.assessments, 1); assert.equal(f.workerRuns, 0); assert.deepEqual(f.runtime.list(), []);
  assert.equal(f.posts, 1); assert.match(f.comments[0].body, /retry limit is 17, defined in settings\.mjs/);
  assert.ok(f.comments[0].body.includes(commit)); assert.ok(!f.comments[0].body.includes('999'));
  assert.equal(f.reads.filter(path => path === `${prefix}/git/ref/heads/main`).length, 1);
  assert.ok(f.reads.includes(`${prefix}/git/blobs/${f.blob}`)); assert.equal(f.observedFacts.length, 2);
  const [receipt] = f.runtime.notifications();
  assert.equal(receipt.status, 'sent'); assert.equal(receipt.ticketId, undefined);
  assert.deepEqual(receipt.channel.address, { repository, issueNumber: '7' });
  assert.equal(receipt.delivery.url, `https://github.com/${repository}/issues/7#issuecomment-1001`);
  const decisions = f.runtime.readContext('decisions').items.map(item => item.value);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].audit.coordinatorAnswer.replyId, receipt.id);
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  try {
    const [assessment] = store.listMeta('assessment:');
    assert.deepEqual(assessment.value.contextReads.map(read => read.provenance), [
      { repository, sha: commit, path: '' }, { repository, sha: commit, path: 'settings.mjs' },
    ]);
  } finally { store.close(); }
  assert.equal(readFileSync(join(f.root, 'settings.mjs'), 'utf8'), 'export const retryLimit = 999;\n');
  assert.equal(f.runtime.receiveGitHubEvent(f.event).status, 'duplicate'); await f.runtime.runNext();
  assert.equal(f.assessments, 1); assert.equal(f.posts, 1); assert.equal(f.workerRuns, 0);
});

test('a failed default-branch lookup ends unavailable without guessing an answer or dispatching work', async t => {
  const f = fixture(t, { failDefaultRead: true });
  f.runtime.receiveGitHubEvent(f.event); await f.runtime.runNext();
  assert.equal(f.assessments, 1); assert.equal(f.workerRuns, 0); assert.deepEqual(f.runtime.list(), []);
  assert.equal(f.posts, 0); assert.deepEqual(f.runtime.notifications(), []); assert.deepEqual(f.observedFacts, []);
  assert.ok(f.reads.includes(`${prefix}/git/ref/heads/main`)); assert.ok(!f.reads.some(path => path.includes('/git/blobs/')));
  const decisions = f.runtime.readContext('decisions').items.map(item => item.value);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].kind, 'unavailable');
  assert.match(JSON.stringify(decisions[0].reason), /could not be read/);
});

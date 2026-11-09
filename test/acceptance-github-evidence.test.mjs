import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertActionsEvidence, assertPullFailureInTicket, assertDefaultFailureInTicket, assertAppReceipt, assertOwnedDraftPull, finalizeAcceptance, updateOwnedMain } from '../examples/acceptance/github-evidence.mjs';
const repository = 'owner/js-superagent-acceptance', sha = 'a'.repeat(40);
function actionFixture() {
  const check = { id: 41, head_sha: sha, check_suite: { id: 51 }, status: 'completed', conclusion: 'failure', name: 'diagnostic-contract', app: { id: 15368, slug: 'github-actions' }, html_url: 'check-url' };
  const runs = [{ id: 61, check_suite_id: 51, head_sha: sha, status: 'completed', conclusion: 'failure', event: 'push', path: '.github/workflows/acceptance.yml', repository: { full_name: repository }, head_repository: { full_name: repository }, html_url: 'run-url' }];
  return { repository, headSha: sha, conclusion: 'failure', check, runs };
}
function pullFixture() {
  const action = assertActionsEvidence(actionFixture()), remoteId = `github:${repository}:check_run:41:${sha}:completed:failure`, id = `${remoteId}:pr:7`;
  return { repository, pullNumber: 7, ticketId: 'original-ticket', action, domain: { inputs: [{ triggerId: id }] },
    binding: { repository, number: 7, ticketId: 'original-ticket', headSha: sha, own: true, ci: [{ id, headSha: sha, name: 'diagnostic-contract', app: 'github-actions', status: 'completed', conclusion: 'failure' }] },
    trigger: { id, source: 'github', actor: { id: 'github-actions' }, human: false, meta: { pullEvent: { id, remoteEventId: remoteId, repository, pullNumber: 7, headSha: sha, kind: 'check_run', actor: { login: 'github-actions', id: '15368', type: 'Bot' }, ci: { app: 'github-actions', status: 'completed', conclusion: 'failure' } } } } };
}
test('Actions evidence binds real check, suite, workflow run, trusted app and current head', () => {
  assert.equal(assertActionsEvidence(actionFixture()).runId, 61);
  for (const change of [f => { f.runs[0].head_sha = 'b'.repeat(40); }, f => { f.runs[0].check_suite_id = 999; }, f => { f.check.app.slug = 'untrusted-app'; }, f => { f.runs[0].path = '.github/workflows/unrelated.yml'; }, f => { f.runs.push(structuredClone(f.runs[0])); }]) {
    const fixture = actionFixture(); change(fixture); assert.throws(() => assertActionsEvidence(fixture));
  }
});
test('review prose cannot replace a persisted original-ticket CI trigger and current PR binding', () => {
  assert.equal(assertPullFailureInTicket(pullFixture()).checkId, 41);
  for (const change of [f => { f.trigger = { id: 'review-1', text: 'diagnostic-contract failed' }; }, f => { f.domain.inputs = [{ triggerId: 'review-1' }]; }, f => { f.binding.headSha = 'b'.repeat(40); }, f => { f.binding.ci = []; }, f => { f.trigger.meta.pullEvent.actor.id = '999'; }, f => { f.trigger.meta.pullEvent.remoteEventId = 'unrelated-check'; }]) {
    const fixture = pullFixture(); change(fixture); assert.throws(() => assertPullFailureInTicket(fixture));
  }
});
test('default-branch inference requires the exact trusted failed Actions trigger as ticket origin', () => {
  const action = assertActionsEvidence(actionFixture()), id = `github:${repository}:branch_check:41:failure`;
  const fixture = { repository, action, domain: { origin: { triggerId: id }, mandate: { strength: 'inferred' } }, trigger: { id, source: 'github', actor: { id: 'github-actions[bot]' }, human: false, meta: { repository, defaultBranch: 'main', headSha: sha, actorId: '15368', actorType: 'Bot', ci: { app: 'github-actions', name: 'diagnostic-contract', status: 'completed', conclusion: 'failure' } } } };
  assert.equal(assertDefaultFailureInTicket(fixture).runId, 61);
  for (const change of [f => { f.domain.origin.triggerId = 'human-review'; }, f => { f.trigger.meta.headSha = 'b'.repeat(40); }, f => { f.trigger.meta.actorId = '999'; }, f => { f.trigger.human = true; }]) { const changed = structuredClone(fixture); change(changed); assert.throws(() => assertDefaultFailureInTicket(changed)); }
});
test('App receipts cannot silently fall back to a user, another bot, duplicates or an unrelated URL', () => {
  const fixture = { projectId: 'project', identity: { id: '101', login: 'acceptance[bot]' }, notification: { id: 'message', kind: 'reply', status: 'sent', delivery: { url: 'receipt-url' } }, comments: [{ body: '<!-- js-superagent:project:message -->', html_url: 'receipt-url', user: { id: 101, login: 'acceptance[bot]', type: 'Bot' } }] };
  assert.equal(assertAppReceipt(fixture).actorId, '101');
  for (const change of [f => { f.comments[0].user.type = 'User'; }, f => { f.comments[0].user.id = 102; }, f => { f.comments[0].user.login = 'owner'; }, f => { f.comments.push(structuredClone(f.comments[0])); }, f => { f.comments[0].html_url = 'other-url'; }]) { const changed = structuredClone(fixture); change(changed); assert.throws(() => assertAppReceipt(changed)); }
});
test('owned delivery must actually be an unmerged same-repository draft by the selected native-gh actor', () => {
  const fixture = { repository, actor: 'owner', headSha: sha, pull: { state: 'open', draft: true, merged: false, user: { login: 'owner' }, head: { sha, repo: { full_name: repository } }, base: { ref: 'main', repo: { full_name: repository } } } };
  assertOwnedDraftPull(fixture); fixture.pull.user.login = 'other'; assert.throws(() => assertOwnedDraftPull(fixture));
});
test('success is written only after cleanup, and a cleanup failure remains failed and propagates', async () => {
  const evidence = { status: 'running' }, attempted = [], saved = [];
  const error = await finalizeAcceptance({ evidence, checksPassed: true, save: () => saved.push(structuredClone(evidence)), cleanup: [
    { name: 'runtime', async run() { assert.equal(evidence.status, 'running'); attempted.push('runtime'); throw new Error('stop failed'); } },
    { name: 'remote', async run() { attempted.push('remote'); } },
  ] });
  assert.deepEqual(attempted, ['runtime', 'remote']); assert.equal(saved.at(-1).status, 'failed'); assert.equal(evidence.cleanupErrors[0].step, 'runtime');
  await assert.rejects(async () => { if (error) throw error; }, /cleanup failed/);
  const passed = { status: 'running' }; assert.equal(await finalizeAcceptance({ evidence: passed, checksPassed: true, cleanup: [], save() {} }), null); assert.equal(passed.status, 'passed');
  const failed = { status: 'running', error: 'scenario failed' }; await finalizeAcceptance({ evidence: failed, checksPassed: false, cleanup: [], save() {} }); assert.equal(failed.status, 'failed');
});
test('lost ref-update response retains and reconciles the exact owned commit instead of losing restoration scope', () => {
  const intent = { path: 'target.mjs' }, saved = []; let head = 'before';
  const api = (method, path, body) => {
    if (method === 'GET' && path.endsWith('/git/ref/heads/main')) return { object: { sha: head } };
    if (method === 'GET' && path.endsWith('/git/commits/before')) return { tree: { sha: 'tree-before' } };
    if (method === 'POST' && path.endsWith('/git/trees')) return { sha: 'tree-after' };
    if (method === 'POST' && path.endsWith('/git/commits')) return { sha: 'owned-after' };
    if (method === 'PATCH') { assert.equal(saved.at(-1).sha, 'owned-after'); assert.equal(body.force, false); head = body.sha; throw new Error('response lost'); }
    throw new Error('Unexpected API call');
  };
  assert.equal(updateOwnedMain({ api, prefix: 'repos/' + repository, expected: 'before', content: 'fixture', message: 'acceptance', intent, save: () => saved.push(structuredClone(intent)) }), 'owned-after');
  assert.equal(intent.responseReconciled, true); assert.equal(intent.state, 'observed');
});
test('both remote scripts require immutable package imports and propagate cleanup failure after finalization', () => {
  for (const name of ['real-github-full-chain-smoke.mjs', 'real-default-ci-smoke.mjs']) {
    const code = readFileSync(new URL('../examples/' + name, import.meta.url), 'utf8');
    assert.match(code, /importFrozenModule\(artifact/); assert.match(code, /assertActionsEvidence\(/); assert.match(code, /finalizeAcceptance\(/); assert.match(code, /if \(cleanupError\) throw cleanupError/);
    assert.doesNotMatch(code, /messages\.some\(message => message\.text\.includes\('diagnostic-contract'\)/);
  }
});

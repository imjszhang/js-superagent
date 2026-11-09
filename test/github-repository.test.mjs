import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRepositorySource } from '../src/channels/github-repository.mjs';
import { createRuntimePolicy } from '../src/policy.mjs';

const repository = 'owner/repo', actor = { id: 1, login: 'owner', type: 'User' }, sha = 'a'.repeat(40);
const config = { repository, allowedActors: ['owner'], ci: { checkApps: ['ci'], statusContexts: ['test'], statusActors: ['owner'] } };
function fixture(options = {}) {
  let now = Date.UTC(2026, 10, 1); const calls = [], pulls = [], issues = [], comments = [], checks = [], statuses = [];
  const at = () => new Date(now).toISOString();
  const pull = (number = 1, body = '/js-superagent Fix the parser regression', headRepository = repository) => ({ id: number + 10, number, state: 'open', merged: false, title: 'Parser regression', body,
    created_at: at(), updated_at: at(), user: actor, html_url: `https://github.com/${repository}/pull/${number}`, head: { sha, ref: 'fix-parser', repo: { full_name: headRepository } }, base: { repo: { full_name: repository } } });
  const issue = (number = 2, body = '/js-superagent Update README') => ({ id: number + 20, number, state: 'open', title: 'README', body, created_at: at(), updated_at: at(), user: actor });
  const request = async endpoint => {
    calls.push(endpoint);
    if (options.fail?.(endpoint)) throw new Error('stream unavailable');
    const path = endpoint.split('?')[0];
    if (path === '/repos/owner/repo') return { full_name: repository, default_branch: 'main' };
    if (path === '/repos/owner/repo/commits/main') return { sha };
    if (path === '/repos/owner/repo/pulls') return pulls;
    if (/\/pulls\/\d+$/.test(path)) return pulls.find(item => item.number === Number(path.split('/').at(-1)));
    if (path === '/repos/owner/repo/issues') return issues;
    if (path === '/repos/owner/repo/issues/comments') return comments;
    if (/\/issues\/\d+$/.test(path)) { const number = Number(path.split('/').at(-1)); return issues.find(item => item.number === number) ?? { ...pulls.find(item => item.number === number), pull_request: {} }; }
    if (path.endsWith('/check-runs')) return { total_count: checks.length, check_runs: checks };
    if (path.endsWith('/statuses')) return statuses;
    throw new Error(`Unexpected test endpoint ${endpoint}`);
  };
  const source = createGitHubRepositorySource(config, { request, now: () => now, ...options });
  return { source, calls, pulls, issues, comments, checks, statuses, pull, issue, at, advance() { now += 5000; } };
}
test('repository baseline does not replay history; new same-repo PR becomes an explicit candidate', async () => {
  const f = fixture(); const baseline = await f.source.poll(); assert.equal(baseline.events.length, 0); assert.deepEqual(f.calls, ['/repos/owner/repo']);
  f.advance(); f.pulls.push(f.pull()); const result = await f.source.poll({ cursor: baseline.cursor });
  assert.equal(result.errors.length, 0); assert.equal(result.events.length, 1);
  const trigger = f.source.normalize(result.events[0]); assert.equal(trigger.addressed, 'direct'); assert.equal(trigger.meta.pullRequest.headSha, sha);
  assert.equal(trigger.channel.address.pullNumber, '1'); assert.equal(trigger.channel.address.issueNumber, undefined); assert.equal(trigger.threads[0].id, `${repository}#pr:1`);
});
test('forks and implicit work are excluded while actor facts reach the default-denying Policy', async () => {
  const f = fixture(); const baseline = await f.source.poll(); f.advance();
  f.pulls.push(f.pull(1, '/js-superagent Fix it', 'other/fork'), { ...f.pull(2), user: { ...actor, id: 2, login: 'unlisted' } }, f.pull(3, 'A general project discussion'));
  const result = await f.source.poll({ cursor: baseline.cursor }); assert.equal(result.events.length, 1); assert.deepEqual(result.errors, []);
  const trigger = f.source.normalize(result.events[0]); assert.equal(trigger.actor.id, 'unlisted');
  assert.equal(createRuntimePolicy().gate(trigger).admissible, false);
});
test('observation emits unaddressed facts and each failed stream retains its own cursor', async () => {
  let failIssues = false; const f = fixture({ observe: true, streams: { pulls: true, issues: true, comments: false }, fail: endpoint => failIssues && endpoint.startsWith('/repos/owner/repo/issues?') });
  const baseline = await f.source.poll(); f.advance(); f.pulls.push(f.pull(1, 'Please review this design')); f.issues.push(f.issue()); failIssues = true;
  const result = await f.source.poll({ cursor: baseline.cursor });
  assert.equal(f.source.normalize(result.events[0]).addressed, undefined);
  assert.equal(result.errors[0].scope, 'issues'); assert.equal(result.cursor.streams.issues.since, baseline.cursor.streams.issues.since);
  assert.notEqual(result.cursor.streams.pulls.since, baseline.cursor.streams.pulls.since);
});
test('repository comments distinguish PR and Issue threads and preserve canonical event IDs', async () => {
  const f = fixture({ streams: { pulls: false, comments: true } }); const baseline = await f.source.poll(); f.advance(); f.pulls.push(f.pull()); f.issues.push(f.issue());
  f.comments.push({ id: 101, issue_url: 'https://api.github.com/repos/owner/repo/issues/1', body: '/js-superagent Fix the lint failure', user: actor, created_at: f.at(), updated_at: f.at() },
    { id: 102, issue_url: 'https://api.github.com/repos/owner/repo/issues/2', body: '/js-superagent Clarify usage', user: actor, created_at: f.at(), updated_at: f.at() });
  const result = await f.source.poll({ cursor: baseline.cursor }); const triggers = result.events.map(f.source.normalize);
  assert.equal(triggers[0].meta.githubComment.baseId, `github:${repository}:pr_comment:101`); assert.equal(triggers[0].channel.address.headSha, sha);
  assert.equal(triggers[1].meta.githubComment.baseId, `github:${repository}:comment:102`); assert.equal(triggers[1].channel.address.issueNumber, '2');
});
test('a malformed identifiable event retains its own retry while healthy events advance', async () => {
  const f = fixture({ streams: { pulls: false, issues: true } }); const baseline = await f.source.poll(); f.advance();
  f.issues.push(f.issue(2), f.issue(3, 'x'.repeat(256 * 1024 + 1)));
  const result = await f.source.poll({ cursor: baseline.cursor });
  assert.equal(result.events.length, 1); assert.equal(result.errors[0].scope, 'issues');
  assert.notEqual(result.cursor.streams.issues.since, baseline.cursor.streams.issues.since);
  assert.equal(result.cursor.streams.issues.retries[0].number, 3);
});
test('bound PRs remain with the existing head-checked feedback channel', async () => {
  const f = fixture({ streams: { pulls: true, comments: true }, isTrackedPullRequest: () => true }); const baseline = await f.source.poll(); f.advance(); f.pulls.push(f.pull());
  f.comments.push({ id: 101, issue_url: 'https://api.github.com/repos/owner/repo/issues/1', body: '/js-superagent Fix it', user: actor, created_at: f.at(), updated_at: f.at() });
  assert.deepEqual((await f.source.poll({ cursor: baseline.cursor })).events, []);
});
test('default-branch CI stays inferred and requires explicit app/context allowlists', async () => {
  const f = fixture({ observe: true, streams: { pulls: false, defaultBranchCI: true } }); const baseline = await f.source.poll(); f.advance();
  f.checks.push({ id: 301, name: 'parser tests', status: 'completed', conclusion: 'failure', completed_at: f.at(), head_sha: sha, app: { slug: 'ci', id: 5 }, output: { summary: 'Parser test failed' } },
    { id: 302, name: 'untrusted check', status: 'completed', conclusion: 'failure', completed_at: f.at(), head_sha: sha, app: { slug: 'unlisted', id: 6 } });
  f.statuses.push({ id: 401, context: 'test', state: 'failure', description: 'test failed', created_at: f.at(), creator: actor });
  const result = await f.source.poll({ cursor: baseline.cursor }); assert.equal(result.events.length, 3);
  for (const raw of result.events) { const trigger = f.source.normalize(raw); assert.equal(trigger.human, false); assert.equal(trigger.addressed, undefined); assert.equal(trigger.channel, undefined); assert.equal(trigger.meta.defaultBranch, 'main'); }
  assert.equal(f.source.normalize(result.events[0]).actor.id, 'ci[bot]');
  assert.equal(result.events.at(-1).kind, 'ci_state'); assert.equal(f.source.normalize(result.events.at(-1)).meta.contextOnly, true);
});
test('configured App credential failure never falls back to native gh', async t => {
  const name = 'TEST_JS_SUPERAGENT_MISSING_APP_KEY', previous = process.env[name]; delete process.env[name];
  t.after(() => { if (previous !== undefined) process.env[name] = previous; });
  const source = createGitHubRepositorySource({ ...config, executable: '/must-not-run', app: { appId: '1', installationId: 1, privateKeyEnv: name } });
  assert.equal(source.authentication, 'app'); const result = await source.poll();
  assert.equal(result.errors.length, 1); assert.equal(result.errors[0].category, 'configuration'); assert.equal(result.errors[0].repositoryFailure, true); assert.deepEqual(result.cursor.streams, {});
});

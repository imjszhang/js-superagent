import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeMachineGuard } from '../src/runtime/machine-guard.mjs';
import { ensureProjectIdentity } from '../src/project-identity.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';

function fixture(t, provided) {
  const base = mkdtempSync(join(tmpdir(), 'js-repository-identity-')), projectRoot = join(base, 'project');
  mkdirSync(projectRoot); ensureProjectIdentity(projectRoot, 'identity-project');
  const state = { id: 42, now: 1000, reads: 0, probes: 0, writes: 0, fail: false };
  const channel = provided ?? {
    async probe() { state.probes++; return { repository: 'owner/repo', repositoryId: state.id }; },
    async repositoryIdentity() { state.reads++; if (state.fail) throw new Error('Network unavailable'); return { repository: 'owner/repo', repositoryId: state.id }; },
    async poll() { return []; },
  };
  const guard = new RuntimeMachineGuard({ projectRoot, projectId: 'identity-project', dependencies: { directory: join(base, 'machine'), now: () => state.now },
    prepare() {}, github: () => ({ repository: 'owner/repo' }), channel: () => channel, guardians: () => [], retained: () => false });
  guard.hold();
  t.after(() => { guard.unhold(); guard.close(); rmSync(base, { recursive: true, force: true }); });
  return { guard, channel, state };
}

test('long-lived identity cache expires and detects replacement before more channel reads', async t => {
  const { guard, channel, state } = fixture(t);
  const facade = guard.channelFacade(channel);
  await guard.ready(); assert.equal(guard.isReady(), true);
  state.now += 59_999; await facade.poll(); assert.equal(state.reads, 1);
  state.id = 99; state.now++;
  assert.equal(guard.isReady(), false);
  await assert.rejects(facade.poll(), { code: 'GITHUB_REPOSITORY_ID_CHANGED' });
  assert.equal(state.reads, 2); assert.equal(guard.isReady(), false);
  assert.equal(guard.status().githubIdentity.verified, false);
  state.id = 42; await guard.ready(); assert.equal(guard.isReady(), true);
});

test('a failed fresh write check invalidates a still-young cache and sends nothing', async t => {
  const { guard, state } = fixture(t); await guard.ready();
  const transport = guard.deliveryTransport({ repository: 'owner/repo', async push() { state.writes++; }, async request() { state.writes++; } });
  state.fail = true;
  await assert.rejects(transport.push({}), /Network unavailable/);
  await assert.rejects(transport.request('/repos/owner/repo/pulls', { method: 'POST' }), /Network unavailable/);
  assert.equal(state.writes, 0); assert.equal(guard.isReady(), false);
});

for (const [method, hook] of [['deliver', 'authorizeSend'], ['applyReviewAction', 'beforeWrite']]) {
  test(`${method} rechecks identity at its actual write hook after reconciliation`, async t => {
    const { guard, channel, state } = fixture(t); await guard.ready();
    channel[method] = async (_message, options) => { state.id = 99; await options[hook](); state.writes++; };
    let authorized = 0;
    await assert.rejects(guard.channelFacade(channel)[method]({}, { [hook]: () => { authorized++; } }), { code: 'GITHUB_REPOSITORY_ID_CHANGED' });
    assert.equal(authorized, 1); assert.equal(state.writes, 0);
  });
}

test('identity changes during an asynchronous authorization hook are caught immediately before writing', async t => {
  const { guard, channel, state } = fixture(t); await guard.ready();
  channel.deliver = async (_message, options) => { await options.authorizeSend(); state.writes++; };
  await assert.rejects(guard.channelFacade(channel).deliver({}, { authorizeSend: async () => { await Promise.resolve(); state.id = 99; } }), { code: 'GITHUB_REPOSITORY_ID_CHANGED' });
  assert.equal(state.writes, 0);
});

test('review preflight failures explicitly report that no write was sent', async t => {
  const { guard, channel, state } = fixture(t); await guard.ready();
  channel.applyReviewAction = async () => { state.writes++; };
  state.fail = true;
  await assert.rejects(guard.channelFacade(channel).applyReviewAction({}), error => error.reviewWriteSent === false && error.githubScope === 'repository');
  assert.equal(state.writes, 0);
});

test('push, PR creation and description updates require fresh identity even inside the cache lifetime', async t => {
  const { guard, state } = fixture(t); await guard.ready();
  const transport = guard.deliveryTransport({ repository: 'owner/repo', async push() { state.writes++; }, async request() { state.writes++; } });
  await transport.push({}); await transport.request('/repos/owner/repo/pulls', { method: 'POST' });
  await transport.request('/repos/owner/repo/pulls/1', { method: 'PATCH' });
  assert.equal(state.writes, 3); assert.equal(state.reads, 4);
  state.id = 99;
  await assert.rejects(transport.request('/repos/owner/repo/pulls/1', { method: 'PATCH' }), { code: 'GITHUB_REPOSITORY_ID_CHANGED' });
  assert.equal(state.writes, 3);
  const other = guard.deliveryTransport({ repository: 'owner/other', async push() { state.writes++; } });
  await assert.rejects(other.push({}), /differs from/); assert.equal(state.writes, 3);
});

test('concurrent refreshes share the same in-flight read and no stale identity survives failure', async t => {
  const { guard, channel, state } = fixture(t); await guard.ready();
  let release; const pending = new Promise(resolve => { release = resolve; });
  channel.repositoryIdentity = async () => { state.reads++; await pending; throw new Error('Unavailable'); };
  const first = guard.beforeGitHubWrite(), second = guard.beforeGitHubWrite();
  release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected')); assert.equal(state.reads, 2);
  assert.equal(guard.isReady(), false);
});

test('legacy injected channels without identity probes stay compatible but report unverified identity', async t => {
  let writes = 0;
  const channel = { async deliver(_message, { authorizeSend }) { await authorizeSend(); writes++; } };
  const { guard } = fixture(t, channel);
  await guard.channelFacade(channel).deliver({});
  assert.equal(writes, 1); assert.equal(guard.status().githubIdentity.verified, false);
});

test('built-in lightweight identity lookup requires a stable repository ID and correct name', async () => {
  let repo = { id: 42, full_name: 'Owner/Repo' }; const calls = [];
  const channel = createGitHubChannel({ repository: 'owner/repo', allowedActors: ['owner'] }, { request: async (endpoint, init) => { calls.push({ endpoint, method: init.method }); return repo; } });
  assert.deepEqual(await channel.repositoryIdentity(), { repository: 'owner/repo', repositoryId: 42 });
  assert.deepEqual(calls, [{ endpoint: '/repos/owner/repo', method: 'GET' }]);
  repo = { full_name: 'owner/repo' };
  await assert.rejects(channel.repositoryIdentity(), { code: 'GITHUB_REPOSITORY_IDENTITY_UNVERIFIED' });
  repo = { id: 42, full_name: 'owner/renamed' };
  await assert.rejects(channel.repositoryIdentity(), { code: 'GITHUB_REPOSITORY_IDENTITY_UNVERIFIED' });
});

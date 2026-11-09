import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubAccountRequest, githubAccountEnvironment } from '../src/channels/github-account.mjs';
import { ghRequest, createGitHubChannel } from '../src/channels/github.mjs';
import { createNativeGitHubDeliveryTransport } from '../src/delivery.mjs';

const options = { repository: 'owner/repo', executable: '/usr/local/bin/gh-agent', account: { login: 'agent' }, allowedActors: ['operator'] };
const user = { login: 'Agent', id: 10, type: 'User' };

test('dedicated account requires explicit CLI and separate operator identity', () => {
  for (const patch of [{ executable: undefined }, { account: { login: 'operator' } }, { app: {} }, { account: { login: 'agent[bot]' } }]) {
    assert.throws(() => createGitHubAccountRequest({ ...options, ...patch }));
  }
  assert.throws(() => createNativeGitHubDeliveryTransport({ ...options, executable: undefined }));
  const env = githubAccountEnvironment({ HOME: '/home/user', GH_CONFIG_DIR: '/agent/config', GH_TOKEN: 'ambient', GITHUB_TOKEN: 'ambient', GH_ENTERPRISE_TOKEN: 'ambient', GITHUB_ENTERPRISE_TOKEN: 'ambient' });
  assert.deepEqual(env, { HOME: '/home/user', GH_CONFIG_DIR: '/agent/config', GH_PROMPT_DISABLED: '1' });
});

test('account transport rechecks identity before requests and fails closed on changed login or numeric identity', async () => {
  let current = user;
  const calls = [];
  const request = createGitHubAccountRequest(options, { credential: async () => 'selected-account-token', request: async (executable, endpoint, init) => {
    assert.equal(executable, options.executable);
    assert.equal(init.env.GH_TOKEN, 'selected-account-token');
    for (const key of ['GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN']) assert.equal(init.env[key], undefined);
    calls.push(endpoint);
    return endpoint === '/user' ? current : { ok: true };
  } });
  assert.deepEqual(await request('/repos/owner/repo/issues/1/comments', { method: 'POST', body: { body: 'result' } }), { ok: true });
  assert.deepEqual(calls, ['/user', '/repos/owner/repo/issues/1/comments']);
  for (const identity of [{ ...user, login: 'operator' }, { ...user, id: 11 }, { ...user, type: 'Bot' }]) {
    current = identity;
    await assert.rejects(request('/repos/owner/repo/issues/1/comments', { method: 'POST' }), /identity/);
  }
  assert.equal(calls.filter(c => c.endsWith('/comments')).length, 1);
});

test('account transport scopes URLs and exposes read-only notification headers', async () => {
  const calls = [];
  const request = createGitHubAccountRequest(options, { credential: async () => 'selected-account-token', request: async (_, endpoint, init) => {
    calls.push(endpoint);
    if (endpoint === '/user') return user;
    assert.equal(init.includeHeaders, true);
    return { body: [], headers: { 'x-poll-interval': '120' } };
  } });
  assert.deepEqual(await request.notifications('/repos/owner/repo/notifications?all=true', {}), { body: [], headers: { 'x-poll-interval': '120' } });
  for (const endpoint of ['/repos/other/repo/issues', '/repos/owner/repo/../other', '/repos/owner/repo/%2e%2e/other', 'https://evil.test/', '/graphql']) await assert.rejects(request(endpoint), /outside/);
  await assert.rejects(request.notifications('/repos/owner/repo/notifications', { method: 'PATCH' }), /read-only/);
  await assert.rejects(request('/user', { method: 'PATCH' }), /read-only/);
  assert.equal(calls.filter(e => e !== '/user').length, 1);
});

test('ghRequest optionally parses headers and accepts an isolated process environment without changing legacy JSON results', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-account-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-gh');
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\nX-Poll-Interval: 120\\r\\nContent-Type: application/json\\r\\n\\r\\n');\nconsole.log(JSON.stringify({isolated:process.env.GH_TOKEN===undefined}));\n`, { mode: 0o755 });
  const env = githubAccountEnvironment({ ...process.env, GH_TOKEN: 'ambient' });
  assert.deepEqual(await ghRequest(executable, '/repos/owner/repo/notifications', { env, includeHeaders: true }), { body: { isolated: true }, headers: { 'x-poll-interval': '120', 'content-type': 'application/json' } });
  assert.deepEqual(await ghRequest(executable, '/user', { env }), { isolated: true });
});

test('account channel probes write and notification access and does not scan every open issue', async () => {
  const calls = [];
  let writable = true;
  const request = async endpoint => {
    calls.push(endpoint);
    if (endpoint === '/user') return user;
    if (endpoint === '/repos/owner/repo') return { full_name: 'owner/repo', has_issues: true, permissions: { push: writable } };
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  request.notifications = async endpoint => { calls.push(endpoint); return { body: [], headers: {} }; };
  const channel = createGitHubChannel(options, { request });
  assert.equal((await channel.probe()).authentication, 'account');
  assert.ok(calls.includes('/repos/owner/repo/notifications?all=true&per_page=1'));
  calls.length = 0;
  const poll = await channel.poll();
  assert.deepEqual(poll.events, []);
  assert.equal(poll.repositoryVerified, true);
  assert.deepEqual(calls, ['/repos/owner/repo']);
  writable = false;
  await assert.rejects(channel.probe(), /write access/);
  const failed = await channel.poll();
  assert.equal(failed.repositoryVerified, false);
  assert.equal(failed.errors[0].scope, 'repository');
  writable = true;
  assert.equal((await channel.poll()).repositoryVerified, true);
});

test('account API uses the same verified credential even if the active account switches between requests', async () => {
  let activeToken = 'agent-token';
  const request = createGitHubAccountRequest(options, {
    credential: async (_, login) => { assert.equal(login, 'agent'); return activeToken; },
    request: async (_, endpoint, init) => {
      if (endpoint === '/user') { activeToken = 'operator-token'; return user; }
      assert.equal(init.env.GH_TOKEN, 'agent-token');
      return { ok: true };
    },
  });
  assert.deepEqual(await request('/repos/owner/repo/issues/1/comments', { method: 'POST' }), { ok: true });
});

test('delivery selects the configured user token and verifies that exact credential before use', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-account-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-gh');
  writeFileSync(executable, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='auth'){if(a[a.indexOf('--user')+1]!=='agent'||process.env.GH_TOKEN)process.exit(2);console.log('agent-token');}\nelse { if(process.env.GH_TOKEN!=='agent-token')process.exit(3); console.log(JSON.stringify({login:'agent',id:10,type:'User'})); }\n`, { mode: 0o755 });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_, init) => {
    assert.equal(init.headers.Authorization, 'Bearer agent-token');
    return new Response(JSON.stringify({ ok: true }));
  };
  const transport = createNativeGitHubDeliveryTransport({ ...options, executable });
  assert.deepEqual(await transport.request('/repos/owner/repo/pulls/1'), { ok: true });
});

test('legacy wrapper token fallback is accepted only after verifying that exact token belongs to the configured user', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-account-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-gh');
  const write = login => writeFileSync(executable, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='auth'){if(a.includes('--user')){console.error('no oauth token found for github.com account agent');process.exit(1);} console.log('legacy-token');}\nelse {if(process.env.GH_TOKEN!=='legacy-token')process.exit(3);console.log(JSON.stringify({login:${JSON.stringify(login)},id:10,type:'User'}));}\n`, { mode: 0o755 });
  write('agent');
  const request = createGitHubAccountRequest({ ...options, executable });
  assert.equal((await request.identity()).login, 'agent');
  write('operator');
  await assert.rejects(request.credential(), /identity/);
});

test('notification transport rejects global, foreign and encoded paths before credential lookup', async () => {
  let credentials = 0;
  const request = createGitHubAccountRequest(options, { credential: async () => { credentials++; return 'token'; } });
  for (const endpoint of ['/notifications', '/repos/other/repo/notifications', '/repos/owner/repo/notifications/1', '/repos/owner/repo/%6eotifications', '/repos/owner/repo/notifications?x=\n']) await assert.rejects(request.notifications(endpoint), /configured repository/);
  assert.equal(credentials, 0);
});

test('ghRequest handles conditional 304 and retains only safe quota facts on errors', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-account-conditional-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-gh');
  writeFileSync(executable, `#!${process.execPath}\nif(!process.argv.some(a=>a.startsWith('If-Modified-Since: ')))process.exit(2);process.stdout.write('HTTP/2.0 304 Not Modified\\r\\nX-Poll-Interval: 90\\r\\n\\r\\n');`, { mode: 0o755 });
  const response = await ghRequest(executable, '/repos/owner/repo/notifications?all=true&per_page=1', { includeHeaders: true, headers: { 'If-Modified-Since': 'Tue, 03 Nov 2026 00:00:01 GMT' } });
  assert.equal(response.status, 304); assert.equal(response.body, null);
  await assert.rejects(ghRequest(executable, '/user', { headers: { Authorization: 'unexpected' } }), /Unsupported/);
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('HTTP/2.0 403 Forbidden\\r\\nRetry-After: 600\\r\\nX-RateLimit-Remaining: 0\\r\\nAuthorization: private-header\\r\\n\\r\\n{"message":"private-body"}');process.stderr.write('HTTP 403 private-stderr');process.exit(1);`, { mode: 0o755 });
  await assert.rejects(ghRequest(executable, '/repos/owner/repo/notifications', { includeHeaders: true }), error => {
    assert.equal(error.status, 403); assert.deepEqual(error.headers, { 'retry-after': '600', 'x-ratelimit-remaining': '0' }); assert.ok(!JSON.stringify(error).includes('private-')); return true;
  });
});

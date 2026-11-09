import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubAppRequest } from '../src/channels/github-app.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const repository = 'owner/project';
const options = { repository, app: { appId: '1234', installationId: 777, privateKeyEnv: 'TEST_APP_PRIVATE_KEY' } };
const baseTime = Date.parse('2026-11-01T00:00:00Z');
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });

function fixture({ response, ci, pullRequestComments = false } = {}) {
  let milliseconds = baseTime, minted = 0;
  const calls = [], tokens = [];
  const permissions = { metadata: 'read', issues: 'write', pull_requests: pullRequestComments ? 'write' : 'read', ...(ci?.checkApps ? { checks: 'read' } : {}), ...(ci?.statusContexts ? { statuses: 'read' } : {}) };
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers['X-GitHub-Api-Version'], '2026-03-10');
    const path = new URL(url).pathname;
    calls.push({ path, ...init });
    if (path === '/app/installations/777/access_tokens' || path === '/app') {
      const encoded = init.headers.Authorization.slice(7), [header, payload, signature] = encoded.split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
      assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: Math.floor(milliseconds / 1000) - 60, exp: Math.floor(milliseconds / 1000) + 540, iss: '1234' });
      assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keyPair.publicKey, Buffer.from(signature, 'base64url')));
      if (path === '/app') return json({ id: 1234, slug: 'fixture-app' });
      minted++;
      assert.deepEqual(JSON.parse(init.body), { repositories: ['project'], permissions });
      const value = `ghs_1234_${'stateless'.repeat(20)}_${minted}`;
      tokens.push(value);
      return response ? response({ value, permissions, milliseconds, minted }) : json({ token: value, expires_at: new Date(milliseconds + 3_600_000).toISOString(), permissions,
        repository_selection: 'selected', repositories: [{ id: 55, full_name: repository }] });
    }
    if (path === '/users/fixture-app%5Bbot%5D') {
      assert.equal(init.headers.Authorization, undefined);
      return json({ login: 'fixture-app[bot]', id: 4321, type: 'Bot' });
    }
    assert.ok(tokens.some(token => init.headers.Authorization === `Bearer ${token}`));
    return json({ full_name: repository, has_issues: true });
  };
  const request = createGitHubAppRequest({ ...options, app: { ...options.app, pullRequestComments }, ...(ci ? { ci } : {}) }, { fetch: fetcher, now: () => milliseconds, readPrivateKey: () => pem });
  return { request, calls, tokens, fetcher, now: () => milliseconds, advance(ms) { milliseconds += ms; }, get minted() { return minted; } };
}

test('App JWT is RS256, repository-scoped token requests use least permissions and long tokens are accepted', async () => {
  const f = fixture();
  const result = await f.request('/repos/owner/project');
  assert.equal(result.full_name, repository); assert.equal(f.minted, 1);
  assert.ok(f.tokens[0].length > 40);
  assert.equal(f.calls.some(call => call.path === '/user'), false);
  const ci = fixture({ ci: { checkApps: ['github-actions'], statusContexts: ['build'], statusActors: ['ci'] } });
  await ci.request('/repos/owner/project'); assert.equal(ci.minted, 1);
});

test('W19 App writes allow only exact review reply endpoints with explicit pull-request write permission', async () => {
  const readOnly = fixture();
  await assert.rejects(readOnly.request('/repos/owner/project/pulls/7/comments/31/replies', { method: 'POST', body: { body: 'done' } }), /limited/);
  assert.equal(readOnly.calls.length, 0);
  const writable = fixture({ pullRequestComments: true });
  await writable.request('/repos/owner/project/pulls/7/comments/31/replies', { method: 'POST', body: { body: 'done' } });
  for (const path of ['/pulls/7/comments', '/pulls/7/comments/31/replies?unexpected=1', '/pulls/7/merge']) {
    await assert.rejects(writable.request(`/repos/owner/project${path}`, { method: 'POST', body: {} }), /limited/);
  }
});

test('W20 App reads observe caller cancellation without sending the scoped GET', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.request('/repos/owner/project/issues/1', { signal: controller.signal }), /cancelled/);
  assert.equal(f.calls.length, 0);
  const active = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const request = createGitHubAppRequest(options, { now: f.now, readPrivateKey: () => pem, fetch: async (url, init) => {
    if (url.endsWith('/issues/1')) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); started();
    });
    return f.fetcher(url, init);
  } });
  const pending = request('/repos/owner/project/issues/1', { signal: active.signal });
  await ready; active.abort(); await assert.rejects(pending, /timed out|cancelled/);
});

test('concurrent App requests single-flight token minting and refresh ahead of expiry', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 12 }, () => f.request('/repos/owner/project')));
  assert.equal(f.minted, 1);
  f.advance(3_539_000); await f.request('/repos/owner/project'); assert.equal(f.minted, 1);
  f.advance(2000); await Promise.all([f.request('/repos/owner/project'), f.request('/repos/owner/project')]);
  assert.equal(f.minted, 2);
});

test('401 refresh retries GET once but never blindly retries a comment POST', async () => {
  const f = fixture(); let failures = 1;
  const request = createGitHubAppRequest(options, { now: f.now, readPrivateKey: () => pem, fetch: async (url, init) => {
    if (url.includes('/repos/') && failures-- > 0) return json({ message: 'sensitive response' }, 401);
    return f.fetcher(url, init);
  } });
  await request('/repos/owner/project'); assert.equal(f.minted, 2);
  failures = 2;
  await assert.rejects(request('/repos/owner/project'), /HTTP 401/); assert.equal(f.minted, 3);
  failures = 1;
  await assert.rejects(request('/repos/owner/project/issues/1/comments', { method: 'POST', body: { body: 'result' } }), /HTTP 401/);
  assert.equal(f.minted, 3);
  await request('/repos/owner/project'); assert.equal(f.minted, 4);
});

test('App transport rejects unscoped endpoints, traversal, redirects and non-comment mutations before sending credentials', async () => {
  const f = fixture();
  for (const endpoint of ['https://other.example/repos/owner/project', '//other.example/repos/owner/project', '/user', '/repos/other/project', '/repos/owner/project/../else', '/repos/owner/project/%2e%2e/else', '/repos/owner/project/issues/1#fragment']) {
    await assert.rejects(f.request(endpoint), /outside/);
  }
  await assert.rejects(f.request('/repos/owner/project/git/refs', { method: 'POST', body: {} }), /limited/);
  await assert.rejects(f.request('/repos/owner/project/issues/1/comments', { method: 'DELETE' }), /outside/);
  assert.equal(f.calls.length, 0);
  const redirect = createGitHubAppRequest(options, { readPrivateKey: () => pem, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) });
  await assert.rejects(redirect('/repos/owner/project'), /redirects/);
});

test('invalid token repository/permission/expiry responses are rejected without exposing credentials', async () => {
  const modifications = [
    value => ({ ...value, repositories: [{ id: 1, full_name: 'other/repository' }] }),
    value => ({ ...value, repositories: [...value.repositories, { id: 2, full_name: 'owner/other' }] }),
    value => ({ ...value, repository_selection: 'all' }),
    value => ({ ...value, permissions: { ...value.permissions, contents: 'write' } }),
    value => ({ ...value, permissions: { metadata: 'read', issues: 'read', pull_requests: 'read' } }),
    value => ({ ...value, expires_at: new Date(baseTime + 1000).toISOString() }),
  ];
  for (const modify of modifications) {
    const f = fixture({ response: ({ value, permissions, milliseconds }) => json(modify({ token: value, permissions,
      expires_at: new Date(milliseconds + 3_600_000).toISOString(), repository_selection: 'selected', repositories: [{ id: 55, full_name: repository }] })) });
    await assert.rejects(f.request('/repos/owner/project'), error => !f.tokens.some(token => error.message.includes(token)));
  }
  const failures = createGitHubAppRequest(options, { readPrivateKey: () => { throw new Error('SECRET-KEY-MATERIAL'); } });
  await assert.rejects(failures('/repos/owner/project'), error => !error.message.includes('SECRET-KEY-MATERIAL'));
});

test('App identity resolves the immutable bot ID with public user lookup and caches it', async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.request.identity(), f.request.identity()]);
  assert.deepEqual(a, { id: '4321', login: 'fixture-app[bot]', type: 'Bot', appId: '1234', installationId: 777 });
  assert.deepEqual(a, b); assert.equal(f.minted, 0); assert.equal(f.calls.length, 2);
  await f.request.identity(); assert.equal(f.calls.length, 2);
});

test('private-key references are exclusive, read only bounded regular files and reject weak or invalid keys', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-app-key-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'app.pem'); writeFileSync(path, pem, { mode: 0o600 });
  symlinkSync(path, join(root, 'linked.pem'));
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const f = fixture();
  const request = createGitHubAppRequest({ ...options, app: { appId: '1234', installationId: 777, privateKeyPath: path } }, { fetch: f.fetcher, now: f.now });
  await request('/repos/owner/project');
  for (const value of [weak, 'not a key', 'x'.repeat(65 * 1024)]) {
    const bad = createGitHubAppRequest(options, { readPrivateKey: () => value }); await assert.rejects(bad('/repos/owner/project'), /private key/);
  }
  const linked = createGitHubAppRequest({ ...options, app: { appId: '1234', installationId: 777, privateKeyPath: join(root, 'linked.pem') } });
  await assert.rejects(linked('/repos/owner/project'), /regular file/);
  assert.throws(() => createGitHubAppRequest({ ...options, app: { ...options.app, privateKeyPath: path } }), /exactly one/);
  assert.throws(() => createGitHubAppRequest({ ...options, app: { ...options.app, token: 'not-allowed' } }), /appId/);
});

test('App response bytes and server errors are bounded and never echo remote secrets', async () => {
  const oversized = createGitHubAppRequest(options, { readPrivateKey: () => pem,
    fetch: async () => new Response('unused', { headers: { 'content-length': String(17 * 1024 * 1024) } }) });
  await assert.rejects(oversized('/repos/owner/project'), /16 MiB/);
  const rejected = createGitHubAppRequest(options, { readPrivateKey: () => pem,
    fetch: async () => json({ error: 'SECRET-TOKEN-IN-RESPONSE' }, 403) });
  await assert.rejects(rejected('/repos/owner/project'), error => error.message === 'GitHub App API request failed (HTTP 403)');
});

test('App channel polls without gh, returns bot receipts and reconciles only the authenticated bot', async () => {
  const calls = [], sent = [];
  const bot = { id: 4321, login: 'fixture-app[bot]', type: 'Bot' };
  const request = async (endpoint, init) => {
    calls.push(endpoint);
    if (endpoint === '/repos/owner/project') return { full_name: repository, has_issues: true };
    if (endpoint.includes('/issues?')) return [];
    if (endpoint.includes('/issues/1/comments')) {
      if (init.method === 'POST') { const comment = { id: 987, body: init.body.body, user: bot, performed_via_github_app: { id: 1234 }, html_url: 'https://github.com/owner/project/issues/1#issuecomment-987' }; sent.push(comment); return comment; }
      return [{ id: 1, body: '<!-- js-superagent:project-1:message-1 -->', user: { id: 99, type: 'User' } }, ...sent];
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  request.identity = async () => ({ ...bot, id: String(bot.id), appId: '1234' });
  const channel = createGitHubChannel({ ...options, allowedActors: ['operator'], executable: '/deliberately-missing/gh' }, { request });
  assert.deepEqual((await channel.poll()).events, []);
  assert.equal((await channel.probe()).authentication, 'app');
  const message = { id: 'message-1', kind: 'reply', ticketId: 'ticket-1', text: 'Result',
    channel: { source: 'github', thread: 'owner/project#1', address: { repository, issueNumber: '1' } } };
  const first = await channel.deliver(message, { projectId: 'project-1' });
  assert.deepEqual(await channel.deliver(message, { projectId: 'project-1' }), first); assert.equal(sent.length, 1);
  assert.equal(calls.includes('/user'), false);
  sent[0].performed_via_github_app.id = 9999;
  await channel.deliver(message, { projectId: 'project-1' }); assert.equal(sent.length, 2);
});


test('PR comment write permission is explicit and does not broaden the write endpoint surface', async () => {
  const f = fixture({ pullRequestComments: true });
  await f.request('/repos/owner/project/issues/12/comments', { method: 'POST', body: { body: 'Owned test receipt' } });
  assert.equal(JSON.parse(f.calls.find(call => call.path.endsWith('/access_tokens')).body).permissions.pull_requests, 'write');
  await assert.rejects(f.request('/repos/owner/project/pulls', { method: 'POST', body: {} }), /limited/);
  await assert.rejects(f.request('/repos/owner/project/git/refs', { method: 'POST', body: {} }), /limited/);
  assert.throws(() => createGitHubAppRequest({ ...options, app: { ...options.app, pullRequestComments: 'true' } }), /boolean/);
});

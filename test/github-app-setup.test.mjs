import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { startGitHubAppSetup } from '../examples/github-app-setup.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const secret = 'test-webhook-secret-never-echoed';
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
async function fixture(t, fetcher, options = {}) {
  const output = await mkdtemp(join(tmpdir(), 'js-superagent-app-setup-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const events = [];
  const setup = await startGitHubAppSetup({ repository: 'owner/project', webhookUrl: 'https://hook.example/github/webhook', output, port: 0, ...options }, { fetch: fetcher, onProgress: event => events.push(event) });
  t.after(() => setup.close());
  const response = await fetch(setup.setupUrl);
  const html = await response.text();
  const manifest = JSON.parse(decode(html.match(/name="manifest" value="([^"]+)"/)[1]));
  const state = html.match(/apps\/new\?state=([a-f0-9]+)"/)[1];
  const callback = `${manifest.redirect_url}?state=${state}&code=one-time-code`;
  const installed = `${manifest.setup_url}&installation_id=456&setup_action=install`;
  return { ...setup, output, events, response, html, manifest, callback, installed };
}

test('manifest setup registers privately, writes restricted credentials, validates JWT installation, and never echoes secrets', async t => {
  const calls = [];
  const f = await fixture(t, async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/app-manifests/one-time-code/conversions')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, undefined);
      return json({ id: 123, slug: 'test-app', pem, webhook_secret: secret, client_secret: 'discard-this-secret' });
    }
    assert.equal(url, 'https://api.github.com/repos/owner/project/installation');
    const jwt = init.headers.Authorization.slice(7);
    const [header, claims, signature] = jwt.split('.');
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, '123');
    return json({ id: 456, app_id: 123, account: { login: 'Owner' }, repository_selection: 'selected', suspended_at: null });
  });
  assert.equal(f.server.address().address, '127.0.0.1');
  assert.equal(f.manifest.public, false);
  assert.deepEqual(f.manifest.default_permissions, { metadata: 'read', issues: 'write', pull_requests: 'read', checks: 'read', statuses: 'read' });
  assert.deepEqual(f.manifest.default_events, ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'check_run', 'status']);
  assert.equal(f.response.headers.get('cache-control'), 'no-store');
  assert.match(f.response.headers.get('content-security-policy'), /form-action https:\/\/github.com/);
  const created = await fetch(f.callback);
  assert.equal(created.status, 200);
  const createdHtml = await created.text();
  assert.match(createdHtml, /https:\/\/github.com\/apps\/test-app\/installations\/new/);
  for (const text of [createdHtml, JSON.stringify(f.events)]) {
    assert.ok(!text.includes(secret)); assert.ok(!text.includes(pem)); assert.ok(!text.includes('discard-this-secret'));
  }
  assert.equal(await readFile(join(f.output, '.env.github-app-key.pem'), 'utf8'), pem);
  assert.equal(await readFile(join(f.output, '.env.webhook-secret'), 'utf8'), secret);
  for (const filename of ['.env.github-app-key.pem', '.env.webhook-secret', 'app.json']) assert.equal((await stat(join(f.output, filename))).mode & 0o777, 0o600);
  assert.equal((await fetch(f.callback)).status, 200);
  assert.equal(calls.length, 1, 'one-time code is never exchanged twice');
  const installed = await fetch(f.installed);
  assert.equal(installed.status, 200);
  const metadata = JSON.parse(await readFile(join(f.output, 'app.json'), 'utf8'));
  assert.equal(metadata.installationId, 456);
  assert.deepEqual(Object.keys(metadata), ['id', 'slug', 'privateKeyPath', 'secretPath', 'settingsUrl', 'installationId']);
  assert.deepEqual(f.events.map(event => event.event), ['registered', 'installed']);
});

test('setup rejects forged state, DNS rebinding, unknown pages, and wrong installation before recording it', async t => {
  let calls = 0;
  const f = await fixture(t, async url => {
    calls++;
    if (url.includes('/app-manifests/')) return json({ id: 123, slug: 'test-app', pem, webhook_secret: secret });
    return json({ id: 999, app_id: 123, account: { login: 'owner' }, repository_selection: 'selected' });
  });
  assert.equal((await fetch(`${f.manifest.redirect_url}?state=wrong&code=one-time-code`)).status, 403);
  const forgedHostStatus = await new Promise((yes, no) => get(f.setupUrl, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); yes(response.statusCode); }).on('error', no));
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(f.setupUrl, { method: 'POST' })).status, 403);
  assert.equal((await fetch(new URL('/setup/wrong', f.setupUrl))).status, 404);
  assert.equal(calls, 0);
  await fetch(f.callback);
  assert.equal((await fetch(f.installed)).status, 502);
  assert.equal(JSON.parse(await readFile(join(f.output, 'app.json'), 'utf8')).installationId, undefined);
});

test('setup never retries a failed code exchange and refuses overwriting existing credentials', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error(`unsafe error ${secret}`); });
  const failed = await fetch(f.callback);
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes(secret));
  assert.equal((await fetch(f.callback)).status, 409);
  assert.equal(calls, 1);
  await writeFile(join(f.output, '.env.github-app-key.pem'), 'existing');
  await assert.rejects(startGitHubAppSetup({ repository: 'owner/project', webhookUrl: 'https://hook.example/github/webhook', output: f.output, port: 0 }), /already exists/);
  assert.equal(await readFile(join(f.output, '.env.github-app-key.pem'), 'utf8'), 'existing');
});

test('organization setup registers the private App under its repository owner', async t => {
  const f = await fixture(t, async () => json({ id: 123, slug: 'org-app', pem, webhook_secret: secret }), { ownerType: 'organization' });
  assert.match(f.html, /action="https:\/\/github.com\/organizations\/owner\/settings\/apps\/new\?state=/);
  assert.equal(f.manifest.public, false);
  assert.equal((await fetch(f.callback)).status, 200);
  const metadata = JSON.parse(await readFile(join(f.output, 'app.json'), 'utf8'));
  assert.equal(metadata.settingsUrl, 'https://github.com/organizations/owner/settings/apps/org-app');
});

test('a maximum-length owner keeps the proposed App name within 34 characters', async t => {
  const owner = 'a'.repeat(39);
  const f = await fixture(t, async () => { throw new Error('registration was not requested'); }, { repository: `${owner}/project` });
  assert.equal(f.manifest.name.length, 34);
  assert.match(f.manifest.name, /^js-superagent-a{13}-[a-f0-9]{6}$/);
  assert.equal(f.manifest.url, `https://github.com/${owner}/project`);
});

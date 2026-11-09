import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

function fixture(t, driver) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-credential-path-')));
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets', 'app.pem'), 'fixture-only-app-key');
  writeFileSync(join(root, 'secrets', 'webhook.secret'), 'fixture-only-webhook-secret');
  symlinkSync(join(root, 'secrets'), join(root, 'credential-alias'));
  const runtime = createProjectAgent({ projectRoot: root, driver, githubChannel: {
    async poll() { return []; }, async deliver() { throw new Error('No remote delivery expected'); },
  } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const github = kind => ({ repository: 'owner/project', allowedActors: ['alice'],
    ...(kind !== 'webhook' ? { app: { appId: '123', installationId: 456, privateKeyPath: join(root, 'credential-alias', 'app.pem') } } : {}),
    ...(kind !== 'app' ? { webhook: { secretPath: join(root, 'credential-alias', 'webhook.secret') } } : {}),
  });
  return { root, runtime, github };
}

test('copy workspaces exclude real App and Webhook credential targets behind directory symlinks', async t => {
  let calls = 0;
  const f = fixture(t, { async run(input) {
    calls++;
    assert.equal(existsSync(join(input.projectRoot, 'secrets', 'app.pem')), false);
    assert.equal(existsSync(join(input.projectRoot, 'secrets', 'webhook.secret')), false);
    assert.equal(existsSync(join(input.projectRoot, 'credential-alias')), false);
    for (const path of ['credential-alias/app.pem', 'credential-alias/webhook.secret', 'secrets/app.pem', 'secrets/webhook.secret']) {
      assert.ok(input.workspace.config.exclude.includes(path));
    }
    return { status: 'completed', summary: 'Credential targets excluded' };
  } });
  f.runtime.configure({ workspace: { mode: 'copy' }, github: f.github() });
  f.runtime.submit({ text: 'Inspect the copy workspace' });
  assert.equal((await f.runtime.runNext()).status, 'completed'); assert.equal(calls, 1);
  assert.equal(existsSync(join(f.root, 'secrets', 'app.pem')), true);
  assert.equal(existsSync(join(f.root, 'secrets', 'webhook.secret')), true);
});

test('reused copies containing a newly configured real credential target reject both secret kinds', async t => {
  for (const kind of ['app', 'webhook']) await t.test(kind, async t => {
    let calls = 0;
    const f = fixture(t, { async run() { calls++; return { status: 'completed', summary: 'Inspected workspace' }; } });
    f.runtime.configure({ workspace: { mode: 'copy' } });
    f.runtime.submit({ text: 'Inspect ordinary project files' });
    const first = await f.runtime.runNext(); assert.equal(first.status, 'completed');
    const workspace = f.runtime.getWorkspace(first.id);
    assert.equal(existsSync(join(workspace.path, 'secrets', kind === 'app' ? 'app.pem' : 'webhook.secret')), true);
    f.runtime.configure({ github: f.github(kind) });
    f.runtime.reply(first.id, 'Continue the local inspection');
    const result = await f.runtime.runNext();
    assert.equal(result.status, 'failed'); assert.equal(calls, 1);
    assert.match(result.reports.at(-1).summary, /credential is present/);
  });
});

test('worktrees reject tracked credential targets even when the configured alias is untracked', async t => {
  for (const kind of ['app', 'webhook']) await t.test(kind, async t => {
    let calls = 0;
    const f = fixture(t, { async run() { calls++; return { status: 'completed', summary: 'Unexpected execution' }; } });
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', f.root, ...args], { stdio: 'ignore' });
    git(['init', '-q']); git(['add', 'secrets']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture baseline']);
    f.runtime.configure({ workspace: { mode: 'worktree' }, github: f.github(kind) });
    f.runtime.submit({ text: 'Inspect the Git worktree' });
    const result = await f.runtime.runNext();
    assert.equal(result.status, 'failed'); assert.equal(calls, 0);
    assert.match(result.reports.at(-1).summary, /credential files must not be tracked/);
  });
});

test('missing credential files remain compatible while invalid credential ancestors fail clearly', async t => {
  let calls = 0;
  const f = fixture(t, { async run() { calls++; return { status: 'completed', summary: 'Local task verified' }; } });
  f.runtime.configure({ workspace: { mode: 'copy' }, github: { repository: 'owner/project', allowedActors: ['alice'],
    app: { appId: '123', installationId: 456, privateKeyPath: join(f.root, 'missing', 'key.pem') } } });
  f.runtime.submit({ text: 'Inspect local task with a trusted channel' });
  assert.equal((await f.runtime.runNext()).status, 'completed'); assert.equal(calls, 1);
  writeFileSync(join(f.root, 'not-a-directory'), 'fixture');
  f.runtime.configure({ github: { app: { appId: '123', installationId: 456, privateKeyPath: join(f.root, 'not-a-directory', 'key.pem') } } });
  f.runtime.submit({ text: 'Inspect a second local task' });
  const result = await f.runtime.runNext();
  assert.equal(result.status, 'failed'); assert.equal(calls, 1);
  assert.match(result.reports.at(-1).summary, /Cannot resolve configured credential path \(ENOTDIR\)/);
});

test('credential tracking treats Git pathspec metacharacters literally', async t => {
  for (const tracked of [false, true]) await t.test(tracked ? 'tracked literal name is rejected' : 'untracked pattern-like name does not match other tracked files', async t => {
    let calls = 0;
    const f = fixture(t, { async run() { calls++; return { status: 'completed', summary: 'Literal credential path checked' }; } });
    const filename = tracked ? ':(literal)app[1]*.pem' : 'secrets/[ab]*.pem';
    writeFileSync(join(f.root, filename), 'fixture-only-key');
    writeFileSync(join(f.root, 'secrets', 'a.pem'), 'ordinary tracked fixture');
    const git = args => execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-C', f.root, ...args], { stdio: 'ignore' });
    git(['init', '-q']); git(['add', 'secrets/a.pem']); if (tracked) git(['add', '--', filename]);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Literal path fixture']);
    f.runtime.configure({ workspace: { mode: 'worktree' }, github: { repository: 'owner/project', allowedActors: ['alice'],
      app: { appId: '123', installationId: 456, privateKeyPath: join(f.root, filename) } } });
    f.runtime.submit({ text: 'Inspect literal credential path handling' });
    const result = await f.runtime.runNext();
    assert.equal(result.status, tracked ? 'failed' : 'completed'); assert.equal(calls, tracked ? 0 : 1);
    if (tracked) assert.match(result.reports.at(-1).summary, /credential files must not be tracked/);
  });
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProjectConfig, readProjectConfig, writeProjectConfig, mergeProjectConfig, validateProjectOptions } from '../src/config.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(stateDir(root), 'config.json') };
}

test('configuration persists execution and workspace options with canonical project-relative executable paths', t => {
  const { root, file } = fixture(t);
  const config = initializeProjectConfig(root, {
    workspace: { mode: 'auto', exclude: ['cache/', 'cache', 'scratch/output'] },
    execution: { driver: 'codex-app-server', executable: './tools/codex', model: 'model-A', timeoutMs: 5000, killGraceMs: 50 },
  });
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.workspace.mode, 'auto');
  assert.deepEqual(config.workspace.exclude, ['cache', 'scratch/output']);
  assert.equal(config.execution.executable, join(root, 'tools/codex'));
  assert.deepEqual(readProjectConfig(root), config);
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(initializeProjectConfig(root), config);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => initializeProjectConfig(root, { workspace: { mode: 'copy' } }), /config set/);
  assert.equal(readFileSync(file, 'utf8'), before);
  const changed = writeProjectConfig(root, { execution: { model: 'model-B' }, workspace: { mode: 'copy' } });
  assert.equal(changed.projectId, config.projectId);
  assert.equal(changed.execution.model, 'model-B');
  assert.equal(changed.execution.timeoutMs, 5000);
  assert.equal(changed.workspace.mode, 'copy');
  assert.deepEqual(readdirSync(stateDir(root)), ['config.json']);
});

test('legacy configuration is normalized read-only and upgrades only on explicit write', t => {
  const { root, file } = fixture(t);
  mkdirSync(stateDir(root));
  const bytes = JSON.stringify({ schemaVersion: 1, projectId: 'legacy-project', concurrency: 1, workspace: 'in-place' });
  writeFileSync(file, bytes);
  const current = readProjectConfig(root);
  assert.equal(current.projectId, 'legacy-project');
  assert.deepEqual(current.workspace, { mode: 'in-place' });
  initializeProjectConfig(root);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const changed = writeProjectConfig(root, { execution: { driver: 'codex-app-server', model: 'chosen-model' } });
  assert.equal(changed.schemaVersion, 2);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 2);
});

test('validation rejects unsupported options and malformed values before creating state', t => {
  const { root } = fixture(t);
  for (const patch of [
    { environment: { API_KEY: 'secret' } }, { execution: { driver: 'unknown' } },
    { execution: { driver: 'codex' } }, { execution: { driver: 'dsh-headless' } },
    { execution: { driver: 'codex-app-server', env: {} } }, { execution: { model: '' } },
    { execution: { executable: 'cmd\nnext' } }, { execution: { timeoutMs: 86_400_001 } },
    { execution: { killGraceMs: 0 } }, { workspace: { mode: 'unknown' } },
    { workspace: { mode: 'copy', exclude: ['../secret'] } }, { workspace: { exclude: ['/outside'] } },
    { workspace: { exclude: ['node_modules/**'] } }, { workspace: { exclude: ['.'] } },
    { workspace: { baseRef: '--option' } },
  ]) assert.throws(() => initializeProjectConfig(root, patch), Error);
  assert.equal(existsSync(stateDir(root)), false);
});

test('read rejects invalid versions, unknown persisted fields and malformed JSON without rewriting', t => {
  const { root, file } = fixture(t);
  mkdirSync(stateDir(root));
  for (const data of [
    '{invalid', JSON.stringify({ schemaVersion: 3, projectId: 'p', concurrency: 1, workspace: { mode: 'auto' } }),
    JSON.stringify({ schemaVersion: 2, projectId: 'p', concurrency: 2, workspace: { mode: 'auto' } }),
    JSON.stringify({ schemaVersion: 2, projectId: 'p', concurrency: 1, workspace: { mode: 'auto' }, token: 'secret' }),
    JSON.stringify({ schemaVersion: 2, projectId: 'p', concurrency: 1, workspace: 'auto' }),
  ]) {
    writeFileSync(file, data);
    assert.throws(() => readProjectConfig(root));
    assert.equal(readFileSync(file, 'utf8'), data);
  }
});

test('invocation configuration overrides only supplied fields and never mutates persisted input', t => {
  const { root, file } = fixture(t);
  const config = initializeProjectConfig(root, { execution: { driver: 'codex-app-server', model: 'persisted', timeoutMs: 3000 } });
  const before = readFileSync(file, 'utf8');
  const effective = mergeProjectConfig(config, { execution: { model: 'invocation' } });
  assert.equal(effective.execution.model, 'invocation');
  assert.equal(effective.execution.timeoutMs, 3000);
  assert.equal(config.execution.model, 'persisted');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(validateProjectOptions({ workspace: 'copy' }), { workspace: { mode: 'copy' } });
});

test('state and config symlinks including dangling links are rejected without touching targets', t => {
  const { root } = fixture(t);
  const outside = join(root, 'outside'); mkdirSync(outside);
  const state = stateDir(root);
  symlinkSync(outside, state, 'dir');
  assert.throws(() => initializeProjectConfig(root), /real directory/);
  assert.deepEqual(readdirSync(outside), []);
  rmSync(state); mkdirSync(state);
  const config = join(state, 'config.json');
  symlinkSync(join(outside, 'missing.json'), config);
  assert.throws(() => initializeProjectConfig(root), /regular file/);
  assert.throws(() => readProjectConfig(root), /regular file/);
  assert.deepEqual(readdirSync(outside), []);
});

test('oversized configuration writes fail before replacing valid state or creating new state', t => {
  const { root, file } = fixture(t);
  const giant = { execution: { model: '界'.repeat(30_000) } };
  assert.throws(() => initializeProjectConfig(root, giant), /64 KiB/);
  assert.equal(existsSync(stateDir(root)), false);
  initializeProjectConfig(root, { execution: { driver: 'codex-app-server', model: 'original' } });
  const original = readFileSync(file, 'utf8');
  assert.throws(() => writeProjectConfig(root, giant), /64 KiB/);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(readProjectConfig(root).execution.model, 'original');
  assert.deepEqual(readdirSync(stateDir(root)), ['config.json']);
});

test('GitHub settings persist canonical authority and merge without losing intake scope', t => {
  const { root, file } = fixture(t);
  const config = initializeProjectConfig(root, { github: {
    repository: 'Owner/Repository', allowedActors: ['Alice', 'alice', 'Bob'], issues: [12, 3, 12], executable: './tools/gh',
  } });
  assert.equal(config.github.repository, 'owner/repository');
  assert.deepEqual(config.github.allowedActors, ['alice', 'bob']);
  assert.deepEqual(config.github.issues, [12, 3]);
  assert.equal(config.github.command, '/js-superagent');
  assert.equal(config.github.pollIntervalMs, 30_000);
  assert.equal(config.github.executable, join(root, 'tools/gh'));
  assert.deepEqual(readProjectConfig(root), config);
  const changed = writeProjectConfig(root, { github: { pollIntervalMs: 1000, command: '/repair' } });
  assert.deepEqual(changed.github.issues, [12, 3]);
  assert.deepEqual(changed.github.allowedActors, ['alice', 'bob']);
  const bytes = readFileSync(file, 'utf8');
  assert.throws(() => writeProjectConfig(root, { github: { allowedActors: [] } }));
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const disabled = writeProjectConfig(root, { github: null });
  assert.equal(disabled.github, undefined);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).github, undefined);
  assert.throws(() => writeProjectConfig(root, { github: { pollIntervalMs: 3000 } }));
});

test('GitHub configuration rejects broad, malformed or secret-bearing settings before state creation', t => {
  const { root } = fixture(t);
  const valid = { repository: 'owner/repo', allowedActors: ['alice'] };
  const bad = [
    { repository: 'https://github.com/owner/repo' }, { repository: 'owner/repo/issues/1' },
    { repository: '../repo' }, { repository: 'owner/..' }, { repository: 'owner/repo?query' },
    { repository: 'owner/' }, { allowedActors: [] }, { allowedActors: ['*'] },
    { allowedActors: ['alice[bot]'] }, { allowedActors: ['alice name'] },
    { issues: [] }, { issues: [0] }, { issues: [1.5] }, { issues: ['1'] },
    { command: '/run work' }, { command: 'run' }, { executable: 'gh\nnext' },
    { pollIntervalMs: 999 }, { pollIntervalMs: 86_400_001 },
    { token: 'do-not-store' }, { env: {} }, { hostname: 'enterprise.example' },
  ];
  for (const patch of bad) assert.throws(() => initializeProjectConfig(root, { github: { ...valid, ...patch } }), Error);
  assert.throws(() => initializeProjectConfig(root, { github: { repository: valid.repository } }));
  assert.throws(() => initializeProjectConfig(root, { github: { allowedActors: valid.allowedActors } }));
  assert.equal(existsSync(stateDir(root)), false);
});

test('legacy projects can explicitly enable GitHub without changing project identity or local defaults', t => {
  const { root, file } = fixture(t);
  mkdirSync(stateDir(root));
  const legacy = JSON.stringify({ schemaVersion: 1, projectId: 'old-local-project', concurrency: 1, workspace: 'in-place' });
  writeFileSync(file, legacy);
  assert.equal(readProjectConfig(root).github, undefined);
  assert.equal(readFileSync(file, 'utf8'), legacy);
  const changed = writeProjectConfig(root, { github: { repository: 'owner/repo', allowedActors: ['alice'] } });
  assert.equal(changed.projectId, 'old-local-project');
  assert.equal(changed.workspace.mode, 'in-place');
  assert.equal(changed.execution, undefined);
  assert.equal(changed.github.repository, 'owner/repo');
});

test('GitHub CI policies are explicit, canonical, replaced as a whole and independently removable', t => {
  const { root, file } = fixture(t);
  const original = initializeProjectConfig(root, { github: { repository: 'owner/repo', allowedActors: ['alice'] } });
  assert.equal(original.github.ci, undefined);
  const configured = writeProjectConfig(root, { github: { ci: {
    checkApps: ['GitHub-Actions', 'github-actions'],
    statusContexts: ['CI / test', 'CI / test', 'ci / test'], statusActors: ['Alice', 'alice', 'Build-Bot[bot]'],
  } } });
  assert.deepEqual(configured.github.ci, {
    checkApps: ['github-actions'], statusContexts: ['CI / test', 'ci / test'], statusActors: ['alice', 'build-bot[bot]'],
  });
  assert.deepEqual(readProjectConfig(root), configured);
  assert.deepEqual(writeProjectConfig(root, { github: { pollIntervalMs: 2000 } }).github.ci, configured.github.ci);
  const replaced = writeProjectConfig(root, { github: { ci: { checkApps: ['another-app'] } } });
  assert.deepEqual(replaced.github.ci, { checkApps: ['another-app'] });
  assert.deepEqual(replaced.github.allowedActors, ['alice']);
  const disabled = writeProjectConfig(root, { github: { ci: null } });
  assert.equal(disabled.github.ci, undefined);
  assert.equal(disabled.github.repository, original.github.repository);
  assert.equal(disabled.github.pollIntervalMs, 2000);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).github.ci, undefined);
  assert.equal(disabled.projectId, original.projectId);
});

test('invalid or incomplete CI allowlists cannot broaden an existing configuration', t => {
  const { root, file } = fixture(t);
  const config = initializeProjectConfig(root, { github: {
    repository: 'owner/repo', allowedActors: ['alice'], ci: { checkApps: ['github-actions'] },
  } });
  const before = readFileSync(file, 'utf8');
  for (const ci of [
    {}, [], { checkApps: [] }, { checkApps: ['*'] }, { checkApps: ['-app'] }, { checkApps: ['app-'] },
    { checkApps: ['app/name'] }, { checkApps: ['app name'] }, { checkApps: ['a'.repeat(101)] },
    { statusContexts: ['ci/test'] }, { statusActors: ['alice'] },
    { statusContexts: [], statusActors: ['alice'] }, { statusContexts: ['ci/test'], statusActors: [] },
    { statusContexts: [''], statusActors: ['alice'] }, { statusContexts: ['ci\ttest'], statusActors: ['alice'] },
    { statusContexts: ['a'.repeat(256)], statusActors: ['alice'] },
    { statusContexts: ['ci/test'], statusActors: ['*'] }, { statusContexts: ['ci/test'], statusActors: ['app[owner]'] },
    { checkApps: ['github-actions'], token: 'secret' }, { checkApps: ['github-actions'], env: {} },
  ]) {
    assert.throws(() => writeProjectConfig(root, { github: { ci } }), Error);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  writeFileSync(file, JSON.stringify({ ...config, github: { ...config.github, ci: null } }));
  assert.throws(() => readProjectConfig(root), /github.ci must be an object/);
});

test('App and Webhook configurations retain only secret references and replace independently', t => {
  const { root, file } = fixture(t);
  const first = initializeProjectConfig(root, { github: { repository: 'owner/repo', allowedActors: ['alice'],
    app: { appId: '123', installationId: 456, privateKeyEnv: 'TEST_GITHUB_PRIVATE_KEY' },
    webhook: { secretEnv: 'TEST_GITHUB_WEBHOOK_SECRET' },
  } });
  assert.deepEqual(first.github.app, { appId: '123', installationId: 456, privateKeyEnv: 'TEST_GITHUB_PRIVATE_KEY' });
  assert.deepEqual(first.github.webhook, { secretEnv: 'TEST_GITHUB_WEBHOOK_SECRET', host: '127.0.0.1', port: 8787, path: '/github/webhook', maxBodyBytes: 1048576 });
  assert.deepEqual(readProjectConfig(root), first);
  const changed = writeProjectConfig(root, { github: {
    app: { appId: '789', installationId: 1000, privateKeyPath: './secrets/app.pem' },
    webhook: { secretPath: './secrets/hook.txt', host: '::1', port: 0, path: '/events', maxBodyBytes: 2048 },
  } });
  assert.equal(changed.github.app.privateKeyPath, join(root, 'secrets/app.pem'));
  assert.equal(changed.github.app.privateKeyEnv, undefined);
  assert.equal(changed.github.webhook.secretPath, join(root, 'secrets/hook.txt'));
  assert.equal(changed.github.webhook.secretEnv, undefined);
  assert.equal(changed.github.webhook.port, 0);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => writeProjectConfig(root, { github: { app: { installationId: 2 } } }));
  assert.throws(() => writeProjectConfig(root, { github: { webhook: { port: 1234 } } }));
  assert.equal(readFileSync(file, 'utf8'), before);
  const noApp = writeProjectConfig(root, { github: { app: null } });
  assert.equal(noApp.github.app, undefined);
  assert.deepEqual(noApp.github.webhook, changed.github.webhook);
  const noHook = writeProjectConfig(root, { github: { webhook: null } });
  assert.equal(noHook.github.webhook, undefined);
  assert.equal(noHook.github.repository, 'owner/repo');
  assert.deepEqual(noHook.github.allowedActors, ['alice']);
});

test('App settings reject raw credentials and invalid identities before creating project state', t => {
  const { root } = fixture(t);
  const valid = { appId: '123', installationId: 456, privateKeyEnv: 'PRIVATE_KEY' };
  for (const app of [
    {}, { ...valid, appId: 123 }, { ...valid, appId: '0' }, { ...valid, appId: '01' }, { ...valid, appId: 'app-client' },
    { ...valid, appId: '9007199254740992' }, { ...valid, installationId: 0 }, { ...valid, installationId: '456' },
    { ...valid, privateKeyEnv: 'KEY=value' }, { ...valid, privateKeyEnv: 'A\nB' },
    { ...valid, privateKeyPath: 'app.pem' }, { appId: '123', installationId: 456 },
    { appId: '123', installationId: 456, privateKeyPath: '' }, { appId: '123', installationId: 456, privateKeyPath: 'a\0b' },
    { ...valid, privateKey: 'raw-private-key' }, { ...valid, token: 'raw-token' }, { ...valid, apiUrl: 'https://other.example' },
  ]) assert.throws(() => initializeProjectConfig(root, { github: { repository: 'owner/repo', allowedActors: ['alice'], app } }));
  assert.equal(existsSync(stateDir(root)), false);
});

test('Webhook settings reject ambiguous secret sources, invalid binding routes and oversized payloads', t => {
  const { root, file } = fixture(t);
  initializeProjectConfig(root, { github: { repository: 'owner/repo', allowedActors: ['alice'], webhook: { secretEnv: 'HOOK_SECRET' } } });
  const before = readFileSync(file, 'utf8');
  for (const webhook of [
    {}, { secret: 'plaintext-secret' }, { secretEnv: 'HOOK', secretPath: 'hook.txt' }, { secretEnv: '' }, { secretEnv: 'HOOK TOKEN' },
    { secretPath: 'x\ny' }, { secretEnv: 'HOOK', host: 'https://localhost' }, { secretEnv: 'HOOK', host: '-host' },
    { secretEnv: 'HOOK', port: -1 }, { secretEnv: 'HOOK', port: 65536 }, { secretEnv: 'HOOK', port: 1.5 },
    { secretEnv: 'HOOK', path: 'relative' }, { secretEnv: 'HOOK', path: '/hook?secret=x' },
    { secretEnv: 'HOOK', path: '/a/../b' }, { secretEnv: 'HOOK', path: '//hook' },
    { secretEnv: 'HOOK', maxBodyBytes: 0 }, { secretEnv: 'HOOK', maxBodyBytes: 26214401 },
    { secretEnv: 'HOOK', bypassSignature: true },
  ]) {
    assert.throws(() => writeProjectConfig(root, { github: { webhook } }));
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  const changed = writeProjectConfig(root, { github: { webhook: { secretEnv: 'HOOK', host: '0.0.0.0', port: 65535, path: '/', maxBodyBytes: 26214400 } } });
  assert.equal(changed.github.webhook.port, 65535);
  assert.equal(changed.github.webhook.maxBodyBytes, 26214400);
});

test('W30 App review write opt-in persists separately and defaults unchanged', t => {
  const {root}=fixture(t),github={repository:'owner/repo',allowedActors:['alice'],app:{appId:'1',installationId:2,privateKeyEnv:'APP_KEY'}};
  initializeProjectConfig(root,{github});assert.equal(readProjectConfig(root).github.app.pullRequestReviews,undefined);
  const enabled=mergeProjectConfig(readProjectConfig(root),{github:{app:{...github.app,pullRequestReviews:true}}});assert.equal(enabled.github.app.pullRequestReviews,true);
  assert.throws(()=>mergeProjectConfig(readProjectConfig(root),{github:{app:{...github.app,pullRequestReviews:'true'}}}),/pullRequestReviews/);
});

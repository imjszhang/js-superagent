import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkProjectSetup } from '../src/setup.mjs';
import { initializeProjectConfig } from '../src/config.mjs';
import { ensureProjectIdentity } from '../src/project-identity.mjs';
import { createHarnessRegistry } from '../src/harness/registry.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    return [name, stat.isDirectory() ? snapshot(path) : { mode: stat.mode, data: readFileSync(path).toString('base64') }];
  }));
}
function fixture(t, { initialized = true, execution = { driver: 'codex-app-server' }, github, schema = 14, selected } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-setup-'))), root = join(base, 'project');
  mkdirSync(root); t.after(() => rmSync(base, { recursive: true, force: true }));
  if (initialized) {
    const config = initializeProjectConfig(root, { ...(execution ? { execution } : {}), ...(github ? { github } : {}) });
    ensureProjectIdentity(root, config.projectId);
    const db = new DatabaseSync(join(stateDir(root), 'state.sqlite'));
    try {
      db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = ${schema}`);
      if (selected) db.prepare('INSERT INTO kv VALUES (?,?)').run('executor:settings', JSON.stringify({ revision: 4, execution: selected }));
    } finally { db.close(); }
  }
  const calls = [], deps = {
    directory: join(base, 'machine'), platform: 'darwin', executableAvailable: () => true,
    serviceManager: {
      status() { calls.push('status'); return { installed: true, running: false, loaded: false }; },
      health() { calls.push('health'); return { state: 'stopped' }; },
      start() { calls.push('start'); throw new Error('must not start'); },
      install() { calls.push('install'); throw new Error('must not install'); },
    },
  };
  return { base, root, deps, calls };
}
const check = (report, id) => report.checks.find(item => item.id === id);

test('setup checks an uninitialized directory without creating state or inspecting services', async t => {
  const f = fixture(t, { initialized: false }), before = snapshot(f.base);
  const report = await checkProjectSetup({ projectRoot: f.root }, f.deps);
  assert.equal(report.status, 'blocked');
  assert.equal(check(report, 'project').status, 'blocked');
  assert.deepEqual(snapshot(f.base), before);
  assert.deepEqual(f.calls, []);
});

test('static setup checks leave project, machine registration and a stopped service unchanged', async t => {
  const f = fixture(t, { github: { repository: 'owner/repo', allowedActors: ['owner'] } });
  const calls = [], registry = createHarnessRegistry(), before = snapshot(f.base);
  const report = await checkProjectSetup({ projectRoot: f.root }, {
    ...f.deps,
    harnessRegistry: { ...registry, probeExecution() { calls.push('probe'); throw new Error('no metadata process'); } },
    execFileSync() { calls.push('login'); throw new Error('no login process'); },
    githubChannel: { probe() { calls.push('github'); throw new Error('no network'); } },
  });
  assert.equal(check(report, 'node').status, 'passed');
  assert.equal(check(report, 'database').status, 'passed');
  assert.equal(check(report, 'executor-settings').status, 'passed');
  assert.equal(check(report, 'executor-probe').status, 'unchecked');
  assert.equal(check(report, 'github-access').status, 'unchecked');
  assert.equal(check(report, 'service-health').message, 'Service state: stopped.');
  assert.equal(check(report, 'service-deployment').status, 'unchecked');
  assert.deepEqual(calls, []);
  assert.deepEqual(f.calls, ['status', 'health']);
  assert.deepEqual(snapshot(f.base), before);
  assert.equal(existsSync(f.deps.directory), false);
});

test('setup uses the persisted DSH SDK selection and probes metadata without a model or Codex login', async t => {
  const selected = { driver: 'dsh-sdk', executable: './bin/dsh', model: 'deepseek-test',
    backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'JS_SUPERAGENT_SETUP_TEST_KEY' },
    permission: 'workspace-write', enableManagedJobs: true };
  const old = process.env.JS_SUPERAGENT_SETUP_TEST_KEY;
  process.env.JS_SUPERAGENT_SETUP_TEST_KEY = 'SECRET-MODEL-KEY';
  t.after(() => { if (old === undefined) delete process.env.JS_SUPERAGENT_SETUP_TEST_KEY; else process.env.JS_SUPERAGENT_SETUP_TEST_KEY = old; });
  const f = fixture(t, { selected }), registry = createHarnessRegistry(), probes = [], before = snapshot(f.base);
  const report = await checkProjectSetup({ projectRoot: f.root, checkConnections: true }, {
    ...f.deps,
    harnessRegistry: { ...registry, async probeExecution(execution, options) {
      probes.push({ execution, options });
      return { ok: true, checks: [{ message: 'Metadata only; SECRET-RAW-PROBE-OUTPUT' }] };
    } },
    execFileSync() { assert.fail('DSH must not run Codex login'); },
  });
  assert.equal(check(report, 'executor-settings').message, 'Selected adapter: dsh-sdk.');
  assert.equal(check(report, 'model-credential').status, 'passed');
  assert.equal(check(report, 'executor-probe').status, 'passed');
  assert.equal(probes.length, 1);
  assert.equal(probes[0].execution.executable, join(f.root, 'bin/dsh'));
  assert.equal(probes[0].execution.backend.apiKeyEnv, selected.backend.apiKeyEnv);
  assert.deepEqual(probes[0].options, { checkExecutable: true, timeoutMs: 5000 });
  assert.equal(check(report, 'codex-login'), undefined);
  assert.doesNotMatch(JSON.stringify(report), /SECRET-/);
  assert.deepEqual(snapshot(f.base), before);
  assert.deepEqual(f.calls, ['status', 'health']);
});

test('explicit connection checks use only metadata, login status and read-only repository requests', async t => {
  const github = { repository: 'owner/repo', allowedActors: ['owner'], account: { login: 'agent-bot' }, executable: '/test/gh-agent' };
  const f = fixture(t, { github }), requests = [], commands = [], registry = createHarnessRegistry();
  const request = async (endpoint, options) => {
    requests.push({ endpoint, method: options.method });
    if (endpoint === '/user') return { id: 7, login: 'agent-bot', type: 'User' };
    return { id: 11, full_name: 'owner/repo', has_issues: true, permissions: { push: true } };
  };
  request.notifications = async (endpoint, options) => { requests.push({ endpoint, method: options.method }); return []; };
  const report = await checkProjectSetup({ projectRoot: f.root, checkConnections: true }, {
    ...f.deps,
    harnessRegistry: { ...registry, async probeExecution(execution, options) { commands.push({ execution, options }); return { ok: true }; } },
    execFileSync(executable, args) { commands.push({ executable, args }); return 'Logged in'; },
    githubChannel: createGitHubChannel(github, { request }),
  });
  assert.equal(check(report, 'codex-login').status, 'passed');
  assert.equal(check(report, 'github-access').status, 'passed');
  assert.equal(check(report, 'github-write-permissions').status, 'passed');
  assert.deepEqual(commands[1], { executable: 'codex', args: ['login', 'status'] });
  assert.deepEqual(requests.map(item => item.endpoint), ['/user', '/repos/owner/repo', '/repos/owner/repo/notifications?all=true&per_page=1']);
  assert.ok(requests.every(item => item.method === 'GET'));
  assert.deepEqual(f.calls, ['status', 'health']);
});

test('connection failures and credential files never leak private error or credential contents', async t => {
  const f = fixture(t, { github: { repository: 'owner/repo', allowedActors: ['owner'],
    app: { appId: '12', installationId: 34, privateKeyPath: './private.pem' },
    webhook: { secretPath: './webhook.secret' } } });
  writeFileSync(join(f.root, 'private.pem'), 'SECRET-PRIVATE-KEY');
  writeFileSync(join(f.root, 'webhook.secret'), 'SECRET-WEBHOOK');
  const registry = createHarnessRegistry();
  const report = await checkProjectSetup({ projectRoot: f.root, checkConnections: true }, {
    ...f.deps,
    harnessRegistry: { ...registry, async probeExecution() { return { ok: false, checks: [{ message: 'SECRET-PROBE-OUTPUT' }] }; } },
    execFileSync() { throw Object.assign(new Error('SECRET-LOGIN-ERROR'), { stdout: 'SECRET-LOGIN-OUTPUT' }); },
    githubChannel: { async probe() { throw new Error('SECRET-TOKEN-IN-URL'); } },
  });
  assert.equal(check(report, 'executor-probe').status, 'blocked');
  assert.equal(check(report, 'codex-login').status, 'blocked');
  assert.equal(check(report, 'github-access').status, 'blocked');
  assert.equal(check(report, 'app-key').status, 'passed');
  assert.equal(check(report, 'webhook-secret').status, 'passed');
  assert.doesNotMatch(JSON.stringify(report), /SECRET-/);
  assert.deepEqual(f.calls, ['status', 'health']);
});

test('missing execution and unsupported database schema are reported without initializing or migrating', async t => {
  const f = fixture(t, { execution: null, schema: 9 }), before = snapshot(f.base);
  const report = await checkProjectSetup({ projectRoot: f.root }, f.deps);
  assert.equal(report.status, 'blocked');
  assert.equal(check(report, 'database').status, 'blocked');
  assert.equal(check(report, 'executor-settings').message, 'No execution adapter is configured.');
  assert.deepEqual(snapshot(f.base), before);
});

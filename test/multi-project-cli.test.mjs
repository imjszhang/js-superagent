import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createMachineCoordinator } from '../src/machine-coordination.mjs';
import { initializeProjectConfig } from '../src/config.mjs';

const cli = fileURLToPath(new URL('../bin/js-superagent.mjs', import.meta.url));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'js-multi-cli-')), root = join(base, 'project'), directory = join(base, 'machine'), preload = join(base, 'preload.mjs');
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(preload, `import {MACHINE_DEPENDENCIES} from ${JSON.stringify(new URL('../src/runtime/machine-guard.mjs', import.meta.url).href)};globalThis[MACHINE_DEPENDENCIES]={directory:${JSON.stringify(directory)}};`);
  const run = (...args) => spawnSync(process.execPath, ['--import', preload, cli, '--project', root, ...args], { encoding: 'utf8', timeout: 10000 });
  const json = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  return { base, root, directory, preload, run, json };
}

test('machine commands are isolated from project state and read-only inspection does not create the registry', t => {
  const f = fixture(t);
  assert.equal(f.json('machine', 'status').initialized, false);
  assert.deepEqual(f.json('projects', 'list'), []);
  assert.equal(existsSync(f.directory), false);
  assert.equal(existsSync(stateDir(f.root)), false);
  assert.deepEqual(f.json('machine', 'limits', 'set', '--max-active-executions', '2'), { maxActiveExecutions: 2 });
  assert.equal(f.json('machine', 'status').limits.maxActiveExecutions, 2);
  assert.deepEqual(f.json('machine', 'limits', 'clear'), { maxActiveExecutions: null });
  assert.equal(existsSync(stateDir(f.root)), false);
});

test('setup check is read-only before initialization and connection probing is explicit', t => {
  const f = fixture(t);
  const result = f.run('setup', 'check');
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'blocked');
  assert.equal(report.checkConnections, false);
  assert.equal(report.checks.find(check => check.id === 'project').status, 'blocked');
  assert.equal(f.run('status', '--check-connections').status, 1);
  assert.equal(existsSync(stateDir(f.root)), false);
  assert.equal(existsSync(f.directory), false);
});

test('diagnostic CLI commands expose stored facts and never initialize a missing project',t=>{
  const f=fixture(t);
  assert.equal(f.run('diagnostics','events').status,1);
  assert.equal(existsSync(stateDir(f.root)),false);
  f.json('init');
  assert.deepEqual(f.json('diagnostics','events').items,[]);
  assert.deepEqual(f.json('diagnostics','replies').items,[]);
  assert.equal(f.json('diagnostics','event','missing'),null);
});

test('CLI exposes control receipts and rejects queue submission while the owner is stopped', t => {
  const f = fixture(t); f.json('init');
  assert.deepEqual(f.json('control', 'list'), []);
  const request = join(f.base, 'control.json');
  writeFileSync(request, JSON.stringify({requestId:'verify-once',method:'verifyTicket',args:['missing-ticket']}));
  const result = f.run('control', 'request', request);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owning runtime|owner/i);
  assert.deepEqual(f.json('control', 'list'), []);
  assert.equal(f.json('doctor').machine.leases?.length ?? 0, 0);
});

test('new maintenance flags reject ambiguous/misplaced operations before initializing anything', t => {
  const f = fixture(t);
  for (const args of [
    ['project', 'reinitialize', '--apply'], ['project', 'reinitialize', '--as-new'],
    ['project', 'reinitialize', '--as-new', '--plan', '--apply'], ['project', 'relocate', '--plan'],
    ['project', 'inspect', '--apply'], ['status', '--from', '/old'], ['machine', 'limits', 'set'],
    ['machine', 'limits', 'set', '--max-active-executions', '0'], ['machine', 'limits', 'set', '--max-active-executions', '1025'],
    ['machine', 'limits', 'clear', '--max-active-executions', '2'], ['machine', 'status', '--port', 'auto'],
    ['github', 'binding', 'release'], ['github', 'binding', 'status', '--apply'], ['status', '--webhook-port', '0'],
  ]) assert.equal(f.run(...args).status, 1, args.join(' '));
  assert.equal(existsSync(stateDir(f.root)), false);
  assert.equal(existsSync(f.directory), false);
  assert.match(f.run('--help').stdout, /schema 15/);
  assert.match(f.run('--help').stdout, /machine limits set/);
});

test('CLI initializes and upgrades local state, exposes repository ownership without remote calls, and requires reviewed release', t => {
  const f = fixture(t);
  const initialized = f.json('init', '--github-repo', 'owner/repo', '--github-actor', 'alice');
  const upgraded = f.json('upgrade'); assert.equal(upgraded.schemaVersion, 15);
  const machine = createMachineCoordinator({ projectRoot: f.root, projectId: initialized.projectId }, { directory: f.directory });
  machine.register(); machine.claimRepository({ repository: 'owner/repo', repositoryId: 23 }); machine.close();
  assert.equal(f.json('github', 'binding', 'status').bindings[0].repositoryId, 23);
  assert.equal(f.json('github', 'binding', 'release', '--plan').safe, true);
  assert.equal(f.json('github', 'binding', 'status').bindings.length, 1);
  assert.equal(f.json('github', 'binding', 'release', '--apply').released, true);
  assert.deepEqual(f.json('github', 'binding', 'status').bindings, []);
  assert.equal(f.json('projects', 'list').length, 1);
  const doctor = f.json('doctor'); assert.equal(doctor.identity.initialized, true); assert.deepEqual(doctor.conflicts, []);
});

test('invocation-only Webhook port validation leaves shared configuration untouched', t => {
  const f = fixture(t);
  f.json('init');
  const path = join(stateDir(f.root), 'config.json'), before = readFileSync(path, 'utf8');
  const result = f.run('github', 'listen', '--webhook-port', '0');
  assert.equal(result.status, 1); assert.match(result.stderr, /Configure github.webhook/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(f.run('github', 'listen', '--webhook-port', '65536').status, 1);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('doctor reports overlapping execution and shared resource boundaries without acquiring a lease', t => {
  const f = fixture(t); f.json('init'); f.json('upgrade');
  const parentConfig = initializeProjectConfig(f.base);
  const parent = createMachineCoordinator({ projectRoot: f.base, projectId: parentConfig.projectId }, { directory: f.directory });
  parent.register();
  const lease = parent.acquireLease();
  try {
    const result = f.run('doctor'); assert.equal(result.status, 1, result.stderr);
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.directoryOverlap.overlaps.length, 1);
    assert.equal(facts.directoryOverlap.overlaps[0].active, true);
    assert.equal(facts.sharedResources.managedCommandPorts, 'not-reserved-by-runtime');
    assert.equal(facts.harnessIsolation.codex.loginAndGlobalSettings, 'shared-user');
    assert.equal(parent.status().leases.length, 1, 'doctor must not acquire execution');
  } finally { parent.releaseLease(lease); parent.close(); }
  assert.equal(f.json('doctor').directoryOverlap.overlaps[0].active, false);
});

test('serve preserves a persisted DSH adapter and emits ready only after local startup without model work', async t => {
  const f = fixture(t); f.json('init');
  const executionPath = join(f.base, 'executor.json'), executable = join(f.base, 'fake-dsh.mjs'), receipt = join(f.base, 'unexpected-harness-call');
  writeFileSync(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(receipt)},'called');process.exit(7);`, { mode: 0o700 });
  writeFileSync(executionPath, JSON.stringify({ driver: 'dsh-sdk', executable, model: 'fixture', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://example.invalid', apiKeyEnv: 'JS_TEST_NO_MODEL_KEY' } }));
  f.json('executor', 'set', executionPath, '0');
  const child = spawn(process.execPath, ['--import', f.preload, cli, '--project', f.root, 'serve'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', stderr = '', ready = false;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', value => { if (value?.type === 'js-superagent:ready') ready = true; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const deadline = Date.now() + 3000;
  while ((!output.includes('\n') || !ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ready, true, stderr); assert.equal(JSON.parse(output.trim().split('\n')[0]).driver, 'dsh-sdk');
  assert.equal(existsSync(receipt), false);
  const closed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await closed;
  assert.equal(child.exitCode, 143, stderr);
  assert.equal(f.json('machine', 'status').leases.length, 0);
});

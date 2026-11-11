import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { BusinessHealthRegistry } from '../src/runtime/business-health.mjs';
import { fakeAppServerProcessScript } from './helpers/app-server-process-fixture.mjs';

const cli = fileURLToPath(new URL('../bin/js-superagent.mjs', import.meta.url));
// Sync and linking first identify the configured account and check the repository.
const ghAccountFixture = `
if (args.includes('/user')) { console.log(JSON.stringify({ login: 'agent-account', id: 99, type: 'User' })); process.exit(0); }
if (args.includes('/repos/owner/repo')) { console.log(JSON.stringify({ id: 1, full_name: 'owner/repo', has_issues: true })); process.exit(0); }
`;

test('CLI exposes trace, session replacement and revision-checked prompt/recovery settings', t => {
  const { root, run, executable, mode } = fixture(t);
  const json = (...args) => { const result=run(...args);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout); };
  const file = (name,value) => { const path=join(root,name);writeFileSync(path,JSON.stringify(value));return path; };
  json('init');assert.equal(json('upgrade').schemaVersion,15);
  const ticket=json('submit','Inspect this task and wait for a reply');mode('waiting');json('run','--codex-path',executable);
  const session=json('session','inspect',ticket.id);assert.ok(session.session.id);
  const trace=json('trace',ticket.id,file('trace-page.json',{limit:1}));assert.equal(trace.items.length,1);assert.ok(trace.nextCursor);
  const next=json('trace',ticket.id,file('trace-next.json',{cursor:trace.nextCursor,limit:1}));assert.notDeepEqual(next.items,trace.items);
  const replace=file('replace.json',{reason:'Move explicitly to current configuration',expectedSessionId:session.session.id,adoptCurrentSettings:true});
  const replacement=json('session','replace',ticket.id,replace);assert.equal(replacement.session,null);assert.equal(replacement.history.at(-1).previous.id,session.session.id);
  const stale=run('session','replace',ticket.id,replace);assert.equal(stale.status,1);assert.match(stale.stderr,/Session revision conflict/);
  const prompts=json('prompts','status');const settings=file('prompts.json',{sections:{communication:'Keep progress concise'}});
  assert.equal(json('prompts','set',settings,String(prompts.settings.revision)).origin,'cli');
  assert.match(json('prompts','status').assembled.worker.text,/Keep progress concise/);
  assert.equal(run('prompts','set',settings,String(prompts.settings.revision)).status,1);
  const recovery=json('recovery','status');const recoveryFile=file('recovery.json',{retryBeforeStart:true,maxAttempts:2,initialDelayMs:20});
  assert.equal(json('recovery','set',recoveryFile,String(recovery.revision)).maxAttempts,2);
  assert.equal(run('recovery','set',recoveryFile,String(recovery.revision)).status,1);
  const health=json('health');assert.equal(typeof health.running,'boolean');assert.ok(Array.isArray(health.effects));assert.ok(Array.isArray(health.business.sources));
  assert.deepEqual(json('job','list',ticket.id),[]);
  assert.equal(run('job','cancel',ticket.id,'unknown').status,1);
  assert.equal(run('adoption','plan',ticket.id,'unknown').status,1);
});

test('CLI acknowledges durable incidents only at their current revision', t => {
  const { root,run }=fixture(t);assert.equal(run('init').status,0);
  const store=new Store(join(stateDir(root),'state.sqlite'));let at=Date.now();const registry=new BusinessHealthRegistry(store,{now:()=>at});
  for(let i=0;i<3;i++){at+=1000;registry.observe({running:true,sources:[{id:'test-source',lastAttempt:new Date(at).toISOString(),error:'offline'}]});}
  const incident=registry.listIncidents()[0];assert.ok(incident);store.close();
  const listed=run('incidents','list');assert.equal(listed.status,0,listed.stderr);assert.equal(JSON.parse(listed.stdout)[0].id,incident.id);
  const result=run('incidents','ack',incident.id,String(incident.revision));assert.equal(result.status,0,result.stderr);assert.ok(JSON.parse(result.stdout).acknowledgedAt);
  const stale=run('incidents','ack',incident.id,String(incident.revision));assert.equal(stale.status,1);assert.match(stale.stderr,/revision conflict/);
});

test('CLI validates new mutation identities and App PR delivery flag before initialization', t => {
  const { root,run }=fixture(t);
  for(const args of [
    ['session','replace','ticket'],['job','renew','ticket','job','1.5'],['job','close','ticket','job','1000'],
    ['adoption','apply','ticket','job'],['adoption','apply','ticket','job','unreviewed'],['adoption','recover','ticket','id','unsafe'],['adoption','recover','ticket','id'],['incidents','ack','id','-1'],
    ['prompts','set','missing.json','NaN'],['recovery','set','missing.json','1.5'],
    ['status','--github-app-pr-comments','true'],['init','--github-repo','owner/repo','--github-actor','alice','--github-app-id','1','--github-installation-id','2','--github-private-key-env','APP_KEY','--github-app-pr-comments','yes'],
  ])assert.equal(run(...args).status,1,args.join(' '));
  assert.equal(existsSync(stateDir(root)),false);
  const flags=['--github-app-id','1','--github-installation-id','2','--github-private-key-env','APP_KEY'];
  const initialized=run('init','--github-repo','owner/repo','--github-actor','alice',...flags,'--github-app-pr-comments','true');assert.equal(initialized.status,0,initialized.stderr);
  assert.equal(JSON.parse(run('config').stdout).github.app.pullRequestComments,true);
  const changed=run('config','set',...flags,'--github-app-pr-comments','false');assert.equal(changed.status,0,changed.stderr);assert.equal(JSON.parse(changed.stdout).github.app.pullRequestComments,false);
});

for (const flag of ['--version', '-v']) {
  test(`CLI ${flag} reads its own package version without initializing a project`, t => {
    const root = mkdtempSync(join(tmpdir(), 'js-superagent-version-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    const result = run(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, version + '\n');
    assert.deepEqual(readdirSync(root), []);

    // A target project's manifest must never supply the CLI version.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '999.0.0' }));
    const withProject = run('--project', root, 'init', flag);
    assert.equal(withProject.status, 0, withProject.stderr);
    assert.equal(withProject.stdout, version + '\n');
    assert.deepEqual(readdirSync(root), ['package.json']);
  });
}

test('CLI help remains available without initializing a project', t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-help-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [[], ['--help'], ['-h']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--version, -v/);
    assert.match(result.stdout, /submit <text>/);
  }
  assert.deepEqual(readdirSync(root), []);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, JS_SUPERAGENT_MACHINE_DIRECTORY: join(root, '.machine') };
  const run = (...args) => spawnSync(process.execPath, [cli, '--project', root, ...args], { encoding: 'utf8', timeout: 10_000, env });
  const executable = join(root, 'fake-codex.mjs');
  writeFileSync(executable, fakeAppServerProcessScript(), { mode: 0o700 });
  const start = (...args) => {
    const child = spawn(process.execPath, [cli, '--project', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return { child, completion, output: () => stdout };
  };
  return { root, run, executable, start, mode: value => writeFileSync(join(root, 'mode.txt'), value) };
}

test('CLI material application status treats the operation as an identity, not a JSON file', t => {
  const f = fixture(t);
  assert.equal(f.run('init').status, 0);
  const created = f.run('submit', 'Application status fixture');
  assert.equal(created.status, 0, created.stderr);
  const ticket = JSON.parse(created.stdout);
  const result = f.run('materials', 'apply-status', ticket.id, 'missing-operation');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-applications/);
  assert.doesNotMatch(result.stderr, /Invalid command or arguments/);
  assert.equal(f.run('materials', 'apply-status', ticket.id).status, 1);
});

async function until(check) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for CLI milestone');
    await delay(20);
  }
}

test('CLI initializes a non-Node project and persists work across separate processes', t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, '--project', root, ...args], { encoding: 'utf8' });
  assert.equal(run('status').status, 1);
  assert.equal(existsSync(stateDir(root)), false);
  assert.equal(run('doctor').status, 1);
  assert.equal(run('init').status, 0);
  assert.equal(run('doctor').status, 0);
  const created = run('submit', 'Check the Python project');
  assert.equal(created.status, 0, created.stderr);
  const ticket = JSON.parse(created.stdout);
  assert.equal(JSON.parse(run('show', ticket.id).stdout).text, ticket.text);
  assert.equal(JSON.parse(run('status').stdout).length, 1);
  assert.equal(run('reply', ticket.id, 'Use the existing tests').status, 0);
  assert.equal(JSON.parse(run('show', ticket.id).stdout).messages.length, 2);
  assert.equal(run('cancel', ticket.id).status, 0);
  assert.equal(JSON.parse(run('show', ticket.id).stdout).status, 'cancelled');
  assert.equal(run('retry', ticket.id).status, 0);
  assert.equal(JSON.parse(run('show', ticket.id).stdout).status, 'queued');
  assert.equal(run('show', 'unknown').status, 1);
  assert.equal(run('submit', 'one', 'two').status, 1);
  assert.equal(existsSync(join(root, 'package.json')), false);
});

test('CLI rejects misplaced or invalid execution options before creating state', t => {
  const { root, run } = fixture(t);
  for (const args of [
    ['status', '--model', 'test'], ['submit', 'task', '--driver', 'codex-app-server'], ['run', '--driver', 'unknown'],
    ['run', '--timeout-ms', '0'], ['run', '--timeout-ms', '1.5'], ['run', '--timeout-ms', '86400001'],
    ['run', '--model', ''], ['run', '--codex-path', ''], ['doctor', '--codex-path', '/missing'],
    ['doctor', '--model', 'test'],
    ['init', '--workspace', 'invalid'], ['init', '--exclude', '../outside'],
    ['init', '--kill-grace-ms', '30001'], ['config', '--workspace', 'auto'],
  ]) assert.equal(run(...args).status, 1, args.join(' '));
  assert.equal(existsSync(stateDir(root)), false);
});

test('CLI validates service commands and options before creating project state', t => {
  const { root, run } = fixture(t);
  for (const args of [
    ['service'], ['service', 'unknown'], ['service', 'install', 'extra'],
    ['status', '--mode', 'poll'], ['service', 'start', '--mode', 'webhook'],
    ['service', 'install', '--mode', 'unknown'], ['service', 'restart', '--log-max-bytes', '4096'],
    ['service', 'install', '--log-max-bytes', '1.5'],
    ['service', 'install', '--driver', 'codex-app-server'],
    ['service', 'install', '--github-repo', 'owner/repo'],
  ]) assert.equal(run(...args).status, 1, args.join(' '));
  assert.equal(existsSync(stateDir(root)), false);
  assert.match(run('--help').stdout, /service install/);
});

test('CLI doctor probes the selected Codex without exposing authentication output', t => {
  const { root, run, executable } = fixture(t);
  const before = run('doctor', '--driver', 'codex-app-server', '--codex-path', executable);
  assert.equal(before.status, 1);
  assert.equal(existsSync(stateDir(root)), false);
  assert.equal(run('init').status, 0);
  const result = run('doctor', '--driver', 'codex-app-server', '--codex-path', executable);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).codex, { supported: true, available: true, loggedIn: true });
  assert.doesNotMatch(result.stdout + result.stderr, /private-account-secret/);
  const missing = run('doctor', '--driver', 'codex-app-server', '--codex-path', join(root, 'missing'));
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).codex.available, false);
});

test('CLI executes a waiting turn and resumes the exact session after a reply', t => {
  const { root, run, executable, mode } = fixture(t);
  assert.equal(run('init').status, 0);
  const ticket = JSON.parse(run('submit', 'Implement rounding with the user-selected rule').stdout);
  mode('waiting');
  const question = run('run', '--codex-path', executable, '--model', 'test-model', '--timeout-ms', '5000');
  assert.equal(question.status, 0, question.stderr);
  assert.equal(JSON.parse(question.stdout).status, 'waiting');
  assert.equal(run('reply', ticket.id, 'Round half up').status, 0);
  mode('completed');
  const answer = run('run', '--codex-path', executable);
  assert.equal(answer.status, 0, answer.stderr);
  assert.equal(JSON.parse(answer.stdout).status, 'completed');
  assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'verified');
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'test-model');
  assert.equal(calls[1].sessionMethod, 'thread/resume');
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.match(calls[1].input, /Round half up/);
  assert.equal(run('run', '--codex-path', executable).stdout.trim(), 'null');
});

test('CLI SIGTERM interrupts active work, never replays unverified native history, and continues after explicit session replacement', { timeout: 20_000 }, async t => {
  const { root, run, executable, mode, start } = fixture(t);
  assert.equal(run('init').status, 0);
  const ticket = JSON.parse(run('submit', 'Make the requested change').stdout);
  mode('hang');
  const active = start('run', '--codex-path', executable);
  await until(() => existsSync(join(root, 'heartbeat.txt')));
  active.child.kill('SIGTERM');
  const ended = await active.completion;
  assert.equal(ended.status, 143, ended.stderr);
  assert.equal(JSON.parse(run('show', ticket.id).stdout).status, 'interrupted');
  const lastBeat = readFileSync(join(root, 'heartbeat.txt'), 'utf8');
  await delay(100);
  assert.equal(readFileSync(join(root, 'heartbeat.txt'), 'utf8'), lastBeat);
  assert.equal(run('retry', ticket.id).status, 0);
  mode('completed');
  const inspected = run('run', '--codex-path', executable);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.stdout.trim(), 'null');
  const details = JSON.parse(run('details', ticket.id).stdout);
  assert.equal(details.ticket.status, 'interrupted');
  assert.equal(details.recovery.status, 'inspection');
  assert.equal(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1);
  const session = JSON.parse(run('session', 'inspect', ticket.id).stdout).session;
  const replace = join(root, 'replace.json');
  writeFileSync(replace, JSON.stringify({ reason: 'Interrupted history could not be verified', expectedSessionId: session.id, adoptCurrentSettings: true }));
  assert.equal(run('session', 'replace', ticket.id, replace).status, 0);
  const continued = run('run', '--codex-path', executable);
  assert.equal(continued.status, 0, continued.stderr);
  assert.equal(JSON.parse(continued.stdout).status, 'completed');
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionMethod, 'thread/start');
  assert.notEqual(calls[1].sessionId, session.id);
});

test('CLI run returns a nonzero exit code and a JSON ticket after executor failure', t => {
  const { run, executable, mode } = fixture(t);
  assert.equal(run('init').status, 0);
  const ticket = JSON.parse(run('submit', 'Implement and verify the change').stdout);
  mode('failed');
  const failed = run('run', '--codex-path', executable);
  assert.equal(failed.status, 1, failed.stderr);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.id, ticket.id);
  assert.equal(report.status, 'failed');
  assert.match(report.reports.at(-1).summary, /Verification failed/);
  assert.equal(JSON.parse(run('show', ticket.id).stdout).status, 'failed');
});

test('CLI cancels an active executor from another process and retries explicitly', { timeout: 20_000 }, async t => {
  const { root, run, executable, mode, start } = fixture(t);
  assert.equal(run('init').status, 0);
  const ticket = JSON.parse(run('submit', 'Make the requested change').stdout);
  mode('hang');
  const active = start('run', '--codex-path', executable);
  await until(() => existsSync(join(root, 'heartbeat.txt')));
  assert.equal(run('cancel', ticket.id).status, 0);
  const ended = await active.completion;
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(JSON.parse(ended.stdout).status, 'cancelled');
  const lastBeat = readFileSync(join(root, 'heartbeat.txt'), 'utf8');
  await delay(100);
  assert.equal(readFileSync(join(root, 'heartbeat.txt'), 'utf8'), lastBeat);
  assert.equal(run('retry', ticket.id).status, 0);
  mode('completed');
  const retried = run('run', '--codex-path', executable);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).status, 'completed');
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionMethod, 'thread/resume');
});

test('CLI serve processes tasks and shuts down on SIGINT', { timeout: 20_000 }, async t => {
  const { root, run, executable, mode, start } = fixture(t);
  assert.equal(run('init').status, 0);
  mode('completed');
  const service = start('serve', '--codex-path', executable);
  await until(() => service.output().includes('"running":true'));
  const ticket = JSON.parse(run('submit', 'Create result.txt').stdout);
  await until(() => existsSync(join(root, 'result.txt')));
  await until(() => JSON.parse(run('show', ticket.id).stdout).status === 'completed');
  service.child.kill('SIGINT');
  const ended = await service.completion;
  assert.equal(ended.status, 130, ended.stderr);
  assert.match(ended.stdout, /"running": false/);
});

test('CLI persists execution settings, overrides one invocation, and preserves config on repeated init', t => {
  const { root, run, executable, mode } = fixture(t);
  const initialized = run('init', '--driver', 'codex-app-server', '--codex-path', executable, '--model', 'persisted-model', '--timeout-ms', '5000', '--kill-grace-ms', '50');
  assert.equal(initialized.status, 0, initialized.stderr);
  const file = join(stateDir(root), 'config.json');
  const original = readFileSync(file, 'utf8');
  assert.equal(run('init').status, 0);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(run('init', '--workspace', 'copy').status, 1);
  assert.equal(readFileSync(file, 'utf8'), original);
  const config = JSON.parse(run('config').stdout);
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.execution.model, 'persisted-model');
  mode('completed');
  assert.equal(run('submit', 'First task').status, 0);
  const first = run('run', '--model', 'invocation-model');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(run('submit', 'Second task').status, 0);
  const second = run('run');
  assert.equal(second.status, 0, second.stderr);
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls[0].model, 'invocation-model');
  assert.equal(calls[1].model, 'persisted-model');
  assert.equal(readFileSync(file, 'utf8'), original);
  const changed = run('config', 'set', '--model', 'updated-model', '--workspace', 'copy', '--exclude', 'cache', '--exclude', 'scratch');
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).execution.model, 'updated-model');
  assert.deepEqual(JSON.parse(changed.stdout).workspace.exclude, ['cache', 'scratch']);
  assert.equal(run('doctor', '--driver', 'codex-app-server').status, 0);
});

test('CLI workspace inspection exposes isolated results without changing source files', t => {
  const { root, run, executable, mode } = fixture(t);
  const initialized = run('init', '--workspace', 'copy', '--driver', 'codex-app-server', '--codex-path', executable, '--kill-grace-ms', '50');
  assert.equal(initialized.status, 0, initialized.stderr);
  mode('completed');
  const ticket = JSON.parse(run('submit', 'Create result.txt only inside the task workspace').stdout);
  const completed = run('run');
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).status, 'completed');
  const result = run('workspace', ticket.id);
  assert.equal(result.status, 0, result.stderr);
  const review = JSON.parse(result.stdout);
  assert.equal(review.workspace.mode, 'copy');
  assert.notEqual(review.workspace.path, root);
  assert.equal(existsSync(join(root, 'result.txt')), false);
  assert.equal(readFileSync(join(review.workspace.path, 'result.txt'), 'utf8'), 'verified');
  assert.ok(review.changes.some(change => change.path === 'result.txt'));
});

test('CLI refuses configuration changes while execution owns the project', { timeout: 20_000 }, async t => {
  const { root, run, executable, mode, start } = fixture(t);
  assert.equal(run('init', '--driver', 'codex-app-server', '--codex-path', executable).status, 0);
  const before = readFileSync(join(stateDir(root), 'config.json'), 'utf8');
  mode('hang');
  const ticket = JSON.parse(run('submit', 'Wait for cancellation').stdout);
  const active = start('run');
  await until(() => existsSync(join(root, 'heartbeat.txt')));
  const refused = run('config', 'set', '--workspace', 'copy');
  assert.equal(refused.status, 1);
  assert.equal(readFileSync(join(stateDir(root), 'config.json'), 'utf8'), before);
  assert.equal(run('cancel', ticket.id).status, 0);
  assert.equal((await active.completion).status, 0);
  assert.equal(run('config', 'set', '--workspace', 'copy').status, 0);
});

test('CLI persists explicit GitHub scope and can disable it without changing local configuration', t => {
  const { root, run } = fixture(t);
  const gh = join(root, 'unused-gh');
  const created = run('init', '--workspace', 'copy', '--github-repo', 'Owner/Repo',
    '--github-actor', 'Alice', '--github-actor', 'Bob', '--github-issue', '5', '--github-issue', '8',
    '--github-command', '/repair', '--gh-path', gh, '--github-poll-ms', '2500');
  assert.equal(created.status, 0, created.stderr);
  const current = JSON.parse(run('config').stdout);
  assert.deepEqual(current.github, { repository: 'owner/repo', allowedActors: ['alice', 'bob'], issues: [5, 8], command: '/repair', executable: gh, pollIntervalMs: 2500 });
  const changed = run('config', 'set', '--github-actor', 'Charlie', '--github-poll-ms', '1000');
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(JSON.parse(changed.stdout).github.allowedActors, ['charlie']);
  assert.deepEqual(JSON.parse(changed.stdout).github.issues, [5, 8]);
  const before = readFileSync(join(stateDir(root), 'config.json'), 'utf8');
  assert.equal(run('config', 'set', '--github-disable', '--github-repo', 'owner/other').status, 1);
  assert.equal(readFileSync(join(stateDir(root), 'config.json'), 'utf8'), before);
  const disabled = run('config', 'set', '--github-disable');
  assert.equal(disabled.status, 0, disabled.stderr);
  const config = JSON.parse(disabled.stdout);
  assert.equal(config.github, undefined);
  assert.equal(config.workspace.mode, 'copy');
  assert.equal(config.projectId, current.projectId);
});

test('CLI rejects GitHub settings on non-configuration commands and malformed new scope before writes', t => {
  const { root, run } = fixture(t);
  for (const args of [
    ['init', '--github-repo', 'owner/repo'],
    ['init', '--github-actor', 'alice'],
    ['init', '--github-repo', 'https://github.com/owner/repo', '--github-actor', 'alice'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--github-issue', '2.5'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--github-poll-ms', '10'],
    ['init', '--github-disable'],
    ['run', '--github-repo', 'owner/repo'],
    ['github', 'sync', '--github-repo', 'owner/repo'],
    ['github', 'invalid'],
  ]) assert.equal(run(...args).status, 1, args.join(' '));
  assert.equal(existsSync(stateDir(root)), false);
});

test('CLI github sync polls through configured gh without calling the model and status stays local', t => {
  const { root, run } = fixture(t);
  const gh = join(root, 'fake-gh.mjs'), requests = join(root, 'github-requests.jsonl');
  writeFileSync(gh, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + '\\n');
const endpoint = args.find(value => value.startsWith('/'));
if (args[0] !== 'api' || args[args.indexOf('--method') + 1] !== 'GET') {
  console.error('Unexpected API request in empty-channel fixture'); process.exit(1);
}
${ghAccountFixture}
if (!endpoint?.startsWith('/repos/owner/repo/issues?')) { console.error('Unexpected API request in empty-channel fixture'); process.exit(1); }
console.log('[]');
`, { mode: 0o700 });
  const initialized = run('init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--gh-path', gh);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(existsSync(requests), false);
  const status = run('github', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /owner\/repo/);
  assert.equal(existsSync(requests), false);
  const synced = run('github', 'sync');
  assert.equal(synced.status, 0, synced.stderr);
  assert.doesNotThrow(() => JSON.parse(synced.stdout));
  assert.deepEqual(JSON.parse(run('status').stdout), []);
  const calls = readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call[call.indexOf('--method') + 1] === 'GET'));
  assert.equal(calls.filter(call => call.some(value => value.startsWith('/repos/owner/repo/issues?'))).length, 1);
  const afterSync = calls.length;
  assert.equal(run('github', 'status').status, 0);
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, afterSync);
});

test('CLI persists, replaces and clears explicit CI allowlists while preserving GitHub intake', t => {
  const { root, run } = fixture(t);
  const initialized = run('init', '--github-repo', 'owner/repo', '--github-actor', 'alice',
    '--github-check-app', 'GitHub-Actions', '--github-check-app', 'github-actions',
    '--github-status-context', 'CI / test', '--github-status-context', 'ci/build',
    '--github-status-actor', 'Build-Bot[bot]', '--github-status-actor', 'build-bot[bot]');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.deepEqual(JSON.parse(run('config').stdout).github.ci, {
    checkApps: ['github-actions'], statusContexts: ['CI / test', 'ci/build'], statusActors: ['build-bot[bot]'],
  });
  const replaced = run('config', 'set', '--github-check-app', 'trusted-app');
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.deepEqual(JSON.parse(replaced.stdout).github.ci, { checkApps: ['trusted-app'] });
  const before = readFileSync(join(stateDir(root), 'config.json'), 'utf8');
  for (const args of [
    ['config', 'set', '--github-status-context', 'ci/test'],
    ['config', 'set', '--github-status-actor', 'alice'],
    ['config', 'set', '--github-check-app', '*'],
    ['config', 'set', '--github-ci-disable', '--github-check-app', 'trusted-app'],
    ['config', 'set', '--github-disable', '--github-ci-disable'],
  ]) {
    assert.equal(run(...args).status, 1, args.join(' '));
    assert.equal(readFileSync(join(stateDir(root), 'config.json'), 'utf8'), before);
  }
  const cleared = run('config', 'set', '--github-ci-disable');
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).github.ci, undefined);
  assert.deepEqual(JSON.parse(cleared.stdout).github.allowedActors, ['alice']);
});

test('CLI rejects misplaced CI options and malformed PR linking commands before creating state', t => {
  const { root, run } = fixture(t);
  for (const args of [
    ['init', '--github-ci-disable'], ['run', '--github-check-app', 'github-actions'],
    ['github', 'sync', '--github-status-context', 'ci/test', '--github-status-actor', 'alice'],
    ['github', 'link'], ['github', 'link', 'ticket'], ['github', 'link', 'ticket', '0'],
    ['github', 'link', 'ticket', '1.5'], ['github', 'link', 'ticket', '2147483648'],
    ['github', 'unlink'], ['github', 'unlink', '-1'], ['github', 'unlink', '2', 'extra'],
  ]) assert.equal(run(...args).status, 1, args.join(' '));
  assert.equal(existsSync(stateDir(root)), false);
});

test('CLI links the current PR head explicitly, keeps status local and unlinks without remote writes', t => {
  const { root, run } = fixture(t);
  const gh = join(root, 'fake-pr-gh.mjs'), requests = join(root, 'pr-requests.jsonl'), snapshot = join(root, 'pr.json');
  const sha = 'a'.repeat(40), nextSha = 'b'.repeat(40);
  const pull = { number: 9, id: 109, title: 'Review this change', body: 'PR description', state: 'open', merged: false,
    html_url: 'https://github.com/owner/repo/pull/9', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    user: { login: 'alice', id: 1, type: 'User' }, head: { sha, ref: 'feature', repo: { full_name: 'owner/repo' } },
    base: { ref: 'main', repo: { full_name: 'owner/repo' } } };
  writeFileSync(snapshot, JSON.stringify(pull));
  writeFileSync(gh, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'api' || args[args.indexOf('--method') + 1] !== 'GET') {
  console.error('Unexpected request during local PR linking'); process.exit(1);
}
${ghAccountFixture}
if (!args.includes('/repos/owner/repo/pulls/9')) { console.error('Unexpected request during local PR linking'); process.exit(1); }
console.log(readFileSync(${JSON.stringify(snapshot)}, 'utf8'));
`, { mode: 0o700 });
  const initialized = run('init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--gh-path', gh);
  assert.equal(initialized.status, 0, initialized.stderr);
  const ticket = JSON.parse(run('submit', 'Implement the requested change and handle its review').stdout);
  assert.equal(existsSync(requests), false);
  const linked = run('github', 'link', ticket.id, '9');
  assert.equal(linked.status, 0, linked.stderr);
  const binding = JSON.parse(linked.stdout);
  assert.equal(binding.ticketId, ticket.id);
  assert.equal(binding.headSha, sha);
  const repeat = run('github', 'link', ticket.id, '9');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.deepEqual(JSON.parse(repeat.stdout), binding);
  const beforeStatus = readFileSync(requests, 'utf8');
  assert.deepEqual(JSON.parse(run('github', 'status').stdout).trackedPullRequests, [binding]);
  assert.deepEqual(JSON.parse(run('show', ticket.id).stdout).pullRequests, [binding]);
  assert.equal(readFileSync(requests, 'utf8'), beforeStatus);
  pull.head.sha = nextSha;
  writeFileSync(snapshot, JSON.stringify(pull));
  assert.equal(JSON.parse(run('github', 'status').stdout).trackedPullRequests[0].headSha, sha);
  const relinked = run('github', 'link', ticket.id, '9');
  assert.equal(relinked.status, 0, relinked.stderr);
  assert.equal(JSON.parse(relinked.stdout).headSha, nextSha);
  assert.deepEqual(JSON.parse(relinked.stdout).headHistory, [sha, nextSha]);
  const calls = readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args.includes('/repos/owner/repo/pulls/9')).length, 3);
  assert.ok(calls.every(args => args[args.indexOf('--method') + 1] === 'GET'));
  const removed = run('github', 'unlink', '9');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout), true);
  assert.equal(JSON.parse(run('github', 'unlink', '9').stdout), false);
  assert.deepEqual(JSON.parse(run('github', 'status').stdout).trackedPullRequests, []);
  assert.deepEqual(JSON.parse(run('show', ticket.id).stdout).pullRequests, []);
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, calls.length);
  assert.equal(existsSync(join(root, 'calls.jsonl')), false);
});

test('CLI stores App and Webhook secret references and clears them without calling credentials or channels', t => {
  const { root, run } = fixture(t);
  const first = run('init', '--github-repo', 'owner/repo', '--github-actor', 'alice',
    '--github-app-id', '123', '--github-installation-id', '456', '--github-private-key-env', 'APP_KEY',
    '--webhook-secret-env', 'WEBHOOK_SECRET', '--webhook-port', '0');
  assert.equal(first.status, 0, first.stderr);
  let config = JSON.parse(run('config').stdout);
  assert.deepEqual(config.github.app, { appId: '123', installationId: 456, privateKeyEnv: 'APP_KEY' });
  assert.equal(config.github.webhook.secretEnv, 'WEBHOOK_SECRET'); assert.equal(config.github.webhook.port, 0);
  const changed = run('config', 'set', '--github-app-id', '789', '--github-installation-id', '1000', '--github-private-key-path', './private/app.pem',
    '--webhook-secret-path', './private/hook.txt', '--webhook-host', '::1', '--webhook-port', '12345', '--webhook-path', '/events', '--webhook-max-bytes', '4096');
  assert.equal(changed.status, 0, changed.stderr);
  config = JSON.parse(changed.stdout);
  assert.match(config.github.app.privateKeyPath, /\/private\/app\.pem$/);
  assert.equal(config.github.app.privateKeyEnv, undefined);
  assert.match(config.github.webhook.secretPath, /\/private\/hook\.txt$/);
  assert.equal(config.github.webhook.secretEnv, undefined);
  assert.equal(config.github.webhook.host, '::1'); assert.equal(config.github.webhook.path, '/events');
  assert.equal(existsSync(join(root, 'calls.jsonl')), false);
  assert.equal(run('config', 'set', '--github-app-disable').status, 0);
  config = JSON.parse(run('config').stdout); assert.equal(config.github.app, undefined); assert.ok(config.github.webhook);
  assert.equal(run('config', 'set', '--webhook-disable').status, 0);
  config = JSON.parse(run('config').stdout); assert.equal(config.github.webhook, undefined); assert.equal(config.github.repository, 'owner/repo');
  const noListener = run('github', 'listen');
  assert.equal(noListener.status, 1); assert.match(noListener.stderr, /Configure github.webhook/);
});

test('CLI rejects misplaced and incomplete App or Webhook flags without creating state', t => {
  const { root, run } = fixture(t);
  for (const args of [
    ['init', '--github-app-disable'], ['init', '--webhook-disable'],
    ['status', '--webhook-secret-env', 'HOOK'], ['github', 'listen', '--webhook-port', '8000'],
    ['config', 'set', '--github-app-disable', '--github-app-id', '123'],
    ['config', 'set', '--webhook-disable', '--webhook-secret-env', 'HOOK'],
    ['config', 'set', '--github-disable', '--webhook-disable'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--github-app-id', '123'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--webhook-port', '0'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--webhook-secret-env', 'HOOK', '--webhook-secret-path', 'hook.txt'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--webhook-secret-env', 'HOOK', '--webhook-port', '-1'],
    ['init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--webhook-secret-env', 'HOOK', '--webhook-max-bytes', '0'],
    ['github', 'listen', 'extra'], ['github', 'webhook-status', 'extra'],
  ]) assert.equal(run(...args).status, 1, args.join(' '));
  assert.equal(existsSync(stateDir(root)), false);
});

test('CLI listener binds explicitly, verifies signed HTTP input and closes before runtime shutdown', { timeout: 15_000 }, async t => {
  const { root, run, start, executable, mode } = fixture(t);
  const secret = 'cli-listener-test-secret-not-a-real-credential', secretPath = join(root, 'webhook.secret');
  const gh = join(root, 'empty-gh.mjs');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[args.indexOf('--method') + 1] !== 'GET') process.exit(1);
${ghAccountFixture}
if (!args.some(value => value.startsWith('/repos/owner/repo/issues?'))) process.exit(1);
console.log('[]');
`, { mode: 0o700 });
  mode('completed');
  const initialized = run('init', '--github-repo', 'owner/repo', '--github-actor', 'alice', '--gh-path', gh,
    '--webhook-secret-path', secretPath, '--webhook-port', '0', '--webhook-path', '/hook', '--driver', 'codex-app-server', '--codex-path', executable);
  assert.equal(initialized.status, 0, initialized.stderr);
  const service = start('github', 'listen');
  await until(() => service.output().includes('webhookUrl'));
  const { webhookUrl } = JSON.parse(service.output().trim().split('\n')[0]);
  assert.match(webhookUrl, /^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  const body = JSON.stringify({ zen: 'Preserve the signed bytes', repository: { full_name: 'owner/repo' } });
  const headers = { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': '12345678-1234-4234-8234-123456789abc',
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') };
  let response = await fetch(webhookUrl, { method: 'POST', headers, body: body + ' ' });
  assert.equal(response.status, 401);
  response = await fetch(webhookUrl, { method: 'POST', headers, body });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ignored');
  const status = run('github', 'webhook-status');
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).configured, true);
  assert.equal(existsSync(join(root, 'calls.jsonl')), false);
  service.child.kill('SIGTERM');
  const result = await service.completion;
  assert.equal(result.status, 143, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr + status.stdout, /cli-listener-test-secret-not-a-real-credential/);
  await assert.rejects(fetch(webhookUrl, { method: 'POST', headers, body }));
});

test('W30 W31 W34 CLI exposes scoped review and preview commands without executing workers', t => {
  const {root,run}=fixture(t);
  const help=run('--help');assert.match(help.stdout,/review request/);assert.match(help.stdout,/github bot-review/);assert.match(help.stdout,/native-preview/);assert.match(help.stdout,/schema 15/);
  for(const args of [['review','request','ticket'],['native-preview','renew','ticket','lease','job','1.5'],['native-preview','close','ticket','lease','job','1000'],['github','bot-review','set','12','0','file'],['status','--github-app-pr-reviews','true']])assert.equal(run(...args).status,1,args.join(' '));
  assert.equal(existsSync(stateDir(root)),false);
  const init=run('init','--github-repo','owner/repo','--github-actor','alice','--github-app-id','1','--github-installation-id','2','--github-private-key-env','APP_KEY','--github-app-pr-reviews','true');assert.equal(init.status,0,init.stderr);
  assert.equal(JSON.parse(readFileSync(join(stateDir(root), 'config.json'),'utf8')).github.app.pullRequestReviews,true);
  for(const args of [['review','status'],['github','bot-review','status']]){const result=run(...args);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),[]);}
});

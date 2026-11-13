import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, realpathSync, readdirSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { initializeProjectConfig, writeProjectConfig } from '../src/config.mjs';
import { createServiceManager, retireRelocatedService } from '../src/service.mjs';
import { inspectProcessOwner } from '../src/machine-coordination.mjs';
const modulePath = fileURLToPath(new URL('../src/service.mjs', import.meta.url));
function wrapperArgs(f) {
  const path=join(stateDir(f.root),'service/control-intent.json'),intent=JSON.parse(readFileSync(path));
  writeFileSync(path,JSON.stringify({...intent,desired:'running'}));
  return [modulePath,'run',f.root];
}
test('service preflight rejects an active overlapping root without enabling launchd', async t => {
  const f=fixture(t);
  const {createMachineCoordinator}=await import('../src/machine-coordination.mjs');
  const config=initializeProjectConfig(f.base);
  const parent=createMachineCoordinator({projectRoot:f.base,projectId:config.projectId},{directory:f.deps.coordinationDirectory});
  parent.register();const lease=parent.acquireLease();
  try {
    assert.throws(()=>f.manager.install(),error=>error.code==='PROJECT_ROOT_OVERLAP');
    assert.equal(f.calls.some(args=>['enable','bootstrap','disable','bootout'].includes(args[0])),false);
  } finally {parent.releaseLease(lease);parent.close();}
  assert.equal(f.manager.install().running,false);
});
test('service preflight rejects a repository owned by another project before enabling launchd', async t => {
  const f=fixture(t),other=join(f.base,'other');mkdirSync(other);
  const {createMachineCoordinator}=await import('../src/machine-coordination.mjs');
  const config=initializeProjectConfig(other);
  const coordinator=createMachineCoordinator({projectRoot:other,projectId:config.projectId},{directory:f.deps.coordinationDirectory});
  coordinator.register();coordinator.claimRepository({repository:'owner/repo',repositoryId:7});
  writeProjectConfig(f.root,{github:{repository:'owner/repo',allowedActors:['owner']}});
  const manager=createServiceManager(f.options,f.deps);
  assert.throws(()=>manager.install(),error=>error.code==='GITHUB_REPOSITORY_OWNED');
  assert.equal(f.calls.some(args=>['enable','bootstrap','disable','bootout'].includes(args[0])),false);
});
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-service-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project & "quoted"'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  const codex = join(base, 'codex'); writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  initializeProjectConfig(root, { execution: { driver: 'codex-app-server', executable: codex } });
  let job = false, disabled = false, alive = false;
  const calls = [];
  const record = () => writeFileSync(join(stateDir(root), 'service/runtime.json'), JSON.stringify({ healthProtocol: 1,
    runId: 'cd432b56-5645-4e8d-b211-cc94f64fd111', pid: 12345, childPid: 12346,
    owner: { host: 'fixture', pid: 12345, birth: 'wrapper', bootId: 'fixture-boot' },
    childOwner: { host: 'fixture', pid: 12346, birth: 'child', bootId: 'fixture-boot' }, startedAt: new Date().toISOString() }));
  const deps = { platform: 'darwin', uid: 501, stopTimeoutMs: 0, coordinationDirectory: join(base, 'machine'),
    ownerState: owner => owner?.bootId === 'fixture-boot' ? alive ? 'alive' : 'dead' : inspectProcessOwner(owner),
    signalProcess: () => { alive = false; }, launchctl(args) {
    calls.push(args);
    if (args[0] === 'print') {
      if (!job) throw Object.assign(new Error('missing'), { stderr: 'Could not find service', status: 113 });
      return 'job = {\n\tstate = running\n\tpid = 12345\n\tlast exit code = 0\n}';
    }
    if (args[0] === 'disable') disabled = true;
    if (args[0] === 'enable') disabled = false;
    if (args[0] === 'bootstrap') { job = true; alive = true; record(); }
    if (args[0] === 'bootout') job = false;
    return '';
  } };
  const options = { projectRoot: root, homeDirectory: home };
  return { base, root, home, codex, options, deps, calls, manager: createServiceManager(options, deps), get disabled() { return disabled; }, set job(value) { job = value; alive = value; if (value && existsSync(join(stateDir(root), 'service/manifest.json'))) record(); } };
}
test('install escapes XML, pins absolute executables, remains disabled until start, and is idempotent', t => {
  const f = fixture(t), status = f.manager.install();
  assert.equal(status.installed, true); assert.equal(status.running, false); assert.equal(status.mode, 'poll'); assert.equal(f.disabled, true);
  assert.equal(f.calls.some(args => args[0] === 'bootstrap'), false);
  const plist = readFileSync(status.plistPath, 'utf8');
  assert.match(plist, /project &amp; &quot;quoted&quot;/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><false\/>/);
  assert.ok(plist.includes(realpathSync(process.execPath)));
  const before = readFileSync(status.manifestPath, 'utf8');
  assert.deepEqual(f.manager.install(), status); assert.equal(readFileSync(status.manifestPath, 'utf8'), before);
  assert.equal(readFileSync(join(stateDir(f.root), 'service/.gitignore'), 'utf8'), '*\n');
  assert.equal(statSync(status.plistPath).mode & 0o777, 0o600);
});
test('lifecycle disables across login and supports reinstall with retained bounded diagnostics', t => {
  const f = fixture(t), installed = f.manager.install();
  assert.equal(f.manager.start().running, true); assert.equal(f.disabled, false);
  assert.equal(f.manager.restart().running, true); assert.equal(f.manager.stop().loaded, false); assert.equal(f.disabled, true);
  writeFileSync(installed.logs.stdout, 'retained diagnostic\n');
  assert.equal(f.manager.uninstall().installed, false); assert.equal(existsSync(installed.plistPath), false);
  assert.equal(readFileSync(installed.logs.stdout, 'utf8'), 'retained diagnostic\n');
  assert.equal(f.manager.install().installed, true); assert.equal(f.manager.status().loaded, false); assert.equal(f.disabled, true);
});
test('webhook requires file credential references and a fixed port; generated files never contain credentials', t => {
  const f = fixture(t), key = join(f.base, 'key.pem'), secret = join(f.base, 'webhook.secret');
  writeFileSync(key, 'PRIVATE-KEY-CONTENT'); writeFileSync(secret, 'WEBHOOK-SECRET-CONTENT');
  const github = { repository: 'owner/repo', allowedActors: ['owner'], app: { appId: '123', installationId: 456, privateKeyPath: key }, webhook: { secretPath: secret, port: 8787 } };
  writeProjectConfig(f.root, { github });
  const manager = createServiceManager({ ...f.options, mode: 'webhook' }, f.deps), status = manager.install();
  const generated = readFileSync(status.plistPath, 'utf8') + readFileSync(status.manifestPath, 'utf8');
  assert.equal(generated.includes('PRIVATE-KEY-CONTENT'), false); assert.equal(generated.includes('WEBHOOK-SECRET-CONTENT'), false);
  assert.equal(createServiceManager(f.options, f.deps).start().mode, 'webhook'); manager.uninstall();
  writeProjectConfig(f.root, { github: { app: { appId: '123', installationId: 456, privateKeyEnv: 'SOME_KEY' } } });
  assert.throws(() => manager.install(), /privateKeyPath/);
  writeProjectConfig(f.root, { github: { app: github.app, webhook: { secretEnv: 'SOME_SECRET', port: 8787 } } });
  assert.throws(() => manager.install(), /secretPath/);
  writeProjectConfig(f.root, { github: { webhook: { secretPath: secret, port: 0 } } }); assert.throws(() => manager.install(), /fixed port/);
});
test('validation fails before effects for missing executors, unsupported platform or unsupported mode', t => {
  const f = fixture(t); writeProjectConfig(f.root, { execution: { executable: join(f.base, 'missing-codex') } });
  assert.throws(() => f.manager.install(), /Executable is unavailable/);
  assert.equal(existsSync(join(stateDir(f.root), 'service')), false); assert.equal(existsSync(join(f.home, 'Library')), false); assert.equal(f.calls.length, 0);
  assert.throws(() => createServiceManager({ ...f.options, mode: 'invalid' }, f.deps).install(), /mode must/);
  assert.throws(() => createServiceManager(f.options, { platform: 'linux' }), /macOS/);
});
test('configured executable changes cannot silently run the previous pinned executable', t => {
  const f = fixture(t); f.manager.install();
  const next = join(f.base, 'next-codex'); writeFileSync(next, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeProjectConfig(f.root, { execution: { executable: next } });
  assert.throws(() => f.manager.start(), /executable changed/); assert.equal(f.calls.some(args => args[0] === 'bootstrap'), false);
  f.manager.uninstall(); f.manager.install(); assert.equal(f.manager.start().running, true);
});
test('unowned jobs and plists and edited owned metadata are not adopted or removed', t => {
  const f = fixture(t); f.job = true; assert.throws(() => f.manager.install(), /unowned loaded service/); f.job = false;
  const initial = f.manager.status(); mkdirSync(dirname(initial.plistPath), { recursive: true }); writeFileSync(initial.plistPath, 'user-owned');
  assert.throws(() => f.manager.install(), /unowned LaunchAgent/); assert.throws(() => f.manager.uninstall(), /unowned service/);
  assert.equal(readFileSync(initial.plistPath, 'utf8'), 'user-owned'); rmSync(initial.plistPath);
  const status = f.manager.install(), manifest = readFileSync(status.manifestPath, 'utf8'), plist = readFileSync(status.plistPath, 'utf8');
  writeFileSync(status.manifestPath, manifest.replace('"schemaVersion": 2', '"schemaVersion": 9')); assert.throws(() => f.manager.stop(), /not owned/);
  writeFileSync(status.manifestPath, manifest); writeFileSync(status.plistPath, plist + '<!-- changed -->');
  assert.throws(() => f.manager.uninstall(), /plist changed/); assert.equal(existsSync(status.manifestPath), true);
});
test('symlink redirections through service directories, home ancestors and retained logs are refused', t => {
  const f = fixture(t), outside = join(f.base, 'outside'); mkdirSync(outside);
  const directory = join(stateDir(f.root), 'service'); symlinkSync(outside, directory);
  assert.throws(() => f.manager.install(), /must not be redirected/); rmSync(directory);
  symlinkSync(outside, join(f.home, 'Library')); assert.throws(() => f.manager.install(), /must not be redirected/); rmSync(join(f.home, 'Library'));
  const status = f.manager.install(); f.manager.uninstall(); symlinkSync(join(f.base, 'foreign.log'), status.logs.stdout);
  assert.throws(() => f.manager.install(), /regular, unlinked file/); assert.deepEqual(readdirSync(outside), []);
});
test('launchctl errors are distinguished from absent jobs and failed stop preserves installation', t => {
  const f = fixture(t), status = f.manager.install();
  const manager = createServiceManager(f.options, { ...f.deps, launchctl() { throw Object.assign(new Error('cannot connect'), { stderr: 'Operation not permitted', status: 1 }); } });
  assert.throws(() => manager.status(), /Cannot inspect service.*Operation not permitted/);
  assert.throws(() => manager.uninstall(), /cannot connect/);
  assert.equal(existsSync(status.manifestPath), true); assert.equal(existsSync(status.plistPath), true);
});
test('stop tolerates asynchronous launchd unload and a racing No such process response', t => {
  const f = fixture(t); f.manager.install(); f.manager.start(); f.job = false; let prints = 0, bootout = false;
  const manager = createServiceManager(f.options, { ...f.deps, launchctl(args) {
    if (args[0] === 'print') { prints++; if (!bootout || prints < 4) return 'state = waiting\npid = 12345\n'; throw Object.assign(new Error('missing'), { stderr: 'Could not find service' }); }
    if (args[0] === 'bootout') { bootout = true; throw Object.assign(new Error('gone'), { stderr: 'No such process' }); }
    return '';
  } });
  assert.equal(manager.stop().loaded, false); assert.ok(prints >= 4);
});
test('reinstall with a lower log limit reports retained oversized logs before any installation effect', t => {
  const f = fixture(t), status = f.manager.install(); writeFileSync(status.logs.stdout, 'x'.repeat(2048)); f.manager.uninstall();
  assert.throws(() => createServiceManager({ ...f.options, logMaxBytes: 1024 }, f.deps).install(), /archive them/);
  assert.equal(existsSync(status.plistPath), false); assert.equal(statSync(status.logs.stdout).size, 2048);
});
test('wrapper starts installed CLI without a shell and bounds both logs across rotation', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), cliPath = join(f.base, 'fake-cli.mjs');
  writeFileSync(cliPath, `import {writeSync,existsSync} from 'node:fs';\nwriteSync(1,'A'.repeat(800));\nconst interval=setInterval(()=>{if(existsSync(${JSON.stringify(join(stateDir(f.root), 'service/stdout.log'))})){clearInterval(interval);writeSync(1,'B'.repeat(800));writeSync(2,'E'.repeat(3000));}},10);\n`);
  const manager = createServiceManager({ ...f.options, cliPath, logMaxBytes: 1024 }, f.deps), status = manager.install();
  const child = spawnSync(process.execPath, wrapperArgs(f), { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(status.logs.stdout, 'utf8'), 'B'.repeat(800)); assert.equal(readFileSync(status.logs.stdout + '.1', 'utf8'), 'A'.repeat(800));
  assert.equal(readFileSync(status.logs.stderr, 'utf8'), 'E'.repeat(1024));
  const runtime = JSON.parse(readFileSync(join(stateDir(f.root), 'service/runtime.json'))); assert.ok(runtime.pid > 0 && runtime.childPid > 0 && runtime.pid !== runtime.childPid);
});

test('a newer package entry can inspect, stop and uninstall the same project installation', async t => {
  const f = fixture(t); f.manager.install(); f.manager.start();
  const nextPackage = join(f.base, 'new-package'); mkdirSync(nextPackage);
  let serviceSource = readFileSync(modulePath, 'utf8');
  for (const dependency of ['config.mjs', 'channels/feishu.mjs', 'harness/registry.mjs', 'database-maintenance.mjs', 'machine-coordination.mjs', 'service-health.mjs', 'service-patrol.mjs', 'state-paths.mjs']) {
    serviceSource = serviceSource.replaceAll(`'./${dependency}'`, JSON.stringify(pathToFileURL(join(dirname(modulePath), dependency)).href));
  }
  writeFileSync(join(nextPackage, 'service.mjs'), serviceSource);
  writeFileSync(join(nextPackage, 'config.mjs'), readFileSync(join(dirname(modulePath), 'config.mjs')));
  const next = await import(pathToFileURL(join(nextPackage, 'service.mjs')));
  const manager = next.createServiceManager(f.options, f.deps);
  assert.equal(manager.status().running, true); assert.equal(manager.stop().loaded, false);
  assert.equal(manager.uninstall().installed, false);
});
test('poll mode supports configured native gh without requiring webhook credentials', t => {
  const f = fixture(t), gh = join(f.base, 'gh'); writeFileSync(gh, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeProjectConfig(f.root, { github: { repository: 'owner/repo', allowedActors: ['owner'], executable: gh } });
  const status = f.manager.install(), manifest = JSON.parse(readFileSync(status.manifestPath));
  assert.equal(manifest.ghExecutable, gh); assert.ok(manifest.environment.PATH.split(':').includes(dirname(gh)));
});
test('wrapper startup validation errors are written to the bounded diagnostic log', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), status = f.manager.install(); rmSync(f.codex);
  const child = spawnSync(process.execPath, wrapperArgs(f), { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0); assert.match(readFileSync(status.logs.stderr, 'utf8'), /Executable is unavailable/);
  assert.equal(f.manager.status().blocked.code, 'SERVICE_CONFIGURATION');
});

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
test('installation persists only credential-free proxy settings needed outside the terminal environment', t => {
  const chosen = { HTTP_PROXY: 'http://127.0.0.1:8081', HTTPS_PROXY: 'https://proxy.example:443', ALL_PROXY: 'socks5h://127.0.0.1:1080', http_proxy: 'http://localhost:8081/', https_proxy: 'http://[::1]:8081', all_proxy: 'socks4a://localhost:1080', NO_PROXY: 'localhost,127.0.0.1, .example.com,10.0.0.0/8,[::1],::1', no_proxy: '*' };
  environment(t, { ...chosen, JS_SUPERAGENT_UNRELATED_SECRET: 'must-not-be-copied' });
  const f = fixture(t), status = f.manager.install(), manifest = JSON.parse(readFileSync(status.manifestPath));
  for (const [key, value] of Object.entries(chosen)) assert.equal(manifest.environment[key], value);
  assert.equal(manifest.environment.JS_SUPERAGENT_UNRELATED_SECRET, undefined);
  const generated = readFileSync(status.manifestPath, 'utf8') + readFileSync(status.plistPath, 'utf8');
  assert.equal(generated.includes('must-not-be-copied'), false);
});
test('proxy URL credentials, query, fragment and unsafe values are rejected without exposing the original value', t => {
  environment(t, Object.fromEntries(proxyKeys.map(key => [key, undefined])));
  const f = fixture(t);
  for (const value of ['http://private-user:private-password@localhost:8081', 'http://localhost:8081?token=private-token', 'http://localhost:8081#private-fragment', 'file:///private-path', 'http://localhost:8081/private-path', 'http://localhost:8081\n', 'invalid-private-value']) {
    process.env.HTTP_PROXY = value;
    assert.throws(() => f.manager.install(), error => { assert.match(error.message, /HTTP_PROXY must be a valid proxy URL/); assert.equal(error.message.includes('private-'), false); assert.equal(error.message.includes(value), false); return true; });
    assert.equal(existsSync(join(stateDir(f.root), 'service')), false);
  }
  delete process.env.HTTP_PROXY;
  process.env.https_proxy = 'http://user:password@localhost:8081';
  assert.throws(() => f.manager.install(), /https_proxy must be a valid proxy URL/);
  assert.equal(f.calls.length, 0);
});
test('proxy bypass lists reject malformed entries without echoing values and allow explicit empty bypass', t => {
  environment(t, Object.fromEntries(proxyKeys.map(key => [key, undefined])));
  const f = fixture(t);
  for (const value of ['localhost,,example.com', 'private-user@example.com', 'localhost\nsecret', 'https://private.example?secret', 'private-host '.repeat(1000)]) {
    process.env.NO_PROXY = value;
    assert.throws(() => f.manager.install(), error => { assert.match(error.message, /NO_PROXY must be a comma-separated/); assert.equal(error.message.includes(value), false); return true; });
  }
  process.env.NO_PROXY = '';
  const status = f.manager.install();
  assert.equal(JSON.parse(readFileSync(status.manifestPath)).environment.NO_PROXY, '');
});


test('legacy service manifests remain inspectable and stoppable but require explicit reinstall to start', t => {
  const f=fixture(t),status=f.manager.install(),manifest=JSON.parse(readFileSync(status.manifestPath));
  manifest.schemaVersion=1; manifest.codexExecutable=manifest.executorExecutable;
  delete manifest.executorExecutable;delete manifest.executionDriver;delete manifest.requiredEnvironment;
  writeFileSync(status.manifestPath,JSON.stringify(manifest));
  assert.equal(f.manager.status().installed,true);
  assert.throws(()=>f.manager.start(),/Legacy service installation/);
  assert.equal(f.manager.stop().running,false);
  assert.equal(f.calls.some(call=>call[0]==='bootstrap'),false);
  f.manager.uninstall();assert.equal(f.manager.install().installed,true);
});

test('service resolves persisted DSH settings without migration or forwarding a Codex override', {skip:process.platform!=='darwin'}, t => {
  const f=fixture(t),dsh=join(f.base,'dsh'),cliPath=join(f.base,'inspect-cli.mjs');
  writeFileSync(dsh,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const db=new DatabaseSync(join(stateDir(f.root), 'state.sqlite'));
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=5;');
  const execution={driver:'dsh-sdk',executable:dsh,model:'test',backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://example.invalid',apiKeyEnv:'W0_DSH_SERVICE_KEY'}};
  db.prepare('INSERT INTO kv VALUES(?,?)').run('executor:settings',JSON.stringify({revision:1,execution}));db.close();
  const before=readFileSync(join(stateDir(f.root), 'state.sqlite'));
  writeFileSync(cliPath,"if(process.argv.includes('--codex-path') || process.env.W0_DSH_SERVICE_KEY!=='mock-private-key') process.exit(7); console.log('configured-dsh');");
  const manager=createServiceManager({...f.options,cliPath},f.deps),status=manager.install();
  const manifest=JSON.parse(readFileSync(status.manifestPath));
  assert.equal(manifest.executionDriver,'dsh-sdk');assert.equal(manifest.executorExecutable,dsh);
  assert.deepEqual(manifest.requiredEnvironment,['W0_DSH_SERVICE_KEY']);assert.equal(manifest.codexExecutable,undefined);
  assert.equal(JSON.stringify(manifest).includes('mock-private-key'),false);
  const child=spawnSync(process.execPath,wrapperArgs(f),{encoding:'utf8',timeout:5000,env:{...process.env,W0_DSH_SERVICE_KEY:'mock-private-key'}});
  assert.equal(child.status,0,child.stderr);assert.match(readFileSync(status.logs.stdout,'utf8'),/configured-dsh/);
  assert.deepEqual(readFileSync(join(stateDir(f.root), 'state.sqlite')),before);
  assert.equal(f.calls.some(call=>call[0]==='bootstrap'),false);
});

function webhook(f, port = 8787) {
  const key = join(f.base, 'key.pem'), secret = join(f.base, 'webhook.secret');
  writeFileSync(key, 'FIXTURE-KEY'); writeFileSync(secret, 'FIXTURE-SECRET');
  writeProjectConfig(f.root, { github: { repository: 'owner/repo', allowedActors: ['owner'], app: { appId: '123', installationId: 456, privateKeyPath: key }, webhook: { secretPath: secret, port } } });
}
test('auto Webhook ports are persisted per installation, shared-machine conflicts are refused and uninstall releases only its declaration', t => {
  const a = fixture(t), b = fixture(t); webhook(a); webhook(b);
  const first = createServiceManager({ ...a.options, mode: 'webhook', port: 'auto' }, a.deps);
  const installed = first.install(), endpoint = installed.webhookEndpoint;
  assert.ok(endpoint.port > 0); assert.equal(installed.running, false);
  assert.deepEqual(first.install().webhookEndpoint, endpoint);
  assert.equal(JSON.parse(readFileSync(join(stateDir(a.root), 'config.json'))).github.webhook.port, 8787, 'service binding is not an implicit shared config change');
  const second = createServiceManager({ ...b.options, mode: 'webhook', port: endpoint.port }, { ...b.deps, coordinationDirectory: a.deps.coordinationDirectory });
  assert.throws(() => second.install(), error => ['PORT_CONFLICT', 'WEBHOOK_PORT_OWNED'].includes(error.code));
  assert.equal(b.calls.some(args => ['enable', 'bootstrap'].includes(args[0])), false);
  first.uninstall();
  assert.equal(second.install().webhookEndpoint.port, endpoint.port);
  second.uninstall();
});
test('an occupied port after installation blocks startup before enable, and explicit retry rechecks it', async t => {
  const f = fixture(t); webhook(f);
  const manager = createServiceManager({ ...f.options, mode: 'webhook', port: 'auto' }, f.deps), installed = manager.install();
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(installed.webhookEndpoint, resolve); });
  t.after(() => { if (server.listening) server.close(); });
  const before = f.calls.length;
  assert.throws(() => manager.start(), { code: 'EADDRINUSE' });
  assert.equal(f.calls.slice(before).some(args => ['enable', 'bootstrap', 'kickstart'].includes(args[0])), false);
  assert.equal(manager.status().blocked.code, 'EADDRINUSE');
  assert.equal(manager.status().ready, false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(manager.start().blocked, null);
  assert.equal(manager.status().ready, false, 'launchd PID is not a runtime ready receipt');
  manager.stop();
});
test('wrapper records permanent child startup failure and does not spawn it again without explicit start', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), cliPath = join(f.base, 'blocked-cli.mjs'), receipt = join(f.base, 'attempts');
  writeFileSync(cliPath, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(receipt)},'attempt\\n');process.send({type:'js-superagent:startup-error',code:'GITHUB_REPOSITORY_OWNED',message:'fixture-secret-not-for-state'},()=>process.exit(1));`);
  const manager = createServiceManager({ ...f.options, cliPath }, f.deps), installed = manager.install();
  for (let i = 0; i < 2; i++) assert.equal(spawnSync(process.execPath, wrapperArgs(f), { timeout: 5000 }).status, 0);
  assert.equal(readFileSync(receipt, 'utf8'), 'attempt\n');
  assert.equal(manager.status().blocked.code, 'GITHUB_REPOSITORY_OWNED');
  assert.equal(readFileSync(join(stateDir(f.root), 'service/startup.json'), 'utf8').includes('fixture-secret'), false);
  assert.match(readFileSync(installed.plistPath, 'utf8'), /SuccessfulExit<\/key><false\/>/);
});
test('service ready requires the live wrapper/child receipt and is cleared on stop', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), cliPath = join(f.base, 'ready-cli.mjs');
  writeFileSync(cliPath, "process.send({type:'js-superagent:ready'});setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));");
  createServiceManager({ ...f.options, cliPath }, f.deps).install();
  const child = spawn(process.execPath, wrapperArgs(f), { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const manager = createServiceManager(f.options, { ...f.deps, launchctl: () => `state = running\npid = ${child.pid}\n` });
  const deadline = Date.now() + 3000;
  while (!manager.status().ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.status().ready, true);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
  assert.equal(JSON.parse(readFileSync(join(stateDir(f.root), 'service/startup.json'))).state, 'stopped');
  assert.equal(manager.status().ready, false);
});
test('old unconditional restart policy remains inspectable and can be upgraded only while stopped', t => {
  const f = fixture(t), installed = f.manager.install();
  const manifest = JSON.parse(readFileSync(installed.manifestPath));
  delete manifest.restartPolicy;
  const oldPlist = readFileSync(installed.plistPath, 'utf8').replace('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>', '<key>KeepAlive</key><true/>');
  writeFileSync(installed.plistPath, oldPlist); manifest.plistHash = createHash('sha256').update(oldPlist).digest('hex'); writeFileSync(installed.manifestPath, JSON.stringify(manifest));
  assert.equal(f.manager.status().installed, true);
  assert.throws(() => f.manager.start(), /restart policy/);
  f.job = true; assert.throws(() => f.manager.install(), /Stop the service/);
  f.job = false; const updated = f.manager.install();
  assert.equal(updated.running, false); assert.equal(f.disabled, true);
  assert.equal(JSON.parse(readFileSync(updated.manifestPath)).restartPolicy, 'on-failure');
  assert.equal(f.calls.some(args => ['enable', 'bootstrap'].includes(args[0])), false);
});
test('unclassified process failure gets a bounded delayed retry, then blocks at the retry ceiling', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), cliPath = join(f.base, 'crashing-cli.mjs'), receipt = join(f.base, 'attempts');
  writeFileSync(cliPath, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(receipt)},'attempt\\n');process.exit(2);`);
  const manager = createServiceManager({ ...f.options, cliPath }, f.deps); manager.install();
  assert.equal(spawnSync(process.execPath, wrapperArgs(f), { timeout: 5000 }).status, 1);
  const path = join(stateDir(f.root), 'service/startup.json'), state = JSON.parse(readFileSync(path));
  assert.equal(state.state, 'retrying'); assert.equal(state.retryCount, 1); assert.ok(Date.parse(state.nextRetryAt) > Date.now());
  writeFileSync(path, JSON.stringify({ ...state, retryCount: 8, nextRetryAt: null }));
  assert.equal(spawnSync(process.execPath, wrapperArgs(f), { timeout: 5000 }).status, 0);
  assert.equal(manager.status().blocked.code, 'SERVICE_RETRY_LIMIT');
  assert.equal(readFileSync(receipt, 'utf8'), 'attempt\n');
});
test('relocation can retire the exactly verified old service when its original directory is gone', t => {
  const f = fixture(t), installed = f.manager.install(), target = join(f.base, 'moved-project');
  const unrelated = join(dirname(installed.plistPath), 'com.example.unrelated.plist'); writeFileSync(unrelated, 'unrelated');
  f.job = true;
  const state = stateDir(f.root); renameSync(f.root, target); renameSync(state, stateDir(target));
  const result = retireRelocatedService({ projectRoot: target, fromRoot: f.root }, f.deps);
  assert.equal(result.retired, true); assert.equal(result.manifest.projectRoot, f.root);
  assert.equal(existsSync(installed.plistPath), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'unrelated');
  assert.equal(existsSync(join(stateDir(target), 'service/manifest.json')), true, 'maintenance caller archives copied files after retirement');
  assert.equal(f.calls.some(args => args[0] === 'bootstrap'), false);
  assert.equal(retireRelocatedService({ projectRoot: target, fromRoot: f.root }, f.deps).alreadyRetired, true);
});
test('relocation refuses a modified old plist before disabling or unloading it', t => {
  const f = fixture(t), installed = f.manager.install(), target = join(f.base, 'moved-project');
  const state = stateDir(f.root); renameSync(f.root, target); renameSync(state, stateDir(target)); writeFileSync(installed.plistPath, readFileSync(installed.plistPath, 'utf8') + '<!-- external edit -->');
  const before = f.calls.length;
  assert.throws(() => retireRelocatedService({ projectRoot: target, fromRoot: f.root }, f.deps), /ownership or content changed/);
  assert.equal(f.calls.slice(before).some(args => ['disable', 'bootout'].includes(args[0])), false);
  assert.equal(existsSync(installed.plistPath), true);
});
test('old restart policy from another installed package requires explicit reinstall without editing that deployment', t => {
  for (const field of ['modulePath', 'cliPath']) {
    const f = fixture(t), installed = f.manager.install(), manifest = JSON.parse(readFileSync(installed.manifestPath));
    const original = manifest[field]; manifest[field] = join(f.base, field === 'modulePath' ? 'old-service.mjs' : 'old-cli.mjs');
    delete manifest.restartPolicy;
    const plist = readFileSync(installed.plistPath, 'utf8').replace('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>', '<key>KeepAlive</key><true/>').replace(original, manifest[field]);
    manifest.plistHash = createHash('sha256').update(plist).digest('hex');
    writeFileSync(installed.plistPath, plist); writeFileSync(installed.manifestPath, JSON.stringify(manifest));
    const before = f.calls.length;
    assert.throws(() => f.manager.install(), /different installed package.*uninstall and reinstall/);
    assert.equal(readFileSync(installed.plistPath, 'utf8'), plist);
    assert.deepEqual(JSON.parse(readFileSync(installed.manifestPath)), manifest);
    assert.equal(f.calls.slice(before).some(args => ['disable', 'enable', 'bootstrap', 'bootout'].includes(args[0])), false);
    assert.equal(f.manager.status().installed, true); f.manager.stop();
  }
});
test('concurrent machine registry initialization gets bounded retry without clearing registry evidence', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), cliPath = join(f.base, 'initializing-cli.mjs'), evidence = join(f.base, 'registry-evidence');
  writeFileSync(evidence, 'preserve-creator-evidence');
  writeFileSync(cliPath, "process.send({type:'js-superagent:startup-error',code:'MACHINE_REGISTRY_INITIALIZING'},()=>process.exit(1));");
  const manager = createServiceManager({ ...f.options, cliPath }, f.deps); manager.install();
  assert.equal(spawnSync(process.execPath, wrapperArgs(f), { timeout: 5000 }).status, 1);
  assert.equal(manager.status().blocked, null);
  assert.equal(manager.status().startupState, 'retrying');
  assert.equal(manager.status().retryCount, 1);
  assert.equal(readFileSync(evidence, 'utf8'), 'preserve-creator-evidence');
});

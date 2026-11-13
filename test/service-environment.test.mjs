import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeProjectConfig } from '../src/config.mjs';
import { createServiceManager } from '../src/service.mjs';
import { inspectProcessOwner } from '../src/machine-coordination.mjs';

const modulePath = fileURLToPath(new URL('../src/service.mjs', import.meta.url));
const KEY = 'JS_SUPERAGENT_TEST_SERVICE_KEY';
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-service-env-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'home'), dsh = join(base, 'dsh');
  mkdirSync(root); mkdirSync(home); writeFileSync(dsh, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  initializeProjectConfig(root, { execution: { driver: 'codex-app-server', executable: dsh } });
  const db = new DatabaseSync(join(stateDir(root), 'state.sqlite'));
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=5;');
  db.prepare('INSERT INTO kv VALUES(?,?)').run('executor:settings', JSON.stringify({ revision: 1, execution: {
    driver: 'dsh-sdk', executable: dsh, model: 'fixture', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://example.invalid', apiKeyEnv: KEY },
  } })); db.close();
  const environmentFile = join(base, 'service.env'), cliPath = join(base, 'child.mjs'), childResult = join(base, 'child.json');
  writeFileSync(environmentFile, `${KEY}=fixture-only-secret\nUNRELATED_SECRET=not-for-child\nNODE_OPTIONS=--invalid-env-file-option\n`, { mode: 0o600 });
  writeFileSync(cliPath, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(childResult)},JSON.stringify({key:process.env.${KEY},unrelated:process.env.UNRELATED_SECRET,nodeOptions:process.env.NODE_OPTIONS}));console.log('child-ok');`);
  let job = false, disabled = false, alive = false;
  const record = () => writeFileSync(join(stateDir(root), 'service/runtime.json'), JSON.stringify({ healthProtocol: 1,
    runId: 'cd432b56-5645-4e8d-b211-cc94f64fd111', pid: 12345, childPid: 12346,
    owner: { host: 'fixture', pid: 12345, birth: 'wrapper', bootId: 'fixture-boot' },
    childOwner: { host: 'fixture', pid: 12346, birth: 'child', bootId: 'fixture-boot' }, startedAt: new Date().toISOString() }));
  const calls = [], dependencies = { platform: 'darwin', uid: process.getuid(), stopTimeoutMs: 0,
    ownerState: owner => owner?.bootId === 'fixture-boot' ? alive ? 'alive' : 'dead' : inspectProcessOwner(owner),
    signalProcess: () => { alive = false; }, launchctl(args) {
    calls.push(args);
    if (args[0] === 'print') {
      if (!job) throw Object.assign(new Error('missing'), { stderr: 'Could not find service' });
      return 'state = running\npid = 12345\n';
    }
    if (args[0] === 'disable') disabled = true;
    if (args[0] === 'enable') disabled = false;
    if (args[0] === 'bootstrap') { job = true; alive = true; record(); }
    if (args[0] === 'bootout') job = false;
    return '';
  } };
  const options = { projectRoot: root, homeDirectory: home, cliPath };
  const manager = (extra = {}) => createServiceManager({ ...options, ...extra }, dependencies);
  return { base, root, home, environmentFile, childResult, calls, manager, get disabled() { return disabled; }, set job(value) { job = value; alive = value; if (value) record(); } };
}
const cleanRun = f => {
  const path=join(stateDir(f.root),'service/control-intent.json'),intent=JSON.parse(readFileSync(path));
  writeFileSync(path,JSON.stringify({...intent,desired:'running'}));
  return spawnSync(process.execPath, [modulePath, 'run', f.root], { encoding: 'utf8', timeout: 5000, env: { HOME: f.home, PATH: process.env.PATH, JS_SUPERAGENT_HOME: process.env.JS_SUPERAGENT_HOME } });
};

test('DSH service reads its persisted file with no launchd secret, only forwards required keys and rereads rotation', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), status = f.manager({ environmentFile: f.environmentFile }).install();
  const generated = readFileSync(status.manifestPath, 'utf8') + readFileSync(status.plistPath, 'utf8');
  assert.equal(JSON.parse(readFileSync(status.manifestPath)).environmentFile, f.environmentFile);
  assert.equal(generated.includes('fixture-only-secret'), false);
  assert.equal(generated.includes('not-for-child'), false);
  assert.equal(f.disabled, true);
  for (const secret of ['fixture-only-secret', 'rotated-fixture-secret']) {
    writeFileSync(f.environmentFile, `${KEY}=${secret}\nUNRELATED_SECRET=not-for-child\nNODE_OPTIONS=--invalid-env-file-option\n`, { mode: 0o600 });
    const child = cleanRun(f);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.childResult)), { key: secret });
    assert.equal(readFileSync(status.logs.stdout, 'utf8').includes(secret), false);
    assert.equal(child.stderr.includes(secret), false);
  }
  assert.equal(f.calls.some(args => ['bootstrap', 'enable', 'kickstart'].includes(args[0])), false);
});

test('invalid secret files fail before enabling service and do not echo their contents', t => {
  const mutations = {
    missing: f => unlinkSync(f.environmentFile),
    permissions: f => chmodSync(f.environmentFile, 0o644),
    symlink: f => { const target = join(f.base, 'target.env'); writeFileSync(target, `${KEY}=fixture-only-secret\n`, { mode: 0o600 }); unlinkSync(f.environmentFile); symlinkSync(target, f.environmentFile); },
    hardlink: f => linkSync(f.environmentFile, join(f.base, 'alias.env')),
    oversized: f => writeFileSync(f.environmentFile, `${KEY}=fixture-only-secret\n#${'x'.repeat(65536)}`),
    missingKey: f => writeFileSync(f.environmentFile, 'OTHER_KEY=fixture-only-secret\n'),
    nul: f => writeFileSync(f.environmentFile, `${KEY}=fixture-only-secret\0bad\n`),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = fixture(t), manager = f.manager({ environmentFile: f.environmentFile });
    manager.install(); mutate(f);
    const before = f.calls.length;
    assert.throws(() => manager.start(), error => { assert.equal(error.message.includes('fixture-only-secret'), false); return true; }, name);
    assert.equal(f.calls.slice(before).some(args => ['enable', 'bootstrap', 'kickstart'].includes(args[0])), false, name);
    assert.equal(existsSync(f.childResult), false);
  }
});

test('stopped installed service gains a persistent file reference without changing its plist or starting', t => {
  const f = fixture(t), first = f.manager().install(), beforePlist = readFileSync(first.plistPath, 'utf8');
  const updated = f.manager({ environmentFile: f.environmentFile }).install();
  assert.equal(JSON.parse(readFileSync(updated.manifestPath)).environmentFile, f.environmentFile);
  assert.equal(readFileSync(updated.plistPath, 'utf8'), beforePlist);
  assert.equal(updated.running, false); assert.equal(updated.loaded, false); assert.equal(f.disabled, true);
  assert.equal(f.calls.some(args => ['enable', 'bootstrap', 'kickstart'].includes(args[0])), false);
  const beforeManifest = readFileSync(updated.manifestPath, 'utf8');
  f.manager({ environmentFile: f.environmentFile }).install();
  assert.equal(readFileSync(updated.manifestPath, 'utf8'), beforeManifest);
  const next = join(f.base, 'replacement.env'); writeFileSync(next, `${KEY}=replacement-fixture\n`, { mode: 0o600 });
  f.job = true;
  assert.throws(() => f.manager({ environmentFile: next }).install(), /stop|running|loaded/i);
  assert.equal(JSON.parse(readFileSync(updated.manifestPath)).environmentFile, f.environmentFile);
  f.job = false;
  f.manager().uninstall();
  assert.equal(existsSync(f.environmentFile), true, 'uninstall must retain externally managed credentials');
});

test('status and stop remain available when configured secrets disappear', t => {
  const f = fixture(t), manager = f.manager({ environmentFile: f.environmentFile }); manager.install();
  unlinkSync(f.environmentFile); f.job = true;
  assert.equal(manager.status().running, true);
  assert.equal(manager.stop().loaded, false);
  assert.equal(f.disabled, true);
});

test('a bad persistent file cannot be masked by an inherited launchd secret', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), status = f.manager({ environmentFile: f.environmentFile }).install();
  const intentPath=join(stateDir(f.root),'service/control-intent.json');
  writeFileSync(intentPath,JSON.stringify({...JSON.parse(readFileSync(intentPath)),desired:'running'}));
  writeFileSync(f.environmentFile, 'OTHER_KEY=fixture-only-secret\n');
  const child = spawnSync(process.execPath, [modulePath, 'run', f.root], { encoding: 'utf8', timeout: 5000, env: { HOME: f.home, PATH: process.env.PATH, JS_SUPERAGENT_HOME: process.env.JS_SUPERAGENT_HOME, [KEY]: 'stale-inherited-fixture' } });
  assert.equal(child.status, 0); assert.equal(f.manager().status().blocked.code, 'SERVICE_CONFIGURATION'); assert.equal(existsSync(f.childResult), false);
  assert.equal(child.stderr.includes('fixture-only-secret'), false); assert.equal(child.stderr.includes('stale-inherited-fixture'), false);
  if (existsSync(status.logs.stderr)) assert.equal(readFileSync(status.logs.stderr, 'utf8').includes('fixture-only-secret'), false);
});

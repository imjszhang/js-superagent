import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareWorkspace } from '../src/workspaces.mjs';
import { normalizeVerificationProfile, captureVerificationTree, runVerification, verificationMatches } from '../src/verification.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-verification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  const workspace = prepareWorkspace({ projectRoot: root, ticketId: 'verify', config: { mode: 'copy' }, persist() {} });
  return { root, workspace };
}
function profile(code, overrides = {}) {
  return { id: 'node-check', version: '1', command: process.execPath, args: ['-e', code], environment: 'host', allowHostExecution: true, ...overrides };
}

test('host verification records command facts and allows actual localhost listener tests', async t => {
  const { root, workspace } = fixture(t), records = [];
  const result = await runVerification({ projectRoot: root, workspace, profile: profile("require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log('port check passed'); this.close(); });"), persist: value => records.push(value) });
  assert.equal(result.status, 'passed'); assert.equal(result.isolation, false);
  assert.deepEqual(records.map(record => record.status), ['pending', 'running', 'running', 'running', 'passed']);
  assert.equal(result.exitCode, 0);
  assert.match(readFileSync(result.logs.stdout, 'utf8'), /port check passed/);
  assert.equal(verificationMatches({ projectRoot: root, workspace, verification: result }), true);
  writeFileSync(join(workspace.path, 'source.js'), 'changed');
  assert.equal(verificationMatches({ projectRoot: root, workspace, verification: result }), false);
});

test('a successful command that changes source is not passing evidence for the new tree', async t => {
  const { root, workspace } = fixture(t);
  const result = await runVerification({ projectRoot: root, workspace, profile: profile("require('node:fs').writeFileSync('source.js', 'changed')"), persist() {} });
  assert.equal(result.status, 'changed');
  assert.equal(verificationMatches({ projectRoot: root, workspace, verification: result }), false);
  const prepared = await runVerification({ projectRoot: root, workspace, profile: profile("require('node:fs').writeFileSync('source.js', 'prepared')", { kind: 'prepare' }), persist() {} });
  assert.equal(prepared.status, 'passed');
  assert.equal(verificationMatches({ projectRoot: root, workspace, verification: prepared }), false);
});

test('nonzero, timeouts and cancellation remain distinct recorded outcomes', async t => {
  const { root, workspace } = fixture(t);
  const failed = await runVerification({ projectRoot: root, workspace, profile: profile('process.exit(7)'), persist() {} });
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 7);
  const timed = await runVerification({ projectRoot: root, workspace, profile: profile('setInterval(() => {}, 1000)', { timeoutMs: 100 }), persist() {} });
  assert.equal(timed.status, 'timed-out'); assert.equal(timed.exitCode, null);
  const controller = new AbortController();
  const work = runVerification({ projectRoot: root, workspace, profile: profile('setInterval(() => {}, 1000)'), signal: controller.signal, persist() {} });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await work).status, 'cancelled');
});

test('verification requires an explicit trusted host profile and constrains cwd', async t => {
  const { root, workspace } = fixture(t);
  assert.throws(() => normalizeVerificationProfile({ ...profile(''), allowHostExecution: false }), /requires explicit/);
  assert.throws(() => normalizeVerificationProfile({ ...profile(''), arbitraryCommand: 'ignored' }), /Invalid verification profile/);
  assert.throws(() => normalizeVerificationProfile(profile('', { cwd: '../escape' })), /relative path/);
  symlinkSync(root, join(workspace.path, 'escape'));
  await assert.rejects(runVerification({ projectRoot: root, workspace, profile: profile('', { cwd: 'escape' }), persist() {} }), /inside its owned workspace/);
});

test('secret environment is not inherited, logs are bounded and private state does not change fingerprints', async t => {
  const { root, workspace } = fixture(t);
  const before = captureVerificationTree({ projectRoot: root, workspace });
  writeFileSync(join(workspace.path, '.js-superagent', 'irrelevant.log'), 'log');
  assert.equal(captureVerificationTree({ projectRoot: root, workspace }).digest, before.digest);
  process.env.JS_SUPERAGENT_TEST_SECRET = 'do-not-inherit';
  t.after(() => delete process.env.JS_SUPERAGENT_TEST_SECRET);
  const result = await runVerification({ projectRoot: root, workspace, profile: profile("if (process.env.JS_SUPERAGENT_TEST_SECRET) process.exit(99); console.log('a'.repeat(4096))", { maxLogBytes: 1024 }), persist() {} });
  assert.equal(result.status, 'passed'); assert.equal(result.logTruncated.stdout, true);
  assert.equal(readFileSync(result.logs.stdout).length, 1024);
});

test('an unpersisted intent never starts a command and verification IDs cannot overwrite previous records', async t => {
  const { root, workspace } = fixture(t);
  await assert.rejects(runVerification({ projectRoot: root, workspace, profile: profile("require('node:fs').writeFileSync('source.js', 'wrong')"), persist() { throw new Error('journal unavailable'); } }), /journal unavailable/);
  assert.match(readFileSync(join(workspace.path, 'source.js'), 'utf8'), /value = 1/);
  await runVerification({ projectRoot: root, workspace, profile: profile(''), verificationId: 'fixed', persist() {} });
  await assert.rejects(runVerification({ projectRoot: root, workspace, profile: profile(''), verificationId: 'fixed', persist() {} }), /EEXIST/);
});


test('verification supervisor stops its command after the hosting process is killed', async t => {
  const { root, workspace } = fixture(t);
  const journal = join(root, 'verification-journal.json');
  const module = fileURLToPath(new URL('../src/verification.mjs', import.meta.url));
  const source = `import { runVerification } from ${JSON.stringify(module)}; import { writeFileSync } from 'node:fs'; await runVerification(${JSON.stringify({ projectRoot: root, workspace, profile: profile('setInterval(() => {}, 1000)') }).slice(0, -1)}, persist(value) { writeFileSync(${JSON.stringify(journal)}, JSON.stringify(value)); }});`;
  const host = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  t.after(() => host.kill('SIGKILL'));
  let record;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { record = JSON.parse(readFileSync(journal, 'utf8')); } catch {}
    if (record?.childPid) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(record?.childPid, 'supervisor and command identities saved before host death');
  host.kill('SIGKILL');
  await new Promise(resolve => host.once('close', resolve));
  const alive = pid => {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
    return result.status === 0 && !result.stdout.trim().startsWith('Z');
  };
  for (let attempt = 0; attempt < 100 && (alive(record.pid) || alive(record.childPid)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(record.childPid), false); assert.equal(alive(record.pid), false);
});


test('trusted verification paths keep large unrelated content outside the proof scope', async t => {
  const { root, workspace } = fixture(t);
  mkdirSync(join(workspace.path, 'media')); writeFileSync(join(workspace.path, 'media', 'unrelated'), 'one');
  const result = await runVerification({ projectRoot: root, workspace, profile: profile('', { paths: ['source.js'] }), persist() {} });
  assert.deepEqual(result.treeAfter.paths, ['source.js']); assert.equal(result.treeAfter.files, 1);
  writeFileSync(join(workspace.path, 'media', 'unrelated'), 'two');
  assert.equal(verificationMatches({ projectRoot: root, workspace, verification: result }), true);
  writeFileSync(join(workspace.path, 'source.js'), 'changed');
  assert.equal(verificationMatches({ projectRoot: root, workspace, verification: result }), false);
});

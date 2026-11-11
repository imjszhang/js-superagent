import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync, symlinkSync, linkSync, writeFileSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, put, snapshot, prepare } from './helpers/material-workspace.mjs';
import { previewLocalApplication, applyLocalApplication, recoverLocalApplication, inspectLocalApplication, listLocalApplications } from '../src/runtime/local-application.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';

function setup(t) {
  const f = fixture(t);
  put(f.root, 'docs/a.md', 'user dirty a'); put(f.root, 'docs/delete.md', 'user dirty delete'); put(f.root, 'outside.md', 'unrelated');
  f.workspace = prepare(f, snapshot(f, ['docs/a.md', 'docs/delete.md']));
  put(f.workspace.path, 'docs/a.md', 'Worker a'); put(f.workspace.path, 'docs/new.md', 'Worker new');
  chmodSync(join(f.workspace.path, 'docs/new.md'), 0o664); unlinkSync(join(f.workspace.path, 'docs/delete.md'));
  f.paths = ['docs']; f.authorize = () => true; f.withLock = (key, callback) => { assert.match(key, /^local-application:/); return callback(); };
  f.persist = () => {}; f.operationId = 'apply-1';
  f.plan = previewLocalApplication(f); return f;
}
async function interrupted(f, appliedCount = 1) {
  let failed = false;
  await assert.rejects(applyLocalApplication({ ...f, persist(record) {
    if (!failed && record.status === 'applying' && record.appliedPaths.length === appliedCount) { failed = true; throw new Error('simulated store failure'); }
  } }), { code: 'MATERIAL_APPLY_INTERRUPTED' });
  return inspectLocalApplication(f);
}

test('host applies only the reviewed Worker increment, including added/modified/deleted files', async t => {
  const f = setup(t), records = [];
  assert.deepEqual(f.plan.changes.map(({ path, status }) => ({ path, status })), [
    { path: 'docs/a.md', status: 'modified' }, { path: 'docs/delete.md', status: 'deleted' }, { path: 'docs/new.md', status: 'added' },
  ]);
  const result = await applyLocalApplication({ ...f, persist: record => records.push(record) });
  assert.equal(result.status, 'applied');
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'Worker a');
  assert.equal(readFileSync(join(f.root, 'docs/new.md'), 'utf8'), 'Worker new');
  assert.equal(statSync(join(f.root, 'docs/new.md')).mode & 0o777, 0o664);
  assert.equal(existsSync(join(f.root, 'docs/delete.md')), false);
  assert.equal(readFileSync(join(f.root, 'outside.md'), 'utf8'), 'unrelated');
  assert.equal(records[0].status, 'preparing'); assert.equal(records.at(-1).status, 'applied');
  put(f.root, 'docs/a.md', 'later user edit');
  assert.deepEqual(await applyLocalApplication(f), result);
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'later user edit');
});

test('changed source, changed Worker content, out-of-scope changes and reused operation IDs refuse writes', async t => {
  const f = setup(t);
  put(f.root, 'docs/a.md', 'later source');
  await assert.rejects(applyLocalApplication(f), { code: 'MATERIAL_APPLY_CONFLICT' });
  assert.equal(existsSync(join(f.root, 'docs/new.md')), false);
  put(f.root, 'docs/a.md', 'user dirty a'); put(f.workspace.path, 'docs/a.md', 'different Worker');
  await assert.rejects(applyLocalApplication(f), /plan changed/);
  put(f.workspace.path, 'docs/a.md', 'Worker a'); put(f.workspace.path, 'outside.md', 'escape');
  assert.throws(() => previewLocalApplication(f), /allowed application paths/);
  unlinkSync(join(f.workspace.path, 'outside.md'));
  await applyLocalApplication(f);
  const altered = { ...f.plan, paths: ['docs/a.md'] };
  // An altered reviewed plan is rejected before its operation can be reused.
  await assert.rejects(applyLocalApplication({ ...f, plan: altered }), /Invalid local application plan/);
});

test('local apply requires synchronous explicit authorization and a host write fence', async t => {
  const f = setup(t);
  await assert.rejects(applyLocalApplication({ ...f, withLock: undefined }), /write fence/);
  for (const authorize of [undefined, () => false, () => undefined, async () => true]) await assert.rejects(applyLocalApplication({ ...f, authorize }), /authorization/);
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'user dirty a');
});

test('partial application can finish exactly once from durable before/after states', async t => {
  const f = setup(t), record = await interrupted(f);
  assert.equal(record.status, 'interrupted'); assert.deepEqual(record.appliedPaths, ['docs/a.md']);
  await assert.rejects(applyLocalApplication(f), { code: 'MATERIAL_APPLY_RECOVERY_REQUIRED' });
  const result = await recoverLocalApplication({ ...f, mode: 'finish' });
  assert.equal(result.status, 'applied'); assert.equal(readFileSync(join(f.root, 'docs/new.md'), 'utf8'), 'Worker new');
  assert.equal(existsSync(join(f.root, 'docs/delete.md')), false);
  assert.deepEqual(await recoverLocalApplication({ ...f, mode: 'finish' }), result);
});

test('SIGKILL after the first source write leaves a discoverable owner and resumes without a Worker', async t => {
  const f = setup(t), input = { projectRoot: f.root, workspace: f.workspace, plan: f.plan, operationId: f.operationId };
  const script = `import {applyLocalApplication} from ${JSON.stringify(new URL('../src/runtime/local-application.mjs', import.meta.url).href)};
    await applyLocalApplication({...${JSON.stringify(input)}, authorize:()=>true, withLock:(_key,work)=>work(),
      persist(record){if(record.status==='applying'&&record.appliedPaths.length===1)process.kill(process.pid,'SIGKILL');}});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const record = listLocalApplications({ projectRoot: f.root })[0];
  assert.equal(record.status, 'applying'); assert.deepEqual(record.appliedPaths, ['docs/a.md']);
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'Worker a');
  const result = await recoverLocalApplication({ ...f, mode: 'finish' });
  assert.equal(result.status, 'applied'); assert.equal(readFileSync(join(f.root, 'docs/new.md'), 'utf8'), 'Worker new');
  assert.equal(existsSync(join(f.root, 'docs/delete.md')), false);
});

test('rollback restores the original dirty baseline after writes, without restoring committed historical content', async t => {
  const f = setup(t); await interrupted(f, 3);
  assert.equal(existsSync(join(f.root, 'docs/delete.md')), false);
  const result = await recoverLocalApplication({ ...f, mode: 'rollback' });
  assert.equal(result.status, 'rolled-back');
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'user dirty a');
  assert.equal(readFileSync(join(f.root, 'docs/delete.md'), 'utf8'), 'user dirty delete');
  assert.equal(existsSync(join(f.root, 'docs/new.md')), false);
  assert.deepEqual(await recoverLocalApplication({ ...f, mode: 'rollback' }), result);
});

test('recovery prechecks every file and refuses unknown newer source edits or corrupt backups', async t => {
  const f = setup(t); await interrupted(f);
  put(f.root, 'docs/new.md', 'concurrent user new');
  await assert.rejects(recoverLocalApplication({ ...f, mode: 'rollback' }), { code: 'MATERIAL_APPLY_CONFLICT' });
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'Worker a');
  unlinkSync(join(f.root, 'docs/new.md'));
  writeFileSync(join(projectStateDirectory(f.root), 'local-applications', f.operationId, '0-before'), 'corrupt');
  await assert.rejects(recoverLocalApplication({ ...f, mode: 'rollback' }), /backup/);
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'Worker a');
});

test('lost acknowledgement before backups has a durable owner and explicit no-write rollback', async t => {
  const f = setup(t);
  await assert.rejects(applyLocalApplication({ ...f, persist(record) { if (record.status === 'preparing') throw new Error('preparing acknowledgement lost'); } }), /acknowledgement lost/);
  assert.equal(inspectLocalApplication(f).status, 'preparing');
  assert.equal(listLocalApplications({ projectRoot: f.root, ticketId: 'material-ticket' })[0].status, 'preparing');
  assert.deepEqual(listLocalApplications({ projectRoot: f.root, ticketId: 'other-ticket' }), []);
  await assert.rejects(recoverLocalApplication({ ...f, mode: 'finish' }), /backup preparation is incomplete/);
  const result = await recoverLocalApplication({ ...f, mode: 'rollback' });
  assert.equal(result.status, 'rolled-back'); assert.equal(inspectLocalApplication(f).status, 'rolled-back');
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'user dirty a');
});

test('journal inventory returns durable receipts and rejects unknown owners and links before filtering', async t => {
  const f = setup(t);
  assert.deepEqual(listLocalApplications({ projectRoot: f.root }), []);
  await applyLocalApplication(f);
  assert.deepEqual(listLocalApplications({ projectRoot: f.root }), [inspectLocalApplication(f)]);
  const journal = join(projectStateDirectory(f.root), 'local-applications');
  symlinkSync(f.root, join(journal, 'malicious-owner'));
  assert.throws(() => listLocalApplications({ projectRoot: f.root, ticketId: 'unrelated-ticket' }), { code: 'MATERIAL_APPLY_JOURNAL_INVALID' });
  unlinkSync(join(journal, 'malicious-owner')); mkdirSync(join(journal, 'unknown-owner'));
  assert.throws(() => listLocalApplications({ projectRoot: f.root }), { code: 'MATERIAL_APPLY_JOURNAL_INVALID' });
});

test('authorization revocation stops an ongoing application and leaves explicit recovery', async t => {
  const f = setup(t); let allowed = true;
  await assert.rejects(applyLocalApplication({ ...f, authorize: () => allowed, persist(record) { if (record.appliedPaths.length) allowed = false; } }), { code: 'MATERIAL_APPLY_INTERRUPTED' });
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'Worker a');
  assert.equal(existsSync(join(f.root, 'docs/delete.md')), true);
  await recoverLocalApplication({ ...f, mode: 'rollback' });
  assert.equal(readFileSync(join(f.root, 'docs/a.md'), 'utf8'), 'user dirty a');
});

test('symbolic and hard links are refused in either source or Worker result', t => {
  const f = setup(t);
  unlinkSync(join(f.workspace.path, 'docs/new.md')); symlinkSync(join(f.root, 'outside.md'), join(f.workspace.path, 'docs/new.md'));
  assert.throws(() => previewLocalApplication(f), /unlinked regular files/);
  unlinkSync(join(f.workspace.path, 'docs/new.md')); linkSync(join(f.root, 'outside.md'), join(f.workspace.path, 'docs/new.md'));
  assert.throws(() => previewLocalApplication(f), /unlinked regular files/);
});

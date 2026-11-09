import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorkspace, prepareChildWorkspaceSnapshot, inspectWorkspace } from '../src/workspaces.mjs';
import { planChildAdoption, applyChildAdoption, recoverChildAdoption } from '../src/runtime/child-adoption.mjs';

function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'js-superagent-child-adopt-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(join(projectRoot, 'src')); writeFileSync(join(projectRoot, 'src/example.txt'), 'project baseline');
  writeFileSync(join(projectRoot, '.env'), 'private'); writeFileSync(join(projectRoot, 'other.txt'), 'not delegated');
  const parentWorkspace = prepareWorkspace({ projectRoot, ticketId: 'parent', config: { mode: 'copy' }, persist() {} });
  writeFileSync(join(parentWorkspace.path, 'src/example.txt'), 'parent uncommitted');
  writeFileSync(join(parentWorkspace.path, 'src/delete.txt'), 'remove later');
  const childWorkspace = prepareChildWorkspaceSnapshot({ projectRoot, ticketId: 'child', parentWorkspace, paths: ['src'], persist() {} });
  return { projectRoot, parentWorkspace, childWorkspace, paths: ['src'] };
}

test('child snapshot contains current parent files and excludes undelegated data', t => {
  const f = fixture(t);
  assert.equal(readFileSync(join(f.childWorkspace.path, 'src/example.txt'), 'utf8'), 'parent uncommitted');
  assert.equal(existsSync(join(f.childWorkspace.path, '.env')), false);
  assert.equal(existsSync(join(f.childWorkspace.path, 'other.txt')), false);
  assert.equal(f.childWorkspace.sourceWorkspaceProvisionId, f.parentWorkspace.provisionId);
  assert.deepEqual(inspectWorkspace({ projectRoot: f.projectRoot, workspace: f.childWorkspace }).changes, []);
});

test('reviewed child changes apply only to the isolated parent and invalidate prior verification first', t => {
  const f = fixture(t), records = []; let invalidated = false;
  writeFileSync(join(f.childWorkspace.path, 'src/example.txt'), 'child result');
  writeFileSync(join(f.childWorkspace.path, 'src/new.txt'), 'new');
  unlinkSync(join(f.childWorkspace.path, 'src/delete.txt'));
  const plan = planChildAdoption(f);
  assert.equal(plan.changes.length, 3);
  const result = applyChildAdoption({ ...f, plan, persist: record => records.push(record), invalidateVerification() {
    assert.equal(readFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'utf8'), 'parent uncommitted'); invalidated = true;
  } });
  assert.equal(invalidated, true); assert.equal(result.status, 'applied'); assert.equal(result.requiresVerification, true);
  assert.equal(readFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'utf8'), 'child result');
  assert.equal(existsSync(join(f.parentWorkspace.path, 'src/delete.txt')), false);
  assert.equal(readFileSync(join(f.projectRoot, 'src/example.txt'), 'utf8'), 'project baseline');
  assert.equal(records[0].status, 'pending'); assert.equal(records.at(-1).status, 'applied');
});

test('parent edits after snapshot or plan refuse adoption without overwriting them', t => {
  const f = fixture(t); writeFileSync(join(f.childWorkspace.path, 'src/example.txt'), 'child result');
  const plan = planChildAdoption(f);
  writeFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'new parent change');
  assert.throws(() => applyChildAdoption({ ...f, plan, persist() {}, invalidateVerification() {} }), /changed since/);
  assert.equal(readFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'utf8'), 'new parent change');
});

test('out-of-scope changes and symlink changes are visible and refused', t => {
  const f = fixture(t); writeFileSync(join(f.childWorkspace.path, 'outside.txt'), 'outside');
  assert.ok(inspectWorkspace({ projectRoot: f.projectRoot, workspace: f.childWorkspace }).changes.some(item => item.path === 'outside.txt'));
  assert.throws(() => planChildAdoption(f), /allowed adoption paths/);
  unlinkSync(join(f.childWorkspace.path, 'outside.txt'));
  symlinkSync('/etc/hosts', join(f.childWorkspace.path, 'src/link.txt'));
  assert.throws(() => planChildAdoption(f), /symlink/);
});

test('partial application persistence failure rolls back only its own changed files', t => {
  const f = fixture(t); writeFileSync(join(f.childWorkspace.path, 'src/example.txt'), 'child result');
  const plan = planChildAdoption(f), records = []; let failed = false;
  assert.throws(() => applyChildAdoption({ ...f, plan, invalidateVerification() {}, persist(record) {
    records.push(record);
    if (!failed && record.status === 'applying' && record.appliedPaths.length) { failed = true; throw new Error('journal unavailable'); }
  } }), /did not complete/);
  assert.equal(readFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'utf8'), 'parent uncommitted');
  assert.equal(records.at(-1).status, 'rolled-back');
});

test('explicit reconciliation uses verified durable backups and refuses newer parent changes', t => {
  const f = fixture(t); writeFileSync(join(f.childWorkspace.path, 'src/example.txt'), 'child result');
  const plan = planChildAdoption(f);
  const record = applyChildAdoption({ ...f, plan, persist() {}, invalidateVerification() {} });
  const rolled = recoverChildAdoption({ ...f, record, mode: 'rollback', persist() {}, invalidateVerification() {} });
  assert.equal(rolled.status, 'rolled-back'); assert.equal(readFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'utf8'), 'parent uncommitted');
  const finished = recoverChildAdoption({ ...f, record: rolled, mode: 'finish', persist() {}, invalidateVerification() {} });
  assert.equal(finished.status, 'applied'); assert.equal(readFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'utf8'), 'child result');
  writeFileSync(join(f.parentWorkspace.path, 'src/example.txt'), 'new work');
  assert.throws(() => recoverChildAdoption({ ...f, record: finished, mode: 'rollback', persist() {}, invalidateVerification() {} }), /newer parent changes/);
});

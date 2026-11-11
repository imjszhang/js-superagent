import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, put, snapshot, prepare } from './helpers/material-workspace.mjs';
import { materialSnapshotDigest } from '../src/materials.mjs';
import { prepareWorkspace, prepareMaterialWorkspace, inspectWorkspace, validateWorkspace } from '../src/workspaces.mjs';

test('material copy imports dirty/new files and preserves the imported baseline separately from Worker changes', t => {
  const f = fixture(t);
  put(f.root, 'docs/existing.md', 'user uncommitted content'); put(f.root, 'docs/new.md', 'user new file');
  put(f.root, 'docs/excluded/private.md', 'private'); put(f.root, 'outside.md', 'outside');
  chmodSync(join(f.root, 'docs/new.md'), 0o664);
  const input = snapshot(f, ['docs/existing.md', 'docs/new.md'], ['docs'], ['docs/excluded']);
  // Source changes after capture must not silently alter the approved snapshot.
  put(f.root, 'docs/existing.md', 'later user content');
  const workspace = prepare(f, input);
  assert.equal(workspace.snapshotOrigin, 'project-materials'); assert.equal(workspace.mode, 'copy');
  assert.equal(workspace.materialSnapshotDigest, input.digest);
  assert.equal(readFileSync(join(workspace.path, 'docs/existing.md'), 'utf8'), 'user uncommitted content');
  assert.equal(existsSync(join(workspace.path, 'outside.md')), false);
  assert.equal(existsSync(join(workspace.path, 'docs/excluded')), false);
  assert.deepEqual(inspectWorkspace({ projectRoot: f.root, workspace }).changes, []);
  put(workspace.path, 'docs/existing.md', 'worker changed'); put(workspace.path, 'docs/created.md', 'worker created');
  unlinkSync(join(workspace.path, 'docs/new.md'));
  assert.deepEqual(inspectWorkspace({ projectRoot: f.root, workspace }).changes, [
    { path: 'docs/created.md', status: 'added' }, { path: 'docs/existing.md', status: 'modified' }, { path: 'docs/new.md', status: 'deleted' },
  ]);
  assert.equal(readFileSync(join(f.root, 'docs/existing.md'), 'utf8'), 'later user content');
});

test('generic material preparation creates a new generation without a GitHub continuation', t => {
  const f = fixture(t); put(f.root, 'docs/a.md', 'committed');
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', 'docs/a.md'); git('commit', '-m', 'baseline');
  const previous = prepareWorkspace({ projectRoot: f.root, ticketId: 'material-ticket', config: { mode: 'worktree' }, persist() {} });
  put(f.root, 'docs/a.md', 'uncommitted');
  const input = snapshot(f, ['docs/a.md']), workspace = prepare(f, input, { previousWorkspace: previous });
  assert.equal(workspace.generation, 1); assert.equal(workspace.previousProvisionId, previous.provisionId);
  assert.equal(workspace.continuationId, undefined); assert.equal(workspace.branch, undefined);
  assert.equal(readFileSync(join(previous.path, 'docs/a.md'), 'utf8'), 'committed');
  assert.equal(readFileSync(join(workspace.path, 'docs/a.md'), 'utf8'), 'uncommitted');
  assert.deepEqual(prepare(f, input, { previousWorkspace: previous, existing: workspace }), workspace);
  assert.equal(validateWorkspace({ projectRoot: f.root, workspace: previous }).provisionId, previous.provisionId);
});

test('preparation refuses changed input, other project identity, private paths and file ancestors before creating copy', t => {
  const f = fixture(t); put(f.root, 'docs/a.md', 'a'); const valid = snapshot(f, ['docs/a.md']);
  const malformed = [
    input => { input.files['docs/a.md'].content = Buffer.from('tampered').toString('base64'); },
    input => { input.source.instanceId = 'another-instance'; input.digest = materialSnapshotDigest(input); },
    input => { input.files['../escape'] = input.files['docs/a.md']; input.digest = materialSnapshotDigest(input); },
    input => { input.include = ['.']; input.files['.ssh/key'] = input.files['docs/a.md']; input.digest = materialSnapshotDigest(input); },
    input => { input.files.docs = input.files['docs/a.md']; input.digest = materialSnapshotDigest(input); },
  ];
  for (const change of malformed) { const input = structuredClone(valid); change(input); assert.throws(() => prepare(f, input)); }
  assert.throws(() => prepare(f, valid, { assertAuthorized: () => false }), /authorized/);
  assert.throws(() => prepare(f, valid, { assertAuthorized: async () => true }), /authorized/);
});

test('material preparation refuses dirty predecessor and unbounded in-place predecessor', t => {
  const f = fixture(t); put(f.root, 'docs/a.md', 'user'); const input = snapshot(f, ['docs/a.md']);
  const previous = prepareWorkspace({ projectRoot: f.root, ticketId: 'material-ticket', config: { mode: 'copy' }, persist() {} });
  put(previous.path, 'docs/a.md', 'old Worker result');
  assert.throws(() => prepare(f, input, { previousWorkspace: previous }), /unpreserved Worker/);
  const inplace = prepareWorkspace({ projectRoot: f.root, ticketId: 'other-ticket', config: { mode: 'in-place' }, persist() {} });
  assert.throws(() => prepare(f, input, { ticketId: 'other-ticket', previousWorkspace: inplace }), /isolated ticket predecessor/);
  assert.equal(readFileSync(join(previous.path, 'docs/a.md'), 'utf8'), 'old Worker result');
});

test('ready-journal recovery reuses original immutable material and refuses a replacement snapshot', t => {
  const f = fixture(t); put(f.root, 'docs/a.md', 'original'); const input = snapshot(f, ['docs/a.md']); let preparing;
  assert.throws(() => prepare(f, input, { persist(value) { if (value.state === 'ready') throw new Error('store stopped'); preparing = value; } }), /store stopped/);
  put(f.root, 'docs/a.md', 'new source');
  assert.throws(() => prepare(f, snapshot(f, ['docs/a.md']), { existing: preparing }), /identity changed/);
  const workspace = prepare(f, input, { existing: preparing });
  assert.equal(readFileSync(join(workspace.path, 'docs/a.md'), 'utf8'), 'original');
  assert.equal(workspace.state, 'ready');
});

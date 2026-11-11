import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureProjectIdentity } from '../src/project-identity.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { normalizeMaterialSettings, normalizeMaterialBinding, resolveMaterialBinding, validateMaterialBinding, assertMaterialDestination, materialSnapshotDigest, validateMaterialSnapshot, captureMaterialSnapshot, readMaterialFile } from '../src/materials.mjs';
import { createWorkerProjectReads } from '../src/runtime/worker-project-context.mjs';

const actor = { source: 'local', id: 'operator' };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'materials-'))), projectId = `fixture-${root.split('/').at(-1)}`;
  const identity = ensureProjectIdentity(root, projectId);
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const settings = { entries: [{ id: 'project', project: 'self', include: ['.'], exclude: ['private'], views: ['current', 'commit', 'snapshot'], readers: [actor], destinations: [actor] }] };
  const bind = (view = { kind: 'current' }, extra = {}) => resolveMaterialBinding({ projectRoot: root, projectId, settings, revision: 1, request: { sources: [{ id: 'project', view }], ...extra }, actor, destinations: [actor] });
  return { root, projectId, identity, write, settings, bind };
}
async function read(provider, reference, options = {}) { return provider.read(provider.prepare({ resource: 'materials', id: reference.id, ...options })); }
async function value(provider, reference) { const result = await read(provider, reference); let body = result.text, offset = result.nextOffset; while (offset !== null) { const page = await read(provider, reference, { version: result.version, offset }); body += page.text; offset = page.nextOffset; } return JSON.parse(body); }
async function file(provider, path, sourceId = 'project') {
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const parent = i === 0 ? '.' : parts.slice(0, i).join('/');
    const ref = provider.references().find(record => record.value.sourceId === sourceId && record.value.kind === 'directory' && record.value.path === parent);
    if (ref) await value(provider, ref);
  }
  return provider.references().find(record => record.value.sourceId === sourceId && record.value.kind === 'file' && record.value.path === path);
}

test('material configuration rejects ambiguous views, traversal, implicit identities and duplicate entries', () => {
  assert.throws(() => normalizeMaterialSettings({ entries: [{ id: 'x', project: 'self', include: ['../secret'], views: ['current'], readers: [actor], destinations: [actor] }] }), /relative/);
  assert.throws(() => normalizeMaterialBinding({ sources: [{ id: 'x', view: { kind: 'commit', sha: 'main' } }] }), /exact commit/);
  assert.throws(() => normalizeMaterialBinding({ sources: [{ id: 'x', view: { kind: 'current', sha: 'a'.repeat(40) } }] }), /Material view/);
  assert.throws(() => normalizeMaterialBinding({ sources: [{ id: 'x', view: { kind: 'current' } }], owner: { kind: 'longrun', contractHash: 'a'.repeat(64) } }), /Frozen tasks/);
  assert.deepEqual(normalizeMaterialSettings(), { version: 1, entries: [] });
});

test('resolved bindings enforce actor, output, revision and project identity', t => {
  const f = fixture(t), binding = f.bind();
  assert.equal(validateMaterialBinding({ binding, projectRoot: f.root, settings: f.settings, revision: 1 }), true);
  assert.throws(() => validateMaterialBinding({ binding, settings: f.settings, revision: 2 }), { code: 'MATERIAL_BINDING_CHANGED' });
  assert.throws(() => resolveMaterialBinding({ projectRoot: f.root, settings: f.settings, request: { sources: [{ id: 'project', view: { kind: 'current' } }] }, actor: { source: 'local', id: 'stranger' } }), { code: 'MATERIAL_ACCESS_DENIED' });
  assert.throws(() => assertMaterialDestination(binding, { source: 'github', id: 'public' }), { code: 'MATERIAL_DESTINATION_DENIED' });
  const path = join(projectStateDirectory(f.root), 'instance.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...saved, instanceId: 'another-instance' }));
  assert.throws(() => validateMaterialBinding({ binding, settings: f.settings, revision: 1 }), { code: 'MATERIAL_BINDING_CHANGED' });
});

test('current materials include untracked and ignored business files, but exclude secrets and links', async t => {
  const f = fixture(t);
  f.write('README.md', 'current'); f.write('working/receipts/result.json', '{"ok":true}'); f.write('.gitignore', 'working/\n'); f.write('.env.local', 'secret'); f.write('private/token.json', 'secret'); f.write('target.txt', 'linked');
  symlinkSync(join(f.root, 'README.md'), join(f.root, 'symlink.md')); linkSync(join(f.root, 'target.txt'), join(f.root, 'hardlink.txt'));
  const provider = createWorkerProjectReads({ binding: f.bind() });
  assert.equal((await value(provider, await file(provider, 'README.md'))).text, 'current');
  assert.equal((await value(provider, await file(provider, 'working/receipts/result.json'))).text, '{"ok":true}');
  assert.equal(await file(provider, '.env.local'), undefined); assert.equal(await file(provider, 'private/token.json'), undefined);
  assert.equal(await file(provider, 'symlink.md'), undefined); assert.equal(await file(provider, 'hardlink.txt'), undefined);
  assert.throws(() => readMaterialFile(f.bind().sources[0], 'target.txt'), { code: 'MATERIAL_PATH' });
  assert.throws(() => provider.prepare({ resource: 'materials', id: '/etc/passwd' }), { code: 'MATERIAL_ACCESS_DENIED' });
});

test('file pages reject content changes; fresh reads and observations survive provider reconstruction', async t => {
  const f = fixture(t); f.write('large.md', 'alpha'.repeat(1000));
  const binding = f.bind(), observations = [], provider = createWorkerProjectReads({ binding, onObservation: observation => observations.push(observation) });
  const ref = await file(provider, 'large.md'), first = await read(provider, ref, { limit: 256 });
  assert.notEqual(first.nextOffset, null); f.write('large.md', 'beta'.repeat(1000));
  await assert.rejects(() => read(provider, ref, { version: first.version, offset: first.nextOffset, limit: 256 }), { code: 'MATERIAL_CHANGED' });
  assert.equal(provider.checkFreshness().fresh, false);
  const restored = createWorkerProjectReads({ binding, observations });
  assert.equal(restored.checkFreshness().fresh, false);
  assert.equal((await value(restored, ref)).text, 'beta'.repeat(1000));
  // The old directory read had a different file size, so reread it too.
  await value(restored, restored.references().find(item => item.value.kind === 'directory' && item.value.path === '.'));
  assert.equal(restored.checkFreshness().fresh, true);
});

test('directory observations detect additions and deletions even when files were not read', async t => {
  const f = fixture(t); f.write('one.md', 'one'); const provider = createWorkerProjectReads({ binding: f.bind() });
  const root = provider.references().find(item => item.value.kind === 'directory'); await value(provider, root);
  assert.equal(provider.checkFreshness().fresh, true); f.write('two.md', 'two'); assert.equal(provider.checkFreshness().fresh, false);
  await value(provider, root); assert.equal(provider.checkFreshness().fresh, true); rmSync(join(f.root, 'one.md')); assert.equal(provider.checkFreshness().fresh, false);
});

test('fixed commits do not read later workspace contents or symlink targets', async t => {
  const f = fixture(t), git = args => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
  f.write('readme.md', 'committed'); symlinkSync('readme.md', join(f.root, 'link.md')); git(['add', '.']); git(['commit', '-m', 'fixture']);
  const sha = git(['rev-parse', 'HEAD']); f.write('readme.md', 'uncommitted'); f.write('new.md', 'new');
  const provider = createWorkerProjectReads({ binding: f.bind({ kind: 'commit', sha }) });
  assert.equal((await value(provider, await file(provider, 'readme.md'))).text, 'committed');
  assert.equal(await file(provider, 'new.md'), undefined); assert.equal(await file(provider, 'link.md'), undefined);
  assert.equal(provider.checkFreshness().fresh, true);
});

test('snapshots capture binary files and remain fixed after source changes', async t => {
  const f = fixture(t); f.write('data.md', 'original'); f.write('asset.bin', Buffer.from([0, 255, 2]));
  const source = f.bind().sources[0], snapshot = captureMaterialSnapshot(source);
  assert.equal(snapshot.digest, materialSnapshotDigest(snapshot)); assert.equal(snapshot.files['asset.bin'].encoding, 'base64');
  f.write('data.md', 'changed'); const provider = createWorkerProjectReads({ binding: f.bind({ kind: 'snapshot', snapshotId: 'frozen' }), snapshots: id => id === 'frozen' ? snapshot : null });
  assert.equal((await value(provider, await file(provider, 'data.md'))).text, 'original');
  await assert.rejects(() => value(provider, provider.references().find(item => item.value.path === 'asset.bin')), { code: 'MATERIAL_ENCODING' });
  assert.equal(provider.checkFreshness().fresh, true);
  const corrupt = structuredClone(snapshot); corrupt.files['data.md'].content = Buffer.from('tampered').toString('base64');
  assert.throws(() => validateMaterialSnapshot(corrupt, source), { code: 'MATERIAL_SNAPSHOT' });
});

test('snapshot copy detects changes during collection and excludes forbidden files', t => {
  const f = fixture(t); f.write('one.md', 'before'); f.write('.env', 'secret');
  let checks = 0;
  assert.throws(() => captureMaterialSnapshot(f.bind().sources[0], { assertActive: () => { if (++checks === 2) f.write('one.md', 'after'); } }), { code: 'MATERIAL_CHANGED' });
  const snapshot = captureMaterialSnapshot(f.bind().sources[0]); assert.deepEqual(Object.keys(snapshot.files), ['one.md']);
});

test('cross-project grants require the exact configured instance and destination', async t => {
  const main = fixture(t), extra = fixture(t); extra.write('allowed/info.md', 'external'); extra.write('other.md', 'hidden');
  main.settings.entries.push({ id: 'extra', project: { root: extra.root, projectId: extra.projectId, instanceId: extra.identity.instanceId }, include: ['allowed'], exclude: [], views: ['current'], readers: [actor], destinations: [actor] });
  const request = { sources: [{ id: 'extra', view: { kind: 'current' } }] };
  const binding = resolveMaterialBinding({ projectRoot: main.root, settings: main.settings, request, actor, destinations: [actor] });
  const provider = createWorkerProjectReads({ binding });
  assert.equal((await value(provider, await file(provider, 'allowed/info.md', 'extra'))).text, 'external');
  assert.equal(await file(provider, 'other.md', 'extra'), undefined);
  main.settings.entries[1].project.instanceId = 'replaced';
  assert.throws(() => resolveMaterialBinding({ projectRoot: main.root, settings: main.settings, request, actor }), { code: 'MATERIAL_IDENTITY' });
});

test('active authority and budget callbacks run on every material call', async t => {
  const f = fixture(t); f.write('readme.md', 'hello'); let active = true;
  const provider = createWorkerProjectReads({ binding: f.bind(), assertActive: () => { if (!active) throw new Error('revoked'); } });
  const root = provider.references().find(item => item.value.kind === 'directory'), prepared = provider.prepare({ resource: 'materials', id: root.id });
  await assert.rejects(() => provider.read(prepared, { charge: () => { throw new Error('budget exhausted'); } }), /budget exhausted/);
  assert.equal(provider.observations().length, 0); active = false;
  assert.throws(() => provider.references(), /revoked/); assert.throws(() => provider.checkFreshness(), /revoked/);
});

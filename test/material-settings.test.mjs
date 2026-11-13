import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { materialSnapshotDigest, normalizeMaterialBinding, captureMaterialSnapshot, resolveMaterialBinding } from '../src/materials.mjs';

const actor = { source: 'local', id: 'operator' };
const request = { sources: [{ id: 'project', view: { kind: 'current' } }] };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-settings-'))), agents = [];
  const open = () => { const agent = createProjectAgent({ projectRoot: root }).init(); agents.push(agent); return agent; };
  t.after(() => { for (const agent of agents) agent.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const settings = { entries: [{ id: 'project', project: 'self', include: ['.'], exclude: [], views: ['current', 'commit', 'snapshot'], readers: [actor], destinations: [actor] }] };
  return { root, open, settings };
}

test('public material settings use revision checks, preserve legacy submission and survive reopening', t => {
  const f = fixture(t), agent = f.open();
  assert.equal(agent.materialCapabilities().schemaVersion, 15);
  assert.deepEqual(agent.getMaterialSettings(), { version: 1, revision: 0, entries: [] });
  const legacy = agent.submit({ text: 'legacy' });
  assert.equal(agent.getDetailed(legacy.id).materialBinding, null);
  const settings = agent.configureMaterials({ ...f.settings, defaults: request }, { expectedRevision: 0 });
  assert.equal(settings.revision, 1);
  assert.throws(() => agent.configureMaterials(f.settings, { expectedRevision: 0 }), { code: 'MATERIAL_REVISION' });
  const ticket = agent.submit({ text: 'inspect project' }), detail = agent.getDetailed(ticket.id);
  assert.equal(detail.materialBinding.revision, 1); assert.deepEqual(detail.materialBinding.actor, actor);
  assert.equal(detail.materialBinding.sources[0].project.root, f.root);
  assert.deepEqual(detail.materialObservations, []); assert.deepEqual(detail.workspaceHistory, []);
  agent.close(); const restored = f.open();
  assert.deepEqual(restored.getMaterialSettings(), settings);
  assert.deepEqual(restored.getDetailed(ticket.id).materialBinding, detail.materialBinding);
});

test('selected defaults and explicit materials reject missing reader and destination grants before ticket creation', t => {
  const f = fixture(t), agent = f.open();
  const denied = { ...f.settings, entries: f.settings.entries.map(entry => ({ ...entry, readers: [{ source: 'feishu', id: 'someone' }] })), defaults: request };
  agent.configureMaterials(denied, { expectedRevision: 0 });
  for (const materials of [undefined, request]) assert.throws(() => agent.submit({ text: 'inspect selected materials', ...(materials ? { materials } : {}) }), { code: 'MATERIAL_ACCESS_DENIED' });
  assert.equal(agent.list().length, 0);
  agent.configureMaterials({ ...f.settings, entries: f.settings.entries.map(entry => ({ ...entry, destinations: [{ source: 'github', id: 'fictional/repo#1' }] })), defaults: request }, { expectedRevision: 1 });
  for (const materials of [undefined, request]) assert.throws(() => agent.submit({ text: 'report selected materials', ...(materials ? { materials } : {}) }), { code: 'MATERIAL_DESTINATION_DENIED' });
  assert.equal(agent.list().length, 0);
  // Having source entries alone does not opt ordinary submissions into materials.
  agent.configureMaterials({ ...denied, defaults: null }, { expectedRevision: 2 });
  const ordinary = agent.submit({ text: 'ordinary task without material defaults' });
  assert.equal(agent.getDetailed(ordinary.id).materialBinding, null);
});

test('host snapshots pin uncommitted bytes and reject tampering before acceptance', t => {
  const f = fixture(t), agent = f.open();
  writeFileSync(join(f.root, 'draft.md'), 'uncommitted first');
  agent.configureMaterials(f.settings, { expectedRevision: 0 });
  const snapshot = agent.createMaterialSnapshot({ sourceId: 'project' });
  const path = join(projectStateDirectory(f.root), 'materials', 'snapshots', `${snapshot.id}.json`), bundle = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(Buffer.from(bundle.files['draft.md'].content, 'base64').toString(), 'uncommitted first');
  assert.equal(bundle.digest, snapshot.digest);
  writeFileSync(join(f.root, 'draft.md'), 'new current value');
  const materials = { access: 'native', allowPreparation: true, workspaceSourceId: 'project', sources: [{ id: 'project', view: { kind: 'snapshot', snapshotId: snapshot.id } }], owner: { kind: 'longrun', contractHash: 'a'.repeat(64) } };
  const ticket = agent.submit({ text: 'frozen task', materials });
  assert.equal(agent.getDetailed(ticket.id).materialBinding.sources[0].view.snapshotId, snapshot.id);
  const binding = resolveMaterialBinding({ projectRoot: f.root, settings: agent.getMaterialSettings(), actor, request: materials });
  assert.deepEqual(captureMaterialSnapshot(binding.sources[0], { snapshots: () => bundle }), bundle);
  bundle.files['draft.md'].content = Buffer.from('tampered').toString('base64'); bundle.digest = materialSnapshotDigest(bundle);
  writeFileSync(path, JSON.stringify(bundle));
  assert.throws(() => agent.submit({ text: 'tampered snapshot', materials }), { code: 'MATERIAL_SNAPSHOT' });
  assert.equal(agent.list().length, 1);
});

test('initial material workspace is an explicit trusted native preparation constraint', () => {
  for (const extra of [{}, { access: 'native' }, { access: 'host-only', allowPreparation: true }]) {
    assert.throws(() => normalizeMaterialBinding({ ...request, ...extra, workspaceSourceId: 'project' }), { code: 'MATERIAL_AUTHORITY' });
  }
  assert.throws(() => normalizeMaterialBinding({ ...request, access: 'native', allowPreparation: true, workspaceSourceId: 'other' }), { code: 'MATERIAL_AUTHORITY' });
  assert.equal(normalizeMaterialBinding({ ...request, access: 'native', allowPreparation: true, workspaceSourceId: 'project' }).workspaceSourceId, 'project');
});

test('material activation fences preopened schema 14 writers without rewriting legacy tickets', t => {
  const f = fixture(t), agent = f.open(), legacy = agent.submit({ text: 'existing task' });
  const db = new DatabaseSync(join(projectStateDirectory(f.root), 'state.sqlite'));
  try {
    db.exec('PRAGMA user_version=14');
    const original = db.prepare('SELECT data FROM kv WHERE key=?').get(`ticket:${legacy.id}`).data;
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 14);
    agent.getMaterialSettings(); agent.getDetailed(legacy.id);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 14);
    agent.configureMaterials(f.settings, { expectedRevision: 0 });
    // Frozen guard used by the previous release, checked before each write.
    const oldWriter = () => {
      const version = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (version > 14) throw new Error(`Unsupported state schema: ${version}`);
      db.prepare('INSERT INTO kv VALUES(?,?)').run('legacy:unsafe-write', 'true');
    };
    assert.throws(oldWriter, /Unsupported state schema: 15/);
    assert.equal(db.prepare('SELECT data FROM kv WHERE key=?').get('legacy:unsafe-write'), undefined);
    assert.equal(db.prepare('SELECT data FROM kv WHERE key=?').get(`ticket:${legacy.id}`).data, original);
  } finally { db.close(); }
});

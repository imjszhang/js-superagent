import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-apply-freshness-'))), principal = { source: 'local', id: 'operator' };
  writeFileSync(join(root, 'input.md'), 'Observed current input');
  const runtime = createProjectAgent({ projectRoot: root, workspace: 'copy', execution: { driver: 'fixture', enableAgentTools: true }, driver: {
    capabilities: { agentTools: true, boundedMaterialReadsVersion: 1, workspacePreparationVersion: 1, sessionResume: true },
    async run(input) {
      input.checkpoint({ driver: 'fixture', id: `session-${input.runId}` }); let counter = 0;
      const refs = () => input.agentTools.contextResources().filter(item => item.resource === 'materials');
      const read = ref => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id }, callId: `read-${++counter}`, sessionId: `session-${input.runId}`, turnId: 'turn-1' });
      await read(refs().find(ref => ref.value.kind === 'directory' && ref.value.path === '.'));
      await read(refs().find(ref => ref.value.kind === 'file' && ref.value.path === 'input.md'));
      writeFileSync(join(input.projectRoot, 'first.md'), 'Worker first result');
      writeFileSync(join(input.projectRoot, 'second.md'), 'Worker second result');
      return { version: 2, state: 'ready', summary: 'Two reviewed artifacts', artifacts: [], attention: null };
    },
  } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  runtime.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['.'], exclude: [], views: ['current'], readers: [principal], destinations: [principal] }] }, { expectedRevision: 0 });
  const ticket = runtime.submit({ text: 'Produce two artifacts from current materials', materials: { access: 'native', sources: [{ id: 'project', view: { kind: 'current' } }], allowPreparation: true, allowApply: true, workspaceSourceId: 'project' } });
  await runtime.runNext(); assert.equal(runtime.get(ticket.id).status, 'completed');
  assert.equal(runtime.getDetailed(ticket.id).materialObservations.length, 2);
  const plan = runtime.previewMaterialApplication(ticket.id, { paths: ['.'] });
  return { root, runtime, ticket, plan };
}

async function interruptAfterFirstWrite(f) {
  const setMeta = Store.prototype.setMeta; let interrupted = false;
  Store.prototype.setMeta = function(key, value) {
    const application = key === `ticket:${f.ticket.id}` ? value.materialApplications?.['partial-apply'] : null;
    if (!interrupted && application?.status === 'applying' && application.appliedPaths.length === 1) {
      interrupted = true; throw new Error('Lost acknowledgement after first source write');
    }
    return setMeta.call(this, key, value);
  };
  try { await assert.rejects(f.runtime.applyMaterialChanges(f.ticket.id, { plan: f.plan, operationId: 'partial-apply' }), { code: 'MATERIAL_APPLY_INTERRUPTED' }); }
  finally { Store.prototype.setMeta = setMeta; }
  assert.equal(readFileSync(join(f.root, 'first.md'), 'utf8'), 'Worker first result');
  assert.equal(existsSync(join(f.root, 'second.md')), false);
  assert.equal(f.runtime.materialApplicationStatus(f.ticket.id, 'partial-apply').status, 'interrupted');
}

test('current-observation application recovery uses the saved baseline while preserving conflict checks', async t => {
  await t.test('finish accepts the first write made by its own journal despite stale directory observations', async t => {
    const f = await fixture(t); await interruptAfterFirstWrite(f);
    assert.throws(() => f.runtime.previewMaterialApplication(f.ticket.id, { paths: ['.'] }), { code: 'MATERIAL_CHANGED' });
    const result = await f.runtime.recoverMaterialApplication(f.ticket.id, { operationId: 'partial-apply', mode: 'finish' });
    assert.equal(result.status, 'applied');
    assert.equal(readFileSync(join(f.root, 'second.md'), 'utf8'), 'Worker second result');
    assert.equal(readFileSync(join(f.root, 'input.md'), 'utf8'), 'Observed current input');
  });
  await t.test('finish refuses a newer external target before writing any remaining files', async t => {
    const f = await fixture(t); await interruptAfterFirstWrite(f);
    writeFileSync(join(f.root, 'second.md'), 'Concurrent user content');
    await assert.rejects(f.runtime.recoverMaterialApplication(f.ticket.id, { operationId: 'partial-apply', mode: 'finish' }), { code: 'MATERIAL_APPLY_CONFLICT' });
    assert.equal(readFileSync(join(f.root, 'second.md'), 'utf8'), 'Concurrent user content');
    assert.equal(readFileSync(join(f.root, 'first.md'), 'utf8'), 'Worker first result');
    assert.equal(f.runtime.materialApplicationStatus(f.ticket.id, 'partial-apply').status, 'interrupted');
  });
  await t.test('a new application still refuses changed observed input before opening its journal', async t => {
    const f = await fixture(t);
    writeFileSync(join(f.root, 'input.md'), 'New external input after preview');
    await assert.rejects(async () => f.runtime.applyMaterialChanges(f.ticket.id, { plan: f.plan, operationId: 'stale-new-apply' }), { code: 'MATERIAL_CHANGED' });
    assert.deepEqual(f.runtime.materialApplicationStatus(f.ticket.id), []);
    assert.equal(existsSync(join(f.root, 'first.md')), false); assert.equal(existsSync(join(f.root, 'second.md')), false);
  });
});

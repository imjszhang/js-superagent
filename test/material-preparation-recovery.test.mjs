import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';

const principal = { source: 'local', id: 'operator' };
const capabilities = { agentTools: true, boundedMaterialReadsVersion: 1, workspacePreparationVersion: 1, sessionResume: true };
const ready = summary => ({ version: 2, state: 'ready', summary, artifacts: [], attention: null });

test('SIGKILL after material copy publication recovers activation without recapturing source or replacing the Assignment', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-preparation-crash-'))), agents = [];
  t.after(async () => { for (const agent of agents) { await agent.stop(); agent.close(); } rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  writeFileSync(join(root, 'notes.md'), 'original workspace');
  const first = createProjectAgent({ projectRoot: root, workspace: 'copy', execution: { driver: 'fixture', enableAgentTools: true }, driver: { capabilities, async run(input) {
    input.checkpoint({ driver: 'fixture', id: 'old-native-session' });
    await input.agentTools.call({ name: 'js_superagent_prepare_workspace', arguments: { materialId: 'project', provisionId: input.workspace.provisionId, reason: 'Use the authorized current input' }, callId: 'prepare-current', sessionId: 'old-native-session', turnId: 'turn-1' });
    return ready('This must become preparation waiting');
  } } }).init();
  first.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['notes.md'], exclude: [], views: ['current'], readers: [principal], destinations: [principal] }] }, { expectedRevision: 0 });
  const ticket = first.submit({ text: 'Use current input', materials: { access: 'native', sources: [{ id: 'project', view: { kind: 'current' } }], allowPreparation: true } });
  await first.runNext();
  const assignment = first.getDomainTicket(ticket.id).assignments.at(-1).id, previous = first.getWorkspace(ticket.id);
  assert.equal(first.workspacePreparationStatus(ticket.id).status, 'queued');
  await first.stop(); first.close();
  writeFileSync(join(root, 'notes.md'), 'captured before activation crash');
  const script = `import {createProjectAgent} from ${JSON.stringify(new URL('./helpers/runtime-fixture.mjs', import.meta.url).href)};
    import {Store} from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    const save=Store.prototype.setMeta; Store.prototype.setMeta=function(key,value){
      if(key===${JSON.stringify(`ticket:${ticket.id}`)}&&value.workspacePreparation?.status==='ready')process.kill(process.pid,'SIGKILL');
      return save.call(this,key,value);
    };
    const agent=createProjectAgent({projectRoot:${JSON.stringify(root)},execution:{driver:'fixture',enableAgentTools:true},driver:{capabilities:${JSON.stringify(capabilities)},async run(){throw new Error('Worker must not start before preparation activation');}}}).init();
    await agent.runNext();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
  writeFileSync(join(root, 'notes.md'), 'newer source after crash');
  let calls = 0;
  const resumed = createProjectAgent({ projectRoot: root, execution: { driver: 'fixture', enableAgentTools: true }, driver: { capabilities, async run(input) {
    calls++; assert.equal(input.assignmentId, assignment); assert.equal(input.session, undefined);
    assert.equal(readFileSync(join(input.projectRoot, 'notes.md'), 'utf8'), 'captured before activation crash');
    return ready('Recovered preparation complete');
  } } }).init(); agents.push(resumed);
  assert.equal(resumed.getWorkspace(ticket.id).provisionId, previous.provisionId);
  assert.equal(resumed.workspacePreparationStatus(ticket.id).workspace.state, 'ready');
  await resumed.runNext();
  assert.equal(resumed.get(ticket.id).status, 'completed', JSON.stringify(resumed.get(ticket.id)));
  assert.equal(calls, 1); assert.equal(resumed.getDomainTicket(ticket.id).assignments.length, 1);
  assert.equal(resumed.getWorkspace(ticket.id).generation, 1);
  assert.equal(resumed.getDetailed(ticket.id).workspaceHistory.length, 1);
  assert.equal(readFileSync(join(previous.path, 'notes.md'), 'utf8'), 'original workspace');
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'newer source after crash');
});

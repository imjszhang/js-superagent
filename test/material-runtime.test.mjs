import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { applyLocalApplication } from '../src/runtime/local-application.mjs';
import { Store } from '../src/store.mjs';

const principal = {source:'local',id:'operator'};
const ready = summary => ({version:2,state:'ready',summary,artifacts:[],attention:null});
function setup(t, run, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'material-runtime-')));
  writeFileSync(join(root,'notes.md'),'committed input');
  const git = (...args) => execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-m','fixture');
  const runtime=createProjectAgent({projectRoot:root,workspace:{mode:'worktree'},execution:{driver:'fixture',enableAgentTools:true},
    driver:{capabilities:{agentTools:true,boundedMaterialReadsVersion:1,workspacePreparationVersion:1,sessionResume:true},run},...options}).init();
  runtime.configureMaterials({entries:[{id:'project',project:'self',include:['.'],exclude:[],views:['current','commit','snapshot'],readers:[principal],destinations:[principal]}]}, {expectedRevision:0});
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});rmSync(projectStateDirectory(root),{recursive:true,force:true});});
  return {root,runtime,git};
}
function tools(input) {
  input.checkpoint({driver:'fixture',id:`session-${input.runId}`});let counter=0;
  return {call:(name,args,id)=>input.agentTools.call({name:`js_superagent_${name}`,arguments:args,callId:id??`call-${++counter}`,sessionId:`session-${input.runId}`,turnId:'turn-1'}),
    refs:()=>input.agentTools.contextResources().filter(ref=>ref.resource==='materials')};
}
async function readNotes(input) {
  const host=tools(input), directory=host.refs().find(ref=>ref.value.kind==='directory'&&ref.value.path==='.');
  await host.call('read',{resource:'materials',id:directory.id});
  const file=host.refs().find(ref=>ref.value.kind==='file'&&ref.value.path==='notes.md');
  const result=await host.call('read',{resource:'materials',id:file.id});return {host,text:JSON.parse(result.text).text};
}
const materials = extra => ({sources:[{id:'project',view:{kind:'current'}}],...extra});

test('host-only investigation reads dirty current source while cwd retains committed worktree',async t=>{
  let observation;const f=setup(t,async input=>{observation={...(await readNotes(input)),cwdText:readFileSync(join(input.projectRoot,'notes.md'),'utf8')};return ready(observation.text);});
  writeFileSync(join(f.root,'notes.md'),'uncommitted newest input');
  const ticket=f.runtime.submit({text:'Inspect current materials',materials:materials()});const result=await f.runtime.runNext();
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(observation.text,'uncommitted newest input');assert.equal(observation.cwdText,'committed input');
  assert.equal(f.runtime.getDetailed(ticket.id).materialObservations.length,2);
});

test('changed observed current file prevents stale ready result',async t=>{
  let root;const f=setup(t,async input=>{await readNotes(input);writeFileSync(join(root,'notes.md'),'changed during investigation');return ready('old observation');});root=f.root;
  const ticket=f.runtime.submit({text:'Inspect current materials',materials:materials()});await f.runtime.runNext();
  assert.equal(f.runtime.get(ticket.id).status,'failed');assert.match(f.runtime.get(ticket.id).reports.at(-1).summary,/changed after they were read/);
});

test('preparation suppresses ready and resumes same Assignment in new workspace/session',async t=>{
  const runs=[];let stale;
  const f=setup(t,async input=>{
    runs.push({assignmentId:input.assignmentId,session:input.session,workspace:input.workspace});const host=tools(input);stale=input.checkpoint;
    if(runs.length===1){await host.call('prepare_workspace',{materialId:'project',provisionId:input.workspace.provisionId,reason:'Use current authorized input'});return ready('premature business completion');}
    assert.equal(readFileSync(join(input.projectRoot,'notes.md'),'utf8'),'uncommitted input');return ready('prepared investigation complete');
  });writeFileSync(join(f.root,'notes.md'),'uncommitted input');
  const ticket=f.runtime.submit({text:'Investigate latest material',materials:materials({access:'native',allowPreparation:true})});
  const first=await f.runtime.runNext();assert.equal(first.status,'waiting',JSON.stringify(first));
  assert.equal(f.runtime.workspacePreparationStatus(ticket.id).status,'queued');assert.throws(()=>stale({driver:'fixture',id:'late'}),/Stale/);
  await f.runtime.runNext();assert.equal(f.runtime.workspacePreparationStatus(ticket.id).status,'ready',JSON.stringify(f.runtime.workspacePreparationStatus(ticket.id)));
  assert.equal(f.runtime.get(ticket.id).status,'completed',JSON.stringify(f.runtime.get(ticket.id)));
  assert.equal(runs.length,2);assert.equal(runs[0].assignmentId,runs[1].assignmentId);assert.equal(runs[1].session,undefined);
  assert.notEqual(runs[0].workspace.provisionId,runs[1].workspace.provisionId);assert.equal(f.runtime.getDetailed(ticket.id).workspaceHistory.length,1);
});

test('cancelled preparation never creates its successor workspace',async t=>{
  const f=setup(t,async input=>{const host=tools(input);await host.call('prepare_workspace',{materialId:'project',provisionId:input.workspace.provisionId,reason:'Refresh input'});return ready('done');});
  const ticket=f.runtime.submit({text:'Prepare investigation',materials:materials({access:'native',allowPreparation:true})});await f.runtime.runNext();
  const previous=f.runtime.getWorkspace(ticket.id);f.runtime.cancel(ticket.id);await f.runtime.runNext();
  assert.equal(f.runtime.workspacePreparationStatus(ticket.id).status,'cancelled');assert.equal(f.runtime.getWorkspace(ticket.id).provisionId,previous.provisionId);
});

test('preparation preserves the old session when an earlier live input has uncertain consumption',async t=>{
  const f=setup(t,async input=>{const host=tools(input);await host.call('prepare_workspace',{materialId:'project',provisionId:input.workspace.provisionId,reason:'Refresh input'});return ready('done');});
  const ticket=f.runtime.submit({text:'Prepare investigation',materials:materials({access:'native',allowPreparation:true})});await f.runtime.runNext();
  const previous=f.runtime.getSession(ticket.id),workspace=f.runtime.getWorkspace(ticket.id);
  f.runtime.reply(ticket.id,'Preserve this pending instruction');
  const pending=f.runtime.getDomainTicket(ticket.id).inputs.findLast(input=>!input.readAt);
  const store=new Store(join(projectStateDirectory(f.root),'state.sqlite'));
  try {store.setMeta(`live-input:earlier-run:${pending.id}`,{runId:'earlier-run',inputId:pending.id,status:'accepted',session:previous});}finally{store.close();}
  await f.runtime.runNext();assert.equal(f.runtime.workspacePreparationStatus(ticket.id).status,'blocked');
  assert.deepEqual(f.runtime.getSession(ticket.id),previous);assert.equal(f.runtime.getWorkspace(ticket.id).provisionId,workspace.provisionId);
});

test('explicit snapshot workspace starts from frozen dirty input and applies only Worker delta',async t=>{
  const f=setup(t,async input=>{assert.equal(readFileSync(join(input.projectRoot,'notes.md'),'utf8'),'dirty frozen input');writeFileSync(join(input.projectRoot,'result.md'),'Worker result');return ready('complete');});
  writeFileSync(join(f.root,'notes.md'),'dirty frozen input');const snapshot=f.runtime.createMaterialSnapshot({sourceId:'project'});
  const ticket=f.runtime.submit({text:'Produce result',materials:{access:'native',sources:[{id:'project',view:{kind:'snapshot',snapshotId:snapshot.id}}],allowPreparation:true,allowApply:true,workspaceSourceId:'project'}});
  await f.runtime.runNext();assert.equal(f.runtime.get(ticket.id).status,'completed',JSON.stringify(f.runtime.get(ticket.id)));
  const plan=f.runtime.previewMaterialApplication(ticket.id,{paths:['.']});assert.deepEqual(plan.changes.map(item=>item.path),['result.md']);
  const receipt=await f.runtime.applyMaterialChanges(ticket.id,{plan,operationId:'apply-fixture'});assert.equal(receipt.status,'applied');
  assert.equal(readFileSync(join(f.root,'result.md'),'utf8'),'Worker result');assert.equal(readFileSync(join(f.root,'notes.md'),'utf8'),'dirty frozen input');
});

test('lost first application receipt blocks new work and remains recoverable after material revocation',async t=>{
  const f=setup(t,async input=>{writeFileSync(join(input.projectRoot,'result.md'),'pending result');return ready('complete');});
  const snapshot=f.runtime.createMaterialSnapshot({sourceId:'project'});
  const ticket=f.runtime.submit({text:'Produce result',materials:{access:'native',sources:[{id:'project',view:{kind:'snapshot',snapshotId:snapshot.id}}],allowPreparation:true,allowApply:true,workspaceSourceId:'project'}});
  await f.runtime.runNext();const workspace=f.runtime.getWorkspace(ticket.id),plan=f.runtime.previewMaterialApplication(ticket.id,{paths:['.']});
  await assert.rejects(()=>applyLocalApplication({projectRoot:f.root,workspace,plan,operationId:'lost-receipt',authorize:()=>true,withLock:(_key,work)=>work(),persist:()=>{throw new Error('lost first acknowledgement');}}),/lost first acknowledgement/);
  assert.equal(f.runtime.materialApplicationStatus(ticket.id,'lost-receipt').status,'preparing');
  await assert.rejects(async()=>f.runtime.applyMaterialChanges(ticket.id,{plan,operationId:'replacement'}),/interrupted local material application/);
  const next=f.runtime.submit({text:'Another investigation',materials:materials()});await f.runtime.runNext();assert.equal(f.runtime.get(next.id).runId,null);
  f.runtime.configureMaterials({entries:[]},{expectedRevision:1});f.runtime.pause();
  await assert.rejects(async()=>f.runtime.recoverMaterialApplication(ticket.id,{operationId:'lost-receipt',mode:'finish'}),/not granted|changed/);
  const result=await f.runtime.recoverMaterialApplication(ticket.id,{operationId:'lost-receipt',mode:'rollback'});
  assert.equal(result.status,'rolled-back');assert.equal(f.runtime.materialApplicationStatus(ticket.id).length,1);
});

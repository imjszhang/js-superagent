import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {Store} from '../src/store.mjs';
import {buildWorkerContext} from '../src/runtime/worker-context.mjs';

test('a recovered native completed report cannot bypass current material freshness or replay the Worker',async t=>{
  const root=mkdtempSync(join(tmpdir(),'material-recovery-')),principal={source:'local',id:'operator'},session={driver:'fixture',id:'native-one'};
  writeFileSync(join(root,'notes.md'),'old inspected material');let calls=0,inspections=0,runId,contextRecords;
  const runtime=createProjectAgent({projectRoot:root,execution:{driver:'fixture',enableAgentTools:true},driver:{capabilities:{sessionResume:true,agentTools:true,boundedMaterialReadsVersion:1,boundedContextVersion:1},
    async run(input){
      calls++;runId=input.runId;input.checkpoint(session);
      contextRecords=buildWorkerContext(input).messages.map(({resource,id,version})=>({resource,id,version}));
      let count=0;const read=ref=>input.agentTools.call({name:'js_superagent_read',arguments:{resource:'materials',id:ref.id},callId:`read-${++count}`,sessionId:session.id,turnId:'turn-one'});
      await read(input.agentTools.contextResources().find(ref=>ref.resource==='materials'&&ref.value.kind==='directory'));
      await read(input.agentTools.contextResources().find(ref=>ref.resource==='materials'&&ref.value.kind==='file'));
      throw new Error('Connection lost after native completion');
    },
    async inspectRecovery(){inspections++;return {version:1,kind:'interrupted',safeToResume:true,toolsSettled:true,session,checkpoint:{runId,eventSequence:4},code:'HISTORY_VERIFIED',outcome:'completed',contextRecords,
      report:{version:2,state:'ready',summary:'old inspected material',artifacts:[],attention:null}};}
  }}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});rmSync(projectStateDirectory(root),{recursive:true,force:true});});
  runtime.configureRecovery({autoResume:true},{expectedRevision:0});
  runtime.configureMaterials({entries:[{id:'source',project:'self',include:['notes.md'],views:['current'],readers:[principal],destinations:[principal]}]},{expectedRevision:0});
  const ticket=runtime.submit({text:'Inspect materials exactly once',materials:{sources:[{id:'source',view:{kind:'current'}}]}});
  await runtime.runNext();assert.equal(calls,1);assert.equal(runtime.get(ticket.id).status,'failed');
  const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
  const meta=store.getMeta(`ticket:${ticket.id}`);meta.interrupted=true;meta.failure.origin='interrupted';
  meta.recovery={status:'inspect',attempt:0,runId,session,nextAt:'2000-01-01T00:00:00.000Z',deadlineAt:'2000-01-01T00:00:01.000Z'};store.setMeta(`ticket:${ticket.id}`,meta);store.close();
  writeFileSync(join(root,'notes.md'),'changed before result reconciliation');
  await runtime.runNext();
  assert.equal(calls,1);assert.equal(inspections,1);assert.equal(runtime.get(ticket.id).status,'failed');
  assert.match(runtime.get(ticket.id).reports.at(-1).summary,/changed after they were read/);
  assert.notEqual(runtime.getDetailed(ticket.id).materialFreshness?.fresh,true);
});

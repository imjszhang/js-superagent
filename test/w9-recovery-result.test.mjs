import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { buildWorkerContext } from '../src/runtime/worker-context.mjs';
test('W9 completed native result after owner loss is reconciled without executing another worker, even after execution deadline',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-w9-result-'));let calls=0,inspections=0,runId,contextRecords;
  const session={driver:'result-fixture',id:'native-1'};
  const registry=createHarnessRegistry({adapters:[{id:'result-fixture',version:'1',roles:['worker'],validate:v=>v,createDriver:()=>({reportVersion:2,capabilities:{sessionResume:true,boundedContextVersion:1},
    async run(input){calls++;runId=input.runId;input.checkpoint(session);contextRecords=buildWorkerContext(input).messages.map(({resource,id,version})=>({resource,id,version}));throw new Error('Connection lost after native finish');},
    async inspectRecovery(input){inspections++;assert.equal(input.runId,runId);return{version:1,kind:'interrupted',safeToResume:true,toolsSettled:true,session,checkpoint:{runId,eventSequence:4},code:'HISTORY_VERIFIED',outcome:'completed',contextRecords,report:{version:2,state:'ready',summary:'Native completed before loss',artifacts:[]}};}
  })}]});
  let r=createProjectAgent({projectRoot:root,harnessRegistry:registry}).init();
  t.after(async()=>{await r.stop();r.close();rmSync(root,{recursive:true,force:true});});
  r.configureExecutor({driver:'result-fixture'},{expectedRevision:0});r.configureRecovery({autoResume:true},{expectedRevision:0});
  const ticket=r.submit({text:'Make exactly one change'});await r.runNext();r.close();
  const db=new Store(join(stateDir(root), 'state.sqlite')),meta=db.getMeta(`ticket:${ticket.id}`);
  meta.interrupted=true;meta.failure.origin='interrupted';meta.recovery={status:'inspect',attempt:0,runId,session,nextAt:'2000-01-01T00:00:00.000Z',deadlineAt:'2000-01-01T00:00:01.000Z'};db.setMeta(`ticket:${ticket.id}`,meta);db.close();
  r=createProjectAgent({projectRoot:root,harnessRegistry:registry}).init();assert.equal(inspections,0);
  await r.runNext();assert.equal(calls,1);assert.equal(inspections,1);assert.equal(r.get(ticket.id).status,'completed');
  assert.equal(r.getDetailed(ticket.id).nativeResultRecoveredFrom,runId);assert.equal(r.getDetailed(ticket.id).recovery.status,'completed');
  assert.equal(await r.runNext(),null);assert.equal(calls,1);
});

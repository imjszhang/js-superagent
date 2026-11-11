import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { recoveryEvidence, nextRecoveryPlan } from '../src/runtime/recovery.mjs';
const proof=(runId,session,kind='transient')=>({version:1,kind,session,safeToResume:true,toolsSettled:true,checkpoint:{runId,eventSequence:5},code:kind==='transient'?'RATE_LIMIT':'HISTORY_VERIFIED'});
function fixture(t,run,inspectRecovery){
  const root=mkdtempSync(join(tmpdir(),'js-superagent-w4-')),opened=[];
  const registry=createHarnessRegistry({adapters:[{id:'recovery-fixture',version:'1',roles:['worker'],validate:o=>o,createDriver:()=>({reportVersion:2,capabilities:{sessionResume:true},run,inspectRecovery})}]});
  const open=()=>{const r=createProjectAgent({projectRoot:root,harnessRegistry:registry}).init();opened.push(r);return r;};
  const store=fn=>{const db=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(db);}finally{db.close();}};
  const due=id=>store(db=>{const m=db.getMeta(`ticket:${id}`);m.recovery.nextAt='2000-01-01T00:00:00.000Z';db.setMeta(`ticket:${id}`,m);});
  const meta=id=>store(db=>db.getMeta(`ticket:${id}`));
  t.after(async()=>{for(const r of opened.reverse()){await r.stop();r.close();}rmSync(root,{recursive:true,force:true});});
  return {root,open,store,due,meta};
}
function failure(input){const session=input.session??{driver:'recovery-fixture',id:'same-native'};input.checkpoint(session);throw Object.assign(new Error('Native transient failure'),{recoveryEvidence:proof(input.runId,session)});}
const configure=r=>{r.configureExecutor({driver:'recovery-fixture'},{expectedRevision:0});r.configureRecovery({autoResume:true,maxAttempts:2,initialDelayMs:10},{expectedRevision:0});};

test('W4 evidence rejects unknown results and retry schedules are bounded with a virtual clock',()=>{
  const session={driver:'fixture',id:'one'},evidence=proof('run',session);
  assert.equal(recoveryEvidence({...evidence,toolsSettled:false},{session,runId:'run'}),null);
  assert.equal(recoveryEvidence(evidence,{session,runId:'wrong'}),null);
  const first=nextRecoveryPlan(null,{settings:{autoResume:true,initialDelayMs:10,maxAttempts:2},evidence,runId:'run',now:1000});
  assert.equal(first.nextAt,'1970-01-01T00:00:01.010Z');
  const exhausted=nextRecoveryPlan({...first,status:'resuming',attempt:2},{settings:{autoResume:true,maxAttempts:2},evidence,runId:'next',now:2000});
  assert.equal(exhausted.status,'exhausted');
  const prepared=nextRecoveryPlan({...first,status:'superseded',reason:'material-preparation',attempt:2},{settings:{autoResume:true,maxAttempts:2},evidence,runId:'prepared',now:2000});
  assert.equal(prepared.status,'exhausted');assert.equal(prepared.attempt,2);
});

test('W4 native transient retry preserves session and attempts across reopen, with a new recovery instruction',async t=>{
  let calls=0;const seen=[];
  const f=fixture(t,async input=>{calls++;seen.push(input);if(calls<3)failure(input);return {version:2,state:'ready',summary:'Recovered'};});
  let r=f.open();configure(r);const ticket=r.submit({text:'Change the file once'});await r.runNext();
  assert.equal(f.meta(ticket.id).recovery.status,'pending');assert.equal(r.status().active,false);
  r.close();r=f.open();assert.equal(calls,1);assert.equal(f.meta(ticket.id).recovery.attempt,0);
  f.due(ticket.id);await r.runNext();assert.equal(f.meta(ticket.id).recovery.attempt,1);
  f.due(ticket.id);await r.runNext();assert.equal(calls,3);assert.equal(f.meta(ticket.id).recovery.status,'completed');
  assert.equal(seen[1].session.id,'same-native');assert.equal(seen[2].session.id,'same-native');
  assert.ok(seen[1].domainTicket.inputs.some(i=>i.kind==='note'&&i.text.includes('do not repeat completed external actions')));
});

test('W4 exhaustion survives repeated failures and pause/inspection prevent automatic continuation',async t=>{
  let calls=0;const f=fixture(t,async input=>{calls++;failure(input);}),r=f.open();configure(r);
  const ticket=r.submit({text:'Bounded recovery'});await r.runNext();f.due(ticket.id);
  r.pause();await r.runNext();assert.equal(calls,1);r.resume();await r.runNext();f.due(ticket.id);await r.runNext();
  assert.equal(calls,3);assert.equal(f.meta(ticket.id).recovery.status,'exhausted');await r.runNext();assert.equal(calls,3);
  r.retry(ticket.id);assert.equal(f.meta(ticket.id).recovery.status,'cancelled');
});

test('W4 unknown external outcomes and new human instructions cannot trigger replay',async t=>{
  let calls=0;const f=fixture(t,async input=>{calls++;failure(input);}),r=f.open();configure(r);
  const ticket=r.submit({text:'Inspect before continuation'});await r.runNext();
  r.reply(ticket.id,'Check the external result first');f.due(ticket.id);await r.runNext();
  assert.equal(calls,1);assert.equal(f.meta(ticket.id).recovery.status,'inspection');
  r.cancel(ticket.id);assert.equal(f.meta(ticket.id).recovery.status,'cancelled');
});

test('W4 unknown native error never creates a retry plan, and stale configuration does not migrate',async t=>{
  const f=fixture(t,async()=>{throw Object.assign(new Error('HTTP 429 text is not native proof'),{code:'RATE_LIMIT'});}),r=f.open();
  const before=f.store(db=>db.db.prepare('PRAGMA user_version').get().user_version);
  assert.throws(()=>r.configureRecovery({autoResume:true},{expectedRevision:7}),/revision conflict/);
  assert.equal(f.store(db=>db.db.prepare('PRAGMA user_version').get().user_version),before);
  configure(r);const ticket=r.submit({text:'No inferred recovery'});await r.runNext();assert.equal(f.meta(ticket.id).recovery,undefined);
});

test('W4 interrupted history requires adapter verification and only runs on explicit processing',async t=>{
  let calls=0,inspected=0;
  const f=fixture(t,async input=>{calls++;if(calls===1)failure(input);return {version:2,state:'ready',summary:'Continued known state'};},async input=>{inspected++;return proof(input.runId,input.session,'interrupted');});
  let r=f.open();configure(r);const ticket=r.submit({text:'Continue a verified interrupted session'});await r.runNext();
  f.store(db=>{const m=db.getMeta(`ticket:${ticket.id}`);m.recovery.status='inspect';m.failure.origin='interrupted';m.interrupted=true;db.setMeta(`ticket:${ticket.id}`,m);});
  r.close();r=f.open();assert.equal(inspected,0);f.due(ticket.id);await r.runNext();assert.equal(inspected,1);assert.equal(calls,2);
});

test('W4 an unavailable interrupted adapter is held for inspection without blocking other work',async t=>{
  let calls=0;
  const f=fixture(t,async input=>{calls++;if(calls===1)failure(input);return {version:2,state:'ready',summary:'Independent task finished'};});
  const r=f.open();configure(r);const interrupted=r.submit({text:'Old adapter task'});await r.runNext();
  f.store(db=>{const m=db.getMeta(`ticket:${interrupted.id}`);m.recovery.status='inspect';m.failure.origin='interrupted';m.interrupted=true;m.executionConfig={driver:'removed-extension'};db.setMeta(`ticket:${interrupted.id}`,m);});
  f.due(interrupted.id);
  const next=r.submit({text:'Independent valid task'});await r.runNext();
  assert.equal(f.meta(interrupted.id).recovery.status,'inspection');
  assert.equal(r.get(next.id).status,'completed');assert.equal(calls,2);
});

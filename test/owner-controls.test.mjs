import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { OwnerControls } from '../src/runtime/owner-controls.mjs';
import { MACHINE_DEPENDENCIES } from '../src/runtime/machine-guard.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

function queueFixture(t) {
  const root=mkdtempSync(join(tmpdir(),'js-control-queue-')),store=new Store(join(root,'state.sqlite'));
  let owner={loopToken:'loop-1',leaseToken:'lease-1',controlProtocol:1},binding={ticketId:'ticket',revision:1};
  const queue=new OwnerControls(store,{owner:()=>owner,binding:()=>binding});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {queue,store,get owner(){return owner;},set owner(value){owner=value;},set binding(value){binding=value;}};
}
const request=(requestId='request-1')=>({requestId,method:'verifyTicket',args:['ticket']});
test('owner controls validate the public surface and deduplicate request IDs without widening authority',t=>{
  const f=queueFixture(t),receipt=f.queue.enqueue(request());
  assert.equal(receipt.status,'queued');assert.equal(f.queue.enqueue(request()).operationId,receipt.operationId);
  assert.throws(()=>f.queue.enqueue({...request(),method:'deliverTicket'}),{code:'CONTROL_REQUEST_CONFLICT'});
  for(const value of [{...request('bad'),method:'configure'},{...request('bad'),args:['ticket',()=>{}]},{...request('bad'),extra:true},{...request('bad'),method:'replaceSession',args:['ticket',{}]}])assert.throws(()=>f.queue.enqueue(value),{code:'CONTROL_INVALID'});
  assert.equal(f.queue.list().length,1);
});
test('a live owner without the queued control protocol is rejected without a saved request',t=>{
  const f=queueFixture(t);f.owner={loopToken:'old-loop',leaseToken:'old-lease'};
  assert.throws(()=>f.queue.enqueue(request()),{code:'CONTROL_OWNER_UNSUPPORTED'});
  assert.equal(f.queue.list().length,0);
});
test('queued controls validate target state at execution and persist the result exactly once',async t=>{
  const f=queueFixture(t),receipt=f.queue.enqueue(request());let calls=0;
  await f.queue.drain(f.owner,async()=>{calls++;return {status:'passed'};});
  await f.queue.drain(f.owner,async()=>{calls++;});
  assert.equal(calls,1);assert.equal(f.queue.get(receipt.operationId).result.status,'passed');
  assert.equal('claim' in f.queue.get(receipt.operationId),false);
  const stale=f.queue.enqueue(request('request-2'));f.binding={ticketId:'ticket',revision:2};
  await f.queue.drain(f.owner,async()=>{calls++;});
  assert.equal(calls,1);assert.equal(f.queue.get(stale.operationId).status,'failed');
});
test('owner loss never replays queued or interrupted controls on a replacement runtime',async t=>{
  const f=queueFixture(t),queued=f.queue.enqueue(request()),running=f.queue.enqueue(request('request-2'));
  const key=`owner-control:${running.operationId}`;f.store.setMeta(key,{...f.store.getMeta(key),status:'running',startedAt:new Date().toISOString()});
  f.owner=null;
  const before=f.store.listMeta('owner-control:');
  assert.equal(f.queue.get(queued.operationId).status,'cancelled');assert.equal(f.queue.get(running.operationId).status,'unknown');
  assert.deepEqual(f.store.listMeta('owner-control:'),before,'status is read-only');
  f.owner={loopToken:'loop-2',leaseToken:'lease-2'};let calls=0;await f.queue.drain(f.owner,()=>{calls++;});
  assert.equal(calls,0);assert.equal(f.queue.enqueue(request()).status,'cancelled');
});
test('an exception after dispatch records unknown and requires a distinct explicit request',async t=>{
  const f=queueFixture(t),receipt=f.queue.enqueue(request());let calls=0;
  await f.queue.drain(f.owner,async()=>{calls++;throw new Error('Connection lost after sending');});
  await f.queue.drain(f.owner,async()=>{calls++;});
  assert.equal(calls,1);assert.equal(f.queue.get(receipt.operationId).status,'unknown');
});
test('stopping lets the started control settle and leaves remaining requests unclaimed',async t=>{
  const f=queueFixture(t),first=f.queue.enqueue(request()),second=f.queue.enqueue(request('request-2'));
  let stopping=false,calls=0;
  await f.queue.drain(f.owner,async()=>{calls++;stopping=true;return null;},{canExecute:()=>!stopping});
  assert.equal(calls,1);
  assert.deepEqual([f.queue.get(first.operationId).status,f.queue.get(second.operationId).status].sort(),['completed','queued']);
  f.owner=null;
  assert.deepEqual(f.queue.list().map(value=>value.status).sort(),['cancelled','completed']);
});

test('a separate process submits a session control to the live owner while paused and only owner executes',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-owner-control-runtime-'));let modelCalls=0;
  const driver={async run(input){modelCalls++;input.checkpoint({driver:'fixture',id:'original-session'});return {status:'waiting',summary:'Need answer'};}};
  const machineDirectory=join(root,'test-machine');
  const owner=createProjectAgent({projectRoot:root,driver,[MACHINE_DEPENDENCIES]:{directory:machineDirectory}}).init();
  const ticket=owner.submit({text:'Prepare a local task'});await owner.runNext();owner.pause();
  const client=createProjectAgent({projectRoot:root,driver,[MACHINE_DEPENDENCIES]:{directory:machineDirectory}}).init();
  t.after(async()=>{await owner.stop();client.close();owner.close();rmSync(root,{recursive:true,force:true});});
  await owner.prepareExecution();owner.start({intervalMs:10});
  const request={reason:'Inspect and replace old native session',expectedSessionId:'original-session'};
  const state=new Store(join(stateDir(root), 'state.sqlite')),loop=state.getMeta('runtime:loop');
  try {
    state.setMeta('runtime:loop',{...loop,controlProtocol:undefined});
    await assert.rejects(client.replaceSession(ticket.id,request),{code:'CONTROL_OWNER_UNSUPPORTED'});
    assert.equal(client.listControls().length,0);assert.equal(client.getSession(ticket.id).id,'original-session');
  } finally {state.setMeta('runtime:loop',loop);state.close();}
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import { createProjectAgent } from ${JSON.stringify(new URL('./helpers/runtime-fixture.mjs',import.meta.url).href)};
    import { MACHINE_DEPENDENCIES } from ${JSON.stringify(new URL('../src/runtime/machine-guard.mjs',import.meta.url).href)};
    const runtime=createProjectAgent({projectRoot:${JSON.stringify(root)},[MACHINE_DEPENDENCIES]:{directory:${JSON.stringify(machineDirectory)}},driver:{run(){throw new Error('Client must not execute');}}}).init();
    const receipt=await runtime.replaceSession(${JSON.stringify(ticket.id)},${JSON.stringify(request)});
    process.stdout.write(JSON.stringify(receipt));runtime.close();
  `],{encoding:'utf8',timeout:3000});
  assert.equal(child.status,0,child.stderr);const receipt=JSON.parse(child.stdout);
  assert.equal(receipt.status,'queued');assert.equal(client.getSession(ticket.id).id,'original-session');
  const deadline=Date.now()+2000;
  while(client.controlStatus(receipt.operationId).status==='queued'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(client.controlStatus(receipt.operationId).status,'completed');
  assert.equal(client.getSession(ticket.id),null);assert.equal(modelCalls,1);assert.equal(owner.isPaused(),true);
});

test('the live owner cancels its managed job for a separate client without resuming a paused worker',{timeout:5000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-owner-job-control-'));let modelCalls=0,jobId;
  writeFileSync(join(root,'input.txt'),'local fixture\n');
  const driver={async run(input){modelCalls++;jobId=input.jobs.launch({profileId:'check'}).id;return {version:2,state:'waiting',summary:'Awaiting managed command',artifacts:[],attention:null};}};
  const owner=createProjectAgent({projectRoot:root,driver,workspace:'copy'}).init();
  owner.configureJobs({lifecycle:'assignment',paths:['input.txt'],profiles:{check:{kind:'command',version:'1',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],environment:'host',allowHostExecution:true,timeoutMs:4000}}},{expectedRevision:0});
  const ticket=owner.submit({text:'Start one controlled local command'});await owner.runNext();owner.pause();
  const client=createProjectAgent({projectRoot:root,driver}).init();
  t.after(async()=>{await owner.stop();client.close();owner.close();rmSync(root,{recursive:true,force:true});});
  await owner.prepareExecution();owner.start({intervalMs:10});
  const receipt=await client.jobControl(ticket.id,jobId,{action:'cancel'});
  assert.equal(receipt.status,'queued');
  const deadline=Date.now()+2000;
  while(['queued','running'].includes(client.controlStatus(receipt.operationId).status)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(client.controlStatus(receipt.operationId).status,'completed');
  assert.equal(client.listJobs(ticket.id)[0].status,'cancelled');assert.equal(modelCalls,1);assert.equal(owner.isPaused(),true);
  await owner.stop();owner.start({intervalMs:10});
  await assert.rejects(owner.jobControl(ticket.id,jobId,{action:'cancel'}),{code:'JOB_OWNER_UNAVAILABLE'});
  const state=new Store(join(stateDir(root), 'state.sqlite'));
  try {assert.equal(state.listMeta('job-control:').length,0,'An unavailable manager never creates a nested legacy queue receipt');}
  finally {state.close();}
});

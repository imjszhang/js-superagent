import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {Store} from '../src/store.mjs';
import {uiFixture} from './helpers/ui-fixture.mjs';

function deferred(){let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};}
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)assert.fail('Expected isolated owner progress');await new Promise(r=>setTimeout(r,10));}}
function fixture(t,{poll,run=async()=>{throw new Error('No model call expected');}}={}){
  const root=mkdtempSync(join(tmpdir(),'js-online-settings-'));writeFileSync(join(root,'input.txt'),'fixture');
  const options={projectRoot:root,workspace:'copy',driver:{run},...(poll?{github:{repository:'fixture/online-settings',allowedActors:['alice'],pollIntervalMs:1000},githubChannel:{poll,async probe(){return {repository:'fixture/online-settings',repositoryId:54};},async deliver(){return {};}}}:{})};
  const owner=createProjectAgent(options).init(),client=createProjectAgent(options).init();
  t.after(async()=>{await owner.stop();client.close();owner.close();rmSync(root,{recursive:true,force:true});});
  return {owner,client,root,async start(){owner.pause();await owner.prepareExecution();owner.start({intervalMs:10});},state(fn){const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}}};
}
test('online settings keep synchronous receipts and apply through the live owner while paused',async t=>{
  const f=fixture(t);await f.start();
  const capacity=f.client.configureScheduler({maxWorkers:3,humanReserve:1},{expectedRevision:0});
  const recovery=f.owner.configureRecovery({autoResume:true,retryBeforeStart:false},{expectedRevision:0});
  const source=f.client.configureRepositorySource({enabled:false,streams:{issues:true}},{expectedRevision:0});
  for(const receipt of [capacity,recovery,source]){assert.equal(receipt.status,'queued');assert.equal(typeof receipt.then,'undefined');}
  await until(()=>[capacity,recovery,source].every(r=>f.client.controlStatus(r.operationId).status==='completed'));
  assert.equal(f.owner.schedulerStatus().maxWorkers,3);assert.equal(f.owner.getRecoverySettings().autoResume,true);
  assert.equal(f.owner.getRepositorySourceSettings().streams.issues,true);assert.equal(f.owner.isPaused(),true);
  assert.throws(()=>f.client.configureRecovery({autoResume:false},{expectedRevision:0}),/revision/);
  assert.throws(()=>f.client.configureScheduler({maxWorkers:17},{expectedRevision:1}),/1..16/);
});
test('busy polling defers settings, old owners reject them, and competing revisions fail without a second change',async t=>{
  const wait=deferred();t.after(()=>wait.resolve([]));let reads=0;
  const f=fixture(t,{poll:()=>{reads++;return wait.promise;}});await f.start();await until(()=>reads===1);
  f.state(store=>{const loop=store.getMeta('runtime:loop');store.setMeta('runtime:loop',{...loop,controlMethods:[]});});
  assert.throws(()=>f.client.configureRecovery({autoResume:true},{expectedRevision:0}),{code:'CONTROL_OWNER_UNSUPPORTED'});
  f.state(store=>{const loop=store.getMeta('runtime:loop');store.setMeta('runtime:loop',{...loop,controlMethods:['configureRecovery']});});
  const first=f.client.configureRecovery({autoResume:true},{expectedRevision:0}),second=f.client.configureRecovery({autoResume:false},{expectedRevision:0});
  await new Promise(r=>setTimeout(r,30));assert.equal(f.client.controlStatus(first.operationId).status,'queued');assert.equal(f.owner.getRecoverySettings().revision,0);
  wait.resolve([]);await until(()=>[first,second].every(r=>!['queued','running'].includes(f.client.controlStatus(r.operationId).status)));
  assert.deepEqual([first,second].map(r=>f.client.controlStatus(r.operationId).status).sort(),['completed','failed']);assert.equal(f.owner.getRecoverySettings().revision,1);
});
test('paused local settings instructions carry a final owner receipt without invoking an assessor',async t=>{
  const f=fixture(t);await f.start();
  const event=f.client.coordinate({text:'/settings {"target":"recovery","settings":{"autoResume":true},"expectedRevision":0}'});
  await until(()=>f.client.coordinationStatus().events.find(e=>e.id===event.id)?.status==='completed');
  const receipt=f.client.coordinationStatus().events.find(e=>e.id===event.id).receipts[0].result;
  assert.equal(receipt.status,'queued');await until(()=>f.client.controlStatus(receipt.operationId).status==='completed');
  assert.equal(f.owner.getRecoverySettings().autoResume,true);assert.equal(f.owner.isPaused(),true);
});
test('a capacity increase creates live worker lanes and a decrease still enforces the new limit',async t=>{
  let active=0,maximum=0;const waits=[];
  const f=fixture(t,{run:async()=>{active++;maximum=Math.max(maximum,active);const wait=deferred();waits.push(wait);await wait.promise;active--;return {status:'waiting',summary:'Fixture finished'};}});
  t.after(()=>waits.forEach(wait=>wait.resolve()));await f.start();
  const up=f.client.configureScheduler({maxWorkers:2},{expectedRevision:0});await until(()=>f.client.controlStatus(up.operationId).status==='completed');
  f.owner.submit({text:'First'});f.owner.submit({text:'Second'});f.owner.resume();await until(()=>active===2);
  f.owner.pause();waits.forEach(wait=>wait.resolve());await until(()=>f.owner.schedulerStatus().active.length===0);
  const down=f.client.configureScheduler({maxWorkers:1},{expectedRevision:1});await until(()=>f.client.controlStatus(down.operationId).status==='completed');
  maximum=0;const previous=waits.length;f.owner.submit({text:'Third'});f.owner.submit({text:'Fourth'});f.owner.resume();await until(()=>waits.length===previous+1);
  await new Promise(r=>setTimeout(r,30));assert.equal(maximum,1);f.owner.pause();waits.at(-1).resolve();await until(()=>active===0);
});
test('queued settings saves retain the unsaved panel draft until the owner revision arrives',async()=>{
  let scheduler={revision:0,maxWorkers:1,humanReserve:0};
  const f=await uiFixture(({path,method})=>path==='/api/scheduler'?{body:method==='POST'?{operationId:'a'.repeat(64),status:'queued'}:scheduler}:path==='/api/recovery'?{body:{revision:0,autoResume:false,retryBeforeStart:false,maxAttempts:3,initialDelayMs:15000}}:undefined);
  await f.ui.loadOperations();await f.input('scheduler-max','3');await f.$('save-scheduler').emit('click');
  assert.equal(f.$('scheduler-max').value,'3');assert.match(f.$('message').textContent,/排队/);
  let blocked=false;await f.window.emit('beforeunload',{preventDefault(){blocked=true;}});assert.equal(blocked,true);
  scheduler={revision:1,maxWorkers:3,humanReserve:0};await f.ui.loadOperations();assert.equal(Number(f.$('scheduler-max').value),3);
});

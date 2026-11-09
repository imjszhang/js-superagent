import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository='fixture/live-pr-link',head='a'.repeat(40);
const pull={repository,number:9,id:'900',headSha:head,headRef:'work/fixture',headRepository:repository,state:'open',merged:false,title:'Local fixture',url:`https://github.com/${repository}/pull/9`};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function until(predicate){const deadline=Date.now()+2500;while(!predicate()){if(Date.now()>deadline)assert.fail('Expected local owner progress');await new Promise(resolve=>setTimeout(resolve,10));}}
function fixture(t,{poll=async()=>[],inspect=async()=>pull}={}){
  const root=mkdtempSync(join(tmpdir(),'js-live-pr-link-'));let models=0,reads=0,sends=0;
  const channel={async probe(){return {repository,repositoryId:19};},poll,async getPullRequest(number){assert.equal(number,9);reads++;return inspect();},async deliver(){sends++;return {id:'offline-result'};}};
  const options={projectRoot:root,github:{repository,allowedActors:['alice'],pollIntervalMs:1000},githubChannel:channel,driver:{async run(){models++;return {version:2,state:'waiting',summary:'Local fixture waiting',attention:null};}}};
  const owner=createProjectAgent(options).init(),client=createProjectAgent(options).init();
  const ticket=owner.submit({text:'Inspect this change'});owner.pause();
  t.after(async()=>{await owner.stop();client.close();owner.close();rmSync(root,{recursive:true,force:true});});
  const state=work=>{const db=new Store(join(stateDir(root), 'state.sqlite'));try{return work(db);}finally{db.close();}};
  return {owner,client,ticket,state,get models(){return models;},get reads(){return reads;},get sends(){return sends;},async start(){await owner.prepareExecution();owner.start({intervalMs:10});}};
}

test('the live owner links a PR for an external caller while paused and keeps stopped-only unlink guarded',async t=>{
  const f=fixture(t);await f.start();
  const receipt=await f.client.linkGitHubPullRequest(f.ticket.id,{number:9});
  assert.equal(receipt.status,'queued');
  await until(()=>f.client.controlStatus(receipt.operationId).status==='completed');
  const result=f.client.controlStatus(receipt.operationId).result;
  assert.equal(result.ticketId,f.ticket.id);assert.equal(result.headSha,head);
  assert.equal(f.owner.getDomainTicket(f.ticket.id).follows[0].thread,`github:${repository}#pr:9`);
  assert.equal(f.owner.isPaused(),true);assert.equal(f.models,0);assert.equal(f.reads,1);
  assert.throws(()=>f.owner.unlinkGitHubPullRequest(9),/Stop execution/);
  const second=await f.owner.linkGitHubPullRequest(f.ticket.id,{number:9});
  assert.equal(second.status,'queued','The same owner SDK also uses the serialized channel path');
  await until(()=>f.owner.controlStatus(second.operationId).status==='completed');
  assert.equal(f.reads,2);assert.equal(f.models,0);
});

test('busy polling leaves link queued, and in-flight inspection prevents new work and outgoing delivery',async t=>{
  const polling=deferred(),inspecting=deferred();let polls=0;
  t.after(()=>{polling.resolve([]);inspecting.resolve(pull);});
  const f=fixture(t,{poll:()=>{polls++;return polling.promise;},inspect:()=>inspecting.promise});
  await f.start();await until(()=>polls===1);
  const receipt=await f.client.linkGitHubPullRequest(f.ticket.id,{number:9});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(f.client.controlStatus(receipt.operationId).status,'queued');
  assert.equal(f.client.controlStatus(receipt.operationId).startedAt,undefined);assert.equal(f.reads,0);
  polling.resolve([]);await until(()=>f.reads===1);
  assert.equal(f.client.controlStatus(receipt.operationId).status,'running');
  assert.equal(f.state(db=>db.getMeta('github:sync-lock').operation),'link');
  f.owner.submit({text:'Other local work must wait for the association transaction'});f.owner.resume();
  assert.equal(await f.owner.runNext(),null);assert.equal(await f.owner.flushNotifications(),0);
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.models,0);assert.equal(f.sends,0);assert.equal(polls,1);
  f.owner.pause();inspecting.resolve(pull);await until(()=>f.client.controlStatus(receipt.operationId).status==='completed');
  assert.equal(f.state(db=>db.getMeta('github:sync-lock')),undefined);
});

test('cancellation during canonical PR inspection cannot create an association or replay the control',async t=>{
  const inspecting=deferred();t.after(()=>inspecting.resolve(pull));
  const f=fixture(t,{inspect:()=>inspecting.promise});await f.start();
  const receipt=await f.client.linkGitHubPullRequest(f.ticket.id,{number:9});await until(()=>f.reads===1);
  f.client.cancel(f.ticket.id);inspecting.resolve(pull);
  await until(()=>f.client.controlStatus(receipt.operationId).status==='unknown');
  assert.deepEqual(f.client.githubStatus().trackedPullRequests,[]);
  assert.equal(f.state(db=>db.getMeta('github:sync-lock')),undefined);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.reads,1);assert.equal(f.models,0);
});

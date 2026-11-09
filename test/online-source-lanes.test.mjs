import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {Store} from '../src/store.mjs';

async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)assert.fail('Expected isolated source progress');await new Promise(resolve=>setTimeout(resolve,10));}}
function fixture(t,{account=false,run=async()=>{throw new Error('No execution expected');}}={}){
  const root=mkdtempSync(join(tmpdir(),'js-online-source-lanes-')),repository='fixture/source-lanes',requests=[];
  writeFileSync(join(root,'input.txt'),'fixture');
  const github={repository,allowedActors:['alice'],pollIntervalMs:86_400_000,...(account?{executable:'/fixture/gh-agent',account:{login:'helper'}}:{})};
  const request=async endpoint=>{const path=endpoint.split('?')[0];requests.push(path);
    if(path==='/user')return {id:2,login:'helper',type:'User'};
    if(path===`/repos/${repository}`)return {id:54,full_name:repository,default_branch:'main',has_issues:true,permissions:{push:true}};
    if([`/repos/${repository}/pulls`,`/repos/${repository}/issues`,`/repos/${repository}/notifications`].includes(path))return [];
    throw new Error(`Unexpected offline fixture request: ${endpoint}`);};
  const runtime=createProjectAgent({projectRoot:root,workspace:'copy',github,repositoryRequest:request,
    githubChannel:{async poll(){return [];},async probe(){return {repository,repositoryId:54};},async deliver(message){return {id:message.id};}},driver:{run}}).init();
  const state=fn=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}};
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  return {runtime,github,repository,requests,state};
}

test('online source disable clears stale repository failure gating from existing worker lanes',async t=>{
  const releases=[];let running=0;
  const f=fixture(t,{run:async()=>{running++;await new Promise(resolve=>releases.push(resolve));return {version:2,state:'waiting',summary:'Fixture finished',artifacts:[],attention:null};}});
  t.after(()=>releases.forEach(release=>release()));
  f.runtime.configureScheduler({maxWorkers:2},{expectedRevision:0});
  f.runtime.configureRepositorySource({enabled:true,streams:{pulls:false,issues:true}},{expectedRevision:0});
  for(const number of [1,2])f.runtime.receiveGitHubEvent({id:`github:${f.repository}:issue:${number}`,kind:'issue',repository:f.repository,issueNumber:number,issueId:number,
    issueState:'open',title:'Fixture work',text:'/js-superagent Fix the fixture',actor:{id:1,login:'alice',type:'User'},createdAt:new Date().toISOString()});
  f.runtime.pause();await f.runtime.prepareExecution();f.runtime.start({intervalMs:10});
  await until(()=>f.runtime.sourceStatus().every(source=>source.lastSuccess&&!source.active));
  f.state(store=>{const key=`source:github-repository:${f.repository.replace('/',':')}:state`,state=store.getMeta(key);
    store.setMeta(key,{...state,error:[{scope:'repository',repositoryFailure:true,error:'Old source failure'}]});});
  assert.equal(f.runtime.githubStatus().synchronization.state,'unavailable');
  const receipt=f.runtime.configureRepositorySource({enabled:false},{expectedRevision:1});
  await until(()=>f.runtime.controlStatus(receipt.operationId).status==='completed');
  assert.deepEqual(f.runtime.sourceStatus(),[]);f.runtime.resume();
  try {await until(()=>running===2);assert.equal(f.runtime.schedulerStatus().active.length,2);}
  finally {f.runtime.pause();releases.forEach(release=>release());}
});

test('account source disable stops extra repository streams while retaining account notifications',async t=>{
  const f=fixture(t,{account:true});f.runtime.pause();
  const due=()=>f.state(store=>{const key=`source:github-repository:${f.repository.replace('/',':')}:state`,state=store.getMeta(key);store.setMeta(key,{...state,lastAttempt:null,cursor:{...state.cursor,nextAt:null}});});
  f.runtime.configureRepositorySource({enabled:true,observe:true,streams:{pulls:true,issues:true}},{expectedRevision:0});
  await f.runtime.runNext();due();await f.runtime.runNext();assert.ok(f.requests.includes(`/repos/${f.repository}/pulls`));assert.ok(f.requests.includes(`/repos/${f.repository}/issues`));
  f.runtime.configureRepositorySource({enabled:false},{expectedRevision:1});f.requests.length=0;
  due();
  await f.runtime.runNext();
  assert.equal(f.runtime.getRepositorySourceSettings().streams.pulls,false);assert.equal(f.runtime.getRepositorySourceSettings().streams.issues,false);
  assert.ok(!f.requests.includes(`/repos/${f.repository}/pulls`));assert.ok(!f.requests.includes(`/repos/${f.repository}/issues`));
  assert.ok(f.requests.includes(`/repos/${f.repository}/notifications`));assert.equal(f.runtime.getRepositorySourceSettings().streams.mentions,true);
});

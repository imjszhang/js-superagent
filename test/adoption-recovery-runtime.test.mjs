import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProjectAgent, isolatedMachineDirectory } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

async function crashedAdoption(t) {
  const root=mkdtempSync(join(tmpdir(),'superagent-adoption-crash-'));
  for(const name of ['a.txt','b.txt'])writeFileSync(join(root,name),'before\n');
  const executable=join(root,'fake-child.cjs');
  writeFileSync(executable,`#!/usr/bin/env node
${fakeCodexIsolationPrelude({ commonjs: true, appServer: true })}
const fs=require('node:fs');
const {createInterface}=require('node:readline');
const threadId='019a3ade-2bd7-7001-a1a4-cdc82e4bf6ea',turnId='adopt-turn';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const report=JSON.stringify({state:'ready',summary:'Changed two scoped files',artifacts:['a.txt','b.txt'],question:null,questionForTriggerId:null,answers:null,acknowledgedInputIds:[]});
createInterface({input:process.stdin}).on('line',line=>{
const request=JSON.parse(line);
if(request.method==='initialize')send({id:request.id,result:{}});
else if(request.method==='config/read')send({id:request.id,result:__isolationConfig()});
else if(request.method==='thread/start'||request.method==='thread/resume')send({id:request.id,result:{thread:{id:threadId}}});
else if(request.method==='turn/start'){
fs.writeFileSync('a.txt','after\\n');fs.writeFileSync('b.txt','after\\n');
send({id:request.id,result:{turn:{id:turnId}}});
send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',phase:'final_answer',text:report}}});
send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
}
});
`,{mode:0o700});
  let jobId;
  const runtime=createProjectAgent({projectRoot:root,workspace:'copy',driver:{capabilities:{reportVersion:2},async run(input){
    jobId=input.jobs.launch({profileId:'child'}).id;const settled=await input.jobs.wait(jobId);assert.equal(settled.status,'completed',settled.error||JSON.stringify(settled));
    return{version:2,state:'waiting',summary:'Child changes need review',attention:{question:'Adopt both changes?'}};
  }}}).init();
  runtime.configureJobs({lifecycle:'assignment',childWorkspace:'parent-snapshot',paths:['a.txt','b.txt'],profiles:{child:{kind:'agent',version:'1',instruction:'Change both scoped files',paths:['a.txt','b.txt']}},childExecution:{driver:'codex-app-server',executable,killGraceMs:20,timeoutMs:5000}},{expectedRevision:0});
  runtime.configureDelivery({mode:'local',verify:{id:'check',version:'1',command:process.execPath,args:['-e',''],environment:'host',allowHostExecution:true}},{expectedRevision:0});
  const ticket=runtime.submit({text:'Only change a.txt and b.txt'});await runtime.runNext();await runtime.verifyTicket(ticket.id);
  const workspace=runtime.getWorkspace(ticket.id);await runtime.stop();runtime.close();
  const indexURL=new URL('./helpers/runtime-fixture.mjs',import.meta.url).href,storeURL=new URL('../src/store.mjs',import.meta.url).href;
  const script=`import{createProjectAgent}from ${JSON.stringify(indexURL)};import{Store}from ${JSON.stringify(storeURL)};
const original=Store.prototype.setMeta;Store.prototype.setMeta=function(key,value){const result=original.call(this,key,value);if(!this.inTransaction&&key.startsWith('child-adoption:')&&value.status==='applying'&&value.appliedPaths.length===1)process.kill(process.pid,'SIGKILL');return result;};
const runtime=createProjectAgent({projectRoot:${JSON.stringify(root)}}).init();const plan=runtime.planChildAdoption(${JSON.stringify(ticket.id)},${JSON.stringify(jobId)});await runtime.adoptChild(${JSON.stringify(ticket.id)},${JSON.stringify(jobId)},{expectedPlanDigest:plan.digest});`;
  const crash=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});
  assert.equal(crash.signal,'SIGKILL',crash.stderr);
  const reopened=createProjectAgent({projectRoot:root,driver:{async run(){assert.fail('Recovery must not replay the Worker');}}}).init();
  t.after(async()=>{await reopened.stop();reopened.close();rmSync(root,{recursive:true,force:true});});
  const record=reopened.listChildAdoptions(ticket.id)[0];assert.equal(record.status,'applying');assert.deepEqual(record.appliedPaths,['a.txt']);
  assert.equal(readFileSync(join(workspace.path,'a.txt'),'utf8'),'after\n');assert.equal(readFileSync(join(workspace.path,'b.txt'),'utf8'),'before\n');
  assert.equal(reopened.getDetailed(ticket.id).verification.status,'invalidated');
  return{root,runtime:reopened,ticket,record,workspace,jobId};
}

test('actual adoption process death leaves a discoverable journal that SDK finish reconciles without replaying the Worker', {timeout:15000}, async t=>{
  const f=await crashedAdoption(t);f.runtime.pause('Inspect interrupted adoption');
  const result=await f.runtime.recoverChildAdoption(f.ticket.id,f.record.id,{mode:'finish'});
  assert.equal(result.status,'applied');assert.deepEqual(result.recoveredPaths,['a.txt','b.txt']);assert.equal(result.requiresVerification,true);
  for(const path of ['a.txt','b.txt']){assert.equal(readFileSync(join(f.workspace.path,path),'utf8'),'after\n');assert.equal(readFileSync(join(f.root,path),'utf8'),'before\n');}
  const saved=f.runtime.listChildAdoptions(f.ticket.id)[0];assert.equal(saved.ticketId,f.ticket.id);assert.equal(saved.jobId,f.jobId);
  assert.equal(f.runtime.getDetailed(f.ticket.id).verification.reason,'child-adoption-recovery');
  assert.equal(await f.runtime.runNext(),null);
  await assert.rejects(f.runtime.recoverChildAdoption(f.ticket.id,f.record.id,{mode:'finish'}),/No interrupted/);
});

test('CLI explicitly rolls back a crashed adoption and retains its recovery evidence', {timeout:15000}, async t=>{
  const f=await crashedAdoption(t),cli=fileURLToPath(new URL('../bin/js-superagent.mjs',import.meta.url));
  const invoke=(...args)=>spawnSync(process.execPath,[cli,...args,'--project',f.root],{encoding:'utf8',timeout:10000,env:{...process.env,JS_SUPERAGENT_MACHINE_DIRECTORY:isolatedMachineDirectory(f.root)}});
  const list=invoke('adoption','list',f.ticket.id);assert.equal(list.status,0,list.stderr);assert.equal(JSON.parse(list.stdout)[0].id,f.record.id);
  const restored=invoke('adoption','recover',f.ticket.id,f.record.id,'rollback');assert.equal(restored.status,0,restored.stderr);assert.equal(JSON.parse(restored.stdout).status,'rolled-back');
  for(const path of ['a.txt','b.txt'])assert.equal(readFileSync(join(f.workspace.path,path),'utf8'),'before\n');
  assert.equal(f.runtime.listChildAdoptions(f.ticket.id)[0].recoveryMode,'rollback');
  assert.equal(f.runtime.getDetailed(f.ticket.id).verification.status,'invalidated');
});

test('adoption recovery refuses another ticket, active previews, an active operator and newer file conflicts', {timeout:15000}, async t=>{
  const f=await crashedAdoption(t),other=f.runtime.submit({text:'Another ticket'});
  await assert.rejects(f.runtime.recoverChildAdoption(other.id,f.record.id,{mode:'finish'}),/No interrupted/);
  await assert.rejects(f.runtime.recoverChildAdoption(f.ticket.id,f.record.id,{mode:'unsafe'}),/explicit rollback or finish/);
  const store=new Store(join(stateDir(f.root), 'state.sqlite'));
  try{
    const key=`managed-job:${f.jobId}`,job=store.getMeta(key);store.setMeta(key,{...job,previewLease:{status:'active'}});
    await assert.rejects(f.runtime.recoverChildAdoption(f.ticket.id,f.record.id,{mode:'finish'}),/Close the active preview/);store.setMeta(key,job);
    store.setMeta('operation:owner',{pid:process.pid,host:hostname(),token:'another-owner'});
    await assert.rejects(f.runtime.recoverChildAdoption(f.ticket.id,f.record.id,{mode:'finish'}),/Stop or finish active work|Stop live or unverifiable project execution owners/);store.deleteMeta('operation:owner');
  }finally{store.close();}
  writeFileSync(join(f.workspace.path,'a.txt'),'new human change\n');
  await assert.rejects(f.runtime.recoverChildAdoption(f.ticket.id,f.record.id,{mode:'finish'}),/conflicts with newer parent/);
  assert.equal(readFileSync(join(f.workspace.path,'a.txt'),'utf8'),'new human change\n');
  assert.equal(readFileSync(join(f.workspace.path,'b.txt'),'utf8'),'before\n');
  assert.equal(f.runtime.listChildAdoptions(f.ticket.id)[0].status,'applying');
});

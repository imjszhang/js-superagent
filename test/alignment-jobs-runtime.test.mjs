import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

async function until(check, message = 'runtime state') { for (let i=0;i<800;i++) { if(await check())return; await delay(10); } assert.fail(`Timed out: ${message}`); }
async function port() { const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const n=server.address().port;await new Promise(r=>server.close(r));return n; }
const report=(state,summary,question=null)=>({version:2,state,summary,artifacts:[],attention:question?{question}:null});
const command=code=>({kind:'command',version:'1',command:process.execPath,args:['-e',code],environment:'host',allowHostExecution:true,timeoutMs:20_000});
function fixture(t, run) {
  const projectRoot=realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-alignment-jobs-')));
  writeFileSync(join(projectRoot,'example.txt'),'source original\n');
  const driver={capabilities:{reportVersion:2},run};
  const runtime=createProjectAgent({projectRoot,workspace:'copy',driver}).init(), runtimes=[runtime];
  t.after(async()=>{for(const r of runtimes.reverse()){await r.stop();r.close();}rmSync(projectRoot,{recursive:true,force:true});});
  return {projectRoot,runtime,open(){const r=createProjectAgent({projectRoot,driver}).init();runtimes.push(r);return r;}};
}
const configure=(runtime,profiles,extra={})=>runtime.configureJobs({lifecycle:'assignment',paths:['example.txt'],profiles,...extra},{expectedRevision:0});

test('an ordinary assignment job holds one Worker slot across turns and emits one completion after a peer reconnects', {timeout:15_000}, async t=>{
  const calls=[];let jobId;
  const f=fixture(t,async input=>{
    calls.push(input.ticket.text);
    if(input.ticket.text==='parent'&&!jobId){jobId=input.jobs.launch({profileId:'check'}).id;return report('waiting','Background check pending');}
    if(input.ticket.text==='parent')assert.equal(input.jobs.get(jobId).status,'completed');
    return report('ready','Verified');
  });
  configure(f.runtime,{check:command('setTimeout(()=>{},600)')});
  const parent=f.runtime.submit({text:'parent'}),second=f.runtime.submit({text:'second'});
  await f.runtime.runNext();
  assert.equal(f.runtime.schedulerStatus().active.filter(item=>!item.yielded).length,1);
  const peer=f.open();await assert.rejects(peer.runNext(),{code:'PROJECT_EXECUTION_ACTIVE'});assert.deepEqual(calls,['parent']);
  await until(()=>f.runtime.listJobs(parent.id)[0]?.status==='completed');
  await until(async()=>{await f.runtime.runNext();return f.runtime.get(parent.id).status==='completed';});
  await until(async()=>{await peer.runNext();return peer.get(second.id).status==='completed';});
  assert.deepEqual(calls,['parent','parent','second']);
  const notes=f.runtime.getDomainTicket(parent.id).inputs.filter(input=>input.kind==='note'&&input.text.startsWith('Managed job '));
  assert.equal(notes.length,1);assert.equal(f.runtime.getDomainTicket(parent.id).undelivered.length,0);
  assert.equal(f.runtime.listJobs(parent.id).length,1);
});

test('a failed completion write retries from its durable journal and resumes the parent exactly once', {timeout:10_000}, async t=>{
  let calls=0,jobId,failed=false;
  const f=fixture(t,async input=>{
    if(++calls===1){jobId=input.jobs.launch({profileId:'check'}).id;return report('waiting','Background check pending');}
    assert.equal(input.jobs.get(jobId).status,'completed');return report('ready','Inspected recovered completion');
  });
  configure(f.runtime,{check:command('setTimeout(()=>{},100)')});
  const original=Store.prototype.setMeta;
  Store.prototype.setMeta=function(key,value){
    if(key.startsWith('job-wake:')&&!failed){failed=true;throw new Error('Injected transient completion journal failure');}
    return original.call(this,key,value);
  };
  t.after(()=>{Store.prototype.setMeta=original;});
  const ticket=f.runtime.submit({text:'Recover a managed completion'});await f.runtime.runNext();
  await until(()=>f.runtime.listJobs(ticket.id)[0]?.status==='completed');
  Store.prototype.setMeta=original;
  assert.equal(failed,true);assert.equal(f.runtime.listJobs(ticket.id)[0].completion.deliveredAt,null);
  assert.match(f.runtime.listJobs(ticket.id)[0].wakeError,/pending retry/);
  f.runtime.start({intervalMs:10});await until(()=>f.runtime.get(ticket.id).status==='completed');await delay(100);
  assert.equal(calls,2);assert.equal(f.runtime.schedulerStatus().active.length,0);
  assert.ok(f.runtime.listJobs(ticket.id)[0].completion.deliveredAt);
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.kind==='note'&&input.text.startsWith('Managed job ')).length,1);
});

test('human preview without a PR retains its assignment, frees capacity, and cancellation closes only its owned listener', {timeout:15_000}, async t=>{
  const number=await port(),url=`http://127.0.0.1:${number}/`;let jobId;
  const f=fixture(t,async input=>{
    if(input.ticket.text==='preview'){
      jobId=input.jobs.launch({profileId:'preview'}).id;
      await until(async()=>{try{return (await fetch(url)).ok;}catch{return false;}});
      await input.jobs.preview(jobId);
      return report('waiting','Preview ready for review','Is this preview acceptable?');
    }
    return report('ready','Other ticket completed');
  });
  configure(f.runtime,{preview:{...command(`require('http').createServer((q,r)=>r.end('review me')).listen(${number},'127.0.0.1')`),preview:{url}}});
  const ticket=f.runtime.submit({text:'preview'});await f.runtime.runNext();
  const domain=f.runtime.getDomainTicket(ticket.id),assignmentId=domain.assignments.at(-1).id;
  assert.equal(domain.ended,undefined);assert.equal(domain.assignments.at(-1).endedAt,undefined);
  assert.equal(f.runtime.get(ticket.id).status,'waiting');assert.equal(f.runtime.schedulerStatus().active.length,0);
  const second=f.runtime.submit({text:'another'});await f.runtime.runNext();assert.equal(f.runtime.get(second.id).status,'completed');
  const peer=f.open();const lease=await peer.jobControl(ticket.id,jobId,{action:'renew',ttlMs:4000});assert.equal(lease.status,'active');
  assert.equal(await(await fetch(url)).text(),'review me');assert.equal(f.runtime.getDomainTicket(ticket.id).assignments.at(-1).id,assignmentId);
  peer.cancel(ticket.id);await peer.runNext();
  await until(()=>peer.listJobs(ticket.id)[0].status==='cancelled');
  assert.equal(peer.listJobs(ticket.id)[0].completion.suppressed,'human-preview');
  for(const owner of peer.listJobs(ticket.id)[0].guardians)assert.throws(()=>process.kill(owner.pid,0),error=>error.code==='ESRCH');
  await assert.rejects(fetch(url));
});

test('stopping an assignment with background work persists interruption and does not replay on reopen', {timeout:10_000}, async t=>{
  let runs=0;
  const f=fixture(t,async input=>{runs++;input.jobs.launch({profileId:'check'});return report('waiting','Check still running');});
  configure(f.runtime,{check:command('setInterval(()=>{},1000)')});
  const ticket=f.runtime.submit({text:'long check'});await f.runtime.runNext();
  await until(()=>f.runtime.listJobs(ticket.id)[0].guardians.length>=2);
  await f.runtime.stop();const job=f.runtime.listJobs(ticket.id)[0];assert.equal(job.status,'cancelled');
  for(const owner of job.guardians)assert.throws(()=>process.kill(owner.pid,0),error=>error.code==='ESRCH');
  const peer=f.open();assert.equal(await peer.runNext(),null);assert.equal(runs,1);assert.equal(peer.schedulerStatus().active.length,0);
  assert.equal(peer.get(ticket.id).status,'interrupted');
});

test('a child starts from current parent files and explicit adoption invalidates saved verification', {timeout:15_000}, async t=>{
  let childId;
  const f=fixture(t,async input=>{
    writeFileSync(join(input.projectRoot,'example.txt'),'parent uncommitted\n');
    childId=input.jobs.launch({profileId:'child',text:'Append a child line.',paths:['example.txt']}).id;
    const settled=await input.jobs.wait(childId);assert.equal(settled.status,'completed',settled.error||JSON.stringify(settled));
    return report('waiting','Child diff awaits adoption','Adopt the child changes?');
  });
  const executable=join(f.projectRoot,'fake-child-codex');
  writeFileSync(executable,`#!/usr/bin/env node
${fakeCodexIsolationPrelude({ commonjs: true, appServer: true })}
const fs=require('node:fs');
const {createInterface}=require('node:readline');
const threadId='019a3ade-2bd7-7001-a1a4-cdc82e4bf6ea',turnId='child-turn';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
const request=JSON.parse(line);
if(request.method==='initialize')send({id:request.id,result:{}});
else if(request.method==='config/read')send({id:request.id,result:__isolationConfig()});
else if(request.method==='thread/start'||request.method==='thread/resume')send({id:request.id,result:{thread:{id:threadId}}});
else if(request.method==='turn/start'){
if(fs.readFileSync('example.txt','utf8')!=='parent uncommitted\\n')process.exit(7);
fs.appendFileSync('example.txt','child addition\\n');
send({id:request.id,result:{turn:{id:turnId}}});
send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({state:'ready',summary:'Observed parent and appended child line',artifacts:['example.txt'],question:null,questionForTriggerId:null,answers:null,acknowledgedInputIds:[]})}}});
send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});
}
});
`,{mode:0o700});
  configure(f.runtime,{child:{kind:'agent',version:'1',instruction:'Append only to example.txt',paths:['example.txt']}},{childWorkspace:'parent-snapshot',childExecution:{driver:'codex-app-server',executable,timeoutMs:5000,killGraceMs:40}});
  f.runtime.configureDelivery({mode:'local',verify:{id:'check',...command('require("node:fs").readFileSync("example.txt")'),kind:'verify'}},{expectedRevision:0});
  const ticket=f.runtime.submit({text:'Delegate an isolated child'});await f.runtime.runNext();
  assert.equal(await f.runtime.runNext(),null);
  assert.equal(f.runtime.get(ticket.id).status,'waiting',JSON.stringify(f.runtime.get(ticket.id).reports));
  const workspace=f.runtime.getWorkspace(ticket.id);assert.equal(readFileSync(join(workspace.path,'example.txt'),'utf8'),'parent uncommitted\n');
  assert.equal((await f.runtime.verifyTicket(ticket.id)).status,'passed');
  const plan=f.runtime.planChildAdoption(ticket.id,childId);assert.deepEqual(plan.changes.map(change=>change.path),['example.txt']);
  await assert.rejects(f.runtime.adoptChild(ticket.id,childId,{expectedPlanDigest:'stale'}),/revision conflict/);
  const result=await f.runtime.adoptChild(ticket.id,childId,{expectedPlanDigest:plan.digest});assert.equal(result.status,'applied');
  assert.equal(readFileSync(join(workspace.path,'example.txt'),'utf8'),'parent uncommitted\nchild addition\n');
  assert.equal(readFileSync(join(f.projectRoot,'example.txt'),'utf8'),'source original\n');
  assert.equal(f.runtime.getDetailed(ticket.id).verification.status,'invalidated');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { validateNativeHandoff } from '../src/drivers/dsh-lease.mjs';
import { createHostToolVerifier, recordHostToolResult } from '../src/runtime/host-tool-recovery.mjs';

const repository='fixture/project';
const execution={driver:'dsh-sdk',executable:'/not-used/dsh-fixture',model:'fixture-model',timeoutMs:10000,
  backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://fixture.invalid/anthropic',apiKeyEnv:'UNUSED_W34_FIXTURE_KEY'}};
const ready=()=>({version:2,state:'ready',summary:'Completed checks; preview is available for review',artifacts:[],attention:null});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(predicate,message){const deadline=Date.now()+2500;while(!predicate()&&Date.now()<deadline)await wait(10);assert.ok(predicate(),message);}

// Host ownership fixture; actual SDK/job/PID/listener verification is covered by
// the separate bounded W34 SDK probe and producer test, not faked here as proof.
function fixture(t,{ttlMs=1400}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-w34-host-')));
  const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'input.txt'),'fixture\n');git('add','input.txt');git('commit','-m','fixture');
  const headSha=git('rev-parse','HEAD'),inputs=[],closes=[];let child,closed,record,firstTicket,latestInput,reviewWrites=0,requested=[];
  const snapshot=()=>({repository,number:9,id:'900',headSha,headRef:'main',headRepository:repository,baseRef:'main',baseSha:headSha,
    state:'open',merged:false,url:`https://github.com/${repository}/pull/9`,title:'Preview',requestedReviewers:requested,requestedTeams:[],reviews:[]});
  const channel={async poll(){return [];},async getPullRequest(){return snapshot();},async reviewSnapshot(){return snapshot();},
    async reviewRecipientIdentity(login){assert.equal(login,'alice');return {id:42,login,type:'User'};},
    async applyReviewAction(intent,{beforeWrite}){await beforeWrite();reviewWrites++;requested=[...intent.reviewers];},
    async deliver(){return {id:'fixture-receipt'};}};
  const base=createHarnessRegistry();
  const driver={reportVersion:2,capabilities:{sessionResume:true,nativeBackgroundOwnership:true},async run(input){
    inputs.push(input);firstTicket??=input.ticket.id;if(input.ticket.id!==firstTicket)return ready();
    latestInput=input;input.checkpoint({driver:'dsh-sdk',id:'preview-session'});
    assert.equal(input.nativePreviewProfiles[0].id,'preview');assert.equal(input.nativePreviewProfiles[0].command,process.execPath);
    child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});closed=once(child,'exit');await once(child,'spawn');input.registerProcess(child.pid);
    const expiresAt=new Date(Date.now()+ttlMs).toISOString();
    record=validateNativeHandoff({version:1,id:`lease-${input.runId}`,driver:'dsh-sdk',nativeVersion:'0.2.2-alpha.2',
      ticketId:input.ticket.id,assignmentId:input.assignmentId,originRunId:input.runId,session:{driver:'dsh-sdk',id:'preview-session'},cwd:input.projectRoot,
      configDigest:'a'.repeat(64),deadlineAt:expiresAt,guardianPids:[child.pid],jobIds:['preview-job','settled-check'],settledJobIds:['settled-check'],
      previews:[{jobId:'preview-job',profileId:'preview',url:'http://127.0.0.1:1234/',commandPid:child.pid,guardianPid:child.pid,expiresAt,
        endpoint:{url:'http://127.0.0.1:1234/',checkedAt:new Date().toISOString(),status:200,listeners:[{pid:child.pid,birth:'fixture'}]}}],
      reportBoundary:{state:'ready',assistantSequence:5,terminalSequence:6}});
    const control={closed,snapshot:()=>structuredClone(record),async resume(){assert.fail('Preview must not wake a worker');},
      async close(reason){closes.push(reason);if(alive(child.pid))child.kill('SIGTERM');await closed;},
      async renewPreview({jobId,ttlMs}){assert.equal(jobId,'preview-job');const deadlineAt=new Date(Date.now()+ttlMs).toISOString();
        record={...record,deadlineAt,previews:record.previews.map(p=>({...p,expiresAt:deadlineAt}))};
        // A collector result can arrive while renewal awaits the SDK. It must
        // survive merging the returned adapter snapshot into the host journal.
        latestInput.nativeHandoff.update(record.id,{type:'settled',job:{id:'settled-check',status:'completed'},output:{stdout:'checked',exitCode:0}});
        await wait(1);return structuredClone(record);
      }};
    assert.equal(input.nativeHandoff.hold(record,control),true);return ready();
  }};
  const harnessRegistry={...base,createDriver(value,options){base.validateExecution(value,options);return driver;}};
  const runtime=createProjectAgent({projectRoot:root,execution,harnessRegistry,workspace:{mode:'worktree'},github:{repository,allowedActors:['alice'],issues:[7]},githubChannel:channel}).init();
  runtime.configureJobs({lifecycle:'assignment',paths:['input.txt'],limits:{maxDurationMs:30000},profiles:{preview:{kind:'command',version:'1',command:process.execPath,args:['-e',''],environment:'host',allowHostExecution:true,preview:{url:'http://127.0.0.1:1234/',ttlMs:5000}}}},{expectedRevision:0});
  runtime.configureDelivery({mode:'draft-pr',automatic:false,repository,credentialMode:'native-gh',allowedPaths:['input.txt'],review:{requestReviewers:true,reviewers:['alice']},
    verify:{id:'check',version:'1',command:process.execPath,args:['-e',''],paths:['input.txt'],environment:'host',allowHostExecution:true}},{expectedRevision:0});
  t.after(async()=>{try{await runtime.stop();runtime.close();}finally{if(child&&alive(child.pid)){child.kill('SIGTERM');await closed;}rmSync(root,{recursive:true,force:true});}});
  return {runtime,inputs,closes,owner:()=>child,reviewWrites:()=>reviewWrites,record:()=>record,async initial(){const ticket=runtime.submit({text:'Prepare the preview for review'});await runtime.linkGitHubPullRequest(ticket.id,{number:9});await runtime.runNext();return ticket;}};
}

test('W34 ready preview releases worker capacity, permits verification and review, renews both host records, and stops cleanly',{timeout:45000},async t=>{
  // CI can spend several seconds completing Git and verification work after handoff.
  // Keep the lease alive through setup, then still cross its original deadline.
  const f=fixture(t,{ttlMs:10000}),runtime=f.runtime,ticket=await f.initial();
  assert.equal(runtime.get(ticket.id).status,'completed',JSON.stringify(runtime.getDetailed(ticket.id)));
  assert.equal(runtime.get(ticket.id).awaitingReview,true);assert.equal(runtime.getDetailed(ticket.id).verification.status,'passed');
  assert.equal(runtime.schedulerStatus().active.length,0);assert.ok(alive(f.owner().pid));
  const lease=runtime.getDetailed(ticket.id).nativeHandoffs[0],oldDeadline=Date.parse(lease.deadlineAt);
  const renewed=await runtime.controlNativePreview(ticket.id,{leaseId:lease.id,jobId:'preview-job',action:'renew',ttlMs:30000});
  assert.ok(Date.parse(renewed.deadlineAt)>oldDeadline);assert.equal(renewed.results[0].job.id,'settled-check');
  assert.equal(runtime.getDetailed(ticket.id).nativeHandoffs[0].deadlineAt,renewed.deadlineAt);
  assert.equal((await runtime.verifyTicket(ticket.id)).status,'passed');
  const intent=runtime.requestPRReview(ticket.id,{kind:'requestReviewers',reviewers:['alice']});
  const review=await runtime.runPRReview(intent.id);assert.equal(review.status,'completed',review.error);assert.equal(f.reviewWrites(),1);
  const other=runtime.submit({text:'Finish independent work while preview awaits review'});await runtime.runNext();assert.equal(runtime.get(other.id).status,'completed');
  await wait(Math.max(0,oldDeadline-Date.now()+130));
  assert.ok(alive(f.owner().pid),'In-memory owner deadline must be updated alongside the Store');
  assert.equal(runtime.getDetailed(ticket.id).nativeHandoffs[0].status,'holding');assert.equal(f.inputs.length,2);
  await runtime.stop();assert.equal(alive(f.owner().pid),false);assert.ok(f.closes.includes('runtime-stopped'));assert.equal(runtime.schedulerStatus().active.length,0);
});

test('W34 host deadline reclaims a held preview without starting another worker',{timeout:5000},async t=>{
  const f=fixture(t,{ttlMs:1000}),ticket=await f.initial();
  assert.equal(f.runtime.get(ticket.id).awaitingReview,true);await until(()=>!alive(f.owner().pid),'Preview owner must exit at lease expiry');
  assert.equal(f.runtime.getDetailed(ticket.id).nativeHandoffs[0].status,'interrupted');assert.equal(f.inputs.length,1);assert.equal(f.runtime.schedulerStatus().active.length,0);
});

test('W34 a native preview start receipt cannot authorize recovery until the matching owner settled',()=>{
  const values=new Map(),store={getMeta:key=>values.get(key),setMeta:(key,value)=>values.set(key,value),listMeta:prefix=>[...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value}))};
  const session={driver:'dsh-sdk',id:'native-session'},identity={ticketId:'ticket',assignmentId:'assignment',runId:'run',sessionId:session.id};
  const query={driver:session.driver,runId:identity.runId,sessionId:session.id,callId:'call',name:'js_superagent_native_preview_start',arguments:{profileId:'preview'},result:{jobId:'job',profileId:'preview',commandPid:44,guardianPid:43}};
  recordHostToolResult(store,identity,query,new Date().toISOString());let exited=true;
  const verify=createHostToolVerifier({store,ticketId:'ticket',session,ownerExited:owner=>exited&&owner.pid===43&&owner.host===hostname()});
  assert.equal(verify(query),false,'Crash between start and handoff has no settlement evidence');
  const lease={ticketId:'ticket',assignmentId:'assignment',session,jobIds:['job'],previews:[query.result],guardianPids:[43],owner:{host:hostname()},status:'holding',results:[]};
  store.setMeta('native-handoff:lease',lease);assert.equal(verify(query),false);
  lease.status='completed';assert.equal(verify(query),false,'Process exit without a durable result is insufficient');
  lease.results=[{type:'settled',job:{id:'job',status:'killed'}}];assert.equal(verify(query),true);
  exited=false;assert.equal(verify(query),false,'Live guardian cannot be recovered');exited=true;
  lease.assignmentId='other-assignment';assert.equal(verify(query),false);
});

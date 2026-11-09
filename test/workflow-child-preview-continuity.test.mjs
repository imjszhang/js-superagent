import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createManagedJobs } from '../src/runtime/jobs.mjs';
import { prepareWorkspace } from '../src/workspaces.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const report=(state='ready')=>({version:2,state,summary:'Scoped child result',artifacts:[],attention:state==='waiting'?{question:'Which wording?'}:null});
async function until(fn){const deadline=Date.now()+2500;while(!fn()&&Date.now()<deadline)await wait(10);assert.ok(fn(),'condition did not settle');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const value=s.address().port;await new Promise(r=>s.close(r));return value;}
function fixture(t,profiles,extra={}){
  const root=mkdtempSync(join(tmpdir(),'js-child-preview-'));writeFileSync(join(root,'value.txt'),'initial');
  const workspace=prepareWorkspace({projectRoot:root,ticketId:'parent',config:{mode:'copy'},persist(){}}),records=new Map(),wakes=[];
  const options={projectRoot:root,persistentMode:true,parent:{ticketId:'ticket',assignmentId:'assignment',runId:'parent-1',workspace,scope:{instruction:'Only modify value.txt',paths:['value.txt']}},
    profiles,limits:{maxDurationMs:5000},journal:{list:()=>[...records.values()].map(v=>structuredClone(v)),save:r=>records.set(r.id,structuredClone(r))},wakeParent:e=>wakes.push(e),
    prepareChildWorkspace:({jobId})=>prepareWorkspace({projectRoot:root,ticketId:`child-${jobId}`,config:{mode:'copy'},persist(){}}),...extra};
  const manager=createManagedJobs(options);t.after(async()=>{await manager.close();rmSync(root,{recursive:true,force:true});});return{root,workspace,records,wakes,manager,options};
}

test('managed preview renewal changes the real command lifetime beyond its launch deadline, and close/expiry reap the owner',{timeout:8000},async t=>{
  const p=await port(),f=fixture(t,{preview:{kind:'command',version:'1',command:process.execPath,args:['-e',`require('http').createServer((q,s)=>s.end('owned')).listen(${p},'127.0.0.1')`],timeoutMs:900,environment:'host',allowHostExecution:true,preview:{url:`http://127.0.0.1:${p}/`,ttlMs:1500}}});
  const start=f.manager.launch({profileId:'preview'});await until(()=>f.manager.get(start.id).execution?.childPid);await wait(70);
  const initial=Date.parse(f.manager.get(start.id).deadlineAt);await f.manager.preview(start.id);
  await wait(Math.max(0,initial-Date.now()+100));assert.equal(await(await fetch(`http://127.0.0.1:${p}/`)).text(),'owned');
  const previous=Date.parse(f.manager.get(start.id).previewLease.expiresAt),renewed=await f.manager.renewPreview(start.id,{ttlMs:1700});
  assert.ok(Date.parse(renewed.expiresAt)>previous);assert.equal(f.manager.get(start.id).execution.deadlineAt,renewed.expiresAt);
  await wait(Math.max(0,previous-Date.now()+40));assert.equal(await(await fetch(renewed.url)).text(),'owned');
  const ended=await f.manager.closePreview(start.id);assert.ok(ended.guardians.every(g=>!alive(g.pid)));assert.equal(f.wakes.length,0);
  const second=f.manager.launch({profileId:'preview'});await until(()=>f.manager.get(second.id).execution?.childPid);await wait(70);await f.manager.preview(second.id,{ttlMs:1000});
  const expired=await second.done;assert.equal(expired.status,'preview-expired');assert.ok(expired.guardians.every(g=>!alive(g.pid)));await assert.rejects(fetch(renewed.url));
});

for(const driverName of ['codex-app-server','dsh-sdk'])test(`${driverName} child follows up in the same workspace and session, with distinct run receipts and bounded turns`,async t=>{
  const inputs=[];const f=fixture(t,{child:{kind:'agent',version:'1',instruction:'Edit only value.txt',paths:['value.txt'],maxTurns:2}},
    {createChildDriver:()=>({reportVersion:2,capabilities:{sessionResume:true},async run(input){inputs.push(input);input.checkpoint(input.session??{driver:driverName,id:'child-session'});writeFileSync(join(input.projectRoot,'value.txt'),String(inputs.length));return report(inputs.length===1?'waiting':'ready');}})});
  const h=f.manager.launch({profileId:'child'},{requestId:'initial'}),first=await h.done;assert.equal(first.status,'handed-off');assert.equal(first.report.attention.question,'Which wording?');
  f.manager.beginTurn({runId:'parent-2'});const follow=f.manager.resume(h.id,{text:'Use concise wording'},{requestId:'reply-1'}),second=await follow.done;
  assert.equal(second.status,'completed');assert.equal(inputs.length,2);assert.deepEqual(inputs[1].session,{driver:driverName,id:'child-session'});
  assert.equal(inputs[1].projectRoot,inputs[0].projectRoot);assert.notEqual(inputs[1].runId,inputs[0].runId);assert.deepEqual(second.scope,first.scope);assert.equal(second.parent.runId,'parent-1');
  assert.equal(second.messages.at(-1).status,'consumed');assert.equal(second.messages.at(-1).parentRunId,'parent-2');assert.equal(second.turns.length,2);
  assert.equal(new Set(f.wakes.map(e=>e.id)).size,2);assert.equal(readFileSync(join(f.workspace.path,'value.txt'),'utf8'),'initial');
  await f.manager.resume(h.id,{text:'Use concise wording'},{requestId:'reply-1'}).done;assert.equal(inputs.length,2);
  assert.throws(()=>f.manager.message(h.id,{text:'Different wording'},{requestId:'reply-1'}),/identity conflict/);
  assert.throws(()=>f.manager.message(h.id,{text:'One more'},{requestId:'reply-2'}),/turn budget/);
});

test('child messages queue behind a live turn; uncertain execution, lost owner and revoked authority cannot recreate work',async t=>{
  let release,entered=false,active=0,maximum=0,calls=0,allowed=true;
  const f=fixture(t,{child:{kind:'agent',version:'1',instruction:'Edit only value.txt',paths:['value.txt'],maxTurns:4}},
    {assertActive:()=>{if(!allowed)throw new Error('authority revoked');},createChildDriver:()=>({reportVersion:2,capabilities:{sessionResume:true},async run(input){calls++;active++;maximum=Math.max(maximum,active);input.checkpoint(input.session??{driver:'dsh-sdk',id:'child-session'});
      if(calls===1){entered=true;await new Promise(resolve=>{release=resolve;});}active--;if(calls===3)throw new Error('native result unknown');return report();}})});
  const h=f.manager.launch({profileId:'child'});await until(()=>entered);
  const queued=f.manager.message(h.id,{text:'Check the same file again'},{requestId:'queued'});assert.equal(f.manager.get(h.id).messages.at(-1).status,'queued');assert.throws(()=>f.manager.resume(h.id,{text:'bad'}),/still running/);
  release();const result=await queued.done;assert.equal(result.status,'completed');assert.equal(calls,2);assert.equal(maximum,1);
  allowed=false;assert.throws(()=>f.manager.message(h.id,{text:'not allowed'}),/authority revoked/);allowed=true;
  assert.equal((await f.manager.resume(h.id,{text:'A third scoped check'},{requestId:'third'}).done).status,'failed');
  assert.equal(f.manager.get(h.id).messages.at(-1).status,'inspection');assert.throws(()=>f.manager.resume(h.id,{text:'Never replay'}),/inspection/);assert.equal(calls,3);
  const reopened=createManagedJobs(f.options);t.after(()=>reopened.close());assert.throws(()=>reopened.resume(h.id,{text:'Never replace owner'}),/owner is unavailable/);
});

test('child total budget and cancellation survive completed turns',async t=>{
  const f=fixture(t,{child:{kind:'agent',version:'1',instruction:'Edit value.txt',paths:['value.txt'],timeoutMs:100,maxTurns:3}},
    {createChildDriver:()=>({reportVersion:2,capabilities:{sessionResume:true},async run(input){input.checkpoint({driver:'codex-app-server',id:'child'});return report('waiting');}})});
  const first=await f.manager.launch({profileId:'child'}).done;await wait(110);assert.throws(()=>f.manager.resume(first.id,{text:'Too late'}),/time budget expired/);
  const second=await f.manager.launch({profileId:'child'}).done;await f.manager.cancel(second.id);assert.throws(()=>f.manager.resume(second.id,{text:'Cancelled work'}),/inspection/);
});

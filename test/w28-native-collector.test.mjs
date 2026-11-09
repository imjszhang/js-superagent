import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshNativeCollector } from '../src/drivers/dsh-native-jobs.mjs';
import { validateNativeHandoff } from '../src/drivers/dsh-lease.mjs';
import { nativeHandoffClosed, nativeHandoffJobIds, nativeHandoffEvidenceReceipts } from '../src/runtime/native-handoff.mjs';

function fixture() {
  let complete, waiting = false;
  const events = [], job = { id:'bash-example',kind:'bash',owner:'session-example',status:'running',startedAt:1,output:{total:12,earliest:0} };
  const jobs = {
    get(id, caller) { assert.equal(id,job.id);assert.equal(caller,job.owner);return {...job}; },
    wait(id, ms, caller, signal) { this.get(id,caller);assert.equal(ms,30000);waiting=true;return new Promise((resolve,reject)=>{complete=()=>{job.status='completed';job.finishedAt=2;resolve({...job});};signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}); },
    readAt(id, from, caller) { this.get(id,caller);assert.equal(from,0);return {chunks:[{at:0,channel:'stdout',text:'real output'}]}; },
  };
  const collector=createDshNativeCollector(jobs,{sessionId:job.owner,emit:async event=>events.push(event)});
  return {collector,job,events,isWaiting:()=>waiting,complete:()=>complete()};
}

test('native collector installs public wait before acknowledging and saves output without a model call',async()=>{
  const f=fixture();assert.equal(f.collector.hold([f.job.id]).installed,true);assert.equal(f.isWaiting(),true);
  f.complete();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.events.length,1);assert.equal(f.events[0].type,'settled');assert.equal(f.events[0].output.chunks[0].text,'real output');await f.collector.close();
});
test('native collector rejects unrelated ownership and closes a pending waiter',async()=>{
  const f=fixture();f.job.owner='another-session';assert.throws(()=>f.collector.hold([f.job.id]));f.job.owner='session-example';
  f.collector.hold([f.job.id]);await f.collector.close();assert.ok(f.events.every(event=>event.type!=='settled'));
});
test('native handoff records require exact supported release, owned processes and a completed report boundary',()=>{
  const value={version:1,id:'lease-id',driver:'dsh-sdk',nativeVersion:'0.2.2-alpha.2',ticketId:'ticket',assignmentId:'assignment',originRunId:'run',session:{driver:'dsh-sdk',id:'session'},cwd:'/temporary',configDigest:'a'.repeat(64),deadlineAt:new Date().toISOString(),guardianPids:[42],jobIds:['bash-one'],reportBoundary:{state:'waiting',assistantSequence:5,terminalSequence:6,question:'Which wording?'}};
  assert.deepEqual(validateNativeHandoff(value),value);assert.throws(()=>validateNativeHandoff({...value,nativeVersion:'0.2.1-rc.5'}));assert.throws(()=>validateNativeHandoff({...value,guardianPids:[]}));assert.throws(()=>validateNativeHandoff({...value,reportBoundary:{...value.reportBoundary,state:'ready'}}));
});

test('native owner closes only after bridge cleanup on both process exit and failure',async()=>{
  let finish, closed=false;const gate=new Promise(resolve=>{finish=resolve;});
  const owner=nativeHandoffClosed(Promise.resolve('exit'),()=>gate).then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);finish();await owner;assert.equal(closed,true);
  let cleaned=false;const failure=new Error('native process stopped');
  await assert.rejects(nativeHandoffClosed(Promise.reject(failure),async()=>{cleaned=true;}),error=>error===failure);
  assert.equal(cleaned,true);
});

test('partial native results consume only presented jobs and retain identities across transfer',()=>{
  assert.deepEqual(nativeHandoffJobIds(['bash-a','bash-b'],['bash-b','bash-c']),['bash-a','bash-b','bash-c']);
  const record={id:'lease-first',jobIds:['bash-a','bash-b'],results:[{type:'settled',job:{id:'bash-a'}}]};
  assert.deepEqual(nativeHandoffEvidenceReceipts([record]),[{leaseId:'lease-first',jobIds:['bash-a']}]);
  const successor={...record,id:'lease-next',jobIds:nativeHandoffJobIds(record.jobIds,['bash-b']),results:[{type:'settled',job:{id:'bash-b'}},{type:'failed',jobId:'bash-a'}]};
  assert.deepEqual(nativeHandoffEvidenceReceipts([successor]),[{leaseId:'lease-next',jobIds:['bash-b']}]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

const waiting = { version:2, state:'waiting', summary:'Waiting for the next event.' };
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; };
async function until(predicate) { for(let i=0;i<200;i++){if(predicate())return;await delay(10);}assert.fail('Timed out waiting for fixture work'); }
function fixture(t, run) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-status-priority-')));
  const runtime=createProjectAgent({projectRoot:root,workspace:'copy',driver:{run}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  return runtime;
}

test('a status request uses an idle human reserve while ordinary work fills normal capacity', {timeout:5000}, async t => {
  const release=deferred(),calls=[],started=deferred();let active=0,maxActive=0;
  const runtime=fixture(t,async({ticket,signal})=>{
    active++;maxActive=Math.max(maxActive,active);calls.push(ticket.id);
    try {
      if(ticket.text==='Block normal capacity'){
        started.resolve();
        await Promise.race([release.promise,new Promise(done=>signal.addEventListener('abort',done,{once:true}))]);
      }
      return waiting;
    } finally {active--;}
  });
  const target=runtime.submit({text:'Waiting status target'});await runtime.runNext();
  const context=runtime.submit({text:'Waiting context target'});await runtime.runNext();
  const blocker=runtime.submit({text:'Block normal capacity'});
  runtime.configureScheduler({maxWorkers:2,humanReserve:1},{expectedRevision:0});
  runtime.start({intervalMs:10});await started.promise;
  runtime.note(context.id,'This is ordinary context, not a request from a person.');
  assert.equal(runtime.requestStatus(target.id),true);
  await until(()=>calls.filter(id=>id===target.id).length===2);
  assert.equal(calls.filter(id=>id===context.id).length,1,'ordinary context cannot consume the reserved slot');
  assert.equal(calls.filter(id=>id===blocker.id).length,1);
  assert.equal(maxActive,2,'status uses existing capacity instead of adding a worker beyond the configured limit');
  assert.equal(runtime.get(blocker.id).status,'running');
  release.resolve();await runtime.stop();
});

test('a pending status request is selected ahead of an earlier ordinary context delivery', async t => {
  const calls=[],runtime=fixture(t,async({ticket})=>{calls.push(ticket.id);return waiting;});
  const context=runtime.submit({text:'Context first'});await runtime.runNext();
  const target=runtime.submit({text:'Status second'});await runtime.runNext();
  runtime.note(context.id,'Ordinary context was queued first.');
  assert.equal(runtime.requestStatus(target.id),true);
  const next=await runtime.runNext();
  assert.equal(next.id,target.id);
  assert.deepEqual(calls,[context.id,target.id,target.id]);
  assert.equal((await runtime.runNext()).id,context.id,'ordinary context remains queued for normal execution');
});

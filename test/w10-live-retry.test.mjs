import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await delay(10);}assert.fail('Timed out');}
for(const state of ['not-sent','unknown','read-before-error'])test(`W10 input delivery ${state} preserves evidence and avoids unsafe resends`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-w10-input-'));let current,sends=0,release;
  const done=new Promise(r=>release=r);
  const driver={reportVersion:2,capabilities:{realtimeInput:true,inputAcknowledgements:true},async run(input){current=input;input.checkpoint({driver:'fixture',id:'native-1'});await done;return{version:2,state:'ready',summary:'Finished'};},async sendInput({inputId}){
    sends++;
    if(state==='read-before-error'||sends>1)current.inputRead({inputId,evidence:{type:'model-final-ack',sessionId:'native-1',turnId:'t1'}});
    if(sends===1)throw Object.assign(new Error('transport interrupted'),state==='not-sent'?{deliveryState:'not-sent'}:{});
    return{accepted:true,read:false,inputId,sessionId:'native-1'};
  }};
  const r=createProjectAgent({projectRoot:root,driver}).init();t.after(async()=>{release();await r.stop();r.close();rmSync(root,{recursive:true,force:true});});
  const ticket=r.submit({text:'Initial task'}),running=r.runNext();await until(()=>current);
  r.reply(ticket.id,'One additional instruction');await until(()=>r.getDetailed(ticket.id).liveInputs.some(input=>input.status!=='sending'));
  let saved=r.getDetailed(ticket.id).liveInputs[0];assert.equal(saved.status,state==='read-before-error'?'read':state);
  if(state==='not-sent'){
    const db=new Store(join(stateDir(root), 'state.sqlite'));db.setMeta(`live-input:${saved.runId}:${saved.inputId}`,{...saved,nextAt:'2000-01-01T00:00:00.000Z'});db.close();
    await until(()=>r.getDetailed(ticket.id).liveInputs[0].status==='read');assert.equal(sends,2);assert.equal(r.getDetailed(ticket.id).liveInputs[0].attempts,2);
  }else{await delay(80);assert.equal(sends,1);}
  release();await running;
});

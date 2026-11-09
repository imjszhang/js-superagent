import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await delay(10);}assert.fail('Timed out');}
for (const acknowledged of [true,false]) test(`live input receipt is distinct from consumption (acknowledged=${acknowledged})`,async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-steer-'))), release=deferred(); let current,sent,runs=0;
  const driver={reportVersion:2,capabilities:{realtimeInput:true,inputAcknowledgements:true},async run(input){
    current=input;runs++;input.checkpoint({driver:'fixture',id:'session-1'});if(runs===1)await release.promise;
    if(acknowledged&&sent&&runs===1)input.inputRead({inputId:sent.inputId,evidence:{type:'model-final-ack',sessionId:'session-1',turnId:'turn-1'}});
    return{version:2,state:'ready',summary:'Done',attention:null};
  },async sendInput(input){sent=input;return{accepted:true,read:false,inputId:input.inputId,sessionId:'session-1',turnId:'turn-1'};}};
  const runtime=createProjectAgent({projectRoot:root,driver}).init();
  t.after(async()=>{release.resolve();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Start'});const first=runtime.runNext();await until(()=>current);
  runtime.reply(ticket.id,'Change the result');await until(()=>runtime.getDetailed(ticket.id).liveInputs.some(i=>i.status==='accepted'));
  const pending=runtime.getDomainTicket(ticket.id).inputs.find(i=>i.id===sent.inputId);assert.equal(pending.readAt,undefined);
  release.resolve();await first;
  if(acknowledged){assert.equal(runtime.get(ticket.id).status,'completed');assert.equal(runtime.getDetailed(ticket.id).liveInputs[0].status,'read');assert.equal(await runtime.runNext(),null);}
  else{assert.notEqual(runtime.get(ticket.id).status,'completed');await runtime.runNext();assert.equal(runs,2);}
});

test('native consumption can precede enqueue response but must match current adapter evidence',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-native-input-'))),release=deferred();let current,proof;
  const driver={reportVersion:2,capabilities:{realtimeInput:true,inputAcknowledgements:true},
    async run(input){current=input;input.checkpoint({driver:'fixture',id:'native-session'});await release.promise;return{version:2,state:'ready',summary:'Read latest feedback',attention:null};},
    validateInputRead({evidence}){return evidence===proof;},
    async sendInput({runId,inputId}){
      proof={type:'native-user-message',driver:'fixture',sessionId:'native-session',messageId:'native-message',eventSequence:7,runId,inputId};
      assert.throws(()=>current.inputRead({inputId,evidence:{...proof,runId:'stale-run'}}),/Unverified/);
      assert.throws(()=>current.inputRead({inputId,evidence:{...proof,messageId:'forged'}}),/Unverified/);
      current.inputRead({inputId,evidence:proof});
      return{accepted:true,read:false,inputId,sessionId:'native-session',messageId:'native-message'};
    }};
  const runtime=createProjectAgent({projectRoot:root,driver}).init();
  t.after(async()=>{release.resolve();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Start native turn'});const running=runtime.runNext();await until(()=>current);
  runtime.reply(ticket.id,'Follow the new instruction');await until(()=>runtime.getDetailed(ticket.id).liveInputs.some(i=>i.status==='read'));
  release.resolve();await running;
  assert.equal(runtime.get(ticket.id).status,'completed');assert.equal(runtime.getDetailed(ticket.id).liveInputs[0].status,'read');
  assert.equal(await runtime.runNext(),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessRegistry, createProjectAgent } from './helpers/runtime-fixture.mjs';
import { feedbackDisposition } from '../src/runtime/feedback.mjs';
function setup(t, run, github) {
  const root=mkdtempSync(join(tmpdir(),'js-superagent-w1-'));
  const registry=createHarnessRegistry({adapters:[{id:'feedback-fixture',version:'1',roles:['worker'],validate:o=>o,createDriver:()=>({reportVersion:2,run})}]});
  const runtime=createProjectAgent({projectRoot:root,harnessRegistry:registry,execution:{driver:'feedback-fixture'},github,
    ...(github?{githubChannel:{poll:async()=>[],deliver:async()=>({id:'receipt'})}}:{})}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});return runtime;
}
const report=(state,summary)=>({version:2,state,summary});
for(const state of ['failed','blocked']) test(`W1 ${state} business report continues same ticket after human reply`,async t=>{
  let count=0; const seen=[];
  const runtime=setup(t,async input=>{seen.push(input.session??null);input.checkpoint({driver:'feedback-fixture',id:'original'});return report(++count===1?state:'ready','Business outcome');});
  const ticket=runtime.submit({text:'Fix this'});await runtime.runNext();
  assert.equal(runtime.getDetailed(ticket.id).failure.requiresInspection,false);
  runtime.reply(ticket.id,'Here is the missing requirement');await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'completed');assert.equal(count,2);
  assert.deepEqual(seen,[null,{driver:'feedback-fixture',id:'original'}]);
});
test('W1 unknown native result saves human feedback without executing until explicit retry',async t=>{
  let count=0;
  const runtime=setup(t,async()=>{if(++count===1)throw new Error('Process lost after unknown external result');return report('ready','Checked and resumed');});
  const ticket=runtime.submit({text:'Make a change'});await runtime.runNext();runtime.reply(ticket.id,'Additional context');
  assert.equal(runtime.getDetailed(ticket.id).heldFeedback.length,1);await runtime.runNext();assert.equal(count,1);
  runtime.retry(ticket.id);await runtime.runNext();assert.equal(count,2);assert.equal(runtime.getDetailed(ticket.id).heldFeedback.length,0);
});
test('W1 failed Issue receives one authorized reply and does not swallow it as ignored',async t=>{
  const repository='fixture/project';let count=0;
  const runtime=setup(t,async()=>report(++count===1?'failed':'ready','Business result'),{repository,allowedActors:['alice'],issues:[7]});
  const event={id:'github:fixture/project:issue:7',kind:'issue',repository,issueNumber:7,issueId:7,title:'Fix',text:'/js-superagent fix it',actor:{login:'alice',id:'10',type:'User'},createdAt:new Date().toISOString(),url:`https://github.com/${repository}/issues/7`,issueState:'open'};
  const intake=runtime.receiveGitHubEvent(event);await runtime.runNext();
  const reply={...event,id:'github:fixture/project:comment:8',kind:'comment',text:'The expected format is markdown',createdAt:new Date().toISOString()};
  assert.equal(runtime.receiveGitHubEvent(reply).status,'received');assert.equal(runtime.receiveGitHubEvent(reply).status,'duplicate');
  await runtime.runNext();assert.equal(count,2);assert.equal(runtime.get(intake.ticketId).status,'completed');
});
test('W1 bots cannot release failures, unsafe/active/old records require inspection, cancellation rejects',()=>{
  const domain={assignments:[{report:{state:'failed'}}]},known={failure:{requiresInspection:false}};
  assert.equal(feedbackDisposition({meta:known,domain,human:false}).status,'recorded');
  for(const options of [{meta:{}},{meta:known,active:true},{meta:known,pendingDelivery:true},{meta:{interrupted:true}}])assert.equal(feedbackDisposition({domain,human:true,...options}).status,'held');
  assert.equal(feedbackDisposition({meta:known,domain:{...domain,ended:{by:'human'}},human:true}).status,'rejected');
});

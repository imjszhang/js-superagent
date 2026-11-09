import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const repository='fixture/paused-held', actor={login:'alice',id:'10',type:'User'}, head='a'.repeat(40);
async function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-paused-held-')));let count=0,sequence=10;
  const options={projectRoot:root,github:{repository,allowedActors:['alice'],issues:[7]},
    githubChannel:{async poll(){return [];},async deliver(message){return {id:message.id};},async getPullRequest(){return {repository,number:9,id:'900',headSha:head,headRef:'fix',headRepository:repository,state:'open',merged:false,title:'Fix',url:`https://github.com/${repository}/pull/9`};}},
    driver:{async run(input){input.checkpoint({driver:'fixture',id:'native-original'});if(++count===1)throw new Error('Uncertain native result');return {version:2,state:'waiting',summary:'Waiting',artifacts:[],attention:null};}}};
  let runtime=createProjectAgent(options).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const event=text=>({id:`github:${repository}:comment:${++sequence}`,repository,kind:'comment',issueNumber:7,issueId:'700',issueState:'open',actor,text,createdAt:new Date(Date.now()+sequence*1000).toISOString()});
  const inspect=fn=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}};
  const ticket=runtime.receiveGitHubEvent(event('/js-superagent Fix this'));await runtime.runNext();
  assert.equal(runtime.get(ticket.ticketId).status,'failed');
  const hold=()=>{const input=event('Continue after checking the previous result');assert.equal(runtime.receiveGitHubEvent(input).feedback.status,'held');return input;};
  const inputs=id=>runtime.getDomainTicket(ticket.ticketId).inputs.filter(input=>input.triggerId===id);
  return {root,get runtime(){return runtime;},ticket:ticket.ticketId,event,inspect,hold,inputs,
    async reopen(){await runtime.stop();runtime.close();runtime=createProjectAgent(options).init();}};
}

for(const action of ['retry','replace']) test(`paused ${action} retains inspected feedback across reopening and delivers it once on resume`,async t=>{
  const f=await fixture(t),input=f.hold();f.runtime.pause();
  if(action==='retry')f.runtime.retry(f.ticket);
  else await f.runtime.replaceSession(f.ticket,{reason:'Checked original work; replace the native session',expectedSessionId:'native-original'});
  assert.equal(f.inputs(input.id).length,0);assert.equal(f.runtime.getDetailed(f.ticket).heldFeedback[0].reason,'runtime-paused');
  await f.reopen();assert.equal(f.runtime.isPaused(),true);assert.equal(f.inputs(input.id).length,0);
  f.runtime.resume();assert.equal(f.inputs(input.id).length,1);assert.equal(f.runtime.getDetailed(f.ticket).heldFeedback.length,0);
  f.runtime.resume();assert.equal(f.inputs(input.id).length,1);
  assert.equal(f.inspect(store=>store.getMeta(`ticket:${f.ticket}`)).messages.find(message=>message.triggerId===input.id).superseded,undefined);
});

test('plain resume does not release feedback that still needs inspection',async t=>{
  const f=await fixture(t),input=f.hold();f.runtime.pause();f.runtime.resume();
  assert.equal(f.inputs(input.id).length,0);assert.equal(f.runtime.getDetailed(f.ticket).heldFeedback.length,1);
});

for(const change of ['cancel','revoke','unsubscribe','retire']) test(`paused release rechecks ${change} before delivering saved feedback`,async t=>{
  const f=await fixture(t),input=f.hold();f.runtime.pause();f.runtime.retry(f.ticket);
  if(change==='cancel')f.runtime.cancel(f.ticket);
  if(change==='revoke')f.runtime.configureCoordinator({policy:{sourceRows:[{id:'github',source:'github',scope:{repository},actors:[],bots:['alice']}]}},{expectedRevision:0});
  if(change==='unsubscribe'){const thread=f.runtime.managementStatus().threads.find(item=>item.thread===`github:${repository}#7`);f.runtime.unsubscribeThread(thread.thread,{expectedRevision:thread.revision});}
  if(change==='retire')f.inspect(store=>store.setMeta(`input:retired:${f.runtime.getDomainTicket(f.ticket).id}:${input.id}`,{reason:'superseded'}));
  f.runtime.resume();assert.equal(f.inputs(input.id).length,0);assert.equal(f.runtime.getDetailed(f.ticket).heldFeedback.length,0);
  assert.equal(f.inspect(store=>store.getMeta(`ticket:${f.ticket}`)).messages.find(message=>message.triggerId===input.id).feedback.status,'rejected');
});

test('paused release retains PR feedback when its saved head no longer matches the association',async t=>{
  const f=await fixture(t);await f.runtime.linkGitHubPullRequest(f.ticket,{number:9});
  const event={id:`github:${repository}:pr_comment:90`,repository,pullNumber:9,headSha:head,pullState:'open',actor,kind:'pr_comment',createdAt:new Date().toISOString(),text:'Resume after inspection'};
  assert.equal(f.runtime.receiveGitHubEvent(event).feedback.status,'held');f.runtime.pause();f.runtime.retry(f.ticket);
  f.inspect(store=>{const key=`github:pull:${repository}#9`,binding=store.getMeta(key);store.setMeta(key,{...binding,headSha:'b'.repeat(40)});});
  f.runtime.resume();assert.equal(f.inputs(event.id).length,0);assert.equal(f.runtime.getDetailed(f.ticket).heldFeedback[0].reason,'pull-request-version-unavailable');
});

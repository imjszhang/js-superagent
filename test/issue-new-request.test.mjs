import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { normalizeGitHubEvent } from '../src/github-intake.mjs';
import { webhookConfigurationKey } from '../src/github-webhook-inbox.mjs';

const repository='fixture/new-issue-request',alice={login:'alice',id:10,type:'User'},carl={login:'carl',id:12,type:'User'};
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-new-issue-request-'))),assessed=[];
  let sequence=100,clock=Date.now();
  const runtime=createProjectAgent({projectRoot:root,
    github:{repository,allowedActors:['alice','carl'],issues:[7],pollIntervalMs:86_400_000},
    githubChannel:{async poll(){return [];},async deliver(message){return {id:message.id};}},
    driver:{async run(){return {version:2,state:'waiting',summary:'Waiting for follow-up',artifacts:[],attention:null};}},
    assessor:{async assess({candidate}){assessed.push(candidate);return {kind:'accept',title:'New request',scope:candidate.triggers[0].text,reason:'Current explicit request',rules:[]};}},
  }).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  // A fresh event must remain newer than settings enabled during a slow test run.
  const event=(text,extra={})=>{const at=new Date(clock=Math.max(clock+1000,Date.now())).toISOString();return normalizeGitHubEvent({id:`github:${repository}:comment:${++sequence}`,
    repository,kind:'comment',issueNumber:7,issueId:700,issueState:'open',title:'Issue',actor:alice,text,createdAt:at,updatedAt:at,...extra});};
  const inspect=fn=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}};
  const enableAssessor=()=>runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:runtime.coordinatorStatus().settings.revision});
  async function first(){const result=runtime.receiveGitHubEvent(event('/js-superagent Original request'));await runtime.runNext();return runtime.get(result.ticketId);}
  return {runtime,event,inspect,first,assessed,enableAssessor};
}

test('a fresh explicit Issue request after cancellation reaches assessment once without reviving the old mandate',async t=>{
  const f=fixture(t),old=await f.first();f.runtime.cancel(old.id);f.enableAssessor();
  const event=f.event('/js-superagent Please implement a different fix'),result=f.runtime.receiveGitHubEvent(event);
  assert.equal(result.reason,'queued-for-assessment');assert.equal(f.runtime.list().length,1);
  assert.deepEqual(f.inspect(store=>store.triggers.disposition(event.id)).fanout,[]);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');await f.runtime.runNext();
  assert.equal(f.assessed.filter(candidate=>candidate.triggers.some(trigger=>trigger.id===event.id)).length,1);
  assert.equal(f.runtime.list().length,2);assert.equal(f.runtime.get(old.id).status,'cancelled');
  assert.equal(f.runtime.getDomainTicket(old.id).inputs.some(input=>input.triggerId===event.id),false);
});

test('a currently authorized requester can replace revoked ownership while direct-command intake remains usable without an assessor',async t=>{
  const f=fixture(t),old=await f.first();
  f.runtime.configureCoordinator({policy:{mode:'off',sourceRows:[{id:'github',source:'github',scope:{repository},actors:['carl'],bots:['alice']}]}},{expectedRevision:0});
  const event=f.event('/js-superagent Work under my new request',{actor:carl}),result=f.runtime.receiveGitHubEvent(event);
  assert.ok(result.ticketId);assert.notEqual(result.ticketId,old.id);assert.equal(f.runtime.list().length,2);
  assert.equal(f.runtime.getDomainTicket(old.id).inputs.some(input=>input.triggerId===event.id),false);
  assert.equal(f.runtime.getDomainTicket(result.ticketId).mandate.actor.id,'carl');
});

test('ordinary text, cancelled commands, outsiders, bots and closed Issues do not create replacement work',async t=>{
  const f=fixture(t),old=await f.first();f.runtime.cancel(old.id);f.enableAssessor();
  for(const [text,extra] of [
    ['Continue',{}],['/js-superagent cancel',{}],['/js-superagent-malformed New task',{}],
    ['/js-superagent New task',{actor:{login:'outsider',id:99,type:'User'}}],
    ['/js-superagent New task',{actor:{...alice,type:'Bot'}}],
    ['/js-superagent New task',{issueState:'closed'}],
  ]){
    const event=f.event(text,extra);f.runtime.receiveGitHubEvent(event);
    assert.equal(f.inspect(store=>store.threads.get(`github:${repository}#7`)).pending.includes(event.id),false);
  }
  assert.equal(f.runtime.list().length,1);assert.equal(f.assessed.length,0);assert.equal(f.runtime.get(old.id).status,'cancelled');
});

test('a held authorized owner keeps a new explicit message even when other Issue owners were cancelled',async t=>{
  const f=fixture(t),old=await f.first();f.runtime.cancel(old.id);
  const next=f.runtime.receiveGitHubEvent(f.event('/js-superagent Current task'));await f.runtime.runNext();f.enableAssessor();
  f.inspect(store=>{const domain=store.tickets.get(next.ticketId);domain.assignments.at(-1).report.state='failed';store.tickets.save(domain);
    const meta=store.getMeta(`ticket:${next.ticketId}`);meta.failure={requiresInspection:true,origin:'fixture'};store.setMeta(`ticket:${next.ticketId}`,meta);});
  const event=f.event('/js-superagent Continue after inspection'),result=f.runtime.receiveGitHubEvent(event);
  assert.equal(result.outcomes.find(item=>item.ticketId===next.ticketId).feedback.status,'held');
  assert.equal(f.runtime.getDetailed(next.ticketId).heldFeedback.length,1);assert.equal(f.runtime.list().length,2);
  assert.equal(f.inspect(store=>store.threads.get(`github:${repository}#7`)).pending.includes(event.id),false);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');assert.equal(f.runtime.getDetailed(next.ticketId).heldFeedback.length,1);
});

test('paused new requests wait and are admitted under the policy at resume',async t=>{
  const f=fixture(t),old=await f.first();f.runtime.cancel(old.id);f.runtime.pause();
  const denied=f.event('/js-superagent New request while paused');assert.equal(f.runtime.receiveGitHubEvent(denied).reason,'paused-feedback-pending');
  f.runtime.configureCoordinator({policy:{mode:'off',sourceRows:[{id:'github',source:'github',scope:{repository},actors:['carl'],bots:['alice']}]}},{expectedRevision:0});
  f.runtime.resume();assert.equal(f.runtime.list().length,1);
  assert.equal(f.inspect(store=>store.threads.get(`github:${repository}#7`)).pending.includes(denied.id),false);
  f.runtime.pause();const allowed=f.event('/js-superagent Current authorized request',{actor:carl});
  assert.equal(f.runtime.receiveGitHubEvent(allowed).reason,'paused-feedback-pending');assert.equal(f.runtime.list().length,1);
  f.runtime.resume();assert.equal(f.runtime.list().length,2);assert.equal(f.runtime.get(old.id).status,'cancelled');
});

test('verified mentions can start replacement work while independent context followers receive one note',async t=>{
  const f=fixture(t),old=await f.first();f.runtime.cancel(old.id);
  const watcher=f.runtime.submit({text:'Watch related discussion'});await f.runtime.runNext();f.runtime.followForContext(watcher.id,{source:'github',id:`${repository}#7`});
  f.runtime.configureRepositorySource({enabled:true,streams:{pulls:false,issues:false,comments:false,reviewComments:false,defaultBranchCI:false,mentions:true}},{expectedRevision:0});
  const settings=f.runtime.getRepositorySourceSettings();f.inspect(store=>store.setMeta('github:mention-identity',{
    identity:{id:'20',login:'helper',type:'User'},configurationKey:webhookConfigurationKey(f.runtime.getConfig().github),mentionEpoch:settings.mentionEpoch??0,at:new Date().toISOString()}));
  const before=f.runtime.getDomainTicket(watcher.id).inputs.length,event=f.event('@helper Please handle this as a new task');
  const result=f.runtime.receiveGitHubEvent(event);assert.ok(result.ticketId);assert.notEqual(result.ticketId,old.id);
  assert.equal(f.runtime.getDomainTicket(watcher.id).inputs.length,before+1);
  const disposition=f.inspect(store=>store.triggers.disposition(event.id));assert.ok(disposition.context.includes(watcher.id));
  assert.equal(f.inspect(store=>store.triggers.get(event.id)).meta.contextOnly,undefined);
  assert.equal(f.runtime.getDomainTicket(old.id).inputs.some(input=>input.triggerId===event.id),false);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');assert.equal(f.runtime.getDomainTicket(watcher.id).inputs.length,before+1);
});

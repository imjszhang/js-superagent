import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, core } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { normalizeGitHubEvent } from '../src/github-intake.mjs';

const repository='fixture/issues', alice={login:'alice',id:10,type:'User'},head='a'.repeat(40);
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-issue-subscriptions-'))),runs=[],assessed=[];
  let seq=100,clock=Date.now();
  const runtime=createProjectAgent({projectRoot:root,
    github:{repository,allowedActors:['alice','carl'],issues:[7,8],pollIntervalMs:86_400_000},
    githubChannel:{async poll(){return [];},async deliver(message){return {id:message.id,url:`https://github.com/${repository}/issues/7#issuecomment-1`};},
      async getPullRequest(){return {repository,number:9,id:'900',headSha:head,headRef:'fix',headRepository:repository,state:'open',merged:false,title:'Fix',url:`https://github.com/${repository}/pull/9`};}},
    driver:{async run(input){runs.push(input);return {version:2,state:'waiting',summary:'Waiting for relevant feedback',artifacts:[],attention:null};}},
    assessor:{async assess({candidate}){assessed.push(candidate);return {kind:'accept',title:'Second task',scope:'A separate issue task',reason:'An explicitly handed-back request',rules:candidate.strength==='inferred'?['investigate']:[]};}},
  }).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const event=(text,options={})=>{const at=new Date(clock+=1000).toISOString();return normalizeGitHubEvent({id:`github:${repository}:comment:${++seq}`,repository,kind:'comment',issueNumber:7,issueId:700,issueState:'open',title:'Shared discussion',actor:alice,text,createdAt:at,updatedAt:at,...options});};
  const inspect=fn=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}};
  async function first(){runtime.receiveGitHubEvent(event('/js-superagent First task'));const ticket=runtime.list()[0];await runtime.runNext();return ticket;}
  async function two(){const a=await first();runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:0});
    const second=event('/js-superagent A different task',{actor:{login:'carl',id:12,type:'User'}});runtime.receiveGitHubEvent(second);assert.equal(runtime.handback(a.id,second.id,'Different scope'),true);
    await runtime.runNext();const b=runtime.list().find(ticket=>ticket.id!==a.id);assert.ok(b,'handback created another ticket');return {a,b};}
  return {root,runtime,runs,assessed,event,inspect,first,two};
}

test('Issue follow-ups fan out to both owning tickets and remain one source event',async t=>{
  const f=fixture(t),{a,b}=await f.two(),event=f.event('Additional information for both tasks');
  const result=f.runtime.receiveGitHubEvent(event);assert.equal(result.status,'received');assert.deepEqual(new Set(result.ticketIds),new Set([a.id,b.id]));
  const disposition=f.inspect(store=>store.triggers.disposition(event.id));assert.deepEqual(new Set(disposition.fanout),new Set([a.id,b.id]));
  for(const ticket of [a,b])assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.triggerId===event.id).length,1);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');
  assert.equal(f.inspect(store=>store.getMeta(`github:event:${event.id}`)).reference.text,event.text);
});

test('cancelling the last accepted ticket does not hide another live subscriber, including pause and resume',async t=>{
  const f=fixture(t),{a,b}=await f.two();f.runtime.cancel(b.id);f.runtime.pause();const event=f.event('Only the first task still needs this');
  assert.equal(f.runtime.receiveGitHubEvent(event).reason,'paused-feedback-pending');
  f.runtime.resume();const saved=f.inspect(store=>store.getMeta(`github:event:${event.id}`));
  assert.deepEqual(saved.ticketIds,[a.id]);assert.equal(saved.outcomes.find(item=>item.ticketId===b.id).reason,'cancelled');
  assert.ok(f.runtime.getDomainTicket(a.id).inputs.some(input=>input.triggerId===event.id));
  assert.ok(!f.runtime.getDomainTicket(b.id).inputs.some(input=>input.triggerId===event.id));
});

test('unlisted discussion context reaches each active subscriber without creating follow-up ownership',async t=>{
  const f=fixture(t),{a,b}=await f.two(),event=f.event('An outside reproduction',{actor:{login:'bob',id:11,type:'User'}});
  const result=f.runtime.receiveGitHubEvent(event);assert.equal(result.reason,'context-only');
  const disposition=f.inspect(store=>store.triggers.disposition(event.id));assert.deepEqual(new Set(disposition.context),new Set([a.id,b.id]));
  for(const ticket of [a,b])assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.triggerId===event.id).length,0);
  assert.equal(f.runtime.list().length,2);
});

test('held feedback can later reach its subscriber without stealing the other ticket ownership or replaying input',async t=>{
  const f=fixture(t),{a,b}=await f.two();
  f.inspect(store=>{const domain=store.tickets.get(b.id);domain.assignments.at(-1).report.state='failed';store.tickets.save(domain);const meta=store.getMeta(`ticket:${b.id}`);meta.failure={requiresInspection:true,origin:'fixture-unknown-effect'};store.setMeta(`ticket:${b.id}`,meta);});
  const event=f.event('Continue when the failure is inspected'),result=f.runtime.receiveGitHubEvent(event);
  assert.equal(result.outcomes.find(item=>item.ticketId===b.id).feedback.status,'held');
  assert.deepEqual(f.inspect(store=>store.triggers.disposition(event.id)).fanout,[a.id]);
  f.runtime.retry(b.id);
  assert.deepEqual(new Set(f.inspect(store=>store.triggers.disposition(event.id)).fanout),new Set([a.id,b.id]));
  for(const ticket of [a,b])assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.triggerId===event.id).length,1);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');
});

test('revoked mandate is isolated from another ticket and cancellation checks each owner',async t=>{
  const f=fixture(t),{a,b}=await f.two();
  f.runtime.configureCoordinator({policy:{mode:'off',sourceRows:[{id:'github',source:'github',scope:{repository},actors:['alice'],bots:['carl']}]}},{expectedRevision:1});
  const reply=f.event('Continue the permitted task'),result=f.runtime.receiveGitHubEvent(reply);
  assert.deepEqual(result.ticketIds,[a.id]);assert.equal(result.outcomes.find(item=>item.ticketId===b.id).reason,'mandate-revoked');
  const stop=f.runtime.receiveGitHubEvent(f.event('/js-superagent cancel'));
  assert.deepEqual(stop.ticketIds,[a.id]);assert.equal(f.runtime.get(a.id).status,'cancelled');
  assert.notEqual(f.runtime.getDomainTicket(b.id).ended?.by,'human');
});

test('cancelled ticket generations do not duplicate a retried public ticket subscription',async t=>{
  const f=fixture(t),ticket=await f.first(),oldId=ticket.id;f.runtime.cancel(ticket.id);f.runtime.retry(ticket.id);
  const current=f.runtime.getDomainTicket(ticket.id);assert.notEqual(current.id,oldId);
  const event=f.event('Only the current mandate receives this'),result=f.runtime.receiveGitHubEvent(event);
  assert.deepEqual(result.ticketIds,[ticket.id]);assert.equal(result.outcomes.length,1);
  assert.deepEqual(f.inspect(store=>store.triggers.disposition(event.id)).fanout,[current.id]);
});

test('first PR feedback held before its isolated subscription still attaches after explicit retry',async t=>{
  const f=fixture(t),ticket=await f.first();await f.runtime.linkGitHubPullRequest(ticket.id,{number:9});
  f.inspect(store=>{const domain=store.tickets.get(ticket.id);domain.assignments.at(-1).report.state='failed';store.tickets.save(domain);const meta=store.getMeta(`ticket:${ticket.id}`);meta.failure={requiresInspection:true,origin:'fixture-unknown-effect'};store.setMeta(`ticket:${ticket.id}`,meta);});
  const event={id:`github:${repository}:pr_comment:400`,repository,pullNumber:9,headSha:head,pullState:'open',actor:alice,kind:'pr_comment',createdAt:new Date().toISOString(),text:'Follow up after inspection'};
  assert.equal(f.runtime.receiveGitHubEvent(event).feedback.status,'held');const held=f.runtime.getDetailed(ticket.id).heldFeedback[0];
  f.runtime.retry(ticket.id);assert.equal(f.runtime.getDetailed(ticket.id).heldFeedback.length,0);
  assert.ok(f.inspect(store=>store.triggers.disposition(held.id)).fanout.includes(ticket.id));
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.triggerId===held.id).length,1);
});

test('context-only subscriptions do not shadow an admitted inferred candidate or gain acknowledgement rights',async t=>{
  const f=fixture(t),a=await f.first();f.runtime.followForContext(a.id,{source:'github',id:`${repository}#8`});
  f.runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},policy:{mode:'observe',rules:[{id:'investigate',enabled:true,instruction:'Investigate parser defects'}],
    sourceRows:[{id:'github',source:'github',scope:{repository},actors:['alice'],bots:[],admission:{listedUnaddressed:'inferred'}}]}},{expectedRevision:0});
  const event=f.event('A parser defect worth investigating',{issueNumber:8,issueId:800});
  assert.equal(f.runtime.receiveGitHubEvent(event).reason,'queued-for-assessment');
  const record=f.inspect(store=>({trigger:store.triggers.get(event.id),disposition:store.triggers.disposition(event.id),thread:store.threads.get(`github:${repository}#8`)}));
  assert.equal(record.trigger.meta.contextOnly,undefined);assert.deepEqual(record.disposition.context,[a.id]);assert.deepEqual(record.thread.pending,[event.id]);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');await f.runtime.runNext();
  assert.equal(f.assessed.filter(candidate=>candidate.triggers.some(trigger=>trigger.id===event.id)).length,1);
  assert.equal(f.runtime.list().length,1,'observe mode never creates new work');
});

test('removing an Issue subscription does not resurrect the legacy single-ticket binding',async t=>{
  const f=fixture(t),{a,b}=await f.two(),status=f.runtime.managementStatus();
  const thread=status.threads.find(row=>row.thread===`github:${repository}#7`);f.runtime.unsubscribeThread(thread.thread,{expectedRevision:thread.revision});
  const event=f.event('Unaddressed after unsubscribe');assert.equal(f.runtime.receiveGitHubEvent(event).status,'ignored');
  for(const ticket of [a,b])assert.ok(!f.runtime.getDomainTicket(ticket.id).inputs.some(input=>input.triggerId===event.id));
});

test('core receive options only narrow existing subscriptions and preserve default fanout',()=>{
  const repo=new core.MemoryRepositories(),engine=new core.Engine({repo,now:()=>new Date().toISOString(),policy:()=>({version:'one',paused:false,evalTimeoutMs:1000,gate:()=>({admissible:true,strength:'explicit',basis:{via:'listed'}}),revalidate:()=>true,admitsInferred:()=>false}),scope:{scope:()=>({listened:true,observed:false})},assessor:{request(){},release(){}},executor:{start(){},deliver(){},stop(){}},outbox:{send(){},status(){},withdraw(){}}});
  const trigger=(id,thread='shared')=>({id,source:'local',threads:[{source:'local',id:thread}],actor:{source:'local',id:'operator'},human:true,text:id,at:new Date().toISOString(),meta:{}});
  const accept=(id,thread)=>{engine.receive(trigger(id,thread));return engine.decide(id,{kind:'accept',title:id,scope:id,reason:'Requested'}).ticketId;};
  const a=accept('first','shared'),b=accept('second','other');engine.followForContext(b,{source:'local',id:'shared'});
  engine.receive(trigger('narrow'),{ticketIds:[a,'not-a-subscriber'],evaluateUnowned:false});assert.deepEqual(repo.triggers.disposition('narrow').fanout,[a]);
  engine.receive(trigger('normal'));assert.deepEqual(new Set(repo.triggers.disposition('normal').fanout),new Set([a,b]));
  engine.receive(trigger('held'),{ticketIds:[],evaluateUnowned:false});assert.ok(!repo.threads.get('local:shared').pending.includes('held'));
  engine.receive(trigger('candidate'),{ticketIds:[]});assert.ok(repo.threads.get('local:shared').pending.includes('candidate'));
  engine.deliverSubscribed('held',[a,'not-a-subscriber']);assert.deepEqual(repo.triggers.disposition('held').fanout,[a]);
  assert.equal(engine.deliverSubscribed('held',[a]),'duplicate');
  assert.ok(!repo.threads.get('local:shared').pending.includes('held'));
  for(const [id,settled] of [['acknowledged',{acked:[a]}],['handed-back',{handbacks:[{ticketId:a,reason:'Not this task',at:new Date().toISOString()}]}]]){
    engine.receive(trigger(id),{ticketIds:[],evaluateUnowned:false});repo.triggers.saveDisposition(id,{...repo.triggers.disposition(id),...settled});
    assert.equal(engine.deliverSubscribed(id,[a]),'duplicate');assert.deepEqual(repo.triggers.disposition(id).fanout,[]);
  }
  assert.deepEqual(new Set(repo.threads.get('local:shared').subscriptions),new Set([a,b]));
});

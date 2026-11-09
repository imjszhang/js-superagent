import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {createGitHubChannel} from '../src/channels/github.mjs';
import {normalizePullEvent} from '../src/github-pull-intake.mjs';
import {buildWorkerContext} from '../src/runtime/worker-context.mjs';
import {Store} from '../src/store.mjs';

const repository='fixture/context',head='a'.repeat(40),nextHead='b'.repeat(40),alice={login:'alice',id:10,type:'User'};
const pull=(rest={})=>({repository,number:9,id:'900',headSha:head,headRef:'fix',headRepository:repository,state:'open',merged:false,title:'Related work',url:`https://github.com/${repository}/pull/9`,...rest});
function fixture(t,{onRun}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-pr-context-'))),runs=[],polls=[],sent=[];let events=[],sequence=100,clock=Date.now()+10000,current=pull();
  const runtime=createProjectAgent({projectRoot:root,github:{repository,allowedActors:['alice'],issues:[7],pollIntervalMs:86_400_000,ci:{checkApps:['trusted-ci']}},
    githubChannel:{async poll(options){polls.push(options);return events;},async getPullRequest(){return current;},async deliver(message){sent.push(message);return {id:message.id};}},
    driver:{capabilities:{boundedContextVersion:1,agentTools:true},async run(input){runs.push(input);input.checkpoint({driver:'fixture',id:`context-${input.ticket.id}`});
      input.contextDelivered({records:buildWorkerContext(input).messages.filter(card=>!card.truncated).map(({resource,id,version})=>({resource,id,version}))});
      await onRun?.(input);return {version:2,state:'waiting',summary:'Waiting for related work',artifacts:[],attention:null};}}
  }).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const inspect=fn=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}};
  const event=(rest={})=>{const at=new Date(clock+=1000).toISOString();return normalizePullEvent({id:`github:${repository}:pr_comment:${++sequence}`,repository,pullNumber:9,kind:'pr_comment',headSha:current.headSha,pullState:current.state,pullRequest:current,actor:alice,createdAt:at,updatedAt:at,text:'Related review evidence',...rest});};
  return {runtime,runs,polls,sent,event,inspect,setEvents(value){events=value;},setPull(value){current=value;},
    async ticket(text='Investigate the local parser'){const ticket=runtime.submit({text});await runtime.runNext();return ticket;},
    notices(ticket){return inspect(store=>store.listMeta(`context-notice:${runtime.getDomainTicket(ticket.id).id}:`).map(row=>row.value));}};
}

test('Worker can follow a same-repository PR without creating an ownership binding',async t=>{
  const f=fixture(t,{onRun(input){const call=(threadId,callId)=>input.agentTools.call({sessionId:`context-${input.ticket.id}`,turnId:'turn',callId,name:'js_superagent_follow',arguments:{source:'github',threadId}});
    assert.throws(()=>call('other/repo#pr:9','outside'),/outside the configured/);
    assert.throws(()=>call(`${repository}#pr:0`,'zero'),/outside the configured/);
    assert.equal(call(`${repository}#pr:9`,'follow').subscribed,true);
  }});const ticket=await f.ticket();
  assert.equal(f.runtime.githubStatus().trackedPullRequests.length,0);
  assert.deepEqual(f.inspect(store=>store.threads.get(`github:${repository}#pr:9`).context),[f.runtime.getDomainTicket(ticket.id).id]);
  await f.runtime.syncGitHub({flush:false});assert.deepEqual(f.polls.at(-1).contextPullRequests,[9]);assert.deepEqual(f.polls.at(-1).trackedPullRequests,[]);
});

test('unbound PR context is delivered once as a readable note and never grants acknowledgement or PR ownership',async t=>{
  let checked=false;const f=fixture(t,{onRun(input){const context=input.agentTools.contextResources().find(row=>row.resource==='triggers'&&row.value.meta?.pullEvent);if(!context)return;
    assert.throws(()=>input.agentTools.call({sessionId:`context-${input.ticket.id}`,turnId:'turn',callId:'ack',name:'js_superagent_ack',arguments:{triggerId:context.id,text:'I own this work'}}),/do not grant request ownership/);checked=true;}});
  const ticket=await f.ticket();f.runtime.followForContext(ticket.id,{source:'github',id:`${repository}#pr:9`});const event=f.event();f.setEvents([event]);
  await f.runtime.syncGitHub({flush:false});assert.equal(f.notices(ticket).length,1);assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.triggerId===event.id).length,0);
  await f.runtime.runNext();assert.equal(checked,true);assert.equal(f.runs.length,2);assert.equal(f.runtime.list().length,1);assert.equal(f.runtime.githubStatus().trackedPullRequests.length,0);
});

test('bound PR delivers owning feedback and independent context without overwriting the owning source or ending the observer',async t=>{
  const f=fixture(t),owner=await f.ticket('Own the change'),observer=await f.ticket('Study related behavior');await f.runtime.linkGitHubPullRequest(owner.id,{number:9});
  f.runtime.followForContext(observer.id,{source:'github',id:`${repository}#pr:9`});const event=f.event();const result=f.runtime.receiveGitHubEvent(event);
  assert.deepEqual(result.contextTicketIds,[observer.id]);const owning=f.runtime.getDomainTicket(owner.id),watching=f.runtime.getDomainTicket(observer.id);
  assert.equal(owning.inputs.filter(input=>input.triggerId===event.id).length,1);assert.equal(watching.inputs.filter(input=>input.triggerId===event.id).length,0);
  assert.deepEqual(f.inspect(store=>store.triggers.get(event.id).threads),[{source:'github',id:`${repository}#pr:9:${owning.id}`}]);
  assert.ok(f.inspect(store=>store.triggers.disposition(event.id).context.includes(watching.id)));assert.equal(f.notices(observer).length,1);
  await f.runtime.runNext();await f.runtime.runNext();assert.equal(f.runs.filter(input=>input.ticket.id===observer.id).length,2);
  assert.equal(f.runtime.get(observer.id).status,'waiting',JSON.stringify(f.runtime.get(observer.id)));
  f.setPull(pull({headSha:nextHead}));const changed=f.event(),changedResult=f.runtime.receiveGitHubEvent(changed);
  assert.equal(changedResult.ownerOutcome?.reason,'pull-request-version-unavailable',JSON.stringify(changedResult));assert.deepEqual(changedResult.contextTicketIds,[observer.id]);
  assert.equal(f.runtime.getDomainTicket(owner.id).inputs.filter(input=>input.triggerId===changed.id).length,0);assert.equal(f.notices(observer).length,2);
  f.setPull(pull({state:'closed',merged:true}));f.runtime.receiveGitHubEvent(f.event({id:`github:${repository}:pull_request_state:9:${head}:merged`,kind:'pull_request_state',text:'',merged:true}));
  assert.equal(f.runtime.getDomainTicket(observer.id).ended,undefined);assert.equal(f.runtime.getDomainTicket(observer.id).follows,undefined);
});

test('PR observer pause, baseline, revision, current head and trust checks remain independent of execution authority',async t=>{
  const f=fixture(t),ticket=await f.ticket();f.runtime.followForContext(ticket.id,{source:'github',id:`${repository}#pr:9`});
  f.runtime.receiveGitHubEvent(f.event({createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'}));assert.equal(f.notices(ticket).length,0);
  f.runtime.receiveGitHubEvent(f.event({headSha:nextHead}));assert.equal(f.notices(ticket).length,0);
  f.runtime.receiveGitHubEvent(f.event({actor:{login:'helper[bot]',id:12,type:'Bot'}}));assert.equal(f.notices(ticket).length,0);
  f.runtime.receiveGitHubEvent(f.event({id:`github:${repository}:check_run:200`,kind:'check_run',actor:{login:'ci[bot]',id:13,type:'Bot'},ci:{name:'tests',app:'untrusted-ci',headSha:head,status:'completed',conclusion:'failure'}}));assert.equal(f.notices(ticket).length,0);
  const event=f.event();f.runtime.pause();assert.equal(f.runtime.receiveGitHubEvent(event).reason,'paused-feedback-pending');assert.equal(f.notices(ticket).length,0);
  f.runtime.resume();assert.equal(f.notices(ticket).length,1);
  const {commentVersion,...original}=event;const correction={...original,id:commentVersion.baseId,text:'Corrected review evidence',updatedAt:new Date(Date.parse(event.updatedAt)+2000).toISOString()};f.runtime.receiveGitHubEvent(correction);
  assert.equal(f.notices(ticket).length,2);assert.equal(f.notices(ticket).filter(row=>row.retired).length,1);
  f.runtime.cancel(ticket.id);f.runtime.receiveGitHubEvent(f.event());assert.equal(f.notices(ticket).length,2);
});

test('source-adapter PR comments reach observers and unsubscribing stops future context',async t=>{
  const f=fixture(t),ticket=await f.ticket();f.runtime.followForContext(ticket.id,{source:'github',id:`${repository}#pr:9`});const event=f.event();
  const trigger={id:event.id,source:'github',threads:[{source:'github',id:`${repository}#pr:9`}],actor:{source:'github',id:'alice'},human:true,at:event.createdAt,text:event.text,meta:{repository,pullEvent:event,githubComment:event.commentVersion}};
  assert.equal(f.runtime.receive(trigger),'received');assert.equal(f.notices(ticket).length,1);assert.equal(f.runtime.receive(trigger),'duplicate');
  const {commentVersion,...raw}=event,edited=normalizePullEvent({...raw,id:commentVersion.baseId,text:'Corrected source detail',updatedAt:new Date(Date.parse(event.updatedAt)+2000).toISOString()});
  f.runtime.receive({...trigger,id:edited.id,text:edited.text,at:edited.updatedAt,meta:{repository,pullEvent:edited,githubComment:edited.commentVersion}});
  assert.equal(f.notices(ticket).length,2);assert.equal(f.notices(ticket).filter(notice=>notice.retired).length,1);
  const thread=f.runtime.managementStatus().threads.find(row=>row.thread===`github:${repository}#pr:9`);f.runtime.unsubscribeThread(thread.thread,{expectedRevision:thread.revision});
  f.runtime.receiveGitHubEvent(f.event());assert.equal(f.notices(ticket).length,2);await f.runtime.syncGitHub({flush:false});assert.deepEqual(f.polls.at(-1).contextPullRequests,[]);
});

test('paused PR observations do not replay an old head after a newer state snapshot',async t=>{
  const f=fixture(t),ticket=await f.ticket();f.runtime.followForContext(ticket.id,{source:'github',id:`${repository}#pr:9`});
  f.runtime.pause();const old=f.event();f.runtime.receiveGitHubEvent(old);f.setPull(pull({headSha:nextHead}));
  f.runtime.receiveGitHubEvent(f.event({id:`github:${repository}:pull_request_state:9:${nextHead}:open`,kind:'pull_request_state',text:'',merged:false}));
  f.runtime.resume();assert.equal(f.notices(ticket).length,0);
  f.runtime.receiveGitHubEvent(f.event());assert.equal(f.notices(ticket).length,1);assert.equal(f.runtime.githubStatus().trackedPullRequests.length,0);
  // A snapshot from before parking cannot invalidate a fresher source snapshot.
  f.setPull(pull());f.runtime.pause();f.runtime.receiveGitHubEvent(f.event());f.runtime.resume();assert.equal(f.notices(ticket).length,2);
});

test('a separately admitted source PR request remains a candidate alongside one context note',async t=>{
  const f=fixture(t),ticket=await f.ticket();f.runtime.followForContext(ticket.id,{source:'github',id:`${repository}#pr:9`});const event=f.event({text:'/js-superagent A separate change'});
  const trigger={id:event.id,source:'github',threads:[{source:'github',id:`${repository}#pr:9`}],actor:{source:'github',id:'alice'},human:true,addressed:'direct',at:event.createdAt,text:event.text,
    meta:{repository,repositoryEvent:true,issueNumber:9,actor:'alice',actorType:'User',actorId:'10',pullRequest:event.pullRequest,pullEvent:event,githubComment:event.commentVersion}};
  f.runtime.pause();assert.equal(f.runtime.receiveGitHubEvent(event).reason,'paused-feedback-pending');
  assert.equal(f.runtime.receive({...trigger,text:'Source presentation must not replace the parked event'}),'received');assert.equal(f.notices(ticket).length,0);
  f.runtime.resume();assert.equal(f.notices(ticket).length,1);
  assert.match(f.inspect(store=>store.triggers.get(event.id).text),/A separate change/);
  assert.doesNotMatch(f.inspect(store=>store.triggers.get(event.id).text),/Source presentation/);
  assert.ok(f.inspect(store=>store.threads.get(`github:${repository}#pr:9`).pending.includes(event.id)));
  assert.equal(f.runtime.getDomainTicket(ticket.id).inputs.filter(input=>input.triggerId===event.id).length,0);
  assert.equal(f.inspect(store=>store.triggers.get(event.id).meta.contextOnly),undefined);
  const stale=f.event({text:'/js-superagent Request against the previous head'});f.runtime.pause();
  f.runtime.receive({...trigger,id:stale.id,text:stale.text,at:stale.createdAt,meta:{...trigger.meta,pullEvent:stale,githubComment:stale.commentVersion}});
  f.setPull(pull({headSha:nextHead}));f.runtime.receiveGitHubEvent(f.event({id:`github:${repository}:pull_request_state:9:${nextHead}:open`,kind:'pull_request_state',text:'',merged:false}));f.runtime.resume();
  assert.equal(f.notices(ticket).length,1);assert.equal(f.inspect(store=>store.triggers.get(stale.id)),undefined);
  assert.equal(f.inspect(store=>store.threads.get(`github:${repository}#pr:9`).pending.includes(stale.id)),false);
});

test('channel polls context PRs without an owning head and reads a changed head only for observers',async()=>{
  const calls=[];const channel=createGitHubChannel({repository,allowedActors:['alice'],issues:[7]}, {async request(endpoint){calls.push(endpoint);
    if(endpoint.endsWith('/issues/7'))return {number:7,pull_request:{}};
    if(endpoint.endsWith('/pulls/9'))return {id:900,number:9,title:'Related work',head:{sha:nextHead,ref:'fix',repo:{full_name:repository}},base:{repo:{full_name:repository}},state:'open',merged:false,user:alice,updated_at:'2026-11-03T00:00:00Z',html_url:`https://github.com/${repository}/pull/9`};
    if(endpoint.includes('/issues/9/comments?'))return [{id:1,user:alice,body:'Current head discussion',created_at:'2026-11-03T00:01:00Z',html_url:`https://github.com/${repository}/pull/9#issuecomment-1`}];
    if(endpoint.includes('/pulls/9/reviews?')||endpoint.includes('/pulls/9/comments?'))return [];
    throw new Error(endpoint);
  }});
  const first=await channel.poll({contextPullRequests:[9]});assert.equal(first.events.filter(event=>event.kind==='pr_comment').length,1);
  const second=await channel.poll({trackedPullRequests:[{number:9,headSha:head,ticketId:'owner'}],contextPullRequests:[9]});assert.equal(second.events.find(event=>event.kind==='pr_comment').headSha,nextHead);
  assert.equal(calls.some(path=>path.includes('check-runs')),false);await assert.rejects(channel.poll({contextPullRequests:[0]}),/positive integer/);
});

test('poll-first context can later enter source assessment without replay or replacing canonical facts',async t=>{
  const f=fixture(t),ticket=await f.ticket();f.runtime.followForContext(ticket.id,{source:'github',id:`${repository}#pr:9`});const event=f.event({text:'/js-superagent A separate task'});
  f.runtime.receiveGitHubEvent(event);const before=f.inspect(store=>store.triggers.get(event.id));assert.equal(before.meta.contextOnly,true);
  const source={...before,addressed:'direct',text:'A source-specific display text',meta:{...before.meta,contextOnly:undefined,repositoryEvent:true,issueNumber:9,pullRequest:event.pullRequest}};
  assert.equal(f.runtime.receive({...source,actor:{source:'github',id:'mallory'}}),'duplicate');
  assert.deepEqual(f.inspect(store=>store.triggers.get(event.id)),before);
  assert.equal(f.runtime.receive(source),'received');assert.equal(f.notices(ticket).length,1);
  const after=f.inspect(store=>store.triggers.get(event.id));assert.equal(after.text,before.text);assert.deepEqual(after.actor,before.actor);assert.deepEqual(after.threads,before.threads);assert.equal(after.meta.contextOnly,undefined);
  assert.ok(f.inspect(store=>store.threads.get(`github:${repository}#pr:9`).pending.includes(event.id)));
  assert.equal(f.runtime.receive(source),'duplicate');assert.equal(f.notices(ticket).length,1);
});

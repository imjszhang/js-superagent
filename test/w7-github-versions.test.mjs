import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { normalizeGitHubEvent } from '../src/github-intake.mjs';
import { normalizePullEvent, pullEventActionable, pullEventText } from '../src/github-pull-intake.mjs';
import { createGitHubRepositorySource } from '../src/channels/github-repository.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
const repository='fixture/project', actor={login:'alice',id:'10',type:'User'}, head='a'.repeat(40);
const time=n=>`2026-11-02T00:00:${String(n).padStart(2,'0')}.000Z`;
const github={repository,allowedActors:['alice'],issues:[7]};
const issue={id:`github:${repository}:issue:700`,kind:'issue',repository,issueNumber:7,issueId:700,issueState:'open',title:'Change',text:'/js-superagent modify the greeting',actor,createdAt:time(0)};
const comment=(text='First requirement',at=1)=>({...issue,id:`github:${repository}:comment:101`,kind:'comment',text,updatedAt:time(at),observedAt:time(at)});
const review=(state='APPROVED',at=1)=>({id:`github:${repository}:review:201`,kind:'review',repository,pullNumber:9,pullState:'open',headSha:head,commitId:head,state,text:'',actor,createdAt:time(1),updatedAt:time(1),observedAt:time(at),url:`https://github.com/${repository}/pull/9#pullrequestreview-201`});
function setup(t,run=async()=>({version:2,state:'ready',summary:'Complete'}),assessor) {
  const root=mkdtempSync(join(tmpdir(),'js-superagent-w7-'));
  const harnessRegistry=createHarnessRegistry({adapters:[{id:'w7-fixture',version:'1',roles:['worker',...(assessor?['coordinator']:[])],validate:o=>o,createDriver:()=>({reportVersion:2,run}),...(assessor?{createAssessor:()=>assessor}:{})}]});
  const runtime=createProjectAgent({projectRoot:root,github,harnessRegistry,execution:{driver:'w7-fixture'},githubChannel:{poll:async()=>[],deliver:async()=>({id:'receipt'}),getPullRequest:async()=>({repository,number:9,id:'900',headSha:head,headRef:'test',headRepository:repository,state:'open',merged:false,title:'Change'})}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});return runtime;
}
test('W7 comment versions retain canonical native links and reject forged revisions',()=>{
  const original=normalizeGitHubEvent(comment()), edited=normalizeGitHubEvent(comment('Corrected requirement',2));
  assert.notEqual(original.id,edited.id);assert.equal(original.commentVersion.baseId,edited.commentVersion.baseId);
  assert.equal(edited.url,`https://github.com/${repository}/issues/7#issuecomment-101`);
  assert.equal(normalizeGitHubEvent(edited).id,edited.id);
  assert.throws(()=>normalizeGitHubEvent({...edited,text:'Forged different content'}),/revision mismatch/);
});
test('W7 edited pending input stays on the original ticket, retires only its undelivered predecessor, and ignores duplicates/older versions',async t=>{
  const seen=[],runtime=setup(t,async input=>{seen.push(input.ticket);return{version:2,state:'ready',summary:'Complete'};});
  const ticket=runtime.receiveGitHubEvent(issue).ticketId;
  assert.equal(runtime.receiveGitHubEvent(comment()).status,'received');
  assert.equal(runtime.receiveGitHubEvent(comment('Corrected requirement',2)).ticketId,ticket);
  const domain=runtime.getDomainTicket(ticket),old=normalizeGitHubEvent(comment()).id;
  assert.equal(domain.undelivered.some(id=>domain.inputs.find(x=>x.id===id)?.triggerId===old),false);
  assert.equal(domain.inputs.find(x=>x.triggerId===old).readAt ?? null,null);
  assert.equal(runtime.get(ticket).messages.find(x=>x.triggerId===old).superseded.replacementId,normalizeGitHubEvent(comment('Corrected requirement',2)).id);
  assert.equal(runtime.receiveGitHubEvent(comment('Corrected requirement',2)).status,'duplicate');
  assert.equal(runtime.receiveGitHubEvent(comment('Late stale text',1)).reason,'stale-comment-version');
  assert.equal(runtime.receiveGitHubEvent(comment('Corrected requirement',3)).reason,'duplicate-comment-content');
  await runtime.runNext();assert.equal(runtime.list().length,1);assert.equal(seen.length,1);
  assert.ok(seen[0].messages.some(x=>x.text.includes('Treat this as a correction')));
  await runtime.runNext();assert.equal(runtime.list().length,1);
});
test('W7 legacy ID-only comment gets one migration baseline, later editing continues original accepted request',t=>{
  const runtime=setup(t),legacy={...comment('/js-superagent make this bounded change'),updatedAt:undefined,observedAt:undefined};
  const ticket=runtime.receiveGitHubEvent(legacy).ticketId;
  assert.equal(runtime.receiveGitHubEvent(comment('/js-superagent make this bounded change',2)).reason,'legacy-comment-baseline');
  assert.equal(runtime.receiveGitHubEvent(comment('/js-superagent corrected bounded change',3)).ticketId,ticket);
  assert.equal(runtime.list().length,1);
  assert.ok(runtime.get(ticket).messages.some(x=>x.text.includes(`supersedes ${legacy.id}.`)));
});
test('W7 editing a queued initial request withdraws the old candidate and accepts only its current revision',async t=>{
  const assessed=[],runtime=setup(t,undefined,{assess:async({candidate})=>{assessed.push(candidate);return{kind:'accept',title:'Current request',scope:'Change greeting',reason:'Explicit request',rules:[]};}});
  runtime.configureCoordinator({assessor:{driver:'w7-fixture'}},{expectedRevision:0});
  runtime.receiveGitHubEvent(comment('/js-superagent old requirement',1));
  runtime.receiveGitHubEvent(comment('/js-superagent current requirement',2));
  await runtime.runNext();
  assert.equal(assessed.length,1);assert.equal(assessed[0].triggers.length,1);
  assert.equal(assessed[0].triggers[0].id,normalizeGitHubEvent(comment('/js-superagent current requirement',2)).id);
  assert.equal(runtime.list().length,1);
});
test('W7 empty-body decisions and dismissed review revisions are retained, without reviving cancelled work',async t=>{
  const runtime=setup(t),ticket=runtime.receiveGitHubEvent(issue).ticketId;await runtime.runNext();
  await runtime.linkGitHubPullRequest(ticket,{number:9});
  for(const [state,at] of [['APPROVED',2],['CHANGES_REQUESTED',3],['DISMISSED',4]]){
    const normalized=normalizePullEvent(review(state,at));assert.equal(pullEventActionable(normalized),true);
    assert.match(pullEventText(normalized),new RegExp(`Review decision: ${state}`));
    assert.equal(runtime.receiveGitHubEvent(review(state,at)).status,'received');
  }
  assert.deepEqual(runtime.githubStatus().trackedPullRequests[0].reviews.map(x=>x.state),['APPROVED','CHANGES_REQUESTED','DISMISSED']);
  assert.equal(pullEventActionable(normalizePullEvent(review('COMMENTED',5))),false);
  runtime.cancel(ticket);
  assert.equal(runtime.receiveGitHubEvent({...review('APPROVED',6),id:`github:${repository}:review:202`}).reason,'cancelled');
  assert.equal(runtime.get(ticket).status,'cancelled');
});
test('W7 review versions cannot bypass current-head or actor checks and empty edits correct queued requirements',async t=>{
  const runtime=setup(t),ticket=runtime.receiveGitHubEvent(issue).ticketId;await runtime.runNext();await runtime.linkGitHubPullRequest(ticket,{number:9});
  const old={...review(),commitId:'b'.repeat(40)};
  assert.equal(runtime.receiveGitHubEvent(old).reason,'pull-request-version-unavailable');
  const unauthorized={...review(),id:`github:${repository}:review:202`,actor:{...actor,login:'other',id:'11'}};
  assert.equal(runtime.receiveGitHubEvent(unauthorized).reason,'actor-not-authorized');
  assert.equal(runtime.githubStatus().trackedPullRequests[0].reviews,undefined);
  runtime.receiveGitHubEvent(comment('Requirement to withdraw',2));
  assert.equal(runtime.receiveGitHubEvent(comment('',3)).ticketId,ticket);
  assert.ok(runtime.get(ticket).messages.find(x=>x.triggerId===normalizeGitHubEvent(comment('Requirement to withdraw',2)).id).superseded);
});
test('W7 repository-source and linked-channel comments share version identity and preserve later edits',t=>{
  const runtime=setup(t),adapter=createGitHubRepositorySource(github,{streams:{pulls:false,comments:true},observe:true,request:async()=>{throw new Error('No network');}});
  runtime.registerSource(adapter);
  const raw={id:comment().id,kind:'comment',repository,number:7,at:time(1),updatedAt:time(1),observedAt:time(1),text:comment().text,actor,title:'Change'};
  const normalized=adapter.normalize(raw);
  assert.equal(normalized.id,normalizeGitHubEvent(comment()).id);
  runtime.receiveSourceEvent(adapter.id,raw);
  assert.equal(runtime.receiveGitHubEvent(comment()).status,'duplicate');
  const edited={...raw,text:'/js-superagent edited request',updatedAt:time(2),observedAt:time(2),at:time(2)};
  assert.equal(runtime.receiveSourceEvent(adapter.id,edited).status,'received');
  assert.ok(runtime.readContextRecord('triggers',adapter.normalize(edited).id));
});
test('W7 polling transports native update timestamps for Issue comments',async()=>{
  const user={login:'alice',id:10,type:'User'},nativeComment={id:101,body:'changed',user,created_at:time(0),updated_at:time(2),html_url:`https://github.com/${repository}/issues/7#issuecomment-101`};
  const channel=createGitHubChannel(github,{request:async endpoint=>{
    if(endpoint==='/user')return user;
    if(endpoint===`/repos/${repository}`)return{full_name:repository};
    if(endpoint.includes('/issues/7/comments'))return[nativeComment];
    if(endpoint===`/repos/${repository}/issues/7`)return{id:700,number:7,state:'open',title:'Change',body:'',user,created_at:time(0),html_url:`https://github.com/${repository}/issues/7`};
    throw new Error(`Unexpected ${endpoint}`);
  }});
  const {events}=await channel.poll({issues:[7],pullRequests:[]});
  assert.equal(events.find(x=>x.kind==='comment').updatedAt,time(2));
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {createGitHubChannel} from '../src/channels/github.mjs';
import {Store} from '../src/store.mjs';

const repository='fixture/answers',user={id:20,login:'helper',type:'User'};
const answer=candidate=>({kind:'answer',triggerId:candidate.triggers[0].id,answer:'There are no active tasks for this question.',reason:'Answer the original question from the supplied records',rules:[]});
function fixture(t,{assess,loseResponse=false,beforeSend,pull=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'coordinator-answer-runtime-')),comments=[],runtimes=[];
  let posts=0,runs=0,assessments=0,sequence=100,runtime;
  const native=createGitHubChannel({repository,allowedActors:['alice'],issues:[7]},{request:async(path,options)=>{
    if(path===`/repos/${repository}`)return {id:55,full_name:repository,has_issues:true,permissions:{push:true}};
    if(path==='/user')return user;
    if(path.startsWith(`/repos/${repository}/issues/7/comments?`))return comments;
    if(options.method==='POST') {posts++;const comment={id:posts+1000,body:options.body.body,user,html_url:`https://github.com/${repository}/${pull?'pull':'issues'}/7#issuecomment-${posts+1000}`};comments.push(comment);if(loseResponse)throw Error('Lost response after remote acceptance');return comment;}
    throw Error(`Unexpected fixture request ${path}`);
  }});
  const channel={...native,async poll({contextPullRequests=[]}={}){return {version:1,repository,repositoryVerified:true,events:[],objects:[{kind:'issue',number:7,status:'ok'},...contextPullRequests.map(number=>({kind:'pull',number,status:'ok'}))],errors:[],discovery:{complete:true}};},async deliver(message,context){
    return native.deliver(message,{...context,authorizeSend:async destination=>{await beforeSend?.(runtime,message);return context.authorizeSend(destination);}});
  }};
  const open=()=>{runtime=createProjectAgent({projectRoot:root,github:{repository,allowedActors:['alice'],issues:[7],pollIntervalMs:86400000},githubChannel:channel,
    driver:{async run(){runs++;throw Error('No worker expected');}},
    assessor:{async assess(input){assessments++;return assess?assess(input,runtime):answer(input.candidate);}}}).init();runtimes.push(runtime);return runtime;};
  open();runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:0});
  const event=(extra={})=>{const id=++sequence;return {kind:'comment',id:`github:${repository}:comment:${id}`,repository,issueNumber:7,issueId:7,issueState:'open',actor:{login:'alice',id:10,type:'User'},text:'/js-superagent What is the current task status?',createdAt:new Date().toISOString(),...extra};};
  const state=fn=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}};
  const due=()=>state(store=>store.db.prepare("UPDATE effects SET due=0 WHERE kind IN ('reply','coordinator-answer')").run());
  t.after(async()=>{for(const item of runtimes.reverse()){try{await item.stop();item.close();}catch{}}rmSync(root,{recursive:true,force:true});});
  return {get runtime(){return runtime;},open,event,state,due,comments,get posts(){return posts;},get runs(){return runs;},get assessments(){return assessments;}};
}
test('an explicit Issue question is answered through the existing channel without a ticket, and reevaluation cannot answer twice',async t=>{
  const f=fixture(t),event=f.event();f.runtime.receiveGitHubEvent(event);await f.runtime.runNext();
  assert.equal(f.runtime.list().length,0);assert.equal(f.runs,0);assert.equal(f.posts,1);
  assert.equal(f.runtime.notifications()[0].status,'sent');assert.equal(f.runtime.notifications()[0].ticketId,undefined);
  assert.equal(f.runtime.eventDiagnostic(event.id).evaluation.decisions[0].kind,'answer');
  assert.ok(f.runtime.readContext('decisions').items[0].value.audit.coordinatorAnswer.replyId);
  assert.equal(f.runtime.receiveGitHubEvent(event).status,'duplicate');f.runtime.reevaluate(event.id);await f.runtime.runNext();
  assert.equal(f.posts,1);assert.equal(f.runtime.notifications().length,1);
});
test('a queued answer survives reopening and reconciles an unknown write without sending twice, even after revocation',async t=>{
  const f=fixture(t,{loseResponse:true});f.runtime.receiveGitHubEvent(f.event());await f.runtime.runNext();
  assert.equal(f.posts,1);assert.equal(f.runtime.notifications()[0].status,'pending');assert.equal(f.runtime.replyDiagnostics().items[0].status,'failed');await f.runtime.stop();f.runtime.close();f.open();
  f.runtime.configureCoordinator({policy:{mode:'off',sourceRows:[{id:'github',source:'github',scope:{repository},actors:[],bots:['alice']}]}},{expectedRevision:1});
  f.due();await f.runtime.flushNotifications();assert.equal(f.posts,1);assert.equal(f.runtime.notifications()[0].status,'sent');assert.equal(f.runs,0);
});
test('authority revoked at the write boundary withdraws a generated answer',async t=>{
  const f=fixture(t,{beforeSend(runtime){runtime.configureCoordinator({policy:{mode:'off',sourceRows:[{id:'github',source:'github',scope:{repository},actors:[],bots:['alice']}]}},{expectedRevision:1});}});
  f.runtime.receiveGitHubEvent(f.event());await f.runtime.runNext();
  assert.equal(f.posts,0);assert.equal(f.runtime.notifications()[0].status,'dropped');assert.equal(f.runtime.list().length,0);
});
test('a newer observed comment revision invalidates the answer at the write boundary',async t=>{
  let f;f=fixture(t,{beforeSend(_runtime,message){f.state(store=>{const record=store.getMeta(`coordinator-answer-reply:${message.id}`),version=record.trigger.meta.githubComment;store.setMeta(`github:comment-version:${version.baseId}`,{...version,eventId:'newer-revision'});});}});
  f.runtime.receiveGitHubEvent(f.event({updatedAt:new Date().toISOString()}));await f.runtime.runNext();
  assert.equal(f.posts,0);assert.equal(f.runtime.notifications()[0].terminal.reason,'source-revision-retired');
});
test('pause before assessment stores the question and only answers after resume',async t=>{
  const f=fixture(t);f.runtime.pause();f.runtime.receiveGitHubEvent(f.event());await f.runtime.runNext();assert.equal(f.assessments,0);assert.equal(f.posts,0);
  f.runtime.resume();await f.runtime.runNext();assert.equal(f.posts,1);assert.equal(f.runs,0);
});
test('unauthorized people and bots cannot cause a direct answer',async t=>{
  const f=fixture(t);for(const actor of [{login:'stranger',id:30,type:'User'},{login:'alice',id:10,type:'Bot'}])f.runtime.receiveGitHubEvent(f.event({actor}));
  await f.runtime.runNext();assert.equal(f.assessments,0);assert.equal(f.posts,0);assert.equal(f.runs,0);
});

test('an unowned PR discussion receives a coordinator answer without acquiring a PR binding',async t=>{
  const f=fixture(t,{pull:true}),head='a'.repeat(40),id=`github:${repository}:pr_comment:901`;
  f.runtime.receive({id,source:'github',actor:{source:'github',id:'alice'},human:true,addressed:'direct',at:new Date().toISOString(),text:'What does this check mean?',
    threads:[{source:'github',id:`${repository}#pr:7`}],channel:{source:'github',thread:`${repository}#pr:7`,address:{repository,pullNumber:'7',headSha:head}},
    meta:{repository,actor:'alice',actorId:'10',actorType:'User',pullRequest:{repository,headRepository:repository,number:7,headSha:head},issueNumber:7}});
  await f.runtime.runNext();await f.runtime.syncGitHub({flush:false});f.due();await f.runtime.flushNotifications();assert.equal(f.posts,1,JSON.stringify({assessments:f.state(store=>store.listMeta('assessment:')),notifications:f.runtime.notifications(),effects:f.runtime.status().effects}));assert.equal(f.runtime.list().length,0);assert.equal(f.runs,0);
  assert.equal(f.state(store=>store.listMeta('github:pull:').length),0);assert.equal(f.runtime.notifications()[0].status,'sent');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { githubMention, isBareGitHubMention, verifiedGitHubMentionIdentity, versionGitHubMentionBody, observeGitHubMentionBody } from '../src/github-mention.mjs';
import { githubRequest } from '../src/github-intake.mjs';
import { createGitHubRepositorySource } from '../src/channels/github-repository.mjs';
import { normalizeRepositorySourceSettings } from '../src/runtime/repository-source.mjs';
import { webhookRoute } from '../src/github-webhook-inbox.mjs';
import { createRuntimePolicy } from '../src/policy.mjs';

const repository='fixture/mentions',prefix=`/repos/${repository}`,head='a'.repeat(40),bot={id:22,login:'helper[bot]',type:'Bot'},user={id:1,login:'alice',type:'User'};
const start=Date.parse('2026-11-02T00:00:00Z'),at=n=>new Date(start+n).toISOString();
const streams={pulls:false,issues:false,comments:false,reviewComments:false,defaultBranchCI:false,mentions:true};
const config={repository,allowedActors:['alice']};
function fixture(){
  let time=start;const calls=[],pull={id:70,number:7,state:'open',merged:false,title:'PR',body:'Please @helper[bot] fix this PR',user,created_at:at(1000),updated_at:at(1000),
    html_url:`https://github.com/${repository}/pull/7`,head:{sha:head,ref:'feature',repo:{full_name:repository}},base:{sha:'b'.repeat(40),ref:'main',repo:{full_name:repository}}};
  const issue={id:10,number:1,state:'open',title:'Issue',body:'Please @helper[bot] fix this issue',user,created_at:at(1000),updated_at:at(1000)};
  const comments=[1,7].map((number,index)=>({id:100+index,body:'Please @helper[bot] address this comment',user,created_at:at(1100),updated_at:at(1100),issue_url:`https://api.github.com${prefix}/issues/${number}`}));
  const inline={id:200,body:'@helper[bot] repair this line',user,created_at:at(1200),updated_at:at(1200),html_url:`https://github.com/${repository}/pull/7#discussion_r200`,pull_request_url:`https://api.github.com${prefix}/pulls/7`,path:'src/a.js',line:1,side:'RIGHT',commit_id:head};
  const review={id:300,body:'Please @helper[bot] fix this review finding',state:'CHANGES_REQUESTED',user,submitted_at:at(1300),commit_id:head};
  const request=async endpoint=>{
    const path=endpoint.split('?')[0];calls.push(path);
    if(path==='/user')return bot;
    if(path===prefix)return {full_name:repository,default_branch:'main'};
    if(path===`${prefix}/pulls`)return [pull];
    if(path===`${prefix}/issues`)return [issue,{...pull,pull_request:{}}];
    if(path===`${prefix}/pulls/7`)return pull;
    if(path===`${prefix}/issues/1`)return issue;
    if(path===`${prefix}/issues/7`)return {...pull,pull_request:{}};
    if(path===`${prefix}/issues/comments`)return comments;
    if(path===`${prefix}/pulls/comments`)return [inline];
    if(path===`${prefix}/pulls/comments/200`)return inline;
    if(path===`${prefix}/pulls/7/reviews`)return [review];
    if(path===`${prefix}/pulls/7/reviews/300`)return review;
    if(path.startsWith(`${prefix}/issues/comments/`))return comments.find(item=>item.id===Number(path.split('/').at(-1)));
    throw new Error(`Unexpected read ${path}`);
  };
  return {request,calls,pull,issue,comments,inline,review,now:()=>time,tick:n=>{time=start+n;}};
}

test('mention parser accepts actual deployed identity only, preserves the complete request and excludes quotation/code/URL lookalikes',async()=>{
  const identity=await verifiedGitHubMentionIdentity(async()=>bot);
  for(const text of ['@helper[bot] fix it','Please @HELPER[bot], fix it','Fix it\n@helper[bot]'])assert.equal(githubMention(text,identity),true,text);
  for(const text of ['@helper fix it','@helper[bot]-other fix','me@helper[bot]','`@helper[bot]`','```js\n@helper[bot]\n```','> @helper[bot] fix it','    @helper[bot]','https://example.test/@helper[bot]','\\@helper[bot]','<!-- @helper[bot] -->'])assert.equal(githubMention(text,identity),false,text);
  const body='Please @helper[bot] inspect this\nkeep all evidence';assert.equal(githubRequest(body,'/js-superagent',{mentionIdentity:identity}),body);
  assert.equal(isBareGitHubMention('@helper[bot] !\n> quoted instruction\n`quoted code`',identity),true);
  assert.equal(isBareGitHubMention(body,identity),false);
  assert.equal(githubRequest('/js-superagent repair'),'repair');
  await assert.rejects(verifiedGitHubMentionIdentity(async()=>bot,{app:true}),/unavailable/);
  const app=async()=>{throw new Error('No /user for installation token');};app.identity=async()=>bot;
  assert.equal((await verifiedGitHubMentionIdentity(app,{app:true})).login,bot.login);
});

test('mention-only discovery finds unbound bodies, comments and reviews, uses fresh baselines and canonical selector reads',async()=>{
  const f=fixture(),source=createGitHubRepositorySource(config,{request:f.request,streams,now:f.now,mentionEpoch:1});
  const baseline=await source.poll();assert.equal(baseline.events.length,0);assert.equal(Object.keys(baseline.cursor.streams).length,4);
  f.tick(5000);const result=await source.poll({cursor:baseline.cursor});assert.deepEqual(result.errors,[]);assert.equal(result.events.length,6);
  for(const event of result.events){const trigger=source.normalize(event);assert.equal(trigger.addressed,'direct');assert.equal(trigger.text,event.text);assert.equal(trigger.meta.mentionIdentity.id,String(bot.id));}
  const selectors=[{kind:'issue',number:1},{kind:'pull',number:7},{kind:'issue',number:1,commentId:100},{kind:'pull',number:7,commentId:101},{kind:'pull',number:7,reviewCommentId:200},{kind:'pull',number:7,reviewId:300}];
  for(const selector of selectors){const [event]=await source.readContext({mentionSelector:{...selector,mention:true}});assert.ok(result.events.some(item=>source.normalize(item).id===source.normalize(event).id));}
  const disabled=createGitHubRepositorySource(config,{request:f.request,streams:{...streams,mentions:false},now:f.now});await assert.rejects(disabled.readContext({mentionSelector:{kind:'pull',number:7,mention:true}}),/scope/);
  const reenabled=createGitHubRepositorySource(config,{request:f.request,streams,now:f.now,mentionEpoch:2});const renewed=await reenabled.poll({cursor:result.cursor});assert.equal(renewed.events.length,0);
  f.tick(6000);assert.equal((await reenabled.poll({cursor:renewed.cursor})).events.length,0,'the overlap does not replay bodies from before enabling');
});

test('signed unbound hints carry only selectors; quoted or unauthorized messages still do not become permitted work',async()=>{
  const settings=normalizeRepositorySourceSettings({enabled:true,streams});
  for(const [event,payload,expected] of [
    ['issues',{action:'edited',issue:{number:1}},{kind:'issue',number:1,mention:true}],
    ['pull_request',{action:'opened',pull_request:{number:7}},{kind:'pull',number:7,mention:true}],
    ['issue_comment',{action:'created',issue:{number:7,pull_request:{}},comment:{id:101}},{kind:'pull',number:7,commentId:101,mention:true}],
    ['pull_request_review_comment',{action:'created',pull_request:{number:7},comment:{id:200}},{kind:'pull',number:7,reviewCommentId:200,mention:true}],
  ])assert.deepEqual(webhookRoute({event,payload:{...payload,repository:{full_name:repository}}},config,[],settings).selector,expected);
  const f=fixture(),source=createGitHubRepositorySource(config,{request:f.request,streams,now:f.now});
  f.comments[1].body='> @helper[bot] quoted request';assert.deepEqual(await source.readContext({mentionSelector:{kind:'pull',number:7,commentId:101,mention:true}}),[]);
  f.comments[1].body='@helper[bot] real request';f.comments[1].user={id:9,login:'stranger',type:'User'};
  const [event]=await source.readContext({mentionSelector:{kind:'pull',number:7,commentId:101,mention:true}}),trigger=source.normalize(event);
  assert.equal(createRuntimePolicy().gate(trigger).admissible,false,'addressing does not grant author authority');
  f.comments[1].issue_url=`https://api.github.com${prefix}/issues/8`;
  await assert.rejects(source.readContext({mentionSelector:{kind:'pull',number:7,commentId:101,mention:true}}),/parent mismatch/);
});

test('body edits have a shared stable revision, unchanged content deduplicates and legacy observations baseline without replay',()=>{
  const metadata=new Map(),store={getMeta:key=>metadata.get(key),setMeta:(key,value)=>metadata.set(key,value),triggers:{get:()=>null}};
  const original={id:`github:${repository}:issue:10`,kind:'issue',repository,issueNumber:1,createdAt:at(0),updatedAt:at(1000),text:'@helper[bot] fix first',actor:user};
  const first=versionGitHubMentionBody(original,bot),same=versionGitHubMentionBody({...original,updatedAt:at(2000)},bot);
  metadata.set(`github:event:${original.id}`,{status:'ignored'});
  assert.equal(observeGitHubMentionBody(store,first).skip,'legacy-body-baseline');
  assert.equal(observeGitHubMentionBody(store,same).skip,'duplicate-body-content');
  const corrected=versionGitHubMentionBody({...original,updatedAt:at(3000),text:'@helper[bot] corrected request'},bot);
  assert.equal(observeGitHubMentionBody(store,corrected).supersedes,original.id);
  assert.equal(observeGitHubMentionBody(store,first).skip,'stale-body-version');
  assert.equal(versionGitHubMentionBody(first,bot).id,first.id);
});

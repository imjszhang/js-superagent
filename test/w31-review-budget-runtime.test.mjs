import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectAgent,createHarnessRegistry} from './helpers/runtime-fixture.mjs';

test('W31 durable bot rounds gate requeue and mixed human/CI work after reopen',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'js-w31-'))),repository='fixture/project',head='a'.repeat(40);
 const pull={repository,number:9,id:900,headSha:head,headRef:'feature',headRepository:repository,state:'open',merged:false,title:'Work',url:`https://github.com/${repository}/pull/9`};
 let runs=0;const snapshots=[];
 const registry=createHarnessRegistry({adapters:[{id:'w31-fixture',version:'1',roles:['worker','coordinator'],validate:v=>v,createAssessor:()=>({async assess(){return {kind:'ignore',reason:'Unrelated',rules:[]};}}),
   createDriver:()=>({reportVersion:2,async run(input){runs++;snapshots.push(input.ticket);return {version:2,state:runs===1?'blocked':'ready',summary:'Scoped work',artifacts:[],attention:runs===1?{question:'Confirm the scope?'}:null};}})}]});
 const options={projectRoot:root,harnessRegistry:registry,execution:{driver:'w31-fixture'},workspace:{mode:'copy'},githubChannel:{async poll(){return [];},async getPullRequest(){return pull;},async deliver(){return {id:'1',url:`https://github.com/${repository}/issues/7#issuecomment-1`};}}};
 let runtime=createProjectAgent(options).init();
 t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 runtime.configure({github:{repository,allowedActors:['alice'],issues:[7],ci:{checkApps:['actions']}}});
 const event=(kind,id,actor='robot',extra={})=>({id:`github:${repository}:${kind}:${id}`,kind,repository,text:`Finding ${id}`,actor:{login:actor,id:actor==='robot'?'20':'10',type:'User'},createdAt:new Date().toISOString(),url:pull.url,
  ...(kind==='issue'?{issueNumber:7,issueId:700,issueState:'open',title:'Work'}:{pullNumber:9,pullState:'open',headSha:head}),
  ...(kind==='review_comment'?{reviewCommentId:id,reviewRootId:id,path:'file.txt',line:1,side:'RIGHT',commitId:head}:{}),...extra});
 const ticket=runtime.receiveGitHubEvent(event('issue',700,'alice',{text:'/js-superagent Implement and address feedback'})).ticketId;
 await runtime.linkGitHubPullRequest(ticket,{number:9});await runtime.runNext();
 runtime.configureCoordinator({assessor:{driver:'w31-fixture'},policy:{mode:'observe',rules:[{id:'review',enabled:true,instruction:'Address findings within the mandate'}],sourceRows:[{id:'repo',source:'github',scope:{repository},actors:['alice'],bots:['robot'],admission:{}}]}},{expectedRevision:runtime.coordinatorStatus().settings.revision});
 for(let i=0;i<4;i++)assert.equal(runtime.receiveGitHubEvent(event('review_comment',300+i,'robot',{reviewId:20+i})).feedback.status,'recorded');
 assert.equal(runtime.botReviewStatus().length,0,'observations while waiting do not spend rounds');
 runtime.reply(ticket,'Scope confirmed, continue the original work');await runtime.runNext();
 assert.ok(!snapshots.at(-1).messages.some(row=>/Finding 30[0-3]/.test(row.text)),'unreserved observations cannot ride the human reply');
 for(let round=1;round<=3;round++){
  const finding=event('review_comment',100+round,'robot',{reviewId:round});
  assert.equal(runtime.receiveGitHubEvent(finding).status,'received');
  assert.equal(runtime.receiveGitHubEvent(finding).status,'duplicate');
  if(round===1)assert.equal(runtime.receiveGitHubEvent(event('review_comment',111,'robot',{reviewId:1})).status,'received');
  await runtime.runNext();
 }
 assert.equal(runs,5);assert.equal(runtime.botReviewStatus()[0].rounds.length,3);
 await runtime.stop();runtime.close();runtime=createProjectAgent(options).init();
 const fourth=event('review_comment',104,'robot',{reviewId:4});
 assert.equal(runtime.receiveGitHubEvent(fourth).reason,'bot-review-round-limit');
 assert.equal(runtime.reevaluate(fourth.id),false);
 assert.equal(runtime.receiveGitHubEvent(event('pr_comment',200)).reason,'bot-review-run-unknown');
 assert.equal(runtime.receiveGitHubEvent(event('pr_comment',201,'alice',{text:'Please also check the authorized edge case'})).status,'received');
 assert.equal(runtime.receiveGitHubEvent(event('check_run',202,'robot',{ci:{name:'tests',app:'actions',status:'completed',conclusion:'failure',headSha:head}})).status,'received');
 await runtime.runNext();assert.equal(runs,6);assert.equal(runtime.botReviewStatus()[0].rounds.length,3);
 assert.ok(!snapshots.at(-1).messages.some(row=>row.text.includes('Finding 104')),'fourth round cannot ride a human or CI run');
 const ledger=runtime.botReviewStatus()[0];runtime.setBotReviewBudget(9,'20',{remaining:1,reason:'Operator approves one further round',expectedRevision:ledger.revision});
 assert.equal(runtime.reevaluate(fourth.id),true);
});

test('W31 a merged unbound candidate with four bot runs rolls back its whole scope and reservations',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'js-w31-merged-'))),repository='fixture/project',head='a'.repeat(40);
 const pull={repository,number:9,id:'900',headSha:head,headRef:'feature',headRepository:repository,state:'open',merged:false,title:'Unbound review',url:`https://github.com/${repository}/pull/9`};
 let runs=0,merged=0;
 const registry=createHarnessRegistry({adapters:[{id:'merged-fixture',version:'1',roles:['worker','coordinator'],validate:value=>value,
  createAssessor:()=>({async assess({candidate}){merged=candidate.triggers.length;return {kind:'accept',title:'Combined fixes',scope:candidate.triggers.map(trigger=>trigger.text).join('\n'),reason:'Configured bot review rule',rules:['review']};}}),
  createDriver:()=>({reportVersion:2,async run(){runs++;return {version:2,state:'ready',summary:'Should never run',artifacts:[],attention:null};}})}]});
 const runtime=createProjectAgent({projectRoot:root,harnessRegistry:registry,execution:{driver:'merged-fixture'},workspace:{mode:'copy'},
  github:{repository,allowedActors:['alice']},githubChannel:{async poll(){return [];},async deliver(){throw new Error('No delivery expected');}}}).init();
 t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 runtime.configureCoordinator({assessor:{driver:'merged-fixture'},policy:{mode:'auto',rules:[{id:'review',enabled:true,instruction:'Address configured review findings'}],
  sourceRows:[{id:'repo',source:'github',scope:{repository},actors:['alice'],bots:['robot'],admission:{}}]}},{expectedRevision:0});
 for(let reviewId=1;reviewId<=4;reviewId++){
  const event={repository,pullNumber:9,pullRequest:pull,pullState:'open',headSha:head,kind:'review_comment',id:`github:${repository}:review_comment:${100+reviewId}`,
   reviewId,reviewCommentId:100+reviewId,reviewRootId:100+reviewId,path:'file.txt',line:1,side:'RIGHT',commitId:head,actor:{id:'20',login:'robot',type:'Bot'},
   createdAt:new Date().toISOString(),text:`Repair findings from bot run ${reviewId}`,url:pull.url};
  assert.equal(runtime.receive({id:event.id,source:'github',actor:{source:'github',id:'robot'},human:false,at:event.createdAt,text:event.text,
   threads:[{source:'github',id:`${repository}#pr:9`}],channel:{source:'github',thread:`${repository}#pr:9`,address:{repository,pullNumber:'9',headSha:head}},
   meta:{repository,issueNumber:9,actor:'robot',actorId:'20',actorType:'Bot',pullRequest:pull,pullEvent:event}}),'stored');
 }
 assert.equal(await runtime.runNext(),null);assert.equal(merged,4);
 assert.equal(runs,0);assert.deepEqual(runtime.list(),[]);
 assert.deepEqual(runtime.botReviewStatus(),[],'the rejected combined scope must not consume its first three reservations');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubReviewTransport, REVIEW_QUERIES } from '../src/channels/github-review.mjs';

const repository='fixture/project';
test('W30 worker review intent waits for verified real local Git delivery, then requests review and marks the original PR ready', async t => {
  const root=mkdtempSync(join(tmpdir(),'js-w30-runtime-')), bare=join(root,'remote.git'), bin=join(root,'bin');
  const realGit=spawnSync('which',['git'],{encoding:'utf8'}).stdout.trim();
  const git=(cwd,...args)=>{const p=spawnSync(realGit,['-C',cwd,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
  git(root,'init','-b','main'); git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'value.txt'),'before');git(root,'add','value.txt');git(root,'commit','-m','baseline');
  mkdirSync(bare);git(bare,'init','--bare');mkdirSync(bin);
  const gitWrapper=join(bin,'git'),gh=join(bin,'fixture-gh');
  writeFileSync(gitWrapper,`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2).map(arg=>arg==='https://github.com/fixture/project.git'?${JSON.stringify(bare)}:arg);\nif(args.some(arg=>arg.startsWith('https://')))throw new Error('Unexpected network git target');\nconst result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`);
  writeFileSync(gh,`#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='auth token --hostname github.com')throw new Error('Unexpected gh request');process.stdout.write('fixture-only-token');\n`);
  chmodSync(gitWrapper,0o700);chmodSync(gh,0o700);
  let failBob=false,loseReviewResponse=true,pull, runs=0, reviewPosts=0, readyPosts=0, recipients={users:[],teams:[]};
  const head=branch=>{const p=spawnSync(realGit,['--git-dir',bare,'rev-parse','--verify',`refs/heads/${branch}`],{encoding:'utf8'});return p.status===0?p.stdout.trim():null;};
  async function request(endpoint,{method='GET',body}={}) {
    if(endpoint==='/users/bob'){if(failBob)throw Object.assign(new Error('Identity API unavailable'),{status:503});return {id:43,login:'bob',type:'User'};}
    if(endpoint==='/users/alice')return {id:42,login:'alice',type:'User'};
    if(endpoint.includes('/git/ref/heads/')) { const sha=head(decodeURIComponent(endpoint.split('/git/ref/heads/')[1])); if(!sha)throw Object.assign(new Error('not found'),{status:404});return {object:{sha}}; }
    if(method==='POST'&&endpoint==='/repos/fixture/project/pulls') {pull={number:7,node_id:'PR_7',state:'open',draft:true,title:body.title,body:body.body,html_url:'https://github.com/fixture/project/pull/7',user:{login:'agent'},head:{sha:head(body.head),ref:body.head,repo:{full_name:repository}},base:{ref:body.base,repo:{full_name:repository}}};return structuredClone(pull);}
    if(endpoint.includes('/requested_reviewers')) {if(method==='POST'){reviewPosts++;recipients={users:body.reviewers.map(login=>({login})),teams:[]};if(loseReviewResponse){loseReviewResponse=false;throw new Error('Response lost after mutation');}}return structuredClone(recipients);}
    if(endpoint.includes('/reviews?'))return [];
    if(endpoint==='/graphql'&&body.query===REVIEW_QUERIES.ready){readyPosts++;pull.draft=false;return {data:{markPullRequestReadyForReview:{pullRequest:{id:'PR_7',isDraft:false}}}};}
    if(endpoint==='/repos/fixture/project/pulls/7'){pull.head.sha=head(pull.head.ref);if(method==='PATCH')Object.assign(pull,body);return structuredClone(pull);}
    if(endpoint.startsWith('/repos/fixture/project/pulls?')){if(pull)pull.head.sha=head(pull.head.ref);return pull?[structuredClone(pull)]:[];}
    throw new Error(`Unexpected mock API request ${method} ${endpoint}`);
  }
  const originalFetch=globalThis.fetch,originalPath=process.env.PATH;
  process.env.PATH=`${bin}:${originalPath}`;
  globalThis.fetch=async(url,init={})=>{const parsed=new URL(url);assert.equal(parsed.origin,'https://api.github.com');try{return new Response(JSON.stringify(await request(parsed.pathname+parsed.search,{method:init.method,body:init.body?JSON.parse(init.body):undefined})),{status:200});}catch(error){if(error.status)return new Response('{}',{status:error.status});throw error;}};
  const runtimeOptions={projectRoot:root,githubChannel:{async poll(){return [];},async deliver(){return {id:'receipt',url:'https://github.com/fixture/project/issues/1#issuecomment-1'};},
    async getPullRequest(){pull.head.sha=head(pull.head.ref);return {repository,number:7,id:7,headSha:pull.head.sha,headRef:pull.head.ref,headRepository:repository,state:'open',merged:false,title:pull.title,url:pull.html_url};},...createGitHubReviewTransport({repository,request})},
    driver:{capabilities:{reportVersion:2,boundedContextVersion:1,agentTools:true},async run(input){runs++;input.checkpoint({driver:'fixture',id:'worker'});for(const [j,item] of input.agentTools.contextResources().filter(row=>['inputs','triggers'].includes(row.resource)).entries())input.agentTools.call({sessionId:'worker',turnId:`turn-${runs}`,callId:`read-${j}`,name:'js_superagent_read',arguments:{resource:item.resource,id:item.id}});writeFileSync(join(input.projectRoot,'value.txt'),`after ${runs}`);
      if(runs===1)for(const [i,action] of [{kind:'requestReviewers',reviewers:['alice']}].entries()) input.agentTools.call({sessionId:'worker',turnId:'turn-1',callId:`review-${i}`,name:'js_superagent_review',arguments:{request:JSON.stringify(action)}});
      return {version:2,state:'ready',summary:`Implementation revision ${runs}; verified fixture syntax; no external integration claim`,artifacts:[],attention:null};}
    }};let runtime=createProjectAgent(runtimeOptions).init();
  t.after(async()=>{await runtime.stop();runtime.close();globalThis.fetch=originalFetch;process.env.PATH=originalPath;rmSync(root,{recursive:true,force:true});});
  runtime.configure({workspace:{mode:'worktree'},github:{repository,allowedActors:['alice'],issues:[1],executable:gh}});
  runtime.configureDelivery({mode:'draft-pr',automatic:true,repository,base:'main',credentialMode:'native-gh',allowedPaths:['value.txt'],review:{ready:true,requestReviewers:true,reviewers:['alice']},verify:{id:'check',version:'1',command:process.execPath,args:['-e',''],paths:['value.txt'],environment:'host',allowHostExecution:true}},{expectedRevision:0});
  const ticket=runtime.submit({text:'Update value and arrange review'});
  await runtime.runNext(); await runtime.syncGitHub(); await delay(1100); await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'completed',JSON.stringify(runtime.get(ticket.id)));
  assert.ok(runtime.reviewActionStatus(ticket.id).some(row=>row.status==='retrying'),JSON.stringify(runtime.reviewActionStatus(ticket.id)));
  await runtime.stop();runtime.close();runtime=createProjectAgent(runtimeOptions).init();await delay(1200);await runtime.runNext();
  for(const row of runtime.reviewActionStatus(ticket.id))assert.equal(row.status,'completed',JSON.stringify(row));
  const ready=runtime.requestPRReview(ticket.id,{kind:'ready'});assert.equal((await runtime.runPRReview(ready.id)).status,'completed');
  assert.equal(reviewPosts,1);assert.equal(readyPosts,1);assert.equal(pull.draft,false);assert.equal(runs,1);
  runtime.reply(ticket.id,'Adjust the value once more');await runtime.runNext();
  assert.equal(runs,2,JSON.stringify(runtime.get(ticket.id)));assert.equal(runtime.get(ticket.id).status,'completed',JSON.stringify(runtime.get(ticket.id)));assert.match(pull.body,/Implementation revision 2/);assert.equal(reviewPosts,1);assert.equal(readyPosts,1);assert.equal(pull.number,7);
  runtime.configureCoordinator({policy:{mode:'off',rules:[],sourceRows:[{id:'repo',source:'github',scope:{repository},actors:[],bots:['alice'],admission:{}}]}},{expectedRevision:runtime.coordinatorStatus().settings.revision});
  runtime.setBotReviewBudget(7,'42',{remaining:0,reason:'Three earlier rounds confirmed',expectedRevision:0});
  recipients={users:[],teams:[]};const fourth=runtime.requestPRReview(ticket.id,{kind:'requestReviewers',reviewers:['alice']});
  const refused=await runtime.runPRReview(fourth.id);assert.equal(refused.status,'failed');assert.match(refused.error,/budget/);assert.equal(reviewPosts,1);
  const delivery=runtime.getDeliverySettings(),{revision,at,...currentDelivery}=delivery;
  runtime.configureDelivery({...currentDelivery,review:{...delivery.review,reviewers:['alice','bob']}},{expectedRevision:revision});
  failBob=true;const transient=runtime.requestPRReview(ticket.id,{kind:'requestReviewers',reviewers:['bob']});
  assert.equal((await runtime.runPRReview(transient.id)).status,'retrying');
  await delay(1100);await runtime.runNext();await delay(2100);await runtime.runNext();
  const exhausted=runtime.reviewActionStatus(ticket.id).find(row=>row.id===transient.id);
  assert.equal(exhausted.attempts,3);assert.equal(exhausted.exhausted,true);assert.equal(exhausted.status,'failed');
  assert.ok(runtime.coordinationStatus().events.some(event=>event.references?.reviewRequestId===transient.id));
  assert.equal(reviewPosts,1,'finite read failures never request an extra reviewer');

});

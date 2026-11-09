import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { Store } from '../src/store.mjs';

const repository='fixture/mentions',prefix=`/repos/${repository}`,sourceId='github-repository:fixture:mentions';
const user={id:1,login:'alice',type:'User'},identity={id:2,login:'helper[bot]',type:'Bot'};
const streams={pulls:false,issues:false,comments:false,reviewComments:false,defaultBranchCI:false,mentions:true};
function inspect(root,fn){const store=new Store(join(stateDir(root), 'state.sqlite'));try{return fn(store);}finally{store.close();}}

test('W32 host discovers unbound Issue/PR bodies and inline mentions with ordinary streams off, replies and deduplicates webhook/poll across reopen',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-w32-host-'))),sent=[],runs=[],issues=[],pulls=[],inline=[];
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');writeFileSync(join(root,'README.md'),'# Fixture\n');git('add','README.md');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture');
  const sha=git('rev-parse','HEAD'),secret='w32-isolated-fixture-secret',secretPath=join(root,'webhook-secret');writeFileSync(secretPath,secret,{mode:0o600});
  const request=async endpoint=>{
    const path=endpoint.split('?')[0];
    if(path==='/user')return identity;
    if(path===prefix)return {id:1,full_name:repository,default_branch:'main',has_issues:true};
    if(path===`${prefix}/issues`)return structuredClone(issues);
    if(path===`${prefix}/pulls`)return structuredClone(pulls);
    if(path===`${prefix}/issues/comments`)return [];
    if(path===`${prefix}/pulls/comments`)return structuredClone(inline);
    const issue=issues.find(item=>path===`${prefix}/issues/${item.number}`);if(issue)return structuredClone(issue);
    const pull=pulls.find(item=>path===`${prefix}/pulls/${item.number}`);if(pull)return structuredClone(pull);
    const comment=inline.find(item=>path===`${prefix}/pulls/comments/${item.id}`);if(comment)return structuredClone(comment);
    const comments=/\/pulls\/(\d+)\/comments$/.exec(path);if(comments)return structuredClone(inline.filter(item=>item.pull_request_url.endsWith(`/pulls/${comments[1]}`)));
    if(/\/(?:issues\/\d+\/comments|pulls\/\d+\/reviews)$/.test(path))return [];
    throw new Error(`Unexpected fixture read ${endpoint}`);
  };
  const github={repository,allowedActors:['alice'],pollIntervalMs:86_400_000,webhook:{secretPath,port:0}};
  const channel={...createGitHubChannel(github,{request}),async deliver(message,context){await context.authorizeSend();sent.push(message);return {id:String(sent.length),url:`https://github.com/${repository}/issues/1#issuecomment-${sent.length}`};}};
  const open=()=>createProjectAgent({projectRoot:root,github,githubChannel:channel,repositoryRequest:request,workspace:{mode:'worktree'},
    driver:{async run(input){runs.push(input);return {status:'completed',summary:'Fixture mention request completed'};}},
    assessor:{async assess({candidate}){return {kind:'accept',title:'Mention task',scope:candidate.triggers[0].text,reason:'Explicit allowed author',rules:[]};}}}).init();
  let runtime=open();t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:0});
  runtime.configureRepositorySource({enabled:true,streams},{expectedRevision:0});
  assert.equal(await runtime.runNext(),null);
  await new Promise(resolve=>setTimeout(resolve,5));
  const at=new Date().toISOString();
  issues.push({id:10,number:1,state:'open',title:'Issue mention',body:'Please @helper[bot] fix this issue',user,created_at:at,updated_at:at,html_url:`https://github.com/${repository}/issues/1`});
  for(const number of [7,8])pulls.push({id:70+number,number,state:'open',merged:false,title:`PR ${number}`,body:number===7?'Please @helper[bot] fix this pull request':'No request in this description',user,created_at:at,updated_at:at,
    html_url:`https://github.com/${repository}/pull/${number}`,head:{sha,ref:`feature-${number}`,repo:{full_name:repository}},base:{sha,ref:'main',repo:{full_name:repository}}});
  inline.push({id:200,body:'@helper[bot] fix this line',user,created_at:at,updated_at:at,html_url:`https://github.com/${repository}/pull/8#discussion_r200`,pull_request_url:`https://api.github.com${prefix}/pulls/8`,path:'README.md',line:1,side:'RIGHT',commit_id:sha});
  const envelope=(event,payload)=>{const body=Buffer.from(JSON.stringify({...payload,repository:{full_name:repository},sender:user}));return {body,headers:{'x-github-event':event,'x-github-delivery':randomUUID(),'x-hub-signature-256':`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`}};};
  for(const [event,payload] of [['issues',{action:'opened',issue:{number:1,body:'untrusted'}}],['pull_request',{action:'opened',pull_request:{number:7,body:'untrusted'}}],['pull_request_review_comment',{action:'created',pull_request:{number:8},comment:{id:200,body:'untrusted'}}]])assert.equal(runtime.receiveGitHubWebhook(envelope(event,payload)).status,'accepted');
  assert.equal((await runtime.processGitHubWebhooks()).processed,3);
  const issueEvent={id:`github:${repository}:issue:10`,kind:'issue',repository,issueNumber:1,issueId:10,issueState:'open',text:issues[0].body,title:issues[0].title,actor:user,createdAt:at,updatedAt:at};
  assert.equal(runtime.receiveGitHubEvent(issueEvent).status,'duplicate','explicit intake and discovery share one body revision');
  inspect(root,store=>{const key=`source:${sourceId}:state`;store.setMeta(key,{...store.getMeta(key),lastAttempt:null});store.db.exec('UPDATE effects SET due = 0');});
  for(let attempt=0;attempt<6&&runs.length<3;attempt++){inspect(root,store=>store.db.exec('UPDATE effects SET due = 0'));await runtime.runNext();if(runs.length<3)await runtime.syncGitHub();}
  assert.equal(runtime.list().length,3);assert.equal(runs.length,3);assert.ok(runtime.list().every(ticket=>ticket.status==='completed'));
  await runtime.flushNotifications();
  assert.ok(sent.some(message=>message.channel.address.issueNumber==='1'));
  assert.ok(sent.some(message=>message.channel.address.pullNumber==='7'));
  // Intake still creates the original review-thread ticket, but completion summaries
  // must not be broadcast into findings; dispositions use the scoped review tool.
  assert.ok(runtime.list().some(ticket=>runtime.getDomainTicket(ticket.id).channels.some(channel=>channel.address.reviewRootId==='200')));
  assert.equal(sent.some(message=>message.kind==='result'&&message.channel.address.reviewRootId==='200'),false);
  assert.ok(runtime.list().every(ticket=>ticket.text.includes('@helper[bot]')&&!ticket.text.includes('untrusted')));
  const triggers=inspect(root,store=>store.db.prepare('SELECT data FROM domain_triggers').all().map(row=>JSON.parse(row.data)).filter(row=>row.meta?.addressedVia==='mention'));
  assert.equal(triggers.length,3);assert.equal(runtime.githubStatus().mentions.identity.login,identity.login);
  await runtime.stop();runtime.close();runtime=open();
  await runtime.syncGitHub();assert.equal(await runtime.runNext(),null);assert.equal(runs.length,3);assert.equal(runtime.list().length,3);
  // A REST body edit does not establish its editor's authority through the original author.
  const edited={...issueEvent,id:`github:${repository}:issue:11`,issueId:11,issueNumber:2,text:'@helper[bot] edited body request',updatedAt:new Date(Date.parse(at)+1000).toISOString()};
  assert.equal(runtime.receiveGitHubEvent(edited).reason,'body-editor-unverified');assert.equal(runtime.list().length,3);
  const historical={...issueEvent,id:`github:${repository}:issue:12`,issueId:12,issueNumber:3,createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'};
  assert.equal(runtime.receiveGitHubEvent(historical).reason,'explicit-command-required','enabling mention intake does not turn channel history into new authority');
  runtime.configureCoordinator({assessor:null},{expectedRevision:runtime.coordinatorStatus().settings.revision});
  const bare={...issueEvent,id:`github:${repository}:issue:13`,issueId:13,issueNumber:4,text:'@helper[bot] !'};
  assert.equal(runtime.receiveGitHubEvent(bare).reason,'queued-for-assessment');assert.equal(runtime.list().length,3,'bare addressing does not directly create executable work without an assessor');
});

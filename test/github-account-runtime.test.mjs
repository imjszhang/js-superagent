import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {normalizeProjectConfig,mergeProjectConfig} from '../src/config.mjs';
import {createGitHubChannel} from '../src/channels/github.mjs';
import {Store} from '../src/store.mjs';
const github={repository:'owner/repo',allowedActors:['owner'],executable:'/dedicated/gh-agent',account:{login:'helper'}};
test('account configuration is explicit, exclusive, removable and exposed by CLI',t=>{
 const base={schemaVersion:2,projectId:'fixture',concurrency:1,workspace:{mode:'in-place'},github};
 const c=normalizeProjectConfig(base);assert.equal(c.github.pollIntervalMs,60000);
 assert.throws(()=>normalizeProjectConfig({...base,github:{...github,executable:undefined}}),/dedicated CLI/);
 assert.throws(()=>normalizeProjectConfig({...base,github:{...github,allowedActors:['helper']}}),/human actors/);
 const app={appId:'1',installationId:2,privateKeyEnv:'TEST_APP_KEY'};
 assert.throws(()=>mergeProjectConfig(c,{github:{app}}),/mutually exclusive/);
 assert.equal(mergeProjectConfig(c,{github:{account:null,app}}).github.account,undefined);
 const root=realpathSync(mkdtempSync(join(tmpdir(),'js-account-cli-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const run=(...args)=>JSON.parse(execFileSync(process.execPath,[resolve('bin/js-superagent.mjs'),...args,'--project',root],{encoding:'utf8'}));
 run('init','--github-repo','owner/repo','--github-actor','owner','--gh-path','/dedicated/gh-agent','--github-agent-login','helper');
 assert.equal(run('config').github.account.login,'helper');run('config','set','--github-account-disable');assert.equal(run('config').github.account,undefined);
});
test('account notifications create a ticket, execute, return result and deduplicate after reopen',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'js-account-host-'))),sent=[],runs=[];
 const identity={id:2,login:'helper',type:'User'},user={id:1,login:'owner',type:'User'};let issue,notices=[];
 const request=async endpoint=>{const p=endpoint.split('?')[0];if(p==='/user')return identity;
 if(p==='/repos/owner/repo')return {id:1,full_name:'owner/repo',default_branch:'main',has_issues:true,permissions:{push:true}};
 if(p==='/repos/owner/repo/notifications')return notices;if(p==='/repos/owner/repo/pulls')return [];
 if(p==='/repos/owner/repo/issues/1')return issue;if(p==='/repos/owner/repo/issues/1/comments')return [];
 throw new Error(`Unexpected endpoint ${endpoint}`);};
 request.notifications=async endpoint=>({body:await request(endpoint),headers:{'x-poll-interval':'60'}});
 const channel={...createGitHubChannel(github,{request}),async deliver(message,context){await context.authorizeSend();sent.push(message);return {id:String(sent.length),url:`https://github.com/owner/repo/issues/1#issuecomment-${sent.length}`};}};
 const open=()=>createProjectAgent({projectRoot:root,github,githubChannel:channel,repositoryRequest:request,workspace:'in-place',
 driver:{async run(input){runs.push(input);return {status:'completed',summary:'Dedicated-account task complete'};}},
 assessor:{async assess({candidate}){return {kind:'accept',title:'Mention task',scope:candidate.triggers[0].text,reason:'Authorized mention',rules:[]};}}}).init();
 let runtime=open();t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:0});assert.equal(runtime.getRepositorySourceSettings().streams.mentions,true);
 assert.equal(runtime.getRepositorySourceSettings().streams.pulls,false,'account mode does not enable previously disabled repository observation');
 await runtime.runNext();await new Promise(r=>setTimeout(r,10));const at=new Date().toISOString();
 issue={id:11,number:1,state:'open',title:'Small fix',body:'@helper fix the parser',user,created_at:at,updated_at:at,html_url:'https://github.com/owner/repo/issues/1'};
 notices=[{id:'9',updated_at:at,repository:{full_name:'owner/repo'},subject:{type:'Issue',url:'https://api.github.com/repos/owner/repo/issues/1'}}];
 const due=()=>{const store=new Store(join(stateDir(root), 'state.sqlite'));try{const key='source:github-repository:owner:repo:state',s=store.getMeta(key);store.setMeta(key,{...s,lastAttempt:null,cursor:{...s.cursor,nextAt:null}});store.db.exec('UPDATE effects SET due=0');}finally{store.close();}};
 for(let i=0;i<5&&!runs.length;i++){due();await runtime.runNext();if(!runs.length)await runtime.syncGitHub();}
 assert.equal(runs.length,1,JSON.stringify({sources:runtime.sourceStatus(),tickets:runtime.list(),coordinator:runtime.coordinatorStatus()}));assert.equal(runtime.list()[0].status,'completed');await runtime.flushNotifications();assert.ok(sent.some(m=>m.text.includes('Dedicated-account task complete')));
 assert.equal(runtime.githubStatus().intake,'account-notifications');await runtime.stop();runtime.close();runtime=open();due();await runtime.runNext();assert.equal(runtime.list().length,1);assert.equal(runs.length,1);
});

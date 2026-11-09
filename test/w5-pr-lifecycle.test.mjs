import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
const repo='fixture/project', head='a'.repeat(40), actor={login:'alice',id:'1',type:'User'};
function fixture(t, run=async()=>({version:2,state:'ready',summary:'Done'})) {
  const root=mkdtempSync(join(tmpdir(),'js-superagent-w5-')), pulls=new Map(), sent=[];
  const pull=n=>pulls.get(n)??{repository:repo,number:n,id:String(n),headSha:head,headRef:'fix',headRepository:repo,state:'open',merged:false,title:'Fix',url:`https://github.com/${repo}/pull/${n}`};
  const channel={async poll(){return [];},async getPullRequest(n){return pull(n);},async deliver(message){sent.push(message);return {id:String(sent.length)};}};
  const harnessRegistry=createHarnessRegistry({adapters:[{id:'w5-fixture',version:'1',roles:['worker'],validate:o=>o,createDriver:()=>({reportVersion:2,run})}]});
  const runtime=createProjectAgent({projectRoot:root,harnessRegistry,githubChannel:channel,execution:{driver:'w5-fixture'}}).init();
  runtime.configure({github:{repository:repo,allowedActors:['alice'],issues:[7],pollIntervalMs:1000}});
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  let seq=0;
  const state=(n,state='closed',merged=false,sha=head)=>{
    pulls.set(n,{...pull(n),state,merged,headSha:sha});
    return runtime.receiveGitHubEvent({id:`github:${repo}:pull_request_state:${++seq}`,kind:'pull_request_state',repository:repo,pullNumber:n,headSha:sha,pullState:state,merged,actor,text:'',createdAt:new Date().toISOString()});
  };
  const review=n=>runtime.receiveGitHubEvent({id:`github:${repo}:review:${++seq}`,kind:'review',repository:repo,pullNumber:n,headSha:head,pullState:'open',actor,text:'Handle the remaining requirement',state:'COMMENTED',commitId:head,createdAt:new Date().toISOString()});
  const store=work=>{const db=new Store(join(stateDir(root), 'state.sqlite'));try{return work(db);}finally{db.close();}};
  return {root,runtime,pull,pulls,sent,state,review,store};
}

test('W5 manual follows retain ready work until all followed PRs close, unlink preserves other subscriptions',async t=>{
  const f=fixture(t),r=f.runtime,ticket=r.submit({text:'Implement linked work'});
  await r.linkGitHubPullRequest(ticket.id,{number:9});await r.linkGitHubPullRequest(ticket.id,{number:10});
  assert.deepEqual(r.getDomainTicket(ticket.id).follows.map(x=>x.own),[false,false]);
  await r.runNext();assert.equal(r.getDomainTicket(ticket.id).ended,undefined);
  f.state(9);assert.equal(r.getDomainTicket(ticket.id).ended,undefined);
  const other=r.submit({text:'Read related context'});
  r.followForContext(other.id,{source:'github',id:`${repo}#pr:10`});
  r.unlinkGitHubPullRequest(10);
  assert.equal(r.getDomainTicket(ticket.id).follows.some(x=>x.thread.endsWith(':10')),false);
  f.store(db=>assert.deepEqual(db.threads.get(`github:${repo}#pr:10`).subscriptions,[r.getDomainTicket(other.id).id]));
  f.state(9);assert.equal(r.getDomainTicket(ticket.id).ended,undefined,'duplicate close does not manufacture a new lifecycle transition');
});

test('W5 own PR controls completion independently of followed PRs and relink retains ownership',async t=>{
  const f=fixture(t),r=f.runtime,ticket=r.submit({text:'Implement linked work'});
  await r.linkGitHubPullRequest(ticket.id,{number:9});await r.linkGitHubPullRequest(ticket.id,{number:10});
  f.store(db=>{const binding=db.getMeta(`github:pull:${repo}#9`);binding.own=true;db.setMeta(`github:pull:${repo}#9`,binding);const domain=db.tickets.get(r.getDomainTicket(ticket.id).id);domain.follows.find(x=>x.thread.endsWith(':9')).own=true;db.tickets.save(domain);});
  assert.equal((await r.linkGitHubPullRequest(ticket.id,{number:9})).own,true);
  await r.runNext();f.state(9,'closed',true);
  assert.equal(r.getDomainTicket(ticket.id).ended.outcome,'merged');
  const count=f.sent.length;f.state(9,'closed',true);assert.equal(f.sent.length,count);
});

test('W5 reopen clears only closure block and never wakes ended work without human feedback',async t=>{
  const f=fixture(t),r=f.runtime,ticket=r.submit({text:'Implement linked work'});
  await r.linkGitHubPullRequest(ticket.id,{number:9});await r.runNext();f.state(9);
  assert.equal(r.getDomainTicket(ticket.id).ended.outcome,'closed');
  f.state(9,'open');assert.equal(r.getDomainTicket(ticket.id).ended.outcome,'closed');
  assert.equal(r.githubStatus().trackedPullRequests[0].blockedReason,undefined);
  assert.equal(f.review(9).status,'received');
  assert.equal(r.getDomainTicket(ticket.id).ended,undefined);
  assert.equal(r.getDomainTicket(ticket.id).follows[0].closed,undefined);
  await r.runNext();assert.equal(r.getDomainTicket(ticket.id).ended,undefined);
  f.state(9,'closed',false,'b'.repeat(40));f.state(9,'open',false,head);
  assert.equal(r.githubStatus().trackedPullRequests[0].blockedReason,'head-changed');
});

test('W5 already accepted human feedback finishes before the PR close ends its ticket',async t=>{
  let runs=0;const f=fixture(t,async()=>{runs++;return {version:2,state:'ready',summary:'Requirement handled'};}),r=f.runtime,ticket=r.submit({text:'Implement linked work'});
  await r.linkGitHubPullRequest(ticket.id,{number:9});await r.runNext();
  assert.equal(f.review(9).status,'received');f.state(9);
  assert.equal(r.getDomainTicket(ticket.id).ended,undefined);
  assert.ok(r.githubStatus().trackedPullRequests[0].pendingClose);
  await r.runNext();assert.equal(runs,2);assert.equal(r.getDomainTicket(ticket.id).ended.outcome,'closed');
});

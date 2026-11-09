import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { retryBeforeStart } from '../src/runtime/recovery.mjs';
import { workerContextResources,contextVersion } from '../src/runtime/worker-context.mjs';
import { Store } from '../src/store.mjs';

test('only verified pre-start resource failures may be retried',async()=>{
  let calls=0;const attempts=[];
  const result=await retryBeforeStart(async()=>{if(++calls===1)throw Object.assign(new Error('busy'),{code:'EAGAIN'});return 'ok';},
    {settings:{retryBeforeStart:true,maxAttempts:2,initialDelayMs:10},started:()=>false,record:item=>attempts.push(item)});
  assert.equal(result,'ok');assert.equal(calls,2);assert.equal(attempts[0].retryable,true);
  calls=0;await assert.rejects(retryBeforeStart(async()=>{calls++;throw Object.assign(new Error('network'),{code:'EAGAIN'});},
    {settings:{retryBeforeStart:true,maxAttempts:2,initialDelayMs:10},started:()=>true}),/network/);assert.equal(calls,1);
});

test('a custom Driver cannot infer safe retries solely from missing process registration',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-superagent-custom-retry-'));let calls=0;
  const runtime=createProjectAgent({projectRoot:root,driver:{async run(){calls++;throw Object.assign(new Error('unknown in-process side effect'),{code:'EAGAIN'});}}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  runtime.configureRecovery({retryBeforeStart:true,maxAttempts:2,initialDelayMs:10},{expectedRevision:0});
  const ticket=runtime.submit({text:'Do not replay unknown side effects'});
  assert.equal((await runtime.runNext()).status,'failed');assert.equal(calls,1);assert.equal(runtime.get(ticket.id).status,'failed');
});

test('an allowed context-only GitHub thread delivers facts without creating a new ticket',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-superagent-context-follow-'));
  const runtime=createProjectAgent({projectRoot:root,github:{repository:'fixture/project',allowedActors:['alice'],issues:[7,8],pollIntervalMs:1000},
    githubChannel:{async poll(){return [];},async deliver(){return {id:'1',url:'https://github.com/fixture/project/issues/7'};}},
    driver:{async run(){return {status:'waiting',summary:'Waiting'};}}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Work on the primary issue only'});
  runtime.followForContext(ticket.id,{source:'github',id:'fixture/project#8'});
  const event={id:'github:fixture/project:comment:987',repository:'fixture/project',issueNumber:8,issueId:800,kind:'comment',text:'Related background fact',
    title:'Background',actor:{login:'alice',id:'10',type:'User'},createdAt:new Date(Date.now()+1000).toISOString(),url:'https://github.com/fixture/project/issues/8#issuecomment-987',issueState:'open'};
  assert.equal(runtime.receiveGitHubEvent(event).reason,'context-only');
  assert.equal(runtime.list().length,1);
  assert.ok(runtime.getDomainTicket(ticket.id).inputs.some(input=>input.kind==='note'&&input.text.includes(event.text)));
  assert.equal(runtime.receiveGitHubEvent(event).status,'duplicate');
});

test('explicit session replacement retains ticket, workspace and auditable lineage',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-superagent-session-replace-'));let calls=0;
  const runtime=createProjectAgent({projectRoot:root,workspace:'copy',driver:{async run(input){
    calls++;assert.equal(input.session,undefined);input.checkpoint({driver:'fixture',id:`session-${calls}`});
    return calls===1?{status:'waiting',summary:'Please review'}:{status:'completed',summary:'Done after replacement'};
  }}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Prepare the report'});await runtime.runNext();
  const workspace=runtime.getWorkspace(ticket.id);assert.equal(runtime.getSession(ticket.id).id,'session-1');
  await assert.rejects(runtime.replaceSession(ticket.id,{reason:'Recover',expectedSessionId:'wrong'}),/Session revision conflict/);
  await runtime.replaceSession(ticket.id,{reason:'Native session missing',expectedSessionId:'session-1'});
  assert.equal(runtime.getSession(ticket.id),null);assert.equal(runtime.sessionStatus(ticket.id).history[0].previous.id,'session-1');
  assert.equal((await runtime.runNext()).status,'completed');assert.equal(runtime.getSession(ticket.id).id,'session-2');
  assert.deepEqual(runtime.getWorkspace(ticket.id),workspace);
});

test('bounded drivers do not complete work whose delivered follow-up was never read',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-superagent-unread-'));
  const runtime=createProjectAgent({projectRoot:root,driver:{reportVersion:2,capabilities:{reportVersion:2,boundedContextVersion:1},async run(input){
    const first=workerContextResources(input).find(record=>record.resource==='messages');
    input.contextDelivered({records:[{resource:first.resource,id:first.id,version:contextVersion(first.value)}]});
    return {version:2,state:'ready',summary:'Finished',artifacts:[],attention:null};
  }}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Work on this task'});runtime.reply(ticket.id,'A follow-up that must be read');
  const result=await runtime.runNext();assert.equal(result.status,'failed');assert.match(result.reports.at(-1).summary,/remain unread/);
  const domain=runtime.getDomainTicket(ticket.id);assert.ok(domain.undelivered.length);assert.ok(!domain.ended);
});

test('a live external assignment owner prevents another runtime from taking its preview assignment',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-superagent-owner-'));let calls=0;
  const runtime=createProjectAgent({projectRoot:root,driver:{async run(){calls++;return {status:'completed',summary:'Done'};}}}).init();
  const owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(owner,'spawn');
  t.after(async()=>{if(owner.exitCode===null&&owner.signalCode===null){owner.kill('SIGTERM');await once(owner,'exit');}await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Inspect the owned task'}),assignment=runtime.getDomainTicket(ticket.id).assignments.at(-1).id;
  const store=new Store(join(stateDir(root), 'state.sqlite'));
  store.setMeta(`managed-assignment:${assignment}`,{token:'other',pid:owner.pid,host:hostname(),ticketId:ticket.id});store.close();
  assert.equal(await runtime.runNext(),null);assert.equal(calls,0);assert.equal(runtime.getDomainTicket(ticket.id).ended,undefined);
  owner.kill('SIGTERM');await once(owner,'exit');
  const retry=new Store(join(stateDir(root), 'state.sqlite'));retry.db.exec('UPDATE effects SET due=0');retry.close();
  assert.equal((await runtime.runNext()).status,'completed');assert.equal(calls,1);
});

test('crash recovery retains a dead owner until its assignment job guardians exit',async t=>{
  const root=mkdtempSync(join(tmpdir(),'js-superagent-guardian-'));let calls=0;
  const runtime=createProjectAgent({projectRoot:root,driver:{async run(){calls++;return {status:'completed',summary:'Done'};}}}).init();
  const owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(owner,'spawn');
  const guardian=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(guardian,'spawn');
  t.after(async()=>{for(const child of [owner,guardian])if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const ticket=runtime.submit({text:'Recover after interruption'}),domain=runtime.getDomainTicket(ticket.id),assignment=domain.assignments.at(-1).id;
  owner.kill('SIGTERM');await once(owner,'exit');
  const store=new Store(join(stateDir(root), 'state.sqlite'));
  store.setMeta('execution',{token:'dead-owner',pid:owner.pid,host:hostname(),ticketId:domain.id,publicId:ticket.id,assignmentId:assignment,runId:'original',inputs:[]});
  store.setMeta('managed-job:job-1',{id:'job-1',status:'running',rootRunId:'earlier-turn',parent:{ticketId:ticket.id,assignmentId:assignment},owner:{pid:owner.pid,host:hostname()},guardians:[{pid:guardian.pid,host:hostname()}]});
  store.close();assert.equal(await runtime.runNext(),null);assert.equal(calls,0);assert.equal(runtime.get(ticket.id).status,'running');
  guardian.kill('SIGTERM');await once(guardian,'exit');
  assert.equal(await runtime.runNext(),null);assert.equal(runtime.get(ticket.id).status,'interrupted');assert.equal(calls,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {Store} from '../src/store.mjs';
import {CoordinationInbox} from '../src/runtime/coordination.mjs';
const fact={scope:'project',producer:'scheduler',key:'task:alpha',sourceVersion:'v1',observedAt:'2026-11-20T00:00:00.000Z',facts:{state:'active',total:2}};
const ref={producer:'scheduler',taskId:'task-alpha',runId:'run-one',kind:'research'};
function fixture(t,callback=()=>({summary:'Recorded state',actions:[]}),reportState='waiting') {
 const root=mkdtempSync(join(tmpdir(),'host-facts-')),calls=[];
 const runtime=createProjectAgent({projectRoot:root,driver:{async run(){return {version:2,state:reportState,summary:'Earlier waiting report',artifacts:[],attention:null};}},assessor:{async assess(){return {kind:'ignore',reason:'No request',rules:[]};},async handleEvent(input){calls.push(input);input.checkpoint({driver:'fixture-assessor',id:'host-test'});return callback(input);}}}).init();
 runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},workflowMode:'continuous'},{expectedRevision:0});
 const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
 t.after(async()=>{store.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});rmSync(projectStateDirectory(root),{recursive:true,force:true});});
 return {runtime,root,store,calls};
}
test('host facts are bounded durable semantic writes and conflict safely without touching tickets',t=>{
 const {runtime,store}=fixture(t);assert.deepEqual(runtime.hostFactsCapabilities(),{version:1});
 const first=runtime.publishHostFacts(fact),changes=store.db.prepare('PRAGMA data_version').get();
 assert.equal(first.status,'stored');
 assert.deepEqual(runtime.publishHostFacts({...fact,observedAt:'2026-11-21T00:00:00.000Z'}),{status:'unchanged',record:first.record});
 assert.deepEqual(store.db.prepare('PRAGMA data_version').get(),changes);
 assert.equal(runtime.publishHostFacts({...fact,sourceVersion:'old',observedAt:'2026-11-19T00:00:00.000Z'}).status,'stale');
 assert.throws(()=>runtime.publishHostFacts({...fact,facts:{state:'other'}}),{code:'HOST_FACTS_CONFLICT'});
 assert.throws(()=>runtime.publishHostFacts({...fact,key:'invalid',facts:{body:'x'.repeat(2001)}}),{code:'HOST_FACTS_INVALID'});
 assert.throws(()=>runtime.publishHostFacts({...fact,key:'invalid',facts:{body:()=>0}}),{code:'HOST_FACTS_INVALID'});
 assert.equal(runtime.listHostFacts().length,1);assert.equal(runtime.list().length,0);assert.equal(runtime.notifications().length,0);
});
test('submit binds host identity atomically and cancellation records source without inventing a human actor',t=>{
 const {runtime}=fixture(t);assert.throws(()=>runtime.submit({text:'Invalid host identity',hostReference:{...ref,actor:'alice'}}));assert.equal(runtime.list().length,0);
 const ticket=runtime.submit({text:'Bound task',hostReference:ref}),domain=runtime.getDomainTicket(ticket.id).id;
 assert.deepEqual(runtime.getDetailed(ticket.id).hostReference,ref);
 runtime.publishHostFacts({...fact,scope:'ticket',ticketId:ticket.id,domainId:domain});
 assert.throws(()=>runtime.cancel(ticket.id,{expectedDomainId:'wrong-domain'}),{code:'HOST_DOMAIN_CHANGED'});
 assert.equal(runtime.getDomainTicket(ticket.id).ended,undefined);
 runtime.cancel(ticket.id,{source:'scheduler',reason:'execution_timeout',expectedDomainId:domain,reference:{taskId:'task-alpha',runId:'run-one'}});
 assert.equal(runtime.getDomainTicket(ticket.id).ended.by,'human');
 assert.deepEqual({...runtime.getDetailed(ticket.id).cancellation,at:null,policyVersion:null},{source:'scheduler',reason:'execution_timeout',actor:null,domainId:domain,assignmentId:runtime.getDetailed(ticket.id).assignmentId,reference:{taskId:'task-alpha',runId:'run-one'},at:null,policyVersion:null});
 runtime.retry(ticket.id);const details=runtime.getDetailed(ticket.id);
 assert.notEqual(details.domainId,domain);assert.equal(details.initialDomainId,domain);assert.deepEqual(details.hostReference,ref);assert.equal(details.hostReferenceDomainId,domain);assert.equal(details.cancellation,null);
 assert.throws(()=>runtime.cancel(ticket.id,{expectedDomainId:domain}),{code:'HOST_DOMAIN_CHANGED'});
 assert.equal(runtime.publishHostFacts({...fact,scope:'ticket',ticketId:ticket.id,domainId:domain,sourceVersion:'v2',observedAt:'2026-11-21T00:00:00.000Z'}).status,'stored');
 assert.throws(()=>runtime.publishHostFacts({...fact,scope:'ticket',ticketId:ticket.id,domainId:'foreign'}),{code:'HOST_DOMAIN_CHANGED'});
});
test('active tickets precede newer ended history and operator project facts have bounded discoverable reads',async t=>{
 const {runtime,calls}=fixture(t,input=>{const read=input.readContext({resource:'project',query:'task:alpha'});assert.equal(read.total,1);return {summary:'Read metadata',actions:[]};});
 const active=runtime.submit({text:'Existing active work',hostReference:ref});
 for(let i=0;i<105;i++){const ticket=runtime.submit({text:`Historical ${i}`});runtime.cancel(ticket.id);}
 runtime.publishHostFacts(fact);runtime.coordinate({id:'status',text:'What is happening?'});await runtime.runNext();
 const ctx=calls.find(call=>call.event.id==='status').context,card=ctx.tickets.find(ticket=>ticket.id===active.id);
 assert.ok(card);assert.equal(card.status,'queued');assert.equal(ctx.omittedActiveTickets,0);assert.ok(ctx.omittedTickets>0);
 assert.equal(card.domainId,active.id);assert.ok(card.createdAt);assert.deepEqual(card.hostReference,ref);assert.equal(ctx.projectFacts[0].facts.state,'active');
});
test('project facts and their native session are unavailable to nonoperator follow-up',async t=>{
 const {runtime,store,calls}=fixture(t,input=>{assert.equal(input.readContext({resource:'project'}).total,input.event.kind==='operator'?1:0);return {summary:'No actions',actions:[]};});
 runtime.publishHostFacts(fact);runtime.coordinate({id:'operator-status',text:'Status'});await runtime.runNext();
 new CoordinationInbox(store).enqueue({id:'external',kind:'follow_up',text:'External followup',requiresCoordination:true,actor:{kind:'human',source:'github',id:'outside'},source:{channel:'github'}});
 await runtime.runNext();const call=calls.find(value=>value.event.id==='external');assert.ok(call);assert.deepEqual(call.context.projectFacts,[]);assert.equal(call.session,undefined);
});
test('new terminal operator failure queues one fixed receipt; retries and background failures do not fabricate success',async t=>{
 const {runtime,store}=fixture(t,()=>{throw new Error('PRIVATE_ERROR_BODY');});
 runtime.coordinate({id:'failed-event',text:'Status'});await runtime.runNext();
 const messages=runtime.notifications().filter(message=>message.id.startsWith('coordination-failure:'));
 assert.equal(messages.length,1);assert.ok(!messages[0].text.includes('PRIVATE_ERROR_BODY'));
 await runtime.runNext();assert.equal(runtime.notifications().filter(message=>message.id.startsWith('coordination-failure:')).length,1);
 new CoordinationInbox(store).enqueue({id:'worker-event',kind:'report',text:'A report',requiresCoordination:true});await runtime.runNext();
 assert.equal(runtime.notifications().filter(message=>message.id.startsWith('coordination-failure:')).length,1);
 const old=new CoordinationInbox(store).enqueue({id:'old-failure',kind:'operator',text:'Old question',actor:{kind:'human',source:'local',id:'operator'},source:{channel:'local'}});
 store.setMeta(`coordination:event:${old.id}`,{...old,status:'failed'});await runtime.runNext();
 assert.equal(runtime.notifications().filter(message=>message.id.startsWith('coordination-failure:')).length,1);
});

test('same-domain retry keeps repeated and changed old facts on their original assignment',async t=>{
 const {runtime,calls}=fixture(t,()=>({summary:'Only current host state',actions:[]}),'failed');
 const ticket=runtime.submit({text:'Retryable work',hostReference:ref});await runtime.runNext();
 const original=runtime.getDetailed(ticket.id),input={...fact,scope:'ticket',ticketId:ticket.id,domainId:original.domainId,assignmentId:original.assignmentId};
 runtime.publishHostFacts(input);runtime.retry(ticket.id);
 const retried=runtime.getDetailed(ticket.id);assert.equal(retried.domainId,original.domainId);assert.notEqual(retried.assignmentId,original.assignmentId);
 assert.equal(runtime.publishHostFacts({...input,observedAt:'2026-11-21T00:00:00.000Z'}).status,'unchanged');
 runtime.publishHostFacts({...input,sourceVersion:'v2',observedAt:'2026-11-22T00:00:00.000Z',facts:{state:'historical-update'}});
 assert.throws(()=>runtime.publishHostFacts({...input,assignmentId:undefined,sourceVersion:'v3'}),{code:'HOST_DOMAIN_CHANGED'});
 assert.throws(()=>runtime.cancel(ticket.id,{expectedDomainId:original.domainId,expectedAssignmentId:original.assignmentId}),{code:'HOST_DOMAIN_CHANGED'});
 runtime.coordinate({id:'retry-state',text:'Status'});await runtime.runNext();
 const card=calls.find(row=>row.event.id==='retry-state').context.tickets.find(row=>row.id===ticket.id);
 assert.equal(card.execution.assignmentId,retried.assignmentId);assert.equal(card.hostFacts.length,1);assert.equal(card.hostFacts[0].historical,true);assert.equal(card.hostFacts[0].assignmentId,original.assignmentId);
});

test('authenticated stop records its actual operator; SDK cannot supply an actor',async t=>{
 const {runtime}=fixture(t,input=>({summary:'Stop original task',actions:[{kind:'stop',ticketId:input.event.references.stopTicketId,text:'Requested stop'}]}));
 const ticket=runtime.submit({text:'Cancelable work'});
 assert.throws(()=>runtime.cancel(ticket.id,{actor:'invented'}),{code:'HOST_FACTS_INVALID'});
 runtime.coordinate({text:`/stop ${ticket.id} Stop this task`});await runtime.runNext();
 const cancelled=runtime.getDetailed(ticket.id).cancellation;
 assert.deepEqual(cancelled.actor,{kind:'human',source:'local',id:'operator'});assert.equal(cancelled.source,'local');assert.ok(cancelled.eventId);
});
test('transient attempts produce a receipt only after the unchanged retry budget is exhausted',async t=>{
 const {runtime,store}=fixture(t,()=>{throw Object.assign(new Error('Transport unavailable'),{code:'ECONNRESET'});});
 runtime.configureCoordinator({workRetry:{autoRetry:true,maxAttempts:2,initialDelayMs:10,timeoutMs:1000}},{expectedRevision:1});
 runtime.coordinate({id:'transport',text:'Status'});await runtime.runNext();
 assert.equal(runtime.notifications().filter(row=>row.id.startsWith('coordination-failure:')).length,0);
 const event=store.getMeta('coordination:event:transport');assert.equal(event.status,'pending');
 store.setMeta('coordination:event:transport',{...event,nextAt:'2026-01-01T00:00:00.000Z'});await runtime.runNext();
 assert.equal(runtime.coordinationStatus().events.find(row=>row.id==='transport').status,'failed');
 assert.equal(runtime.notifications().filter(row=>row.id.startsWith('coordination-failure:')).length,1);
});

test('missing original domain evidence cannot relabel a replacement as the historical initial tuple',t=>{
 const {runtime,store}=fixture(t),ticket=runtime.submit({text:'Legacy retry history'}),original=runtime.getDetailed(ticket.id);
 runtime.cancel(ticket.id);runtime.retry(ticket.id);
 const meta=store.getMeta(`ticket:${ticket.id}`);delete meta.initialDomainId;store.setMeta(`ticket:${ticket.id}`,meta);
 assert.equal(runtime.getDetailed(ticket.id).initialDomainId,original.domainId);
 store.deleteMeta(`public:${original.domainId}`);
 assert.equal(runtime.getDetailed(ticket.id).initialDomainId,null);assert.equal(runtime.getDetailed(ticket.id).initialAssignmentId,null);
});

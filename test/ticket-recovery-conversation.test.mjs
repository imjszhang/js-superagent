import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createProjectAgent,createHarnessRegistry} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {buildWorkerContext} from '../src/runtime/worker-context.mjs';

const dm=(id,text,chat='oc_dm')=>({sender:{sender_id:{open_id:'ou_alice'},sender_type:'user',tenant_key:'tenant'},message:{message_id:id,chat_id:chat,chat_type:'p2p',message_type:'text',create_time:'1793491200000',content:JSON.stringify({text})}});
const recover=card=>({summary:'Continue the existing failed investigation',actions:[{kind:'retryTicket',ticketId:card.id,expectedVersion:card.recovery.version,text:null,triggerId:null}]});
function fixture(t,custom={}) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ticket-recovery-'))),calls=[],inputs=[],state={workers:0,inspections:0,failures:custom.failures??1};
 let originalContext, originalInput, runtime;
 const api={list:async()=>({code:0,data:{items:[],has_more:false}}),get:async req=>({code:0,data:{items:[{message_id:req.path.message_id,chat_id:'oc_dm'}]}}),reply:async req=>{calls.push(req);return {code:0,data:{message_id:`om_reply_${calls.length}`}}},create:async req=>{calls.push(req);return {code:0,data:{message_id:`om_create_${calls.length}`,chat_id:'oc_dm'}}}};
 const sdk={Client:class{constructor(){this.im={message:api}}},EventDispatcher:class{register(){return this}},WSClient:class{async start(){}close(){}}};
 const session={driver:'ticket-recovery-fixture',id:'original-native-session'};
 const registry=createHarnessRegistry({adapters:[{id:'ticket-recovery-fixture',version:'1',roles:['worker','coordinator'],validate:x=>x,createDriver:()=>({reportVersion:2,capabilities:{sessionResume:true,boundedContextVersion:1},
  async run(input){state.workers++;input.checkpoint(session);const refs=buildWorkerContext(input).messages.filter(x=>!x.truncated).map(({resource,id,version})=>({resource,id,version}));
   if(state.workers===1){originalContext=refs;originalInput=input.domainTicket.inputs.find(x=>x.kind==='trigger')?.id;}
   if(state.workers>1){assert.equal(input.session.id,session.id);assert.equal(input.recoveryContinuation.finalReportFailure,'missing-final-report');if(originalInput)assert.ok(input.domainTicket.inputs.find(x=>x.id===originalInput).readAt,'native-consumed original context must be marked read before continuation');assert.ok(input.domainTicket.inputs.some(x=>x.kind==='note'&&x.text.includes('Do not repeat completed external actions')));}
   if(custom.protocolFailure)return {version:2,state:'unrecognized',summary:'Malformed report'};
   if(state.workers<=state.failures)throw Object.assign(new Error('Completed native turn without final report'),{code:'DSH_MISSING_FINAL_REPORT'});
   input.contextDelivered({records:refs});return{version:2,state:'ready',summary:'Read-only investigation completed',artifacts:[]};},
  async inspectRecovery(input){state.inspections++;if(custom.inspect)return custom.inspect(input);return {version:1,kind:'interrupted',safeToResume:true,toolsSettled:true,session,checkpoint:{runId:input.runId,eventSequence:27},code:'HISTORY_VERIFIED',outcome:'resume',finalReportFailure:'missing-final-report',contextRecords:originalContext};}
 }),createAssessor:()=>({async assess(){return{kind:'accept',title:'Inspect garden archive',scope:'Read-only inspect the garden archive index. Do not change files or publish.',reason:'Authorized investigation',rules:[]}},async handleEvent(input){inputs.push(input);if(custom.handle)return custom.handle(input,runtime);if(input.event.text==='Investigate garden archive')return{summary:'Read-only investigation',actions:[{kind:'request',ticketId:null,text:input.event.text}]};if(input.event.text.startsWith('Retry'))return recover(input.context.tickets[0]);if(input.event.kind==='report'||input.event.kind==='result')return{summary:'Report actual outcome',actions:[{kind:'notify',ticketId:input.event.ticketId,text:input.event.text}]};return{summary:'Status only',actions:[]};}})}]});
 process.env.TICKET_RECOVERY_TEST_SECRET='synthetic';
 const open=()=>createProjectAgent({projectRoot:root,harnessRegistry:registry,feishuSDK:sdk}).init();runtime=open();
 runtime.configure({feishu:{appId:'cli_bot',appSecretEnv:'TICKET_RECOVERY_TEST_SECRET',botOpenId:'ou_bot',tenantKey:'tenant',operator:{openId:'ou_alice'},chats:[{chatId:'oc_group',type:'group',mode:'mentions'}]}});
 runtime.configureExecutor({driver:'ticket-recovery-fixture'},{expectedRevision:0});runtime.configureCoordinator({assessor:{driver:'ticket-recovery-fixture'},workflowMode:'continuous'},{expectedRevision:0});
 if(custom.auto)runtime.configureRecovery({autoResume:true,maxAttempts:3,initialDelayMs:10},{expectedRevision:0});
 const until=async predicate=>{for(let n=0;n<20&&!predicate();n++)await runtime.runNext();assert.ok(predicate(),JSON.stringify({state,tickets:runtime.list(),details:runtime.list().map(x=>runtime.getDetailed(x.id)),events:runtime.coordinationStatus().events.slice(-2)}));};
 t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 return{root,calls,inputs,state,get runtime(){return runtime},until,async reopen({crash=false}={}){if(!crash)await runtime.stop();runtime.close();runtime=open();await runtime.prepareExecution();},async fail(){await runtime.prepareExecution();runtime.receiveSourceEvent('feishu',dm('om_original','Investigate garden archive'));await until(()=>state.workers===1);return runtime.list()[0];},async send(id,text){runtime.receiveSourceEvent('feishu',dm(id,text));await until(()=>runtime.coordinationStatus().events.find(e=>e.source?.messageId===id)?.status==='completed');return runtime.coordinationStatus().events.find(e=>e.source?.messageId===id);}};
}

test('Feishu failed-ticket recovery resumes the same native session, consumes original context and sends truthful receipts',async t=>{
 const f=fixture(t),ticket=await f.fail();assert.equal(ticket.status,'failed');assert.equal(f.runtime.getDetailed(ticket.id).failure.code,'DSH_MISSING_FINAL_REPORT');
 await f.send('om_status','Has it started?');assert.equal(f.state.workers,1);assert.equal(f.state.inspections,0);
 const event=await f.send('om_retry','Retry the original ticket');assert.equal(event.receipts[0].result.status,'checking');
 await f.runtime.flushNotifications();assert.ok(f.calls.some(x=>x.path?.message_id==='om_retry'&&x.data.content.includes('确认可恢复后')));
 assert.equal(f.runtime.receiveSourceEvent('feishu',dm('om_retry','Retry the original ticket')).status,'duplicate');
 await f.until(()=>f.runtime.get(ticket.id).status==='completed');
 assert.equal(f.state.workers,2);assert.equal(f.state.inspections,1);assert.equal(f.runtime.list().length,1);assert.equal(f.runtime.getSession(ticket.id).id,'original-native-session');
 await f.runtime.flushNotifications();assert.ok(f.calls.some(x=>x.path?.message_id==='om_retry'&&x.data.content.includes('已通过恢复检查')));
 const repeated=await f.send('om_again','Retry completed ticket');assert.equal(repeated.receipts[0].result.status,'already-completed');assert.equal(f.state.workers,2);
});

test('recovery inspection rejection is persisted and reported to the requesting Feishu conversation',async t=>{
 const f=fixture(t,{inspect:()=>({version:1,kind:'inspection',safeToResume:false,reason:'native-tools-or-jobs-unsettled'})}),ticket=await f.fail();
 const event=await f.send('om_retry','Retry failed ticket');assert.equal(event.receipts[0].result.status,'checking');
 await f.until(()=>f.runtime.getDetailed(ticket.id).recovery?.status==='inspection');await f.runtime.flushNotifications();
 const recovery=f.runtime.getDetailed(ticket.id).recovery;assert.equal(recovery.reason,'native-tools-or-jobs-unsettled');assert.equal(recovery.outcome.status,'blocked');assert.equal(f.state.workers,1);
 assert.ok(f.calls.some(x=>x.path?.message_id==='om_retry'&&x.data.content.includes('暂未恢复执行')));
});

test('automatic missing-report repair is capped at one and an explicit new request grants one new continuation',async t=>{
 const f=fixture(t,{auto:true,failures:2}),ticket=await f.fail();
 await f.until(()=>f.runtime.getDetailed(ticket.id).recovery?.reason==='final-report-recovery-exhausted');assert.equal(f.state.workers,2);assert.equal(f.runtime.getDetailed(ticket.id).recovery.finalReportRepairAttempts,1);
 for(let n=0;n<3;n++)await f.runtime.runNext();assert.equal(f.state.workers,2);
 await f.send('om_manual','Retry after checking the failure');await f.until(()=>f.runtime.get(ticket.id).status==='completed');assert.equal(f.state.workers,3);assert.equal(f.runtime.getDetailed(ticket.id).recovery.finalReportRepairAttempts,1);
});

test('ticket recovery queue and acknowledgment roll back together if receipt storage fails',async t=>{
 const f=fixture(t),ticket=await f.fail();await f.send('om_status','Status');f.runtime.receiveSourceEvent('feishu',dm('om_atomic','Retry failed ticket'));
 const db=new DatabaseSync(join(projectStateDirectory(f.root),'state.sqlite'));db.exec("CREATE TRIGGER fail_ticket_recovery_ack BEFORE INSERT ON receipts WHEN NEW.id LIKE 'coordination:feishu-operator:%om_atomic:%' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
 await f.runtime.runNext();const event=f.runtime.coordinationStatus().events.find(e=>e.source?.messageId==='om_atomic');assert.equal(event.status,'failed');assert.match(event.error,/synthetic receipt failure/);assert.equal(event.receipts.length,0);assert.equal(f.runtime.getDetailed(ticket.id).recovery,null);assert.equal(f.state.workers,1);
 db.exec('DROP TRIGGER fail_ticket_recovery_ack');db.close();
});

test('operator revocation before handling a queued recovery message prevents continuation',async t=>{
 const f=fixture(t),ticket=await f.fail();f.runtime.receiveSourceEvent('feishu',dm('om_retry','Retry failed ticket'));await f.runtime.stop();f.runtime.configureV2({feishu:{operator:{openId:'ou_other'}}});await f.runtime.prepareExecution();
 await f.until(()=>f.runtime.coordinationStatus().events.find(e=>e.source?.messageId==='om_retry')?.status==='failed');const event=f.runtime.coordinationStatus().events.find(e=>e.source?.messageId==='om_retry');assert.equal(event.status,'failed');assert.equal(f.runtime.get(ticket.id).status,'failed');assert.equal(f.state.workers,1);assert.equal(f.state.inspections,0);
});

test('manual native recovery survives reopen, is idempotent while queued and consumes verified initial input',async t=>{
 const f=fixture(t);await f.runtime.prepareExecution();const ticket=f.runtime.submit({text:'Investigate archive'});f.runtime.reply(ticket.id,'Read the supplemental archive index once');await f.runtime.runNext();assert.equal(f.state.workers,1);assert.equal(f.runtime.get(ticket.id).status,'failed');
 const pending=f.runtime.getDomainTicket(ticket.id).inputs.find(x=>x.kind==='trigger');assert.ok(pending);assert.equal(pending.readAt,null);
 f.runtime.retry(ticket.id);const cycle=f.runtime.getDetailed(ticket.id).recovery.cycle;f.runtime.retry(ticket.id);assert.equal(f.runtime.getDetailed(ticket.id).recovery.cycle,cycle);
 await f.reopen();await f.until(()=>f.runtime.get(ticket.id).status==='completed');assert.equal(f.state.workers,2);assert.equal(f.state.inspections,1);assert.ok(f.runtime.getDomainTicket(ticket.id).inputs.find(x=>x.id===pending.id).readAt);
});


test('unknown report-protocol failure remains inspection-required and cannot be requeued remotely',async t=>{
 const f=fixture(t,{protocolFailure:true}),ticket=await f.fail();assert.equal(f.runtime.getDetailed(ticket.id).failure.origin,'report-protocol');
 const event=await f.send('om_unknown','Retry failed ticket');assert.equal(event.receipts[0].result.status,'blocked');assert.equal(event.receipts[0].result.reason,'inspection-required');
 assert.equal(f.runtime.get(ticket.id).status,'failed');assert.equal(f.state.workers,1);assert.equal(f.state.inspections,0);
});


test('owner loss during final-report continuation preserves its repair cap and original conversation receipt',async t=>{
 const f=fixture(t,{failures:2}),ticket=await f.fail();await f.send('om_repair','Retry failed ticket');assert.equal(f.state.workers,2);
 await f.runtime.stop();f.runtime.configureRecovery({autoResume:true,maxAttempts:3,initialDelayMs:10},{expectedRevision:0});
 const child=spawn(process.execPath,['-e',''],{stdio:'ignore'}),pid=child.pid;await once(child,'close');
 // Reconstruct a crash just before the second run saved its failure, using its actual session and assignment.
 const store=new Store(join(projectStateDirectory(f.root),'state.sqlite'));
 try {store.atomic(()=>{const meta=store.getMeta(`ticket:${ticket.id}`),domain=store.tickets.get(meta.domainId),assignment=domain.assignments.at(-1);
  assignment.state='running';delete assignment.report;store.tickets.save(domain);meta.recovery.status='resuming';delete meta.failure;meta.interrupted=false;store.setMeta(`ticket:${ticket.id}`,meta);
  store.setMeta('execution',{token:'crashed-report-continuation',pid,host:hostname(),publicId:ticket.id,ticketId:domain.id,assignmentId:assignment.id,runId:meta.runId,startedAt:new Date().toISOString()});
 });}finally{store.close();}
 await f.reopen({crash:true});const recovered=f.runtime.getDetailed(ticket.id).recovery;assert.equal(recovered.status,'inspect');assert.equal(recovered.finalReportRepairAttempts,1);assert.ok(recovered.requestedBy.eventId.includes('om_repair'));
 await f.until(()=>f.runtime.getDetailed(ticket.id).recovery?.reason==='final-report-recovery-exhausted');await f.runtime.flushNotifications();
 assert.equal(f.state.workers,2);assert.equal(f.runtime.getDetailed(ticket.id).recovery.outcome.status,'blocked');assert.ok(f.calls.some(x=>x.path?.message_id==='om_repair'&&x.data.content.includes('一次报告补救')));
});

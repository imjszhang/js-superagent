import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createProjectAgent,createHarnessRegistry} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';

const dm=(id,text,chat='oc_dm')=>({sender:{sender_id:{open_id:'ou_alice'},sender_type:'user',tenant_key:'tenant'},message:{message_id:id,chat_id:chat,chat_type:'p2p',message_type:'text',create_time:'1793491200000',content:JSON.stringify({text})}});
const recover=card=>({summary:'Resume only the original authorized investigation',actions:[{kind:'retryRequest',triggerId:card.triggerId,expectedVersion:card.recovery.version,ticketId:null,text:null}]});
function fixture(t,custom={}) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'conversation-recovery-'))), calls=[],inputs=[],state={accept:false,assessments:0,workers:0,failedKind:'format'};
 const api={list:async()=>({code:0,data:{items:[],has_more:false}}),get:async req=>({code:0,data:{items:[{message_id:req.path.message_id,chat_id:'oc_dm'}]}}),reply:async req=>{calls.push(req);return {code:0,data:{message_id:`om_reply_${calls.length}`}}},create:async()=>({code:0,data:{message_id:'om_create',chat_id:'oc_dm'}})};
 const sdk={Client:class{constructor(){this.im={message:api}}},EventDispatcher:class{register(){return this}},WSClient:class{async start(){} close(){}}};
 const registry=createHarnessRegistry({adapters:[{id:'recovery-fixture',version:'1',roles:['worker','coordinator'],validate:x=>x,createDriver:()=>({reportVersion:2,async run(){state.workers++;return {version:2,state:'waiting',summary:'Investigation started',attention:{question:'Confirm observed result'}}}}),createAssessor:()=>({async assess(input){state.assessments++;if(!state.accept)throw Object.assign(new Error('Synthetic assessment failure'),{failureKind:state.failedKind,code:`assessment_${state.failedKind}`,retryable:true});return {kind:'accept',title:'Inspect garden archive',scope:'Read-only inspect the garden archive index. Do not change files or publish.',reason:'Original authorized investigation',rules:[]}},async handleEvent(input){inputs.push(input);if(custom.handle)return custom.handle(input,state);if(input.event.text==='Investigate garden archive')return {summary:'Read-only investigation of the garden archive index',actions:[{kind:'request',ticketId:null,text:input.event.text}]};if(input.event.text==='Retry original investigation')return recover(input.context.recentEvents.flatMap(row=>row.requests??[]).find(row=>row.text==='Investigate garden archive'));return {summary:'Status only',actions:[]}}})}]});
 process.env.RECOVERY_TEST_SECRET='synthetic';
 let runtime=createProjectAgent({projectRoot:root,harnessRegistry:registry,feishuSDK:sdk}).init();
 runtime.configure({feishu:{appId:'cli_bot',appSecretEnv:'RECOVERY_TEST_SECRET',botOpenId:'ou_bot',tenantKey:'tenant',operator:{openId:'ou_alice'},chats:[{chatId:'oc_group',type:'group',mode:'mentions'}]}});
 runtime.configureExecutor({driver:'recovery-fixture'},{expectedRevision:0});runtime.configureCoordinator({assessor:{driver:'recovery-fixture'},workflowMode:'continuous'},{expectedRevision:0});
 t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true})});
 return {root,calls,inputs,state,get runtime(){return runtime},async reopen(){await runtime.stop();runtime.close();runtime=createProjectAgent({projectRoot:root,harnessRegistry:registry,feishuSDK:sdk}).init();await runtime.prepareExecution();},async fail(){await runtime.prepareExecution();runtime.receiveSourceEvent('feishu',dm('om_original','Investigate garden archive'));await runtime.runNext();const event=runtime.coordinationStatus().events.find(row=>row.text==='Investigate garden archive');await runtime.runNext();return event.receipts[0].result.triggerId;}};
}

test('Feishu recovery retains the original trigger, acknowledges queueing, creates one ticket and survives repeated instructions/reopen',async t=>{
 const f=fixture(t),id=await f.fail();assert.equal(f.runtime.list().length,0);
 f.runtime.receiveSourceEvent('feishu',dm('om_status','Has it started?'));await f.runtime.runNext();assert.equal(f.state.assessments,1);
 const card=f.inputs.at(-1).context.recentEvents.flatMap(row=>row.requests??[]).find(row=>row.triggerId===id);assert.equal(card.recovery.allowed,true);assert.match(card.summary,/Read-only/);
 f.runtime.receiveSourceEvent('feishu',dm('om_retry','Retry original investigation'));await f.runtime.runNext();
 const event=f.runtime.coordinationStatus().events.find(row=>row.text==='Retry original investigation');assert.equal(event.status,'completed');assert.equal(event.receipts[0].result.status,'queued');assert.equal(event.receipts[0].result.triggerId,id);
 assert.equal(f.runtime.reevaluate(id),false,'pending recovery cannot queue twice');
 await f.runtime.flushNotifications();assert.ok(f.calls.some(row=>row.path.message_id==='om_retry'&&row.data.content.includes('重新排入评估')));
 await f.reopen();f.state.accept=true;await f.runtime.runNext();assert.equal(f.runtime.list().length,1);const ticket=f.runtime.list()[0];
 assert.equal(f.runtime.getDomainTicket(ticket.id).origin.triggerId,id);await f.runtime.flushNotifications();assert.ok(f.calls.some(row=>row.path.message_id==='om_original'&&row.data.content.includes('已建立工单')));
 assert.equal(f.runtime.receiveSourceEvent('feishu',dm('om_retry','Retry original investigation')).status,'duplicate');
 f.runtime.receiveSourceEvent('feishu',dm('om_repeat','Retry original investigation'));await f.runtime.runNext();assert.equal(f.runtime.list().length,1);assert.equal(f.state.assessments,2);
 const repeat=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_repeat');assert.equal(repeat.receipts[0].result.status,'already-owned');assert.equal(repeat.receipts[0].result.ticketId,ticket.id);
});

test('bounded requests lookup finds old requests and retains recovery cards in host validation context',async t=>{
 let original;
 const f=fixture(t,{handle:input=>{if(input.event.text==='Investigate garden archive')return {summary:'Read-only archive',actions:[{kind:'request',ticketId:null,text:input.event.text}]};if(input.event.text==='Retry old request'){assert.equal(input.context.recentEvents.some(row=>row.requests?.length),false);const result=input.readContext({resource:'requests',recordId:original,offset:0});assert.equal(result.requests[0].triggerId,original);return recover(result.requests[0]);}return {summary:'Status only',actions:[]}}});
 original=await f.fail();for(let n=0;n<21;n++){f.runtime.receiveSourceEvent('feishu',dm(`om_status_${n}`,'Status'));await f.runtime.runNext();}
 f.runtime.receiveSourceEvent('feishu',dm('om_old','Retry old request'));await f.runtime.runNext();const event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_old');assert.equal(event.status,'completed');assert.equal(event.receipts[0].result.status,'queued');assert.equal(event.readSet[0].request.resource,'requests');assert.equal(f.runtime.list().length,0);
});

test('a changed recovery snapshot is reassessed rather than executed; explicit retry does not duplicate a pending evaluation',async t=>{
 let stale=true,f;
 f=fixture(t,{handle:input=>{if(input.event.text==='Investigate garden archive')return {summary:'Read archive',actions:[{kind:'request',ticketId:null,text:input.event.text}]};if(input.event.text==='Retry original investigation'){const card=input.context.recentEvents.flatMap(row=>row.requests??[])[0];if(stale){stale=false;assert.equal(f.runtime.reevaluate(card.triggerId),true)}return recover(card);}return {summary:'Status',actions:[]}}});
 const id=await f.fail();f.runtime.receiveSourceEvent('feishu',dm('om_stale','Retry original investigation'));await f.runtime.runNext();let event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_stale');assert.equal(event.status,'pending');assert.equal(event.failureKind,'stale');assert.equal(event.receipts.length,0);assert.equal(f.runtime.reevaluate(id),false);
 f.state.accept=true;await f.runtime.runNext();event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_stale');assert.equal(event.status,'completed');assert.equal(event.receipts[0].result.status,'already-owned');assert.equal(f.runtime.list().length,1);
});

test('historic retryable does not override current prerequisites or unknown failure inspection',async t=>{
 const f=fixture(t);f.state.failedKind='internal';await f.fail();f.runtime.receiveSourceEvent('feishu',dm('om_unknown','Retry original investigation'));await f.runtime.runNext();const event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_unknown');assert.equal(event.receipts[0].result.status,'blocked');assert.equal(event.receipts[0].result.reason,'inspection-required');assert.equal(f.state.assessments,1);assert.equal(f.runtime.list().length,0);
});

test('revoked operator authority blocks an already queued recovery instruction',async t=>{
 const f=fixture(t),id=await f.fail();f.runtime.receiveSourceEvent('feishu',dm('om_revoked','Retry original investigation'));await f.runtime.stop();f.runtime.configureV2({feishu:{operator:{openId:'ou_bob'}}});await f.runtime.prepareExecution();await f.runtime.runNext();const event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_revoked');assert.equal(event.status,'failed');assert.equal(f.runtime.eventDiagnostic(id).evaluation.status,'failed');assert.equal(f.state.assessments,1);assert.equal(f.runtime.list().length,0);
});

test('acknowledgment storage failure rolls back requeue and its receipt atomically',async t=>{
 const f=fixture(t),id=await f.fail();f.runtime.receiveSourceEvent('feishu',dm('om_atomic','Retry original investigation'));
 const db=new DatabaseSync(join(projectStateDirectory(f.root),'state.sqlite'));
 db.exec("CREATE TRIGGER fail_recovery_ack BEFORE INSERT ON receipts WHEN NEW.id LIKE 'coordination:feishu-operator:%om_atomic:%' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
 await f.runtime.runNext();const event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_atomic');assert.equal(event.status,'failed');assert.match(event.error,/synthetic receipt failure/);assert.equal(event.receipts.length,0);assert.equal(f.runtime.eventDiagnostic(id).evaluation.status,'failed');assert.equal(f.runtime.list().length,0);assert.equal(f.state.assessments,1);
 db.exec('DROP TRIGGER fail_recovery_ack');db.close();
});

test('existing worker ownership established outside the assessment prevents recovery from creating a second ticket',async t=>{
 const {Store}=await import('../src/store.mjs'),{Engine}=await import('../dist/core/index.js');
 const f=fixture(t),id=await f.fail(),ticket=f.runtime.submit({text:'Existing authorized archive investigation'});
 const store=new Store(join(projectStateDirectory(f.root),'state.sqlite'));
 const engine=new Engine({repo:store,policy:()=>({version:'fixture',paused:false,revalidate:()=>true}),scope:{scope:()=>({})},now:()=>new Date().toISOString(),assessor:{request(){}},executor:{start(){},deliver(){},stop(){}},outbox:{send(){},status(){},withdraw(){}}});
 engine.attach(f.runtime.getDomainTicket(ticket.id).id,id,'Existing owner accepts the original request');store.close();
 assert.equal(f.runtime.reevaluate(id),false);
 f.runtime.receiveSourceEvent('feishu',dm('om_owned','Retry original investigation'));await f.runtime.runNext();const event=f.runtime.coordinationStatus().events.find(row=>row.source?.messageId==='om_owned');assert.equal(event.status,'completed');assert.equal(event.receipts[0].result.status,'already-owned');assert.equal(event.receipts[0].result.ticketId,ticket.id);const card=f.inputs.at(-1).context.recentEvents.flatMap(row=>row.requests??[]).find(row=>row.triggerId===id);assert.equal(card.status,'attached');assert.equal(card.failureKind,undefined);assert.equal(card.message,undefined);assert.equal(f.runtime.list().length,1);assert.equal(f.state.assessments,1);
});

test('request discovery never exposes another remote conversation as an actionable recovery target',async t=>{
 let target, foreignReads=0;
 const f=fixture(t,{handle:input=>{if(input.event.text==='Investigate garden archive')return {summary:'Archive request',actions:[{kind:'request',ticketId:null,text:input.event.text}]};foreignReads++;const result=input.readContext({resource:'requests',recordId:target,offset:0});assert.equal(result.missing,true);assert.equal(input.context.recentEvents.flatMap(row=>row.requests??[]).length,0);return {summary:'No original request belongs to this conversation',actions:[]}}});
 target=await f.fail();
 // Simulate a newly learned operator DM after a conversation migration, retaining the old request.
 const db=new DatabaseSync(join(projectStateDirectory(f.root),'state.sqlite'));db.prepare('DELETE FROM kv WHERE key=?').run('feishu:operator-chat');db.close();
 f.runtime.receiveSourceEvent('feishu',dm('om_foreign','Retry other conversation','oc_other'));await f.runtime.runNext();assert.equal(foreignReads,1,'the authenticated new conversation actually queried requests');assert.equal(f.state.assessments,1);assert.equal(f.runtime.eventDiagnostic(target).evaluation.status,'failed');
});

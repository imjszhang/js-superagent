import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {Store} from '../src/store.mjs';
import {createTurnAssessor} from '../src/runtime/turn-assessor.mjs';
import {createAssessmentRecordView,ASSESSMENT_CONTEXT_UNAVAILABLE} from '../src/runtime/assessment-records.mjs';
import {assessmentFailureMessage,assessmentTicketReceiptProof,verifyAssessmentTicketReceipt} from '../src/runtime/assessment-status.mjs';
import {candidateReferences} from '../src/context-requests.mjs';

const complete=(kind,extra={})=>({kind,reason:'Synthetic explicit request',title:null,scope:null,ticketId:null,note:null,rules:[],resource:null,recordId:null,offset:null,triggerId:null,answer:null,...extra});
function fixture(t,{materials=true}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'assessment-projection-'))),sent=[],turns=[],runs=[];
  writeFileSync(join(root,'notes.md'),'Synthetic orchard');
  const api={list:async()=>({code:0,data:{items:[],has_more:false}}),get:async request=>({code:0,data:{items:[{message_id:request.path.message_id,chat_id:'oc_orchard'}]}}),
    create:async request=>{sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`,chat_id:'oc_orchard'}};},
    reply:async request=>{sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`}};}};
  const sdk={Client:class{constructor(){this.im={message:api};}},EventDispatcher:class{register(){return this;}},WSClient:class{async start(){} close(){}}};
  let onRead=()=>{};
  const bounded=createTurnAssessor({config:{timeoutMs:120000},assessmentPrompt:({snapshot,facts})=>JSON.stringify({snapshot,facts}),
    runTurn:async({prompt})=>{const value=JSON.parse(prompt);turns.push(value);
      if(!value.facts.length)return complete('read',{resource:'threads',recordId:value.snapshot.availableRecords.threads[0],offset:0});
      onRead(value);return complete('accept',{title:'Register selected orchard varieties',scope:'Register the previously selected pear and plum in the fictional orchard index; no publication.'});}});
  const runtime=createProjectAgent({projectRoot:root,feishuSDK:sdk,execution:{driver:'fixture'},
    driver:{async run(input){runs.push(input);return {status:'completed',summary:'Synthetic index updated',artifacts:[]};}},
    assessor:{...bounded,async handleEvent(input){return {summary:'Route original operator message',actions:input.event.kind!=='operator'?[]:input.event.text.startsWith('Register')
      ?[{kind:'request',ticketId:null,text:input.event.text}]:[{kind:'reply',ticketId:null,text:'The selected varieties are pear and plum.'}]};}}}).init();
  process.env.PROJECTION_TEST_SECRET='synthetic-secret';
  runtime.configure({feishu:{appId:'cli_orchard',appSecretEnv:'PROJECTION_TEST_SECRET',botOpenId:'ou_bot',tenantKey:'orchard',chats:[{chatId:'oc_group',type:'group',mode:'mentions'}],operator:{openId:'ou_keeper'}}});
  if(materials)runtime.configureMaterials({entries:[{id:'project',project:'self',include:['notes.md'],views:['current'],readers:[{source:'local',id:'operator'},{source:'feishu',id:'ou_keeper'}],destinations:[{source:'local',id:'operator'},{source:'feishu',id:'operator'}]}]},{expectedRevision:0});
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},workflowMode:'continuous'},{expectedRevision:0});
  const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
  t.after(async()=>{store.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});rmSync(projectStateDirectory(root),{recursive:true,force:true});delete process.env.PROJECTION_TEST_SECRET;});
  const dm=(id,text)=>runtime.receiveSourceEvent('feishu',{sender:{sender_id:{open_id:'ou_keeper'},sender_type:'user',tenant_key:'orchard'},message:{message_id:id,chat_id:'oc_orchard',chat_type:'p2p',message_type:'text',create_time:'1793491200000',content:JSON.stringify({text})}});
  const prime=async()=>{await runtime.prepareExecution();dm('om_prior','Which varieties did I choose?');await runtime.runNext();await runtime.flushNotifications();dm('om_request','Register these selected varieties in the index');await runtime.runNext();
    return runtime.coordinationStatus().events.find(event=>event.source?.messageId==='om_request');};
  return {runtime,store,turns,runs,dm,prime,setRead:fn=>{onRead=fn;}};
}

test('configured materials without defaults allow ordinary request thread reads and original sent conversation context',async t=>{
  const f=fixture(t),origin=await f.prime();
  f.setRead(({snapshot,facts})=>{
    assert.equal(snapshot.triggers[0].text,'Register these selected varieties in the index');
    const body=JSON.parse(facts[0].text);assert.match(JSON.stringify(body),/selected varieties are pear and plum/);
    assert.equal(body.conversations[0].messages.length,2);
    assert.ok(body.conversations[0].messages[0].replies[0].id);
    assert.deepEqual(snapshot.availableRecords.decisions,[]);
  });
  await f.runtime.runNext();
  const request=origin.receipts.find(r=>r.kind==='request').result;
  const decisions=f.store.db.prepare('SELECT data FROM domain_decisions').all().map(x=>JSON.parse(x.data));
  const accepted=decisions.find(d=>d.triggerIds?.includes(request.triggerId)&&d.kind==='accept');
  assert.ok(accepted);assert.equal(f.runs.length,1);
  assert.equal(f.store.getMeta(`ticket:${accepted.ticketId}`).materialBinding,undefined);
  assert.equal(f.turns.length,2,'real bounded assessor asks for and receives a projected read');
});

test('new ordinary operator conversations retain verified source context without enabling project materials',async t=>{
  const f=fixture(t,{materials:false});await f.prime();
  f.setRead(({facts})=>{assert.match(facts[0].text,/selected varieties are pear and plum/);});
  await f.runtime.runNext();assert.equal(f.runs.length,1);assert.equal(f.runtime.getMaterialSettings().revision,0);
});

test('projection omits future, foreign actor, wrong route and unsent replies',async t=>{
  const f=fixture(t),origin=await f.prime(),prior=f.runtime.coordinationStatus().events.find(e=>e.source?.messageId==='om_prior');
  const originalReply=prior.receipts.find(r=>r.kind==='reply').result.receiptId;
  f.store.db.prepare("UPDATE receipts SET status='pending' WHERE id=?").run(originalReply);
  for(const [id,actor,sequence,chatId] of [['foreign','ou_intruder',origin.sequence-0.5,'oc_orchard'],['future','ou_keeper',origin.sequence+1,'oc_orchard'],['other-chat','ou_keeper',origin.sequence-0.25,'oc_other']]){
    f.store.setMeta(`coordination:event:${id}`,{...prior,id,actor:{...prior.actor,id:actor},sequence,source:{...prior.source,chatId},text:`CANARY_${id}`,receipts:[]});
    f.store.setMeta(`material-event:${id}`,f.store.getMeta(`material-event:${prior.id}`));
  }
  f.setRead(({facts})=>{assert.doesNotMatch(facts[0].text,/CANARY_|selected varieties are pear and plum/);});
  await f.runtime.runNext();assert.equal(f.runs.length,1);
});

test('stale material-derived conversation bodies are hidden and metadata provenance is inherited',async t=>{
  const f=fixture(t),origin=await f.prime(),prior=f.runtime.coordinationStatus().events.find(e=>e.source?.messageId==='om_prior');
  const material=f.runtime.submit({text:'Synthetic private material task',operatorNotifications:false,
    materials:{sources:[{id:'project',view:{kind:'current'}}]}});
  const proof=f.store.getMeta(`material-event:${prior.id}`);
  f.store.setMeta(`material-event:${prior.id}`,{...proof,projectionVersion:1,ticketIds:[material.id],freshTicketIds:[material.id],metadataTicketIds:[],contentVersions:[[material.id,'obsolete-version']]});
  f.store.setMeta(`coordination:event:${prior.id}`,{...prior,text:'STALE_BODY_CANARY'});
  f.setRead(({facts})=>{assert.match(facts[0].text,/materialState/);assert.doesNotMatch(facts[0].text,/STALE_BODY_CANARY|selected varieties are pear and plum/);});
  await f.runtime.runNext();
  const request=origin.receipts.find(r=>r.kind==='request').result;
  const accepted=f.store.db.prepare('SELECT data FROM domain_decisions').all().map(x=>JSON.parse(x.data)).find(d=>d.triggerIds?.includes(request.triggerId)&&d.kind==='accept');
  assert.ok(accepted);
  const meta=f.store.getMeta(`ticket:${accepted.ticketId}`);
  assert.ok(meta.materialContextSources.includes(material.id));
  assert.deepEqual(meta.materialContextFreshSources,[]);
});

test('historical replies completed after the original request are not added retroactively',async t=>{
  const f=fixture(t),origin=await f.prime(),prior=f.runtime.coordinationStatus().events.find(e=>e.source?.messageId==='om_prior');
  f.store.setMeta(`coordination:event:${prior.id}`,{...prior,completedAt:new Date(Date.parse(origin.createdAt)+1000).toISOString()});
  f.setRead(({facts})=>{assert.match(facts[0].text,/Which varieties did I choose/);assert.doesNotMatch(facts[0].text,/selected varieties are pear and plum/);});
  await f.runtime.runNext();assert.equal(f.runs.length,1);
});

test('published projected references match reads and unknown records stay unavailable',()=>{
  let value={key:'local:fixture',triggers:[{id:'input',text:'Choose these'}]};
  const view=createAssessmentRecordView(()=>[{resource:'threads',id:'local:fixture',value}]);
  const candidate={thread:{key:'local:fixture'},triggers:[{id:'input',threads:[]}],tickets:[{id:'hidden',decisionId:'secret'}]};
  const refs=candidateReferences(candidate,[],view.references);
  assert.deepEqual([...refs.tickets],[]);assert.deepEqual([...refs.decisions],[]);
  for(const ref of view.references)assert.equal(view.read(ref.resource,ref.id).id,ref.id);
  assert.throws(()=>view.read('decisions','secret'),{code:ASSESSMENT_CONTEXT_UNAVAILABLE});
  value={...value,triggers:[{id:'input',text:'Changed'}]};
  assert.throws(()=>view.verify(),error=>error.reason==='read-set-version');
});

test('context failure receipts do not claim missing material permission or exempt arbitrary body text',()=>{
  const record={evalId:'eval',triggerIds:['trigger'],failedTriggerIds:['trigger'],status:'failed',code:ASSESSMENT_CONTEXT_UNAVAILABLE,failureKind:'context'};
  const text=assessmentFailureMessage(record);assert.match(text,/会话上下文暂不可用/);assert.doesNotMatch(text,/请求者没有/);
  const message={id:'assessment-result:eval:trigger',kind:'reply',channel:{source:'local',address:{}},text};
  const proof=assessmentTicketReceiptProof(message,{evalId:'eval',triggerId:'trigger',status:'failed'});
  assert.equal(verifyAssessmentTicketReceipt(message,proof,record),true);
  assert.equal(verifyAssessmentTicketReceipt({...message,text:'sensitive invented body'},proof,record),false);
  assert.match(assessmentFailureMessage({...record,code:'MATERIAL_ACCESS_DENIED'}),/请求者没有/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {Store} from '../src/store.mjs';
import {Effects} from '../src/effects.mjs';
import {Outbox} from '../src/outbox.mjs';

const secret='FICTIONAL_ORCHARD_MATERIAL_BODY';
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'material-assessment-receipt-'))),sent=[],network={fail:true};
  writeFileSync(join(root,'notes.md'),secret);
  const api={list:async()=>({code:0,data:{items:[],has_more:false}}),
    get:async request=>({code:0,data:{items:[{message_id:request.path.message_id,chat_id:'oc_fixture'}]}}),
    create:async request=>{if(network.fail)throw new Error('fixture delivery pending');sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`,chat_id:'oc_fixture'}};},
    reply:async request=>{if(network.fail)throw new Error('fixture delivery pending');sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`}};}};
  const sdk={Client:class{constructor(){this.im={message:api};}},EventDispatcher:class{register(){return this;}},WSClient:class{async start(){} close(){}}};
  let callback=input=>({summary:'Forward the original request',actions:input.event.kind==='operator'?[{kind:'request',ticketId:null,text:input.event.text}]:[]});
  let assess=()=>({kind:'accept',title:'Inspect fictional orchard notes',scope:'Read only and report fictional project notes',reason:'Explicit original request',rules:[]});
  const runtime=createProjectAgent({projectRoot:root,feishuSDK:sdk,execution:{driver:'fixture',enableAgentTools:true},
    driver:{capabilities:{agentTools:true,boundedMaterialReadsVersion:1,sessionResume:true},async run(input){
      const sessionId=`worker-${input.runId}`;input.checkpoint({driver:'fixture',id:sessionId});let n=0;
      const refs=()=>input.agentTools.contextResources().filter(ref=>ref.resource==='materials');
      const read=ref=>input.agentTools.call({name:'js_superagent_read',arguments:{resource:'materials',id:ref.id},callId:`read-${++n}`,sessionId,turnId:'fixture-turn'});
      await read(refs().find(ref=>ref.value.kind==='directory'&&ref.value.path==='.'));
      const result=await read(refs().find(ref=>ref.value.kind==='file'&&ref.value.path==='notes.md'));
      return {version:2,state:'waiting',summary:JSON.parse(result.text).text,artifacts:[],attention:null};
    }},assessor:{async assess(input){return assess(input);},
      async handleEvent(input){input.checkpoint({driver:'fixture-assessor',id:input.session?.id??`coordinator-${input.event.id}`});return callback(input);}}}).init();
  process.env.MATERIAL_ASSESSMENT_FEISHU_SECRET='fixture-secret';
  runtime.configure({feishu:{appId:'cli_fixture',appSecretEnv:'MATERIAL_ASSESSMENT_FEISHU_SECRET',botOpenId:'ou_bot',tenantKey:'tenant',
    chats:[{chatId:'oc_group',type:'group',mode:'mentions'}],operator:{openId:'ou_reader'}}});
  const principal={source:'local',id:'operator'};
  runtime.configureMaterials({entries:[{id:'project',project:'self',include:['notes.md'],views:['current'],
    readers:[principal,{source:'feishu',id:'ou_reader'}],destinations:[principal,{source:'feishu',id:'operator'}]}],
    defaults:{sources:[{id:'project',view:{kind:'current'}}]}},{expectedRevision:0});
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},workflowMode:'continuous'},{expectedRevision:0});
  const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
  t.after(async()=>{store.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});rmSync(projectStateDirectory(root),{recursive:true,force:true});});
  const dm=id=>runtime.receiveSourceEvent('feishu',{sender:{sender_id:{open_id:'ou_reader'},sender_type:'user',tenant_key:'tenant'},
    message:{message_id:id,chat_id:'oc_fixture',chat_type:'p2p',message_type:'text',create_time:'1793491200000',content:JSON.stringify({text:'Start a new read-only investigation'})}});
  const accept=async()=>{
    await runtime.prepareExecution();
    const older=runtime.submit({text:'Earlier authorized investigation',operatorNotifications:false});await runtime.runNext();
    dm('om_new_request');
    for(let i=0;i<4&&!runtime.notifications().some(message=>message.id.startsWith('assessment-result:'));i++)await runtime.runNext();
    const message=runtime.notifications().find(message=>message.id.startsWith('assessment-result:'));
    assert.ok(message,'the original Feishu request must be assessed and accepted');
    const meta=store.getMeta(`ticket:${message.ticketId}`);
    assert.ok(meta.runId,'the new Worker has already started');assert.ok(meta.materialObservations.length,'the Worker actually read current material');
    return {message,older,meta};
  };
  const flush=async()=>{network.fail=false;store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run();await runtime.flushNotifications();};
  return {root,runtime,store,sent,network,dm,accept,flush,setCallback:value=>{callback=value;},setAssessment:value=>{assess=value;}};
}

test('fixed acceptance receipts survive Worker startup and reads while preserving all disclosure dependencies',async t=>{
  const f=fixture(t),{message,older,meta}=await f.accept();
  assert.equal(message.status,'pending');
  const proof=f.store.getMeta(`material-message:${message.id}`);
  assert.equal(proof.hostReceipt.status,'accepted');assert.deepEqual(proof.ticketIds,[older.id,meta.id].sort());
  assert.deepEqual(proof.freshTicketIds,[]);assert.deepEqual(proof.contentVersions,[]);
  await f.flush();
  assert.equal(f.runtime.notifications().find(item=>item.id===message.id).status,'sent');
  assert.ok(f.sent.some(request=>request.data.content.includes(message.text)));
  assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,0);
});

test('fixed acceptance receipts still stop after grant revocation',async t=>{
  const f=fixture(t),{message}=await f.accept();
  f.runtime.configureMaterials({entries:[]},{expectedRevision:1});await f.flush();
  assert.equal(f.runtime.notifications().find(item=>item.id===message.id).status,'dropped');
  assert.ok(f.sent.every(request=>!request.data.content.includes(message.text)));
});

test('fixed attachment receipts use their original assessment after the existing ticket starts a new run',async t=>{
  const f=fixture(t),{message,meta}=await f.accept(),previousRun=meta.runId;
  f.dm('om_attach_request');await f.runtime.runNext();
  const origin=f.runtime.coordinationStatus().events.find(event=>event.source?.messageId==='om_attach_request');
  const request=origin.receipts.find(receipt=>receipt.kind==='request').result;
  const trigger=f.store.triggers.get(request.triggerId),thread=f.store.threads.get(`${trigger.threads[0].source}:${trigger.threads[0].id}`);
  thread.subscriptions=[meta.id];thread.context=[];f.store.threads.save(thread);
  f.setAssessment(input=>({kind:'attach',triggerId:input.candidate.triggers[0].id,ticketId:meta.id,reason:'Continue within the existing mandate',rules:[]}));
  await f.runtime.runNext();
  const attached=f.runtime.notifications().find(item=>item.id.startsWith('assessment-result:')&&item.id!==message.id);
  assert.ok(attached);assert.equal(f.store.getMeta(`material-message:${attached.id}`).hostReceipt.status,'attached');
  assert.notEqual(f.store.getMeta(`ticket:${meta.id}`).runId,previousRun);
  await f.flush();
  for(const id of [message.id,attached.id])assert.equal(f.runtime.notifications().find(item=>item.id===id).status,'sent');
  assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,0);
});

test('fixed acceptance receipts still stop when the concrete operator changes',async t=>{
  const f=fixture(t),{message}=await f.accept();
  await f.runtime.stop();f.runtime.configureV2({feishu:{operator:{openId:'ou_other'}}});await f.runtime.prepareExecution();await f.flush();
  const result=f.runtime.notifications().find(item=>item.id===message.id);
  assert.equal(result.status,'dropped');assert.equal(result.terminal.reason,'MATERIAL_ROUTE_CHANGED');
  assert.ok(f.sent.every(request=>!request.data.content.includes(message.text)));
});

test('an edited host receipt or a copied receipt identity cannot exempt material body text',async t=>{
  const f=fixture(t),{message}=await f.accept();
  const edited={...message,text:secret};delete edited.status;
  f.store.db.prepare('UPDATE receipts SET data=? WHERE id=?').run(JSON.stringify(edited),message.id);
  const forged={...edited,id:'assessment-result:forged:forged'};
  f.store.setMeta(`material-message:${forged.id}`,f.store.getMeta(`material-message:${message.id}`));
  new Outbox(f.store,new Effects(f.store)).send(forged);await f.flush();
  for(const id of [message.id,forged.id]){
    const result=f.runtime.notifications().find(item=>item.id===id);
    assert.equal(result.status,'dropped');assert.equal(result.terminal.reason,'MATERIAL_RECEIPT_INVALID');
  }
  assert.ok(f.sent.every(request=>!request.data.content.includes(secret)));
});

test('ordinary coordinator material bodies retain their observation stamp requirement',async t=>{
  const f=fixture(t);await f.accept();
  f.setCallback(()=>({summary:secret,actions:[{kind:'reply',ticketId:null,text:secret}]}));
  f.dm('om_body_reply');await f.runtime.runNext();
  const body=f.runtime.notifications().find(item=>item.channel.source==='feishu'&&item.text===secret);
  assert.ok(body);assert.equal(body.status,'pending');
  const proof=f.store.getMeta(`material-message:${body.id}`);
  assert.equal(proof.hostReceipt,undefined);assert.ok(proof.freshTicketIds.length);assert.ok(proof.contentVersions.length);
  writeFileSync(join(f.root,'notes.md'),'Changed fictional orchard facts');await f.flush();
  const result=f.runtime.notifications().find(item=>item.id===body.id);
  assert.equal(result.status,'dropped');assert.equal(result.terminal.reason,'MATERIAL_CHANGED');
  assert.ok(f.sent.every(request=>!request.data.content.includes(secret)));
});

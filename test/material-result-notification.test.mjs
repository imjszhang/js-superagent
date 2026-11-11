import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {Store} from '../src/store.mjs';

test('a new completed material investigation reaches Feishu while an earlier investigation is stale',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'material-result-notification-')));
  const oldText='ARCHIVED_ORCHARD_REPORT',currentText='CURRENT_ORCHARD_REPORT',sent=[],events=[];
  writeFileSync(join(root,'notes.md'),oldText);
  const api={list:async()=>({code:0,data:{items:[],has_more:false}}),
    get:async request=>({code:0,data:{items:[{message_id:request.path.message_id,chat_id:'oc_fixture'}]}}),
    create:async request=>{sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`,chat_id:'oc_fixture'}};},
    reply:async request=>{sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`}};}};
  const sdk={Client:class{constructor(){this.im={message:api};}},EventDispatcher:class{register(){return this;}},WSClient:class{async start(){} close(){}}};
  let target;
  const runtime=createProjectAgent({projectRoot:root,feishuSDK:sdk,execution:{driver:'fixture',enableAgentTools:true},
    driver:{capabilities:{agentTools:true,boundedMaterialReadsVersion:1,sessionResume:true},async run(input){
      const sessionId=`worker-${input.runId}`;input.checkpoint({driver:'fixture',id:sessionId});let n=0;
      const refs=()=>input.agentTools.contextResources().filter(ref=>ref.resource==='materials');
      const read=ref=>input.agentTools.call({name:'js_superagent_read',arguments:{resource:'materials',id:ref.id},callId:`read-${++n}`,sessionId,turnId:'fixture-turn'});
      await read(refs().find(ref=>ref.value.kind==='directory'&&ref.value.path==='.'));
      const result=await read(refs().find(ref=>ref.value.kind==='file'&&ref.value.path==='notes.md'));
      return {version:2,state:'ready',summary:JSON.parse(result.text).text,artifacts:[],attention:null};
    }},assessor:{async assess(){return {kind:'ignore',reason:'No new work',rules:[]};},async handleEvent(input){
      events.push(input);input.checkpoint({driver:'fixture-assessor',id:input.session?.id??`coordinator-${events.length}`});
      if(!target)return {summary:oldText,actions:[{kind:'reply',ticketId:null,text:oldText}]};
      assert.equal(input.event.kind,'result');assert.equal(input.event.ticketId,target.id);
      assert.equal(input.context.operatorNotification.required,true);
      assert.doesNotMatch(JSON.stringify(input.context),new RegExp(oldText));
      assert.match(JSON.stringify(input.context),new RegExp(currentText));
      return {summary:'Deliver the current result',actions:[{kind:'notify',ticketId:target.id,text:currentText}]};
    }}}).init();
  process.env.MATERIAL_RESULT_FEISHU_SECRET='fixture-secret';
  runtime.configure({feishu:{appId:'cli_fixture',appSecretEnv:'MATERIAL_RESULT_FEISHU_SECRET',botOpenId:'ou_bot',tenantKey:'tenant',
    chats:[{chatId:'oc_group',type:'group',mode:'mentions'}],operator:{openId:'ou_reader'}}});
  const principal={source:'local',id:'operator'};
  runtime.configureMaterials({entries:[{id:'project',project:'self',include:['notes.md'],views:['current'],readers:[principal],destinations:[principal,{source:'feishu',id:'operator'}]}]},{expectedRevision:0});
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},workflowMode:'continuous'},{expectedRevision:0});
  const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
  t.after(async()=>{store.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});rmSync(projectStateDirectory(root),{recursive:true,force:true});});
  await runtime.prepareExecution();
  const materialBinding={sources:[{id:'project',view:{kind:'current'}}]};
  const older=runtime.submit({text:'Earlier fictional investigation',materials:materialBinding,operatorNotifications:false});
  await runtime.runNext();assert.equal(runtime.get(older.id).status,'completed');
  runtime.coordinate({id:'prime-history',text:'Read the earlier result'});await runtime.runNext();
  assert.match(JSON.stringify(events.at(-1).context),new RegExp(oldText));
  writeFileSync(join(root,'notes.md'),currentText);
  target=runtime.submit({text:'Investigate current fictional notes',materials:materialBinding});
  await runtime.runNext();assert.equal(runtime.get(target.id).status,'completed');
  for(let i=0;i<4&&!events.some(input=>input.event.kind==='result'&&input.event.ticketId===target.id);i++)await runtime.runNext();
  await runtime.flushNotifications();
  const completion=events.find(input=>input.event.kind==='result'&&input.event.ticketId===target.id);
  assert.ok(completion,'completed work must reach the coordinator');
  const historical=completion.context.tickets.find(card=>card.id===older.id);
  assert.ok(historical,'the earlier ticket must remain visible as metadata');
  const notification=runtime.notifications().find(message=>message.channel.source==='feishu'&&message.text.includes(currentText));
  assert.ok(notification,'the notify action must queue the result for Feishu');
  assert.equal(notification.status,'sent');
  assert.ok(sent.some(request=>request.data.content.includes(currentText)),'the transport must actually receive the new report');
  assert.ok(sent.every(request=>!request.data.content.includes(oldText)));
  const proof=store.getMeta(`material-message:${notification.id}`);
  assert.equal(proof.projectionVersion,1);
  assert.ok(proof.ticketIds.includes(target.id));
  assert.ok(proof.ticketIds.includes(older.id),'legacy readers must still enforce metadata disclosure authority');
  assert.ok(proof.freshTicketIds.includes(target.id));
  assert.ok(!proof.freshTicketIds.includes(older.id),'metadata must not inherit the old body freshness obligation');
  assert.equal(runtime.notifications().filter(message=>message.id.startsWith('material-notice:')).length,0);
});

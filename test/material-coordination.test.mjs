import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {ensureProjectIdentity} from '../src/project-identity.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {Store} from '../src/store.mjs';
import {Effects} from '../src/effects.mjs';
import {Outbox} from '../src/outbox.mjs';
import {CoordinationInbox} from '../src/runtime/coordination.mjs';
import {MATERIAL_NOTICE_TEXT,materialWithdrawalNotice} from '../src/runtime/material-notice.mjs';

const principal={source:'local',id:'operator'}, secret='SYNTHETIC_MATERIAL_CANARY';
function fixture(t,{external=false,feishu=false,question=false}={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'material-coordination-')));
  const source=external?realpathSync(mkdtempSync(join(tmpdir(),'material-source-'))):root;
  writeFileSync(join(source,'notes.md'),secret);
  const sourceIdentity=external?ensureProjectIdentity(source,'fixture-source'):null,events=[],assessments=[],sent=[];
  const network={fail:true};
  const api={list:async()=>({code:0,data:{items:[],has_more:false}}),get:async request=>({code:0,data:{items:[{message_id:request.path.message_id,chat_id:'oc_dm'}]}}),
    reply:async request=>{if(network.fail)throw new Error('fixture network unavailable');sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`}};},
    create:async request=>{if(network.fail)throw new Error('fixture network unavailable');sent.push(request);return {code:0,data:{message_id:`om_sent_${sent.length}`,chat_id:'oc_dm'}};}};
  const feishuSDK={Client:class {constructor(){this.im={message:api};}},EventDispatcher:class {register(){return this;}},WSClient:class {async start(){} close(){}}};
  let callback=input=>({summary:'Observed material context',actions:input.event.source?.channel==='feishu'?[]:[{kind:'reply',ticketId:null,text:input.context.tickets.some(card=>card.summary?.includes(secret))?secret:'No disclosed material'}]});
  let assessmentCallback=()=>({kind:'ignore',reason:'No new work',rules:[]});
  const runtime=createProjectAgent({projectRoot:root,...(feishu?{feishuSDK}:{}),execution:{driver:'fixture',enableAgentTools:true},driver:{capabilities:{agentTools:true,boundedMaterialReadsVersion:1,sessionResume:true},async run(input){
    input.checkpoint({driver:'fixture',id:'material-worker'});
    if(input.agentTools.contextResources().some(ref=>ref.resource==='materials')){
      let n=0;const read=ref=>input.agentTools.call({name:'js_superagent_read',arguments:{resource:'materials',id:ref.id},callId:`read-${++n}`,sessionId:'material-worker',turnId:'turn-one'});
      await read(input.agentTools.contextResources().find(ref=>ref.resource==='materials'&&ref.value.kind==='directory'));
      await read(input.agentTools.contextResources().find(ref=>ref.resource==='materials'&&ref.value.kind==='file'));
    }
    return {version:2,state:'waiting',summary:secret,artifacts:[],attention:question?{question:secret}:null};
  }},assessor:{async assess(input){assessments.push(input);input.checkpoint({driver:'fixture-assessor',id:input.session?.id??`candidate-${assessments.length}`});return assessmentCallback(input);},async handleEvent(input){
    events.push(input);input.checkpoint({driver:'fixture-assessor',id:input.session?.id??`coordinator-${events.length}`});return callback(input);
  }}}).init();
  const settings={entries:[{id:'project',project:external?{root:source,projectId:sourceIdentity.projectId,instanceId:sourceIdentity.instanceId}:'self',include:['notes.md'],views:['current'],readers:[principal],destinations:[principal]}]};
  runtime.configureMaterials(settings,{expectedRevision:0});
  if(feishu){process.env.MATERIAL_TEST_FEISHU_SECRET='fixture-secret';runtime.configure({feishu:{appId:'cli_fixture',appSecretEnv:'MATERIAL_TEST_FEISHU_SECRET',botOpenId:'ou_bot',tenantKey:'tenant',chats:[{chatId:'oc_group',type:'group',mode:'mentions'}],operator:{openId:'ou_alice'}}});}
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},workflowMode:'continuous'},{expectedRevision:0});
  const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
  const enqueue=value=>new CoordinationInbox(store).enqueue(value);
  t.after(async()=>{store.close();await runtime.stop();runtime.close();for(const value of new Set([root,source])){rmSync(value,{recursive:true,force:true});rmSync(projectStateDirectory(value),{recursive:true,force:true});}});
  const submit=()=>runtime.submit({text:'Inspect authorized synthetic material',materials:{sources:[{id:'project',view:{kind:'current'}}]}});
  const queue=(id,ticketId,proof)=>{
    if(proof)store.setMeta(`material-message:${id}`,proof);
    new Outbox(store,new Effects(store)).send({id,kind:'reply',...(ticketId?{ticketId}:{}),channel:{source:'local',thread:id,address:{}},text:secret});
  };
  const dm=(id,from,text)=>runtime.receiveSourceEvent('feishu',{sender:{sender_id:{open_id:from},sender_type:'user',tenant_key:'tenant'},message:{message_id:id,chat_id:'oc_dm',chat_type:'p2p',message_type:'text',create_time:'1793491200000',content:JSON.stringify({text})}});
  return {root,source,runtime,events,assessments,settings,store,enqueue,submit,queue,dm,sent,network,setCallback:value=>callback=value,setAssessmentCallback:value=>assessmentCallback=value};
}

test('candidate assessment receives stale ticket metadata and cannot expand its old body',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  writeFileSync(join(f.source,'notes.md'),'changed after historical investigation');
  const request=f.runtime.request({text:'A new user request with independent authority',threadId:'candidate-history'});
  const thread=f.store.threads.get('local:candidate-history');thread.subscriptions=[ticket.id];thread.context=[ticket.id];f.store.threads.save(thread);
  let called=false;
  f.setAssessmentCallback(async input=>{
    called=true;assert.equal(input.candidate.triggers[0].text,'A new user request with independent authority');
    const card=input.candidate.tickets.find(card=>card.id===ticket.id);assert.equal(card.materialState,'stale');
    assert.doesNotMatch(JSON.stringify(input.candidate),new RegExp(secret));
    const record=await input.readContextRecord('tickets',ticket.id);assert.notEqual(record.missing,true);
    assert.equal(JSON.parse(record.text).materialState,'stale');assert.doesNotMatch(record.text,new RegExp(secret));
    return {kind:'ignore',reason:'No new work',rules:[]};
  });
  await f.runtime.runNext();assert.ok(called);
  const assessment=f.store.getMeta(`assessment:${f.store.getMeta(`assessment-trigger:${request.triggerId}`).evalId}`);
  assert.equal(assessment.status,'finished');assert.deepEqual(assessment.materialSources,[ticket.id]);assert.deepEqual(assessment.materialFreshSources,[]);
});

test('stale request cards omit original text and assessment freeform reasons',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  f.setCallback(input=>({summary:secret,actions:[{kind:'request',ticketId:null,text:input.event.text}]}));
  f.runtime.coordinate({id:'origin-request',text:'ORIGINAL_REQUEST_CANARY'});await f.runtime.runNext();
  const request=f.runtime.coordinationStatus().events.find(event=>event.id==='origin-request').receipts.find(item=>item.kind==='request').result;
  f.setAssessmentCallback(()=>({kind:'ignore',reason:`ASSESSMENT_REASON_${secret}`,rules:[]}));await f.runtime.runNext();
  writeFileSync(join(f.source,'notes.md'),'current changed content');
  let inspected=false;
  f.setCallback(input=>{
    inspected=true;const record=input.readContext({resource:'requests',recordId:request.triggerId});
    assert.notEqual(record.missing,true);const card=JSON.parse(record.text);assert.equal(card.materialState,'stale');
    for(const field of ['text','summary','reason','message'])assert.equal(Object.hasOwn(card,field),false);
    assert.doesNotMatch(JSON.stringify(input.context),/ORIGINAL_REQUEST_CANARY|SYNTHETIC_MATERIAL_CANARY/);
    assert.equal(input.readContext({resource:'requests',query:'ASSESSMENT_REASON'}).total,0);
    return {summary:'The earlier request remains recorded; its prior content is stale',actions:[{kind:'reply',ticketId:null,text:'The request exists; a new investigation is needed for current facts.'}]};
  });
  f.runtime.coordinate({id:'request-status',text:'What is the request status?'});await f.runtime.runNext();assert.ok(inspected);
  const message=f.runtime.notifications().find(message=>message.text==='The request exists; a new investigation is needed for current facts.');assert.equal(message.status,'sent');
  assert.ok(f.store.getMeta(`material-message:${message.id}`).ticketIds.includes(ticket.id));
});

test('fresh material readers expose the current report without older assignment and message bodies',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  const domain=f.runtime.getDomainTicket(ticket.id),meta=f.store.getMeta(`ticket:${ticket.id}`);
  domain.assignments.unshift({...domain.assignments.at(-1),id:'historical-assignment',report:{version:2,state:'waiting',summary:'OLDER_REPORT_CANARY',artifacts:[],attention:null}});
  meta.messages.push({text:'OLDER_MESSAGE_CANARY',at:new Date().toISOString()});f.store.tickets.save(domain);f.store.setMeta(`ticket:${ticket.id}`,meta);
  f.setCallback(input=>{
    const value=input.readContext({resource:'tickets',recordId:ticket.id});assert.match(value.text,new RegExp(secret));
    assert.doesNotMatch(value.text,/OLDER_REPORT_CANARY|OLDER_MESSAGE_CANARY/);
    assert.equal(input.readContext({resource:'tickets',query:'OLDER_REPORT_CANARY'}).total,0);
    return {summary:'Only the current report is available',actions:[]};
  });
  f.runtime.coordinate({id:'fresh-current-only',text:'Read the latest report'});await f.runtime.runNext();
  assert.equal(f.runtime.coordinationStatus().events.find(event=>event.id==='fresh-current-only').status,'completed');
});

test('replacing the Feishu operator separates sessions, historical summaries and queued material replies',async t=>{
  const f=fixture(t,{feishu:true}),oldSummary='PRIVATE_OLD_OPERATOR_SUMMARY';
  f.runtime.configureMaterials({entries:f.settings.entries.map(entry=>({...entry,destinations:[principal,{source:'feishu',id:'operator'}]}))},{expectedRevision:1});
  const ticket=f.submit();await f.runtime.runNext();await f.runtime.prepareExecution();
  f.setCallback(input=>({summary:oldSummary,actions:[{kind:'reply',ticketId:null,text:oldSummary}]}));
  f.dm('om_alice_one','ou_alice','Inspect material');await f.runtime.runNext();
  f.dm('om_alice_two','ou_alice','Inspect again');await f.runtime.runNext();
  assert.ok(f.events.at(-1).session,'same operator resumes the same session across different message IDs');
  assert.match(JSON.stringify(f.events.at(-1).context),new RegExp(oldSummary));
  const oldMessages=f.runtime.notifications().filter(message=>message.text===oldSummary);
  assert.equal(oldMessages.length,2);
  assert.ok(oldMessages.every(message=>f.store.getMeta(`material-message:${message.id}`).route.openId==='ou_alice'));
  const oldEvent=f.runtime.coordinationStatus().events.find(event=>event.source?.messageId==='om_alice_one');
  assert.equal(f.store.getMeta(`material-event:${oldEvent.id}`).route.openId,'ou_alice');
  f.dm('om_alice_queued','ou_alice','Old pending private input');
  await f.runtime.stop();f.runtime.configureV2({feishu:{operator:{openId:'ou_bob'}}});await f.runtime.prepareExecution();
  f.setCallback(input=>{
    assert.equal(input.session,undefined);assert.doesNotMatch(JSON.stringify(input.context),new RegExp(oldSummary));
    assert.doesNotMatch(JSON.stringify(input.context),new RegExp(secret));assert.equal(input.context.tickets.length,0);
    assert.equal(input.readContext({resource:'tickets',query:secret}).items.length,0);
    assert.equal(input.readContext({resource:'tickets',recordId:ticket.id}).missing,true);
    assert.ok(input.context.recentEvents.every(event=>event.id!==oldEvent.id));
    return {summary:'Fresh operator session',actions:[]};
  });
  f.dm('om_bob_one','ou_bob','Inspect current material');await f.runtime.runNext();await f.runtime.runNext();
  assert.equal(f.runtime.coordinationStatus().events.find(event=>event.source?.messageId==='om_alice_queued').status,'failed');
  assert.equal(f.events.length,3);f.network.fail=false;
  f.store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run();await f.runtime.flushNotifications();
  for(const message of oldMessages)assert.equal(f.runtime.notifications().find(item=>item.id===message.id).status,'dropped');
  assert.equal(f.sent.length,0);assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,0);
});

test('legacy remote material proofs cannot be adopted by the current operator',async t=>{
  const f=fixture(t,{feishu:true});
  f.runtime.configureMaterials({entries:f.settings.entries.map(entry=>({...entry,destinations:[principal,{source:'feishu',id:'operator'}]}))},{expectedRevision:1});
  const ticket=f.submit();await f.runtime.runNext();await f.runtime.prepareExecution();f.store.setMeta('feishu:operator-chat',{chatId:'oc_dm'});
  const channel={source:'feishu',thread:'tenant:oc_dm:operator',address:{sourceId:'feishu',tenantKey:'tenant',chatId:'oc_dm',messageId:'om_legacy',operator:'true'}};
  f.store.setMeta('material-message:legacy-message',{revision:2,destination:{source:'feishu',id:'operator'},ticketIds:[ticket.id]});
  new Outbox(f.store,new Effects(f.store)).send({id:'legacy-message',kind:'reply',channel,text:secret});
  f.network.fail=false;await f.runtime.flushNotifications();
  const message=f.runtime.notifications().find(item=>item.id==='legacy-message');
  assert.equal(message.status,'dropped');assert.equal(message.terminal.reason,'MATERIAL_ROUTE_CHANGED');assert.equal(f.sent.length,0);
});

test('host material questions bind the recipient on enqueue and survive learning the same operator chat',async t=>{
  const f=fixture(t,{feishu:true,question:true});
  f.runtime.configureMaterials({entries:f.settings.entries.map(entry=>({...entry,destinations:[principal,{source:'feishu',id:'operator'}]}))},{expectedRevision:1});
  const ticket=f.submit();await f.runtime.runNext();await f.runtime.prepareExecution();
  const question=f.runtime.notifications().find(message=>message.channel.source==='feishu'&&message.ticketId===ticket.id);
  assert.ok(question);assert.equal(question.status,'pending');
  const proof=f.store.getMeta(`material-message:${question.id}`);
  assert.deepEqual(proof.ticketIds,[ticket.id]);assert.equal(proof.route.openId,'ou_alice');assert.equal(proof.route.chatId,null);
  f.dm('om_learn_chat','ou_alice','Check question');await f.runtime.runNext();
  f.network.fail=false;f.store.db.prepare("UPDATE effects SET due=0 WHERE kind='reply'").run();await f.runtime.flushNotifications();
  assert.equal(f.runtime.notifications().find(message=>message.id===question.id).status,'sent');
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.receive_id,'ou_alice');
});

test('queued local material output is withdrawn after source grant revocation',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  f.queue('queued-result',ticket.id);
  f.runtime.configureMaterials({entries:[]},{expectedRevision:1});
  await f.runtime.flushNotifications();
  const receipt=f.runtime.notifications().find(item=>item.id==='queued-result');
  assert.equal(receipt.status,'dropped');assert.equal(receipt.terminal.status,'withdrawn');
  const notices=f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:'));
  assert.equal(notices.length,1);assert.equal(notices[0].status,'sent');assert.equal(notices[0].text,MATERIAL_NOTICE_TEXT);
  assert.doesNotMatch(notices[0].text,new RegExp(secret));
  await f.runtime.flushNotifications();assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,1);
});

test('queued coordinator material summary rechecks current observations even without a ticket ID',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  f.queue('queued-summary',null,{revision:1,destination:principal,ticketIds:[ticket.id]});
  writeFileSync(join(f.source,'notes.md'),'new version after summary');
  await f.runtime.flushNotifications();
  const receipt=f.runtime.notifications().find(item=>item.id==='queued-summary');
  assert.equal(receipt.status,'dropped');assert.equal(receipt.terminal.reason,'MATERIAL_CHANGED');
  assert.equal(f.runtime.notifications().find(item=>item.id.startsWith('material-notice:')).text,MATERIAL_NOTICE_TEXT);
});

test('a different destination cannot see material tickets, prior summaries or their coordinator session',async t=>{
  const f=fixture(t);f.submit();await f.runtime.runNext();
  f.runtime.coordinate({id:'local-query',text:'Summarize the current investigation'});await f.runtime.runNext();
  assert.match(JSON.stringify(f.events.at(-1).context),new RegExp(secret));
  const localSession=f.events.at(-1).session;
  f.setCallback(input=>{
    assert.doesNotMatch(JSON.stringify(input.context),new RegExp(secret));
    assert.equal(input.context.tickets.length,0);
    const hidden=input.readContext({resource:'tickets',query:secret});assert.equal(hidden.items.length,0);
    assert.equal(input.readContext({resource:'decisions',query:secret}).items.length,0);
    assert.equal(input.session,undefined);return {summary:'No authorized material context',actions:[]};
  });
  f.enqueue({id:'other-destination',kind:'operator',actor:{source:'feishu',kind:'human',id:'other'},source:{channel:'feishu',chatId:'external'},text:'Status?'});
  await f.runtime.runNext();assert.equal(f.events.length,2);assert.equal(localSession,undefined);
});

test('source identity changes invalidate historical summaries and coordinator sessions without a settings edit',async t=>{
  const f=fixture(t,{external:true});f.submit();await f.runtime.runNext();
  f.runtime.coordinate({id:'first-query',text:'Read material status'});await f.runtime.runNext();
  f.runtime.coordinate({id:'second-query',text:'Read material status again'});await f.runtime.runNext();
  assert.ok(f.events.at(-1).session);
  const identityFile=join(projectStateDirectory(f.source),'instance.json'),identity=JSON.parse(readFileSync(identityFile,'utf8'));
  writeFileSync(identityFile,JSON.stringify({...identity,instanceId:'replacement-source-instance'}));
  f.setCallback(input=>{assert.equal(input.session,undefined);assert.doesNotMatch(JSON.stringify(input.context),new RegExp(secret));return {summary:'Source requires inspection',actions:[]};});
  f.runtime.coordinate({id:'changed-source',text:'Read material status now'});await f.runtime.runNext();
  assert.equal(f.events.length,3);assert.equal(f.runtime.getMaterialSettings().revision,1);
});

test('material coordinator history is not inherited by candidate assessment and original input stays intact',async t=>{
  const f=fixture(t);f.submit();await f.runtime.runNext();
  f.runtime.coordinate({id:'knowledge-query',text:'Read material status'});await f.runtime.runNext();
  const request=f.runtime.request({text:'Unrelated original user request'});await f.runtime.runNext();
  assert.equal(f.assessments.length,1);assert.equal(f.assessments[0].session,undefined);
  assert.equal(f.assessments[0].candidate.triggers[0].text,'Unrelated original user request');
  assert.equal(f.assessments[0].candidate.triggers[0].id,request.triggerId);
});

test('an unauthorized result event never passes its raw material text to the coordinator',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  f.enqueue({id:'restricted-result',kind:'result',ticketId:ticket.id,text:secret,requiresCoordination:true,source:{channel:'feishu'}});
  await f.runtime.runNext();
  assert.equal(f.events.length,0);
  assert.equal(f.runtime.coordinationStatus().events.find(event=>event.id==='restricted-result').status,'failed');
});

test('a coordinator note retains its material provenance when attached to an unbound ticket',async t=>{
  const f=fixture(t),source=f.submit();await f.runtime.runNext();
  const target=f.runtime.submit({text:'Existing unbound task'});
  f.setCallback(()=>({summary:'Attach relevant context',actions:[{kind:'note',ticketId:target.id,text:secret}]}));
  f.runtime.coordinate({id:'attach-context',text:'Give the existing task this context'});await f.runtime.runNext();
  assert.deepEqual(f.store.getMeta(`ticket:${target.id}`).materialContextSources,[source.id]);
  f.setCallback(input=>{assert.equal(input.context.tickets.length,0);assert.doesNotMatch(JSON.stringify(input.context),new RegExp(secret));return {summary:'No disclosed context',actions:[]};});
  f.enqueue({id:'remote-after-note',kind:'operator',actor:{source:'feishu',kind:'human',id:'other'},source:{channel:'feishu'},text:'Status?'});
  await f.runtime.runNext();assert.equal(f.events.length,2);
});

test('legacy body proofs without observation identity stay hidden and cannot send',async t=>{
  const f=fixture(t),source=f.submit();await f.runtime.runNext();
  const oldSummary='LEGACY_UNATTESTED_SUMMARY';
  f.setCallback(()=>({summary:oldSummary,actions:[]}));
  f.runtime.coordinate({id:'legacy-body-origin',text:'Inspect earlier source'});await f.runtime.runNext();
  const proof=f.store.getMeta('material-event:legacy-body-origin');delete proof.contentVersions;
  f.store.setMeta('material-event:legacy-body-origin',proof);
  f.setCallback(input=>{
    const old=input.context.recentEvents.find(event=>event.id==='legacy-body-origin');
    assert.equal(old.materialState,'stale');assert.equal(Object.hasOwn(old,'summary'),false);
    assert.doesNotMatch(JSON.stringify(input.context),new RegExp(oldSummary));
    return {summary:'Legacy source content has no observation identity',actions:[]};
  });
  f.runtime.coordinate({id:'legacy-body-status',text:'Inspect recorded status'});await f.runtime.runNext();
  assert.equal(f.runtime.coordinationStatus().events.find(event=>event.id==='legacy-body-status').status,'completed');
  f.queue('legacy-proofless-body',source.id);await f.runtime.flushNotifications();
  const message=f.runtime.notifications().find(item=>item.id==='legacy-proofless-body');
  assert.equal(message.status,'dropped');assert.equal(message.terminal.reason,'MATERIAL_CHANGED');
});

test('rereading a source does not replace inherited body observation identity',async t=>{
  const f=fixture(t),source=f.submit();await f.runtime.runNext();
  const target=f.runtime.submit({text:'Existing task receiving source facts'});await f.runtime.runNext();
  f.setCallback(()=>({summary:'Transfer source facts',actions:[{kind:'note',ticketId:target.id,text:secret}]}));
  f.runtime.coordinate({id:'inherit-source-body',text:'Give the task these facts'});await f.runtime.runNext();
  const versions=f.store.getMeta(`ticket:${target.id}`).materialContextContentVersions;
  assert.equal(versions.length,1);assert.equal(versions[0][0],source.id);assert.equal(typeof versions[0][1],'string');
  await f.runtime.runNext();
  const firstRun=f.store.getMeta(`ticket:${source.id}`).runId;
  writeFileSync(join(f.source,'notes.md'),'New source observation');
  f.runtime.note(source.id,'Read the changed source within the existing mandate');await f.runtime.runNext();
  assert.notEqual(f.store.getMeta(`ticket:${source.id}`).runId,firstRun);
  assert.deepEqual(f.store.getMeta(`ticket:${target.id}`).materialContextContentVersions,versions);
  f.setCallback(input=>{
    const card=input.context.tickets.find(item=>item.id===target.id);
    assert.equal(card.materialState,'stale');assert.equal(Object.hasOwn(card,'summary'),false);
    assert.doesNotMatch(input.readContext({resource:'tickets',recordId:target.id}).text,new RegExp(secret));
    return {summary:'Inherited facts require a new investigation',actions:[]};
  });
  f.runtime.coordinate({id:'inherited-body-status',text:'Check the dependent task'});await f.runtime.runNext();
  assert.equal(f.runtime.coordinationStatus().events.find(event=>event.id==='inherited-body-status').status,'completed');
  f.runtime.note(target.id,'Continue with the existing note');await f.runtime.runNext();
  assert.equal(f.runtime.get(target.id).status,'failed');
  assert.deepEqual(f.store.getMeta(`ticket:${target.id}`).materialContextContentVersions,versions);
});

test('material-derived notes are rejected before reaching a Worker with an unauthorized output channel',async t=>{
  const f=fixture(t);f.submit();await f.runtime.runNext();
  const target=f.runtime.submit({text:'Existing task with a public discussion'}),domain=f.runtime.getDomainTicket(target.id);
  domain.channels.push({source:'github',thread:'example/public#1',address:{repository:'example/public',issueNumber:'1'}});f.store.tickets.save(domain);
  f.setCallback(()=>({summary:'Proposed contextual note',actions:[{kind:'note',ticketId:target.id,text:secret}]}));
  f.runtime.coordinate({id:'reject-public-note',text:'Pass the source context to the task'});await f.runtime.runNext();
  assert.equal(f.runtime.coordinationStatus().events.find(event=>event.id==='reject-public-note').status,'failed');
  assert.ok(f.runtime.getDomainTicket(target.id).inputs.every(input=>input.kind!=='note'||input.text!==secret));
  assert.equal(f.store.getMeta(`ticket:${target.id}`).materialContextSources,undefined);
});

test('a forged or edited host-notice payload cannot bypass material checks or recursively generate notices',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  f.queue('material-notice:forged',ticket.id);
  await f.runtime.flushNotifications();
  assert.equal(f.runtime.notifications().find(item=>item.id==='material-notice:forged').status,'dropped');
  assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,1);
  const original={id:'original-forged-body',kind:'reply',ticketId:ticket.id,channel:{source:'local',thread:'fixture',address:{}},text:secret};
  const notice=materialWithdrawalNotice(original,[ticket.id],{source:'local'});
  f.store.setMeta(`material-host-notice:${notice.message.id}`,notice.proof);
  new Outbox(f.store,new Effects(f.store)).send({...notice.message,text:secret});await f.runtime.flushNotifications();
  assert.equal(f.runtime.notifications().find(item=>item.id===notice.message.id).status,'dropped');
  assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,2);
});

test('a withdrawn task mandate suppresses new material-change notices',async t=>{
  const f=fixture(t),ticket=f.submit();await f.runtime.runNext();
  f.queue('cancelled-result',ticket.id);f.runtime.cancel(ticket.id);
  f.runtime.configureMaterials({entries:[]},{expectedRevision:1});await f.runtime.flushNotifications();
  assert.equal(f.runtime.notifications().find(item=>item.id==='cancelled-result').status,'dropped');
  assert.equal(f.runtime.notifications().filter(item=>item.id.startsWith('material-notice:')).length,0);
});

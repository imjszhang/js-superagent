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
function fixture(t,{external=false}={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'material-coordination-')));
  const source=external?realpathSync(mkdtempSync(join(tmpdir(),'material-source-'))):root;
  writeFileSync(join(source,'notes.md'),secret);
  const sourceIdentity=external?ensureProjectIdentity(source,'fixture-source'):null,events=[],assessments=[];
  let callback=input=>({summary:'Observed material context',actions:input.event.source?.channel==='feishu'?[]:[{kind:'reply',ticketId:null,text:input.context.tickets.some(card=>card.summary?.includes(secret))?secret:'No disclosed material'}]});
  const runtime=createProjectAgent({projectRoot:root,execution:{driver:'fixture',enableAgentTools:true},driver:{capabilities:{agentTools:true,boundedMaterialReadsVersion:1,sessionResume:true},async run(input){
    input.checkpoint({driver:'fixture',id:'material-worker'});
    if(input.agentTools.contextResources().some(ref=>ref.resource==='materials')){
      let n=0;const read=ref=>input.agentTools.call({name:'js_superagent_read',arguments:{resource:'materials',id:ref.id},callId:`read-${++n}`,sessionId:'material-worker',turnId:'turn-one'});
      await read(input.agentTools.contextResources().find(ref=>ref.resource==='materials'&&ref.value.kind==='directory'));
      await read(input.agentTools.contextResources().find(ref=>ref.resource==='materials'&&ref.value.kind==='file'));
    }
    return {version:2,state:'waiting',summary:secret,artifacts:[],attention:null};
  }},assessor:{async assess(input){assessments.push(input);input.checkpoint({driver:'fixture-assessor',id:input.session?.id??`candidate-${assessments.length}`});return {kind:'ignore',reason:'No new work',rules:[]};},async handleEvent(input){
    events.push(input);input.checkpoint({driver:'fixture-assessor',id:input.session?.id??`coordinator-${events.length}`});return callback(input);
  }}}).init();
  const settings={entries:[{id:'project',project:external?{root:source,projectId:sourceIdentity.projectId,instanceId:sourceIdentity.instanceId}:'self',include:['notes.md'],views:['current'],readers:[principal],destinations:[principal]}]};
  runtime.configureMaterials(settings,{expectedRevision:0});
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'},workflowMode:'continuous'},{expectedRevision:0});
  const store=new Store(join(projectStateDirectory(root),'state.sqlite'));
  const enqueue=value=>new CoordinationInbox(store).enqueue(value);
  t.after(async()=>{store.close();await runtime.stop();runtime.close();for(const value of new Set([root,source])){rmSync(value,{recursive:true,force:true});rmSync(projectStateDirectory(value),{recursive:true,force:true});}});
  const submit=()=>runtime.submit({text:'Inspect authorized synthetic material',materials:{sources:[{id:'project',view:{kind:'current'}}]}});
  const queue=(id,ticketId,proof)=>{
    if(proof)store.setMeta(`material-message:${id}`,proof);
    new Outbox(store,new Effects(store)).send({id,kind:'reply',...(ticketId?{ticketId}:{}),channel:{source:'local',thread:id,address:{}},text:secret});
  };
  return {root,source,runtime,events,assessments,settings,store,enqueue,submit,queue,setCallback:value=>callback=value};
}

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

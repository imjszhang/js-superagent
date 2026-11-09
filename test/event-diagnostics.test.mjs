import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { key } from '../dist/core/index.js';
import { readEventDiagnostics, readEventDiagnostic, readReplyDiagnostics } from '../src/runtime/event-diagnostics.mjs';

const at='2026-11-03T00:00:00.000Z',thread='owner/repo#1',channel={source:'github',thread,address:{repository:'owner/repo',issueNumber:'1'}};
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'js-event-diagnostics-')),store=new Store(join(root,'state.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;
}
function trigger(store,id,text='A request',source='github'){
  const value={id,source,actor:{source,id:'alice'},human:true,at,text,threads:[{source,id:thread}],channel:{...channel,source},meta:{},url:'https://github.com/owner/repo/issues/1'};
  store.triggers.save(value);return value;
}
function reply(store,{id,status='pending',ticketId='domain-A',text='reply',...rest}){
  store.db.prepare('INSERT INTO receipts(id,data,status) VALUES(?,?,?)').run(id,JSON.stringify({id,channel,ticketId,kind:'reply',text,...rest}),status);
}
function snapshot(store){
  return JSON.stringify(['kv','domain_triggers','domain_dispositions','domain_threads','domain_decisions','domain_tickets','receipts','effects'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

test('event diagnostics join intake, evaluation, each ticket and exact versus related reply receipts',t=>{
  const store=fixture(t),id='github:owner/repo:comment:1';trigger(store,id);
  store.setMeta('public:domain-A','ticket-A');store.setMeta('public:domain-B','ticket-B');
  store.tickets.save({id:'domain-A',origin:{triggerId:id},inputs:[{id:'input-A',kind:'trigger',triggerId:id,at,deliveredTo:'assignment-A',deliveredAt:at}],undelivered:[]});
  store.tickets.save({id:'domain-B',origin:{triggerId:'another'},inputs:[{id:'note-B',kind:'note',text:'context',at,readAt:at}],undelivered:[]});
  store.setMeta(`context-notice:domain-B:${id}`,{triggerId:id,inputId:'note-B',at});
  store.triggers.saveDisposition(id,{fanout:['domain-A','domain-B'],context:['domain-B'],acked:['domain-A'],handbacks:[{ticketId:'domain-A',reason:'Another scope',at}],decisionId:'decision',at});
  store.threads.save({key:`github:${thread}`,ref:{source:'github',id:thread},subscriptions:['domain-A','domain-B'],pending:[],evaluating:{id:'reeval',triggerIds:[id]},meta:{}});
  store.decisions.save({id:'decision',kind:'unavailable',triggerIds:[id],ticketId:'domain-A',reason:[{code:'evidenceMissing'}],at});
  store.setMeta(`github:event:${id}`,{status:'received',outcomes:[{ticketId:'ticket-A',status:'received',reason:'followup'},{ticketId:'ticket-B',status:'received',reason:'context-only'}]});
  reply(store,{id:key('ack',id),kind:'acknowledgement',status:'sent'});
  const answerId=key('reply',id,'answer');reply(store,{id:answerId,text:'answer'});
  store.db.prepare("INSERT INTO effects(kind,key,payload,due,attempts,error) VALUES('reply',?,'{}',?,2,'network unavailable')").run(answerId,Date.parse(at)+5000);
  const resultId=key('reply','domain-A','result');reply(store,{id:resultId,text:'result',status:'dropped'});store.setMeta(`receipt:terminal:${resultId}`,{status:'gone',reason:'locked'});
  const value=readEventDiagnostic(store,id);
  assert.equal(value.evaluation.status,'evaluating','current reevaluation takes precedence over historical decisions');
  assert.equal(value.evaluation.decisions[0].ticketId,'ticket-A');
  assert.deepEqual(value.tickets.map(ticket=>ticket.ticketId),['ticket-A','ticket-B']);
  assert.equal(value.tickets[0].acknowledged,true);assert.equal(value.tickets[0].handback,'Another scope');
  assert.equal(value.tickets[0].inputs[0].state,'delivered');assert.equal(value.tickets[1].inputs[0].state,'read');assert.equal(value.tickets[1].context,true);
  const answer=value.replies.find(item=>item.id===answerId);assert.equal(answer.relation,'direct');assert.equal(answer.status,'failed');assert.equal(answer.attempts,2);assert.equal(answer.nextRetryAt,'2026-11-03T00:00:05.000Z');
  assert.equal(value.replies.find(item=>item.id===resultId).relation,'related');assert.equal(value.replies.find(item=>item.id===resultId).reason,'locked');
  assert.equal(value.problem,true);
  assert.deepEqual(readReplyDiagnostics(store).summary,{total:3,pending:0,failed:1,sent:1,dropped:1});
});

test('filtered receipt references and paused events remain diagnosable without inventing a full original',t=>{
  const store=fixture(t),filtered='github:owner/repo:comment:2',paused='github:owner/repo:comment:3';
  store.setMeta(`github:event:${filtered}`,{status:'ignored',reason:'actor-not-authorized',reference:{source:'github',actor:'someone',threads:[{source:'github',id:thread}],text:'Visible receipt excerpt',at}});
  store.setMeta(`github:paused:${paused}`,{event:{id:paused,repository:'owner/repo',actor:{login:'alice',id:'7'},thread,text:'Held while paused',createdAt:at},at});
  const value=readEventDiagnostic(store,filtered);assert.equal(value.available,false);assert.equal(value.intake.status,'filtered');assert.equal(value.intake.reason,'actor-not-authorized');assert.equal(value.actor.id,'someone');
  const held=readEventDiagnostic(store,paused);assert.equal(held.intake.status,'deferred');assert.equal(held.available,false);assert.equal(held.text,'Held while paused');
  assert.deepEqual(readEventDiagnostics(store,{problemsOnly:true}).summary,{total:2,problems:2,filtered:1,deferred:1,pending:0,evaluating:0,decided:0});
  assert.equal(readEventDiagnostic(store,'not-present'),null);
});

test('search redacts complete facts before matching and only then truncates displayed text',t=>{
  const store=fixture(t),id='github:owner/repo:comment:4',secret='ghp_privateCredentialMustNotMatch';
  trigger(store,id,`Intro ${secret} ${'x'.repeat(2400)} visible-after-excerpt`);
  const projectForSearch=value=>JSON.parse(JSON.stringify(value).replaceAll(secret,'[redacted]'));
  assert.equal(readEventDiagnostics(store,{query:secret,projectForSearch}).total,0);
  const page=readEventDiagnostics(store,{query:'visible-after-excerpt',projectForSearch});
  assert.equal(page.total,1);assert.equal(page.items[0].text.length,500);assert.equal(page.items[0].textTruncated,true);assert.doesNotMatch(JSON.stringify(page),/privateCredential/);
  const detail=readEventDiagnostic(store,id,{projectForSearch});assert.equal(detail.text.length,2000);assert.doesNotMatch(JSON.stringify(detail),/privateCredential/);
  reply(store,{id:'unrelated-reply',text:`${secret} ${'x'.repeat(800)} searchable-reply`,ticketId:undefined});
  assert.equal(readReplyDiagnostics(store,{query:secret,projectForSearch}).total,0);
  assert.equal(readReplyDiagnostics(store,{query:'searchable-reply',projectForSearch}).total,1);
});

test('pagination binds cursor to project, resource, query and filters and includes orphaned dropped replies',t=>{
  const store=fixture(t),other=fixture(t);for(const id of ['a','b','c'])trigger(store,id);
  const first=readEventDiagnostics(store,{limit:1});assert.equal(first.items[0].id,'a');assert.equal(first.total,3);
  const second=readEventDiagnostics(store,{limit:1,cursor:first.nextCursor});assert.equal(second.items[0].id,'b');
  for(const options of [{query:'x'},{source:'github'},{problemsOnly:true}])assert.throws(()=>readEventDiagnostics(store,{cursor:first.nextCursor,...options}),/cursor does not match/);
  assert.throws(()=>readEventDiagnostics(other,{cursor:first.nextCursor}),/cursor does not match/);
  assert.throws(()=>readReplyDiagnostics(store,{cursor:first.nextCursor}),/cursor does not match/);
  reply(store,{id:'orphaned-dropped',status:'dropped',ticketId:undefined,channel:{source:'feishu',thread:'unavailable-topic',address:{}}});
  const dropped=readReplyDiagnostics(store,{source:'feishu',problemsOnly:true});assert.equal(dropped.total,1);assert.deepEqual(dropped.items[0].eventIds,[]);assert.equal(dropped.items[0].reason,'withdrawn-or-unavailable');
  assert.throws(()=>readEventDiagnostics(store,{limit:101}),/limit/);assert.throws(()=>readReplyDiagnostics(store,{query:'x'.repeat(201)}),/query/);
});

test('pending reply diagnostics explain pause and the first earlier conversation blocker in insertion order',t=>{
  const store=fixture(t);
  // IDs deliberately sort opposite to row order: delivery ordering is rowid.
  reply(store,{id:'z-first'});reply(store,{id:'a-next'});
  reply(store,{id:'other-ticket',ticketId:'domain-B'});
  reply(store,{id:'other-review',channel:{...channel,address:{...channel.address,reviewRootId:'44'}}});
  let values=readReplyDiagnostics(store).items;
  const next=values.find(item=>item.id==='a-next');
  assert.equal(next.reason,'waiting-for-earlier-reply');assert.deepEqual(next.blockedBy,['z-first']);
  assert.equal(values.find(item=>item.id==='other-ticket').reason,null);assert.equal(values.find(item=>item.id==='other-review').reason,null);
  store.db.prepare("INSERT INTO effects(kind,key,payload,due,attempts,error) VALUES('reply',?,'{}',?,3,'network unavailable')").run('z-first',Date.parse(at));
  assert.equal(readReplyDiagnostics(store).items.find(item=>item.id==='a-next').reason,null,'three failed attempts release following replies');
  store.setMeta('runtime:pause',{paused:true,at});
  const before=snapshot(store);store.db.exec('PRAGMA query_only=ON');
  values=readReplyDiagnostics(store).items;
  assert.equal(values.find(item=>item.id==='a-next').reason,'runtime-paused');assert.equal(values.find(item=>item.id==='z-first').status,'failed');
  assert.equal(snapshot(store),before);
});

test('diagnostic reads do not write state and every nested collection and long fact has an omission signal',t=>{
  const store=fixture(t),id='github:owner/repo:comment:5';trigger(store,id,'x'.repeat(3000));
  store.tickets.save({id:'domain-A',origin:{triggerId:id},inputs:Array.from({length:55},(_,i)=>({id:`input-${i}`,kind:'trigger',triggerId:id,at})),undelivered:[],ended:{reason:'r'.repeat(3000)}});
  for(let i=0;i<55;i++){
    reply(store,{id:`related-${i}`,text:'z'.repeat(2100)});
    store.decisions.save({id:`decision-${i}`,kind:'ignore',triggerIds:[id],at,reason:[{code:'note',values:{text:'e'.repeat(3000)}}]});
  }
  store.setMeta(`github:event:${id}`,{status:'received',outcomes:[{ticketId:'domain-A',status:'ignored',reason:'o'.repeat(3000)}]});
  const before=snapshot(store),schema=store.db.prepare('PRAGMA user_version').get().user_version;
  store.beforeWrite=()=>assert.fail('diagnostics must never use a write operation');store.db.exec('PRAGMA query_only=ON');
  const value=readEventDiagnostic(store,id);readEventDiagnostics(store);readReplyDiagnostics(store);
  assert.equal(value.omitted.inputs,5);assert.equal(value.omitted.replies,5);assert.equal(value.omitted.decisions,5);assert.ok(value.omitted.textFields>0);
  assert.equal(value.tickets[0].ended.reason.length,2000);assert.equal(value.intake.outcomes[0].reason.length,2000);assert.equal(value.evaluation.decisions[0].reason[0].values.text.length,2000);
  assert.equal(value.text.length,2000);assert.equal(value.replies[0].text.length,2000);
  assert.equal(snapshot(store),before);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,schema);
});

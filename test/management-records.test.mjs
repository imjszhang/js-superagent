import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent,createManagementServer} from './helpers/runtime-fixture.mjs';
import {Store} from '../src/store.mjs';

async function fixture(t, options={}) {
  const root=mkdtempSync(join(tmpdir(),'superagent-management-records-'));
  const runtime=createProjectAgent({projectRoot:root,...options}).init(),server=await createManagementServer(runtime);
  t.after(async()=>{await server.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const request=(path,body)=>fetch(new URL(path,server.url),{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${server.token}`,...(body===undefined?{}:{Origin:new URL(server.url).origin,'X-Superagent-Request':'local-ui','Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{runtime,server,request,root};
}
const event=(id,text,meta={})=>({id,source:'local',actor:{source:'local',id:'operator'},human:true,addressed:'direct',threads:[{source:'local',id:'thread-'+id}],at:'2026-11-01T00:00:00Z',meta,text});

test('management searches all tickets and original event identities before pagination',async t=>{
  const f=await fixture(t);for(let i=0;i<105;i++)f.runtime.submit({text:`ordinary ${i}`,scope:'Local fixture'});
  const wanted=f.runtime.submit({text:'later SERVER Needle',scope:'Needle only'}),domain=f.runtime.getDomainTicket(wanted.id);
  const found=await(await f.request('/api/tickets?q=server%20needle&limit=1')).json();assert.equal(found.total,1);assert.equal(found.items[0].id,wanted.id);
  const origin=await(await f.request('/api/tickets?q='+encodeURIComponent(domain.origin.triggerId))).json();assert.ok(origin.items.some(item=>item.id===wanted.id));
  assert.equal((await f.request('/api/tickets?q='+('x'.repeat(201)))).status,400);
  assert.equal((await(await f.request('/api/tickets?q=%25_OR_1%3D1')).json()).total,0);
});

test('context query covers records beyond the first page and fences resource/query cursors',async t=>{
  const f=await fixture(t);for(let i=0;i<110;i++)f.runtime.receive(event(`event-${String(i).padStart(3,'0')}`,i>=106?'LATE Needle value':'ordinary'));
  const first=await(await f.request('/api/context/triggers?q=late%20needle&limit=2')).json();assert.equal(first.total,4);assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const next=await(await f.request('/api/context/triggers?q=late%20needle&limit=2&cursor='+encodeURIComponent(first.nextCursor))).json();assert.equal(next.items.length,2);assert.equal(next.nextCursor,null);assert.equal(new Set([...first.items,...next.items].map(item=>item.id)).size,4);
  assert.equal((await f.request('/api/context/triggers?q=different&cursor='+encodeURIComponent(first.nextCursor))).status,400);
  assert.equal((await f.request('/api/context/decisions?q=late%20needle&cursor='+encodeURIComponent(first.nextCursor))).status,400);
});

test('complete HTTP record reads redact before segmentation and keep long text, arrays and versions',async t=>{
  const f=await fixture(t),secret='private-record-value-DO-NOT-EXPOSE';
  f.runtime.receive(event('long-record','prefix '+('LONG FACT '.repeat(5000))+' FINAL-ORIGINAL-MARKER',{privateKey:secret,entries:Array.from({length:250},(_,i)=>({item:i})),url:'https://user:password@example.com/facts?token=secret#fragment',path:'/private/account/key.pem'}));
  const hidden=await(await f.request('/api/context/triggers?q='+secret)).json();assert.equal(hidden.total,0,'Search must not reveal hidden fields through matches');
  const listed=await(await f.request('/api/context/triggers?q=FINAL-ORIGINAL-MARKER')).json();assert.equal(listed.items.length,1);assert.doesNotMatch(JSON.stringify(listed),new RegExp(secret));
  let page=await(await f.request('/api/context/triggers/record?id=long-record&limit=1000')).json(),combined=page.text,version=page.version;
  assert.equal(page.redacted,true);while(page.nextOffset!==null){page=await(await f.request(`/api/context/triggers/record?id=long-record&limit=1000&offset=${page.nextOffset}&version=${version}`)).json();assert.equal(page.version,version);combined+=page.text;}
  const record=JSON.parse(combined);assert.ok(record.text.endsWith('FINAL-ORIGINAL-MARKER'));assert.equal(record.meta.entries.length,250);assert.equal(record.meta.url,'https://example.com/facts');assert.equal(record.meta.path,'[local path]');assert.equal(record.meta.privateKey,undefined);assert.doesNotMatch(combined,new RegExp(secret));assert.equal(combined.length,page.length);
  assert.equal((await f.request('/api/context/triggers/record?id=long-record&offset=1000')).status,400);
  assert.equal((await f.request('/api/context/triggers/record?id=long-record&limit=99')).status,400);
  assert.equal((await f.request('/api/context/triggers/record?id=long-record&limit=16001')).status,400);
  const store=new Store(join(stateDir(f.root), 'state.sqlite'));store.triggers.save(event('long-record','Changed content'));store.close();
  assert.equal((await f.request(`/api/context/triggers/record?id=long-record&offset=1000&version=${version}`)).status,409);
  assert.equal((await f.request('/api/context/triggers/record?id=missing')).status,404);
  assert.equal((await f.request('/api/context/credentials/record?id=anything')).status,404);
  assert.equal((await fetch(new URL('/api/context/triggers/record?id=long-record',f.server.url))).status,401);
  f.runtime.receive(event('oversize','x'.repeat(2*1024*1024)));assert.equal((await f.request('/api/context/triggers/record?id=oversize')).status,413);
});

test('real decisions link both directions through triggerIds, including ignored events with no ticket',async t=>{
  const f=await fixture(t,{assessor:{async assess(){return{kind:'ignore',reason:'No work requested',rules:[]};}},driver:{async run(){throw new Error('Ignored requests must not execute');}}});
  f.runtime.configureCoordinator({assessor:{driver:'codex-app-server'}},{expectedRevision:0});
  const ticket=f.runtime.submit({text:'Accepted local request'}),domain=f.runtime.getDomainTicket(ticket.id),triggerId=domain.origin.triggerId;
  const events=await(await f.request('/api/context/triggers?q='+triggerId)).json();assert.equal(events.items[0].associations.tickets[0].id,ticket.id);assert.ok(events.items[0].associations.decisions.length);
  const decisionId=events.items[0].associations.decisions[0].id,decision=await(await f.request('/api/context/decisions/record?id='+decisionId)).json();assert.ok(decision.associations.triggers.some(link=>link.id===triggerId));assert.ok(decision.associations.tickets.some(link=>link.id===ticket.id));
  f.runtime.cancel(ticket.id);const ignored=f.runtime.request({text:'No work required; record only'});for(let n=0;n<3;n++)await f.runtime.runNext();
  const ignoredEvents=await(await f.request('/api/context/triggers?q='+ignored.triggerId)).json();assert.ok(ignoredEvents.items[0].associations.decisions.length);assert.equal(ignoredEvents.items[0].associations.tickets.length,0);
  const trace=await(await f.request(`/api/tickets/${ticket.id}/trace?limit=100`)).json();assert.ok(trace.items.find(item=>item.kind==='decision').associations.triggers.some(link=>link.id===triggerId));
});

test('management actions are read-only and reflect waiting, native session, active execution, delivery and authority',async t=>{
  const f=await fixture(t,{driver:{async run(input){input.checkpoint({driver:'fixture',id:'native-session-1'});return{status:'waiting',summary:'Waiting for review'};}}});
  f.runtime.configurePrompts({},{expectedRevision:0});const ticket=f.runtime.submit({text:'Wait for operator'});assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'no-session');await f.runtime.runNext();
  const store=new Store(join(stateDir(f.root), 'state.sqlite'));t.after(()=>store.close());const snapshot=()=>JSON.stringify(store.db.prepare('SELECT key,data FROM kv ORDER BY key').all());
  const before=snapshot(),available=f.runtime.actionAvailability(ticket.id);assert.equal(available.requestStatus.allowed,true);assert.equal(available.sessionReplace.allowed,true);assert.equal(snapshot(),before);
  assert.deepEqual((await(await f.request(`/api/tickets/${ticket.id}/session`)).json()).actionAvailability,available);
  assert.deepEqual((await(await f.request(`/api/tickets/${ticket.id}/details`)).json()).actionAvailability,available);
  store.setMeta('execution',{publicId:ticket.id,pid:process.pid,host:hostname()});assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'execution-active');store.deleteMeta('execution');
  store.setMeta('runtime:loop',{pid:process.pid,host:hostname()});assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'processing-active');store.deleteMeta('runtime:loop');
  store.setMeta('managed-job:fixture',{id:'fixture',status:'running',parent:{ticketId:ticket.id}});assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'owned-jobs-active');store.deleteMeta('managed-job:fixture');
  const meta=store.getMeta('ticket:'+ticket.id);store.setMeta('ticket:'+ticket.id,{...meta,deliveryAttempt:{runId:meta.runId,state:'failed'}});assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'delivery-unreconciled');store.setMeta('ticket:'+ticket.id,meta);
  const domain=f.runtime.getDomainTicket(ticket.id);store.tickets.save({...domain,mandate:{...domain.mandate,actor:{source:'local',id:'other'}}});assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'mandate-revoked');assert.equal(f.runtime.actionAvailability(ticket.id).requestStatus.allowed,false);store.tickets.save(domain);
  f.runtime.cancel(ticket.id);assert.equal(f.runtime.actionAvailability(ticket.id).sessionReplace.code,'ticket-ended');assert.equal(f.runtime.actionAvailability(ticket.id).requestStatus.allowed,false);
});

test('associations resolve stored domain IDs to distinct public ticket IDs',async t=>{
  const f=await fixture(t),ticket=f.runtime.submit({text:'Legacy public identity'}),domain=f.runtime.getDomainTicket(ticket.id),publicId='legacy-public-id';
  const store=new Store(join(stateDir(f.root), 'state.sqlite')),meta=store.getMeta('ticket:'+ticket.id);
  store.setMeta('ticket:'+publicId,{...meta,id:publicId});store.deleteMeta('ticket:'+ticket.id);store.setMeta('public:'+domain.id,publicId);store.close();
  const result=await(await f.request('/api/context/triggers?q='+domain.origin.triggerId)).json();assert.equal(result.items[0].associations.tickets[0].id,publicId);
  const record=await(await f.request('/api/context/tickets/record?id='+domain.id)).json();assert.equal(record.associations.tickets[0].id,publicId);
  assert.notEqual(publicId,domain.id);assert.equal((await f.request(`/api/tickets/${publicId}/details`)).status,200);
});

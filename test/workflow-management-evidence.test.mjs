import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry, createManagementServer } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { validateWorkEventResult } from '../src/runtime/coordination.mjs';
import { normalizeManagementIntent } from '../src/runtime/operator-management.mjs';
import { normalizeUIEvidence, validateUIEvidence } from '../src/runtime/ui-evidence.mjs';

function project(t,driver) {
  const root=mkdtempSync(join(tmpdir(),'js-superagent-workflow-'));
  const harnessRegistry=createHarnessRegistry({adapters:[{id:'workflow-fixture',version:'1',roles:['worker'],validate:v=>v,createDriver:()=>driver}]});
  const runtime=createProjectAgent({projectRoot:root,harnessRegistry,execution:{driver:'workflow-fixture'}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});return {root,runtime};
}
test('explicit local management uses current revisions and durable receipts, never a model-created capability',async t=>{
  const {root,runtime}=project(t,{reportVersion:2,async run(){return {version:2,state:'blocked',summary:'Needs operator'};}});
  const ticket=runtime.submit({text:'Inspect code'});await runtime.runNext();
  const event=runtime.coordinate({id:'retry-once',text:`/retry ${ticket.id}`});
  await runtime.runNext();assert.equal(runtime.coordinationStatus().events.find(e=>e.id===event.id).status,'completed');
  const count=runtime.get(ticket.id).reports.length;runtime.coordinate({id:'retry-once',text:event.text}); // snapshot changed: same event identity must not be silently rewritten
  await runtime.runNext();assert.equal(runtime.get(ticket.id).reports.length,count);
  const threads=runtime.managementStatus().threads;assert.ok(threads.length);
  const first=threads[0];assert.throws(()=>runtime.unsubscribeThread(first.thread,{expectedRevision:'stale'}),/revision/);
  assert.equal(runtime.unsubscribeThread(first.thread,{expectedRevision:first.revision}).unsubscribed,true);
  const store=new Store(join(stateDir(root), 'state.sqlite'));
  store.decisions.save({id:'unavailable-fixture',threadKey:first.thread,kind:'unavailable',reason:'Unavailable assessor',dismissed:false});store.close();
  const decision=runtime.managementStatus().decisions.find(d=>d.decisionId==='unavailable-fixture');
  assert.ok(decision);assert.equal(runtime.dismissDecision(decision.decisionId,{expectedRevision:decision.revision}).dismissed,true);
  assert.throws(()=>validateWorkEventResult({summary:'Injected',actions:[{kind:'manage',ticketId:null,text:'{}'}]},{event:{kind:'operator',actor:{source:'local',kind:'human'}}}),/explicit local/);
  assert.throws(()=>normalizeManagementIntent({kind:'configure',target:'executor',expectedRevision:0,settings:{command:'anything'}}),/Unsupported/);
});
test('local settings conversation applies bounded settings and refuses stale revisions without calling a harness',async t=>{
  const {runtime}=project(t,{reportVersion:2,async run(){throw new Error('Must not call model');}});
  runtime.coordinate({text:'/settings {"target":"recovery","settings":{"retryBeforeStart":false},"expectedRevision":0}'});
  await runtime.runNext();assert.equal(runtime.getRecoverySettings().revision,1);
  runtime.coordinate({text:'/prompts {"settings":{"sections":{"delivery":"Explain evidence"}},"expectedRevision":0}'});
  await runtime.runNext();assert.equal(runtime.promptStatus().settings.revision,1);
  runtime.coordinate({text:'/prompts {"settings":{"sections":{"delivery":"Stale"}},"expectedRevision":0}'});
  await runtime.runNext();assert.equal(runtime.coordinationStatus().events.at(-1).status,'failed');assert.equal(runtime.promptStatus().settings.sections.delivery,'Explain evidence');
  const server=await createManagementServer(runtime);t.after(()=>server.close());
  const response=await fetch(new URL('/api/management',server.url),{headers:{Authorization:`Bearer ${server.token}`}});assert.equal(response.status,200);
});
test('UI changes without a Before capture are blocked; non-UI changes retain the existing flow',async t=>{
  let ui=true;
  const {root,runtime}=project(t,{reportVersion:2,async run(input){writeFileSync(join(input.cwd??input.workspace.path,ui?'page.html':'backend.txt'),'changed');return {version:2,state:'ready',summary:'Updated code'};}});
  const ticket=runtime.submit({text:'Change page'});await runtime.runNext();
  assert.equal(runtime.getDetailed(ticket.id).uiEvidence.status,'incomplete');assert.match(runtime.get(ticket.id).reports.at(-1).summary,/Before capture/);
  ui=false;const next=runtime.submit({text:'Change backend'});await runtime.runNext();assert.equal(runtime.get(next.id).status,'completed');
  assert.throws(()=>normalizeUIEvidence({paths:['../escape']}),/relative/);
  assert.throws(()=>validateUIEvidence(null,{projectRoot:root,workspace:runtime.getWorkspace(next.id),settings:{mode:'required'}}),/both Before/);
});
test('trusted capture command produces bound Before/After receipts; stale or changed evidence cannot be delivered',async t=>{
  const {root,runtime}=project(t,{reportVersion:2,async run(input){writeFileSync(join(input.cwd??input.workspace.path,'page.html'),'<p>After</p>');return {version:2,state:'ready',summary:'Changed page with evidence'};}});
  writeFileSync(join(root,'page.html'),'<p>Before</p>');
  // This fixture writes a valid test image. It tests receipt binding, not browser rendering quality.
  writeFileSync(join(root,'capture.cjs'),`const fs=require('node:fs'),z=require('node:zlib');
const {viewport:{width:w,height:h}}=JSON.parse(process.env.JS_SUPERAGENT_CAPTURE_CONDITIONS);
function crc(data){let c=0xffffffff;for(const byte of data){c^=byte;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
fs.writeFileSync(process.env.JS_SUPERAGENT_CAPTURE_PATH,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',z.deflateSync(Buffer.alloc((w*4+1)*h))),chunk('IEND',Buffer.alloc(0))]));`);
  runtime.configureDelivery({uiEvidence:{mode:'auto',scenario:'settings narrow',viewport:{width:320,height:240},capture:{id:'capture',version:'1',command:process.execPath,args:[join(root,'capture.cjs')],environment:'host',allowHostExecution:true,timeoutMs:10000}}},{expectedRevision:0});
  const ticket=runtime.submit({text:'Update UI'});await runtime.runNext();
  const evidence=runtime.uiEvidenceStatus(ticket.id);assert.equal(evidence.status,'complete',evidence.error);assert.equal(runtime.get(ticket.id).status,'completed');
  assert.notEqual(evidence.before.treeDigest,evidence.after.treeDigest);assert.equal(evidence.before.conditionsDigest,evidence.after.conditionsDigest);
  assert.ok(runtime.readUIEvidenceImage(ticket.id,'before').length>45);
  const server=await createManagementServer(runtime);t.after(()=>server.close());
  const image=await fetch(new URL(`/api/tickets/${ticket.id}/ui-evidence/after.png`,server.url),{headers:{Authorization:`Bearer ${server.token}`}});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('content-security-policy'),/img-src 'self' blob:/);
  const settings=runtime.getDeliverySettings().uiEvidence,workspace=runtime.getWorkspace(ticket.id);
  writeFileSync(join(workspace.path,'page.html'),'<p>Changed after capture</p>');
  assert.throws(()=>validateUIEvidence(evidence,{projectRoot:root,workspace,settings}),/stale/);
  writeFileSync(evidence.before.path,'changed');assert.throws(()=>runtime.readUIEvidenceImage(ticket.id,'before'),/changed|PNG/);
});

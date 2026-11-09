import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-advanced-')));
  const runtime = createProjectAgent({projectRoot: root, ...options}).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root,{recursive:true,force:true}); });
  return {root,runtime};
}
test('v2 waiting does not manufacture a question; explicit attention remains independent', async t => {
  let round = 0;
  const {runtime} = fixture(t,{driver:{reportVersion:2,async run() {round++; return {version:2,state:'waiting',summary:'Waiting for an external event',...(round===2?{attention:{question:'Which target?'}}:{attention:null})};}}});
  const task=runtime.submit({text:'Inspect'}); await runtime.runNext();
  assert.equal(runtime.getDetailed(task.id).attention,null); assert.equal(runtime.get(task.id).status,'waiting');
  runtime.reply(task.id,'Clarify'); await runtime.runNext(); assert.equal(runtime.getDetailed(task.id).attention.question,'Which target?');
});
test('v2 progress and blocked report persist without widening legacy states',async t=>{
  const {runtime}=fixture(t,{driver:{reportVersion:2,capabilities:{structuredProgress:true},async run({progress}) {progress({version:2,state:'progress',summary:'Checking prerequisites'}); return {version:2,state:'blocked',summary:'Dependency unavailable',attention:{question:'Supply the dependency?'}};}}});
  const task=runtime.submit({text:'Build'}); await runtime.runNext();
  assert.equal(runtime.get(task.id).status,'failed'); const detail=runtime.getDetailed(task.id);
  assert.deepEqual(detail.reports.map(r=>r.state),['progress','blocked']); assert.equal(detail.reportState,'blocked'); assert.ok(detail.attention);
});
test('runtime coordinator creates compatible tickets and persists decisions under policy revision',async t=>{
  let assessments=0;
  const {runtime}=fixture(t,{driver:{async run(){return {status:'completed',summary:'Done'};}},assessor:{async assess(){assessments++; return {kind:'accept',title:'Requested task',scope:'Implement scoped task',reason:'Explicit request',rules:[]};}}});
  runtime.configureCoordinator({assessor:{driver:'fixture-assessor'}},{expectedRevision:0});
  runtime.request({text:'Implement scoped task'}); const result=await runtime.runNext();
  assert.equal(assessments,1); assert.equal(result.status,'completed'); assert.equal(runtime.list().length,1);
  assert.ok(runtime.readContext('decisions').items.some(item=>item.value.kind==='accept'));
  runtime.configureCoordinator({assessor:{driver:'codex-app-server',model:'fixture'}},{expectedRevision:1});
  assert.throws(()=>runtime.configureCoordinator({assessor:null},{expectedRevision:0}),/revision conflict/);
});
test('automatic trusted host verification records facts and keeps original source isolated', async t=>{
  const {root,runtime}=fixture(t,{workspace:'copy',driver:{async run({projectRoot}) {writeFileSync(join(projectRoot,'answer.txt'),'42\n'); return {status:'completed',summary:'Changed answer',artifacts:['answer.txt']};}}});
  writeFileSync(join(root,'answer.txt'),'wrong\n');
  runtime.configureDelivery({mode:'local',automatic:true,verify:{id:'check',version:'1',command:process.execPath,args:['-e',"if(require('node:fs').readFileSync('answer.txt','utf8').trim()!=='42')process.exit(1)"],environment:'host',allowHostExecution:true}},{expectedRevision:0});
  const task=runtime.submit({text:'Fix answer'}); const result=await runtime.runNext();
  assert.equal(result.status,'completed'); assert.equal(runtime.getDetailed(task.id).verification.status,'passed');
  assert.equal(runtime.getDetailed(task.id).delivery.mode,'local'); assert.equal(readFileSync(join(root,'answer.txt'),'utf8'),'wrong\n');
});
test('failed host verification prevents a completion report and remains inspectable',async t=>{
  const {runtime}=fixture(t,{workspace:'copy',driver:{async run(){return {status:'completed',summary:'Unverified assertion'};}}});
  runtime.configureDelivery({mode:'local',automatic:true,verify:{id:'fail',version:'1',command:process.execPath,args:['-e','process.exit(7)'],environment:'host',allowHostExecution:true}},{expectedRevision:0});
  const task=runtime.submit({text:'Check'}); await runtime.runNext(); assert.equal(runtime.get(task.id).status,'failed'); assert.equal(runtime.getDetailed(task.id).verification.exitCode,7);
});

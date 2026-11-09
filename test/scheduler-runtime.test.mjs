import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await delay(10);}assert.fail('Timed out');}
test('three workers execute simultaneously in distinct owned directories and preserve single-ticket ownership', {timeout:10000},async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-pool-'))), release=deferred(), started=[];
  const runtime=createProjectAgent({projectRoot:root,workspace:'copy',driver:{async run({projectRoot,ticket,signal}){
    started.push({id:ticket.id,path:projectRoot});writeFileSync(join(projectRoot,'owner.txt'),ticket.id);
    await Promise.race([release.promise,new Promise(r=>signal.addEventListener('abort',r,{once:true}))]); return{status:'completed',summary:'Verified owned file'};
  }}}).init();
  t.after(async()=>{release.resolve();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  runtime.configureScheduler({maxWorkers:3},{expectedRevision:0});
  assert.throws(()=>runtime.getConfig(),/getConfigV2/);assert.equal(runtime.getConfigV2().concurrency,3);
  const tasks=[1,2,3].map(i=>runtime.submit({text:`Task ${i}`}));runtime.start({intervalMs:10});await until(()=>started.length===3);
  assert.equal(new Set(started.map(s=>s.path)).size,3);assert.ok(tasks.every(task=>runtime.get(task.id).status==='running'));
  for(const item of started)assert.equal(readFileSync(join(item.path,'owner.txt'),'utf8'),item.id);
  runtime.reply(tasks[0].id,'One more check');await delay(100);assert.equal(started.length,3);
  release.resolve();await until(()=>tasks.every(task=>runtime.get(task.id).status==='completed'));assert.equal(started.filter(item=>item.id===tasks[0].id).length,2);
});
test('capacity changes reject active work and in-place concurrency',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-pool-config-')));
  const runtime=createProjectAgent({projectRoot:root,driver:{async run(){return{status:'completed',summary:'Done'};}}}).init();
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  assert.throws(()=>runtime.configureScheduler({maxWorkers:2},{expectedRevision:0}),/In-place/);
  assert.throws(()=>runtime.configureScheduler({maxWorkers:1,humanReserve:1},{expectedRevision:0}),/reserved/);
  runtime.start();assert.throws(()=>runtime.configureScheduler({maxWorkers:1},{expectedRevision:0}),/Stop/);
});
test('loop ownership is visible across SDK instances and protects idle configuration',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-loop-owner-')));
  const driver={async run(){return{status:'completed',summary:'Done'};}};
  const first=createProjectAgent({projectRoot:root,driver}).init();
  const second=createProjectAgent({projectRoot:root,driver}).init();
  t.after(async()=>{await first.stop();await second.stop();first.close();second.close();rmSync(root,{recursive:true,force:true});});
  first.start(); assert.equal(second.status().running,true);
  assert.throws(()=>second.start(),/owns the project loop|live or unverifiable project execution owners/);
  assert.throws(()=>second.configureScheduler({maxWorkers:1},{expectedRevision:0}),/Stop/);
  await first.stop(); assert.equal(second.status().running,false);
  second.start();assert.equal(first.status().running,true);
});

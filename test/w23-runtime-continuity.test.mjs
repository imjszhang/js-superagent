import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { buildWorkerContext } from '../src/runtime/worker-context.mjs';
import { Store } from '../src/store.mjs';
import { inspectDatabase } from './helpers/runtime-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';

function fixture(t,driver) {
  const root=mkdtempSync(join(tmpdir(),'js-w23-'));
  const harnessRegistry=createHarnessRegistry({adapters:[{id:'continuity-fixture',version:'1',roles:['worker'],validate:v=>v,createDriver:()=>driver}]});
  let runtime=createProjectAgent({projectRoot:root,harnessRegistry}).init();
  runtime.configureExecutor({driver:'continuity-fixture'},{expectedRevision:0});
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  return {get runtime(){return runtime;},reopen(){runtime.close();runtime=createProjectAgent({projectRoot:root,harnessRegistry}).init();return runtime;}};
}

for(const manual of [false,true])test(`An ordinary lost connection is inspected ${manual?'on explicit retry':'automatically'} and completed history is collected without another model run`,async t=>{
  let calls=0,checks=0,runId,records;
  const session={driver:'continuity-fixture',id:'native-1'};
  const env=fixture(t,{reportVersion:2,capabilities:{sessionResume:true,boundedContextVersion:1},
    async run(input){calls++;runId=input.runId;input.checkpoint(session);records=buildWorkerContext(input).messages.map(({resource,id,version})=>({resource,id,version}));throw new Error('Connection closed after completion');},
    async inspectRecovery(input){checks++;assert.equal(input.diagnostics,true);assert.equal(input.runId,runId);
      return {version:1,kind:'interrupted',safeToResume:true,toolsSettled:true,session,checkpoint:{runId,eventSequence:3},code:'HISTORY_VERIFIED',outcome:'completed',contextRecords:records,
        report:{version:2,state:'ready',summary:'Completed exactly once',artifacts:[]}};}
  });
  if(!manual)env.runtime.configureRecovery({autoResume:true},{expectedRevision:0});
  const ticket=env.runtime.submit({text:'Make one bounded change'});
  await env.runtime.runNext();assert.equal(env.runtime.get(ticket.id).status,'failed');assert.equal(checks,0);
  const runtime=env.reopen();
  if(manual){assert.equal(await runtime.runNext(),null);runtime.retry(ticket.id);}
  await new Promise(resolve=>setTimeout(resolve,60));
  await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'completed',JSON.stringify(runtime.getDetailed(ticket.id)));assert.equal(calls,1);assert.equal(checks,1);
  assert.equal(runtime.getDetailed(ticket.id).nativeResultRecoveredFrom,runId);
  assert.equal(await runtime.runNext(),null);
});

test('Publishing business policy does not wake work, and the next round reuses session and fixed execution binding',async t=>{
  const snapshots=[],session={driver:'continuity-fixture',id:'same-session'};
  const env=fixture(t,{reportVersion:2,capabilities:{sessionResume:true},async run(input){
    if(snapshots.length)assert.deepEqual(input.session,session);
    input.checkpoint(session);snapshots.push(structuredClone(input.policySnapshot));
    input.checkpointNative({projectRules:{digest:'unchanged'}});
    input.checkpointNative({policy:{revision:input.policySnapshot.revision,digest:input.policySnapshot.digest,status:'applied',evidence:'fixture'}});
    return {version:2,state:snapshots.length===1?'waiting':'ready',summary:'Policy round',attention:snapshots.length===1?{question:'Continue?'}:null,artifacts:[]};
  }});
  const r=env.runtime;r.configurePrompts({sections:{delivery:'Original team rule'}},{expectedRevision:0});
  const ticket=r.submit({text:'Work in two rounds'});await r.runNext();const binding=r.sessionStatus(ticket.id).binding;
  r.configurePrompts({sections:{delivery:'Updated team rule'}},{expectedRevision:1});
  assert.equal(await r.runNext(),null);assert.equal(snapshots.length,1);
  assert.equal(r.getDetailed(ticket.id).policyStatus.desiredRevision,2);
  r.reply(ticket.id,'Continue');await r.runNext();
  assert.equal(snapshots[0].revision,1);assert.equal(snapshots[1].revision,2);
  assert.equal(snapshots[0].sourcePromptDigest,snapshots[1].sourcePromptDigest);
  assert.deepEqual(r.sessionStatus(ticket.id).binding,binding);
  assert.equal(r.getDetailed(ticket.id).nativeFacts.projectRules.digest,'unchanged');
  assert.equal(r.getDetailed(ticket.id).nativeFacts.policy.revision,2);
  assert.ok(Number.isFinite(Date.parse(r.getDetailed(ticket.id).nativeFacts.policy.at)));
  assert.equal(r.get(ticket.id).status,'completed');
});

test('Schema 6 queries stay read-only; explicit schema 8 upgrade backs up and preserves pending work without enabling recovery',async t=>{
  const env=fixture(t,{reportVersion:2,async run(){throw new Error('No model run is allowed');}}),r=env.runtime;
  const ticket=r.submit({text:'Saved pending ticket'}),path=join(stateDir(r.projectRoot), 'state.sqlite');
  const db=new Store(path);t.after(()=>db.close());
  db.db.exec('DELETE FROM schema_migrations WHERE to_version>=7; PRAGMA user_version=6');db.setMeta('runtime:minimum-version','0.5.0-alpha.0');
  const before=r.getDomainTicket(ticket.id),saved=db.getMeta(`ticket:${ticket.id}`);
  r.getDetailed(ticket.id);r.githubStatus();r.ticketTrace(ticket.id);
  assert.equal(inspectDatabase(path).schemaVersion,6);
  assert.equal(r.upgradeRuntime().schemaVersion,15);
  assert.deepEqual(r.getDomainTicket(ticket.id),before);assert.deepEqual(db.getMeta(`ticket:${ticket.id}`),saved);
  assert.equal(r.getRecoverySettings().autoResume,false);
  const directory=stateDir(r.projectRoot),manifests=readdirSync(directory).filter(name=>name.endsWith('.backup.json')).map(name=>JSON.parse(readFileSync(join(directory,name),'utf8')));
  assert.ok(manifests.some(manifest=>manifest.schemaVersion===6&&manifest.targetVersion===15));
  const oldReader=new DatabaseSync(path,{readOnly:true});
  try {assert.throws(()=>{const version=Number(oldReader.prepare('PRAGMA user_version').get().user_version);if(version>6)throw new Error(`Unsupported state schema: ${version}`);},/Unsupported state schema: 15/);}
  finally{oldReader.close();}
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { MACHINE_DEPENDENCIES } from '../src/runtime/machine-guard.mjs';
import { createMachineCoordinator } from '../src/machine-coordination.mjs';
import { Store } from '../src/store.mjs';
import { relocateProject } from '../src/project-maintenance.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'js-multi-runtime-'))), directory=join(root,'machine'), runtimes=[];
  const project=name=>{const path=join(root,name);mkdirSync(path,{recursive:true});return path;};
  const open=(path,options={})=>{const runtime=createProjectAgent({projectRoot:path,[MACHINE_DEPENDENCIES]:{directory},driver:{async run(){return {status:'completed',summary:'done'};}},...options}).init();runtimes.push(runtime);return runtime;};
  t.after(async()=>{for(const runtime of runtimes.reverse()){await runtime.stop();runtime.close();}rmSync(root,{recursive:true,force:true});});
  return {root,directory,project,open};
}
function gate() { let release,entered;return {done:new Promise(r=>release=r),started:new Promise(r=>entered=r),release:()=>release(),enter:()=>entered()}; }

test('local init/status does not create shared registry; execution upgrades and records identity',async t=>{
  const f=fixture(t),runtime=f.open(f.project('a'));
  runtime.list();runtime.machineStatus();assert.equal(existsSync(f.directory),false);
  const ticket=runtime.submit({text:'work'});await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'completed');
  const store=new Store(join(stateDir(runtime.projectRoot), 'state.sqlite'));try{assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,14);assert.ok(store.getMeta('instance:identity').instanceId);}finally{store.close();}
  assert.equal(runtime.machineStatus().leases.length,0);
});

test('two runtime objects cannot concurrently execute one project; pure enqueue remains available',async t=>{
  const f=fixture(t),g=gate(),path=f.project('a');
  const a=f.open(path,{driver:{async run(){g.enter();await g.done;return {status:'completed',summary:'done'};}}}),b=f.open(path);
  a.submit({text:'first'});const work=a.runNext();await g.started;
  try { assert.ok(b.submit({text:'queued'}).id);await assert.rejects(b.runNext(),error=>error.code==='PROJECT_LEASE_OWNED'||/owned|owner|owns|active/i.test(error.message)); }
  finally {g.release();await work;}
});

test('repository ownership persists after stop and rejects another project before channel calls',async t=>{
  const f=fixture(t);let probes=0,polls=0;
  const github={repository:'owner/repo',allowedActors:['owner']};
  const channel={async probe(){probes++;return {repository:'owner/repo',repositoryId:42};},async poll(){polls++;return [];},async deliver(){throw new Error('No writes expected');}};
  const a=f.open(f.project('a'),{github,githubChannel:channel}),b=f.open(f.project('b'),{github,githubChannel:channel});
  await a.syncGitHub();await a.stop();const before={probes,polls};
  await assert.rejects(b.syncGitHub(),error=>error.code==='GITHUB_REPOSITORY_OWNED');
  assert.deepEqual({probes,polls},before);assert.equal(a.githubBindingStatus().bindings[0].repositoryId,42);
});

test('nested project execution is blocked while local enqueue remains available and resumes after release',async t=>{
  const f=fixture(t),g=gate(),root=f.project('parent');let childRuns=0;
  const parent=f.open(root,{driver:{async run(){g.enter();await g.done;return {status:'completed',summary:'parent done'};}}});
  const child=f.open(f.project('parent/nested'),{driver:{async run(){childRuns++;return {status:'completed',summary:'child done'};}}});
  parent.submit({text:'parent work'});const work=parent.runNext();await g.started;
  try {
    assert.ok(child.submit({text:'queued child work'}).id);
    await assert.rejects(child.runNext(),error=>error.code==='PROJECT_ROOT_OVERLAP');
    assert.equal(childRuns,0);
  } finally {g.release();await work;}
  await child.runNext();assert.equal(childRuns,1);
});

test('copied state is readable but cannot enqueue or execute as its original project',async t=>{
  const f=fixture(t),a=f.open(f.project('a'));a.submit({text:'saved'});a.upgradeRuntime();
  const bPath=join(f.root,'b');cpSync(a.projectRoot,bPath,{recursive:true});cpSync(stateDir(a.projectRoot),stateDir(bPath),{recursive:true});const b=f.open(bPath);
  assert.equal(b.list().length,1);assert.throws(()=>b.submit({text:'bad'}),/identity|read-only|copied|moved/i);
  await assert.rejects(b.runNext(),/identity|copied|moved/i);
});

test('maintenance blocks existing local writers before backup',t=>{
  const f=fixture(t),a=f.open(f.project('a'));a.upgradeRuntime();
  const coordinator=createMachineCoordinator({projectRoot:a.projectRoot,projectId:a.projectId},{directory:f.directory});
  const lease=coordinator.acquireMaintenance();
  try {assert.throws(()=>a.submit({text:'must wait'}),/maintenance/i);assert.equal(a.list().length,0);}
  finally{coordinator.releaseLease(lease);}
  assert.ok(a.submit({text:'after maintenance'}).id);
});

test('machine execution capacity serializes independent projects without dropping queued work',async t=>{
  const f=fixture(t),g=gate();let secondStarted=false;
  const a=f.open(f.project('a'),{driver:{async run(){g.enter();await g.done;return {status:'completed',summary:'first'};}}});
  const b=f.open(f.project('b'),{driver:{async run(){secondStarted=true;return {status:'completed',summary:'second'};}}});
  createMachineCoordinator({}, {directory:f.directory}).setLimits({maxActiveExecutions:1});
  a.submit({text:'first'});b.submit({text:'second'});const first=a.runNext();await g.started;const second=b.runNext();
  await new Promise(r=>setTimeout(r,40));assert.equal(secondStarted,false);assert.equal(b.machineStatus().waiting.length,1);
  g.release();await Promise.all([first,second]);assert.equal(secondStarted,true);assert.equal(a.machineStatus().slots.length,0);
});

test('legacy state requires explicit adoption before execution',async t=>{
  const f=fixture(t),a=f.open(f.project('legacy'));
  unlinkSync(join(stateDir(a.projectRoot), 'instance.json'));
  a.submit({text:'legacy local work'});
  await assert.rejects(a.runNext(),error=>error.code==='PROJECT_IDENTITY_ADOPTION_REQUIRED');
  assert.equal(a.upgradeRuntime().schemaVersion,14);
  assert.equal((await a.runNext()).status,'completed');
});

test('relocated native work waits for explicit replacement and old directory stays read-only',async t=>{
  const f=fixture(t),a=f.open(f.project('original'),{driver:{async run(input){input.checkpoint({driver:'fixture',id:'native-original'});return {status:'waiting',summary:'Please confirm'};}}});
  const ticket=a.submit({text:'work after move'});await a.runNext();await a.stop();
  const destination=join(f.root,'moved');cpSync(a.projectRoot,destination,{recursive:true});cpSync(stateDir(a.projectRoot),stateDir(destination),{recursive:true});
  const relocation=await relocateProject({projectRoot:destination,fromRoot:a.projectRoot,apply:true},{directory:f.directory});
  assert.equal(relocation.phase,'completed');let runs=0;
  const b=f.open(destination,{driver:{async run(){runs++;return {status:'completed',summary:'new native session'};}}});
  assert.equal(b.isPaused(),true);b.resume();b.reply(ticket.id,'Continue this task in the reviewed location');
  assert.equal(await b.runNext(),null);assert.equal(runs,0);
  await b.replaceSession(ticket.id,{reason:'Reviewed relocated workspace',expectedSessionId:'native-original'});
  await new Promise(resolve=>setTimeout(resolve,25));await b.runNext();assert.equal(runs,1);assert.equal(b.get(ticket.id).status,'completed');
  assert.throws(()=>a.submit({text:'stale location'}),/identity|registered|path/i);
  const old=f.open(a.projectRoot);assert.equal(old.list().length,1);assert.equal(old.machineStatus().readOnly,true);
});

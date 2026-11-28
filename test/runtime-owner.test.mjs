import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Effects} from '../src/effects.mjs';
import {inspectDatabase,createDatabaseBackup} from '../src/database-maintenance.mjs';
import {runtimeOwner,inspectRuntimeOwner,sameRuntimeOwner,isCurrentRuntimeOwner,nativeGuardianOwners,registerChildOwner} from '../src/runtime-owner.mjs';
const previousBoot='11111111-1111-4111-8111-111111111111';
const renamed=()=>({...runtimeOwner(),host:'prior-network-name'});
const exited=()=>({...renamed(),bootSessionId:previousBoot});
function fixture(t) {const root=mkdtempSync(join(tmpdir(),'business-owner-'));const path=join(root,'state.sqlite');const store=new Store(path);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,path,store};}
test('durable business owner identity survives rename and classifies reboot, reuse, foreign and incomplete evidence',()=>{
 const owner=renamed();assert.equal(inspectRuntimeOwner(owner),'alive');assert.equal(isCurrentRuntimeOwner(owner),true);
 assert.equal(inspectRuntimeOwner(exited()),'dead');assert.equal(inspectRuntimeOwner({...owner,birth:'previous-incarnation'}),'dead');
 for(const patch of [{machineId:`sha256:${'f'.repeat(64)}`},{pidNamespace:'pid:[999]'},{identityVersion:3},{bootSessionId:undefined},{unknown:true}]) {
  assert.equal(inspectRuntimeOwner({...owner,...patch}),'unknown');assert.equal(sameRuntimeOwner({...owner,...patch},{pid:owner.pid,host:owner.host}),false);
 }
 assert.equal(inspectRuntimeOwner({pid:process.pid,host:'old-network-name'}),'unknown');
});
test('effects write stable claims, do not steal a renamed live claim, and recover only proven old-boot claims',async t=>{
 const {store}=fixture(t);const effects=new Effects(store);effects.enqueue('work','one',{});
 let release;const running=effects.runNext({work:()=>new Promise(done=>{release=done;})});
 const claim=effects.list()[0];assert.equal(claim.owner.identityVersion,2);
 store.db.prepare('UPDATE effects SET owner=? WHERE seq=?').run(JSON.stringify({...claim.owner,host:'changed'}),claim.seq);
 assert.equal(effects.recover(),0);assert.equal(await effects.runNext({work:()=>assert.fail('must not steal')}),false);
 release();await running;
 for(const [key,owner] of [['old',exited()],['foreign',{...exited(),machineId:`sha256:${'f'.repeat(64)}`}],['legacy',{pid:process.pid,host:'old-network-name'}]]) {
  effects.enqueue('work',key,{});store.db.prepare('UPDATE effects SET token=?,owner=? WHERE key=?').run('claim',JSON.stringify(owner),key);
 }
 assert.equal(effects.recover(),1);assert.equal(effects.list().find(x=>x.key==='old').token,null);
 assert.ok(effects.list().find(x=>x.key==='foreign').token);assert.ok(effects.list().find(x=>x.key==='legacy').token);
});
test('database maintenance shares stable identity recovery and never converts foreign absence into stopped proof',async t=>{
 const {store,path}=fixture(t);store.setMeta('coordinator:owner',renamed());
 assert.equal(inspectDatabase(path).owners[0].state,'alive');
 await assert.rejects(createDatabaseBackup({path,assertStopped:()=>true}),/live or unverifiable/);
 store.setMeta('coordinator:owner',exited());assert.equal(inspectDatabase(path).owners[0].state,'dead');
 const backup=await createDatabaseBackup({path,assertStopped:()=>true});assert.equal(backup.schemaVersion,2);
 store.setMeta('coordinator:owner',{...exited(),machineId:`sha256:${'f'.repeat(64)}`});
 assert.equal(inspectDatabase(path).owners[0].state,'unknown');
 await assert.rejects(createDatabaseBackup({path,assertStopped:()=>true}),/live or unverifiable/);
});
test('native handoff recovery preserves full guardian evidence instead of reconstructing host/PID pairs',()=>{
 const guardian=exited();const record={owner:renamed(),guardianPids:[guardian.pid],guardianOwners:[guardian]};
 assert.deepEqual(nativeGuardianOwners(record),[guardian]);assert.equal(inspectRuntimeOwner(nativeGuardianOwners(record)[0]),'dead');
 assert.equal(inspectRuntimeOwner(nativeGuardianOwners({...record,guardianOwners:undefined})[0]),'unknown');
});
test('guardian registration retains a new process incarnation when its PID appears in old evidence',()=>{
 const previous={...runtimeOwner(),birth:'previous-incarnation'},guardians=[previous];
 const current=registerChildOwner(guardians,process.pid);
 assert.equal(guardians.length,2);assert.equal(sameRuntimeOwner(previous,current),false);
 guardians[1]={...current,host:'renamed'};
 registerChildOwner(guardians,process.pid);assert.equal(guardians.length,2);
});

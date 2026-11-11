import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAgent, inspectDatabase, prepareDatabaseRestore, createDatabaseBackup } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { BotReviewBudget, legacyReviewBudgetKey } from '../src/runtime/bot-review-budget.mjs';

const packageRoot=fileURLToPath(new URL('..',import.meta.url));
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'js-w35-schema9-')),runtime=createProjectAgent({projectRoot:root}).init();
  const directory=stateDir(root),path=join(directory,'state.sqlite'),store=new Store(path);
  store.db.exec('PRAGMA user_version=8');store.setMeta('runtime:minimum-version','0.7.0-alpha.0');
  const binding={repository:'fixture/project',id:'900',number:9};store.setMeta('github:pull:fixture/project#9',binding);
  t.after(async()=>{store.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  return {root,runtime,directory,path,store,binding};
}
// Frozen schema guard from 0.7's writer. The old package must refuse before
// changing journal mode or performing any write against a newer database.
function previousWriter(path){
  const db=new DatabaseSync(path);
  if(Number(db.prepare('PRAGMA user_version').get().user_version)>8){db.close();throw new Error('Unsupported state schema: 9');}
  return db;
}

test('W35 schema8 queries stay unchanged; explicit schema9 upgrade backs up, marks unknown PR history and stages rollback',{timeout:5000},async t=>{
  const f=fixture(t);
  assert.deepEqual(f.runtime.list(),[]);assert.deepEqual(f.runtime.reviewActionStatus(),[]);assert.deepEqual(f.runtime.botReviewStatus(),[]);f.runtime.schedulerStatus();
  assert.equal(inspectDatabase(f.path).schemaVersion,8);assert.equal(f.store.getMeta(legacyReviewBudgetKey(f.binding)),undefined);
  assert.equal(readdirSync(f.directory).filter(name=>name.endsWith('.backup')).length,0);
  const cli=spawnSync(process.execPath,[join(packageRoot,'bin/js-superagent.mjs'),'--project',f.root,'review','status'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),[]);assert.equal(inspectDatabase(f.path).schemaVersion,8);
  assert.equal(f.runtime.upgradeRuntime().schemaVersion,15);assert.equal(f.store.getMeta('runtime:minimum-version'),'0.15.0-alpha.0');
  const facts=inspectDatabase(f.path);assert.equal(facts.schemaVersion,15);assert.equal(facts.migrations.at(-1).id,'project-materials-v14');
  const budget=new BotReviewBudget(f.store);assert.equal(budget.get(f.binding,'42').historicalUnknown,true);
  assert.equal(budget.inspect(f.binding,{id:'review:1',kind:'review',reviewId:'1',actor:{id:'42'}}).reason,'bot-review-history-unknown');
  assert.throws(()=>previousWriter(f.path),/Unsupported state schema: 9/);
  const backups=readdirSync(f.directory).filter(name=>name.endsWith('.backup'));assert.equal(backups.length,1);
  const backupPath=join(f.directory,backups[0]),manifest=JSON.parse(readFileSync(`${backupPath}.json`,'utf8'));
  assert.equal(manifest.schemaVersion,8);assert.equal(manifest.targetVersion,15);assert.equal(inspectDatabase(backupPath).schemaVersion,8);
  assert.equal(f.runtime.upgradeRuntime().schemaVersion,15);assert.equal(readdirSync(f.directory).filter(name=>name.endsWith('.backup')).length,1);
  const options={path:f.path,backupPath,expectedVersion:8,assertStopped:()=>true};
  await assert.rejects(prepareDatabaseRestore(options),/reconciliation/);
  const staged=await prepareDatabaseRestore({...options,reconciliation:{backupId:manifest.id,note:'Temporary fixture only; no external effects occurred.'}});
  assert.equal(staged.installRequired,true);assert.equal(staged.oldPackageRequired,true);assert.equal(inspectDatabase(f.path).schemaVersion,15);
  const old=previousWriter(staged.path);try{assert.equal(old.prepare('SELECT data FROM kv WHERE key=?').get('runtime:minimum-version').data,'"0.7.0-alpha.0"');
    assert.equal(old.prepare('SELECT data FROM kv WHERE key=?').get(legacyReviewBudgetKey(f.binding)),undefined);}finally{old.close();}
});

test('W35 database maintenance cannot ignore transferred native owners or their guardians',{timeout:5000},async t=>{
  const f=fixture(t),key='native-handoff:held',deadPid=2147483647;
  for(const [status,owner,guardianPids] of [
    ['holding',{host:hostname(),pid:process.pid},[deadPid]],
    ['resuming',{host:hostname(),pid:deadPid},[process.pid]],
    ['closing',{host:'unverifiable-host',pid:deadPid},[deadPid]],
    ['holding',{host:hostname(),pid:deadPid},[]],
  ]){
    f.store.setMeta(key,{status,owner,guardianPids});
    assert.ok(inspectDatabase(f.path).owners.some(item=>item.name.startsWith(key)&&item.state!=='dead'));
    await assert.rejects(createDatabaseBackup({path:f.path,assertStopped:()=>true}),/native-handoff:held/);
    assert.equal(inspectDatabase(f.path).schemaVersion,8);assert.equal(readdirSync(f.directory).filter(name=>name.endsWith('.backup')).length,0);
  }
  f.store.setMeta(key,{status:'completed',owner:{host:hostname(),pid:process.pid},guardianPids:[process.pid]});
  assert.equal(inspectDatabase(f.path).owners.some(item=>item.name.startsWith(key)),false);f.store.deleteMeta(key);
});

test('W35 CLI help and public SDK import remain side-effect free',{timeout:5000},t=>{
  const root=mkdtempSync(join(tmpdir(),'js-w35-entry-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const help=spawnSync(process.execPath,[join(packageRoot,'bin/js-superagent.mjs'),'--help'],{cwd:root,encoding:'utf8'});
  assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/review status/);assert.match(help.stdout,/native-preview renew\|close/);
  const sdk=spawnSync(process.execPath,['--input-type=module','-e',`const api=await import(${JSON.stringify(new URL('../src/index.mjs',import.meta.url).href)});if(typeof api.createProjectAgent!=='function'||typeof api.inspectDatabase!=='function')throw new Error('Missing public API');console.log('SDK_IMPORT_OK');`],{cwd:root,encoding:'utf8'});
  assert.equal(sdk.status,0,sdk.stderr);assert.match(sdk.stdout,/SDK_IMPORT_OK/);assert.equal(existsSync(stateDir(root)),false);
});

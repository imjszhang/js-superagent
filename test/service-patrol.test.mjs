import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeProjectConfig } from '../src/config.mjs';
import { createServiceManager } from '../src/service.mjs';

const runId='cd432b56-5645-4e8d-b211-cc94f64fd111';
function fixture(t) {
  const base=realpathSync(mkdtempSync(join(tmpdir(),'js-service-patrol-'))),root=join(base,'project'),home=join(base,'home');
  mkdirSync(root);mkdirSync(home);t.after(()=>rmSync(base,{recursive:true,force:true}));
  const executable=join(base,'codex');writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
  initializeProjectConfig(root,{execution:{driver:'codex-app-server',executable}});
  const directory=join(stateDir(root), 'service'),dbPath=join(stateDir(root), 'state.sqlite');
  const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,data TEXT);CREATE TABLE domain_tickets(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE effects(owner TEXT);CREATE TABLE receipts(status TEXT);PRAGMA user_version=14');db.close();
  let now=100_000,job=false,alive=true,hook,signalHook;const calls=[],signals=[];
  const deps={platform:'darwin',uid:501,coordinationDirectory:join(base,'machine'),now:()=>now,ownerState:()=>alive?'alive':'dead',patrolGraceMs:0,
    signalProcess(pid,signal){signals.push({pid,signal});if(signalHook)signalHook();else alive=false;},
    launchctl(args){calls.push(args);if(args[0]==='print'){if(!job)throw Object.assign(new Error('missing'),{stderr:'Could not find service'});return 'state = running\npid = 100\n';}
      if(args[0]==='bootstrap'||args[0]==='kickstart'){job=true;alive=true;}if(args[0]==='bootout')job=false;hook?.(args);return '';}};
  const manager=createServiceManager({projectRoot:root,homeDirectory:home},deps);
  const write=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value),{mode:0o600});
  const pulse=(patch={})=>{
    write('runtime.json',{healthProtocol:1,runId,pid:100,childPid:101,owner:{host:'fixture',pid:100,birth:'parent',bootId:'boot'},childOwner:{host:'fixture',pid:101,birth:'child',bootId:'boot'},startedAt:new Date(0).toISOString()});
    write('startup.json',{schemaVersion:1,state:'ready',retryCount:0,pid:100,childPid:101});
    write('heartbeat.json',{schemaVersion:1,runId,sequence:1,pid:100,childPid:101,receivedAt:new Date(now).toISOString(),business:{available:true,observedAt:new Date(now).toISOString(),machineReady:true,paused:false,active:false,activeIncidents:0,modelWaits:0,sources:[],...patch}});
  };
  const mutate=fn=>{const db=new DatabaseSync(dbPath);try{return fn(db);}finally{db.close();}};
  return {root,directory,dbPath,manager,calls,signals,pulse,write,mutate,advance(ms){now+=ms;},
    set hook(fn){hook=fn;},set signalHook(fn){signalHook=fn;},set alive(value){alive=value;},
    start(){manager.install();manager.start();pulse();},stale(){now+=20_001;}};
}

test('patrol never installs or starts an absent or intentionally stopped service',t=>{
  const f=fixture(t);assert.equal(f.manager.patrol({recover:true}).action,'not-installed');assert.equal(existsSync(f.directory),false);
  f.manager.install();const before=f.calls.length,report=f.manager.patrol({recover:true});
  assert.equal(report.health.state,'stopped');assert.equal(report.notify,false);assert.equal(f.signals.length,0);
  assert.equal(f.calls.slice(before).some(args=>['enable','bootstrap','kickstart','bootout'].includes(args[0])),false);
});

test('healthy patrols stay quiet and persistent notifications change only with meaningful health facts',t=>{
  const f=fixture(t);f.start();assert.equal(f.manager.patrol().notify,false);f.advance(5000);f.pulse();
  assert.equal(f.manager.patrol().changed,false);
  f.pulse({sources:[{id:'github',state:'degraded'}]});assert.equal(f.manager.patrol().notify,true);assert.equal(f.manager.patrol().notify,false);
  f.pulse({sources:[{id:'github',state:'healthy'}]});const recovered=f.manager.patrol();assert.equal(recovered.changed,true);assert.equal(recovered.notify,true);assert.equal(f.manager.patrol().notify,false);
  f.manager.stop();assert.equal(f.manager.patrol({recover:true}).health.state,'stopped');assert.deepEqual(f.signals,[{pid:100,signal:'SIGTERM'}]);
  const stateDb=new DatabaseSync(join(f.directory,'patrol.sqlite'),{readOnly:true});try{assert.equal(stateDb.prepare('SELECT COUNT(*) AS count FROM state').get().count,1);}finally{stateDb.close();}
});

test('recovery requires spaced observations and a proven idle project, then gracefully stops and restarts once',t=>{
  const f=fixture(t);f.start();f.stale();
  assert.equal(f.manager.patrol({recover:true}).action,'awaiting-confirmation');
  assert.equal(f.manager.patrol({recover:true}).confirmations,1);assert.equal(f.signals.length,0);
  f.advance(20_000);const nested=[];f.signalHook=()=>{nested.push(f.manager.patrol({recover:true}));f.alive=false;};
  const recovered=f.manager.patrol({recover:true});assert.equal(recovered.action,'restarted');assert.equal(recovered.notify,true);
  assert.deepEqual(f.signals,[{pid:100,signal:'SIGTERM'}]);assert.equal(nested[0].action,'busy');
  assert.equal(f.manager.patrol({recover:true}).reason,'recovery-already-attempted');assert.equal(f.signals.length,1);
});

test('unknown native work and unfinished tickets forbid recovery without changing project state',t=>{
  const f=fixture(t);f.start();f.stale();
  f.mutate(db=>db.prepare('INSERT INTO domain_tickets VALUES(?,?)').run('open',JSON.stringify({id:'open'})));
  const before=readFileSync(f.dbPath);assert.equal(f.manager.patrol({recover:true}).reason,'unfinished-tickets');
  assert.deepEqual(readFileSync(f.dbPath),before);assert.equal(f.signals.length,0);
  f.mutate(db=>{db.exec('DELETE FROM domain_tickets');db.prepare('INSERT INTO kv VALUES(?,?)').run('live-input:pending',JSON.stringify({status:'accepted'}));});
  f.advance(20_000);assert.equal(f.manager.patrol({recover:true}).reason,'native-input-needs-inspection');assert.equal(f.signals.length,0);
});

test('patrol recognizes material schema but still refuses unfinished material work', t => {
  const f = fixture(t); f.start(); f.stale();
  f.mutate(db => { db.exec('PRAGMA user_version=15'); db.prepare('INSERT INTO domain_tickets VALUES(?,?)').run('material-work', JSON.stringify({ id: 'material-work' })); });
  assert.equal(f.manager.patrol({ recover: true }).reason, 'unfinished-tickets');
  assert.equal(f.signals.length, 0);
  f.mutate(db => db.exec('DELETE FROM domain_tickets'));
  f.advance(20_000);
  assert.notEqual(f.manager.patrol({ recover: true }).reason, 'project-version-needs-inspection');
});

test('the first refused recovery explains its safety reason once even after the unchanged fault was already reported',t=>{
  const f=fixture(t);f.start();f.pulse({modelWaits:1});f.stale();assert.equal(f.manager.patrol().notify,true);assert.equal(f.manager.patrol().notify,false);
  const refused=f.manager.patrol({recover:true});assert.equal(refused.reason,'business-needs-attention');assert.equal(refused.notify,true);
  assert.equal(f.manager.patrol({recover:true}).notify,false);assert.equal(f.signals.length,0);
});

test('a missing legacy start intent or unknown process identity is observed without recovery',t=>{
  const f=fixture(t);f.start();f.stale();unlinkSync(join(f.directory,'control-intent.json'));
  assert.equal(f.manager.patrol({recover:true}).reason,'explicit-start-required');assert.equal(f.signals.length,0);
  f.write('runtime.json',{healthProtocol:1,runId,pid:100,childPid:101});
  assert.equal(f.manager.patrol({recover:true}).health.state,'unobserved');assert.equal(f.signals.length,0);
});

test('operator stop during recovery invalidates the old running intent and prevents any restart',t=>{
  const f=fixture(t);f.start();f.stale();f.manager.patrol({recover:true});f.advance(20_000);
  let afterStop;f.signalHook=()=>{f.alive=false;f.manager.stop();afterStop=f.calls.length;};
  const result=f.manager.patrol({recover:true});assert.equal(result.reason,'operator-intent-changed');
  assert.equal(f.calls.slice(afterStop).some(args=>['enable','bootstrap','kickstart'].includes(args[0])),false);
  assert.equal(f.manager.status().running,false);assert.equal(f.manager.patrol({recover:true}).health.state,'stopped');
});

test('an operator stop racing the enable boundary wins and no process is bootstrapped afterwards',t=>{
  const f=fixture(t);f.start();f.stale();f.manager.patrol({recover:true});f.advance(20_000);
  let afterStop;f.hook=args=>{if(args[0]==='enable'){f.hook=null;f.manager.stop();afterStop=f.calls.length;}};
  const result=f.manager.patrol({recover:true});assert.equal(result.reason,'operator-intent-changed');
  assert.equal(f.calls.slice(afterStop).some(args=>['enable','bootstrap','kickstart'].includes(args[0])),false);
  assert.equal(f.manager.status().running,false);
});

test('unconfirmed graceful shutdown never bootouts or force kills the live process and is not retried automatically',t=>{
  const f=fixture(t);f.start();f.stale();f.manager.patrol({recover:true});f.advance(20_000);f.signalHook=()=>{};
  const before=f.calls.length,result=f.manager.patrol({recover:true});assert.equal(result.reason,'graceful-stop-unconfirmed');
  assert.equal(f.calls.slice(before).some(args=>['bootout','enable','bootstrap','kickstart'].includes(args[0])),false);
  assert.equal(f.manager.patrol({recover:true}).reason,'recovery-already-attempted');assert.equal(f.signals.length,1);
});

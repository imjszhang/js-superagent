import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProjectConfig } from '../src/config.mjs';
import { createServiceManager, retireRelocatedService } from '../src/service.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureProcessIdentity, inspectProcessOwner } from '../src/machine-coordination.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';

function fixture(t) {
  const base=realpathSync(mkdtempSync(join(tmpdir(),'js-service-stop-'))),root=join(base,'project'),home=join(base,'home');
  mkdirSync(root);mkdirSync(home);t.after(()=>rmSync(base,{recursive:true,force:true}));
  const executable=join(base,'codex');writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
  initializeProjectConfig(root,{execution:{driver:'codex-app-server',executable}});
  const directory=join(projectStateDirectory(root),'service'),calls=[],signals=[];
  const states=new Map([[100,'dead'],[101,'dead']]);let job=false,graceful=true;
  const deps={platform:'darwin',uid:501,coordinationDirectory:join(base,'machine'),stopTimeoutMs:0,
    ownerState:owner=>states.get(owner.pid)??'unknown',
    signalProcess(pid,signal){signals.push({pid,signal});if(graceful){states.set(pid,'dead');if(pid===100)states.set(101,'dead');}},
    launchctl(args){calls.push(args);if(args[0]==='print'){if(!job)throw Object.assign(new Error('missing'),{stderr:'Could not find service'});return 'state = running\npid = 100\n';}
      if(args[0]==='bootstrap'||args[0]==='kickstart')job=true;if(args[0]==='bootout')job=false;return '';}};
  const options={projectRoot:root,homeDirectory:home},manager=createServiceManager(options,deps);
  const write=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value),{mode:0o600});
  const record=()=>write('runtime.json',{healthProtocol:1,runId:'cd432b56-5645-4e8d-b211-cc94f64fd111',pid:100,childPid:101,
    owner:{host:'fixture',pid:100,birth:'wrapper',bootId:'boot'},childOwner:{host:'fixture',pid:101,birth:'child',bootId:'boot'},startedAt:new Date(0).toISOString()});
  manager.install();
  return {manager,options,deps,directory,calls,signals,states,record,write,set job(value){job=value;},set graceful(value){graceful=value;}};
}

test('unloaded launchd with a live owned child is not stopped and cannot start a second instance',t=>{
  const f=fixture(t);f.record();f.states.set(101,'alive');f.graceful=false;
  assert.equal(f.manager.status().stopPending,true);
  assert.equal(f.manager.health().reason,'service-stop-incomplete');
  assert.throws(()=>f.manager.start(),error=>error.code==='SERVICE_STOP_PENDING');
  assert.throws(()=>f.manager.restart(),error=>error.code==='SERVICE_STOP_PENDING');
  assert.throws(()=>f.manager.uninstall(),error=>error.code==='SERVICE_STOP_PENDING');
  assert.throws(()=>f.manager.install(),error=>error.code==='SERVICE_STOP_PENDING');
  assert.equal(f.calls.some(args=>['bootstrap','kickstart','bootout','enable'].includes(args[0])),false);
  assert.equal(f.signals.every(({pid,signal})=>pid===101&&signal==='SIGTERM'),true);
  assert.equal(existsSync(join(f.directory,'manifest.json')),true);
});

test('stop requests graceful wrapper exit before unloading its launchd job',t=>{
  const f=fixture(t);f.record();f.job=true;f.states.set(100,'alive');f.states.set(101,'alive');
  f.deps.signalProcess=(pid,signal)=>{assert.equal(f.calls.some(args=>args[0]==='bootout'),false);f.signals.push({pid,signal});f.states.set(100,'dead');f.states.set(101,'dead');};
  const stopped=f.manager.stop();
  assert.equal(stopped.stopPending,false);assert.equal(stopped.loaded,false);
  assert.deepEqual(f.signals,[{pid:100,signal:'SIGTERM'}]);
});

test('unknown process identity remains unverified and is never signalled or unloaded',t=>{
  const f=fixture(t);f.record();f.job=true;f.states.set(100,'unknown');f.states.set(101,'alive');
  assert.throws(()=>f.manager.stop(),error=>error.code==='SERVICE_STOP_PENDING');
  assert.equal(f.manager.health().reason,'service-stop-unverified');
  assert.equal(f.signals.length,0);assert.equal(f.calls.some(args=>args[0]==='bootout'),false);
  const before=readFileSync(join(f.directory,'startup.json'));
  f.manager.status();f.manager.health();assert.deepEqual(readFileSync(join(f.directory,'startup.json')),before);
});

test('only the proven orphan child is signalled and reused PIDs are not touched',t=>{
  const f=fixture(t);f.record();f.states.set(100,'dead');f.states.set(101,'alive');
  assert.equal(f.manager.stop().stopPending,false);assert.deepEqual(f.signals,[{pid:101,signal:'SIGTERM'}]);
  f.signals.length=0;assert.equal(f.manager.stop().stopPending,false);assert.equal(f.signals.length,0);
});

test('never-started installation is stoppable but malformed retained runtime is not treated as never started',t=>{
  const f=fixture(t);assert.equal(f.manager.stop().stopPending,false);
  f.write('runtime.json',{pid:100,childPid:101});
  assert.throws(()=>f.manager.start(),error=>error.code==='SERVICE_STOP_PENDING');
  assert.throws(()=>f.manager.stop(),error=>error.code==='SERVICE_STOP_PENDING');assert.equal(f.signals.length,0);
  f.write('runtime.json',null);assert.throws(()=>f.manager.start(),error=>error.code==='SERVICE_STOP_PENDING');
});

test('relocation refuses a surviving child, including an already removed plist',t=>{
  const f=fixture(t),root=f.options.projectRoot,target=join(root,'..','moved'),plist=f.manager.status().plistPath;
  f.record();f.states.set(101,'alive');f.graceful=false;
  renameSync(root,target);renameSync(projectStateDirectory(root),projectStateDirectory(target));
  assert.throws(()=>retireRelocatedService({projectRoot:target,fromRoot:root},f.deps),error=>error.code==='SERVICE_STOP_PENDING');
  assert.equal(existsSync(plist),true);rmSync(plist);
  assert.throws(()=>retireRelocatedService({projectRoot:target,fromRoot:root},f.deps),error=>error.code==='SERVICE_STOP_PENDING');
});

test('an automatic wrapper retry refuses to replace evidence of an actually live child', {skip:process.platform!=='darwin'}, async t=>{
  const f=fixture(t),orphan=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>{if(orphan.exitCode===null)orphan.kill('SIGTERM');});
  await new Promise(resolve=>orphan.once('spawn',resolve));
  const childOwner=captureProcessIdentity(orphan.pid),owner={...childOwner,pid:999999,birth:'old-wrapper'};
  const recorded={healthProtocol:1,runId:'cd432b56-5645-4e8d-b211-cc94f64fd111',pid:owner.pid,childPid:orphan.pid,owner,childOwner,startedAt:new Date().toISOString()};
  f.write('runtime.json',recorded);
  const intent=JSON.parse(readFileSync(join(f.directory,'control-intent.json')));f.write('control-intent.json',{...intent,desired:'running'});
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/service.mjs',import.meta.url)),'run',f.options.projectRoot],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.directory,'startup.json'))).errorCode,'SERVICE_STOP_PENDING');
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'runtime.json'))),recorded);
  assert.equal(orphan.exitCode,null);
});

test('a stopped control intent prevents a late wrapper from spawning its child', {skip:process.platform!=='darwin'}, t=>{
  const f=fixture(t),cliPath=join(f.options.projectRoot,'test-cli.mjs'),receipt=join(f.options.projectRoot,'spawned');
  f.manager.uninstall();writeFileSync(cliPath,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(receipt)},'spawned');`);
  createServiceManager({...f.options,cliPath},f.deps).install();
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/service.mjs',import.meta.url)),'run',f.options.projectRoot],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.equal(existsSync(receipt),false);
});

test('service stop waits for a real wrapper and child to exit before bootout', {skip:process.platform!=='darwin'}, async t=>{
  const f=fixture(t),cliPath=join(f.options.projectRoot,'test-cli.mjs');f.manager.uninstall();
  writeFileSync(cliPath,"process.send({type:'js-superagent:ready'});setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));");
  let wrapper,job=false;const signals=[];
  const manager=createServiceManager({...f.options,cliPath},{...f.deps,stopTimeoutMs:3000,ownerState:inspectProcessOwner,
    signalProcess(pid,signal){signals.push({pid,signal});process.kill(pid,signal);},
    launchctl(args){if(args[0]==='print'){if(!job)throw Object.assign(new Error('missing'),{stderr:'Could not find service'});return wrapper?`state = running\npid = ${wrapper.pid}\n`:'state = waiting\n';}
      if(args[0]==='bootstrap')job=true;
      if(args[0]==='bootout'){const record=JSON.parse(readFileSync(join(f.directory,'runtime.json')));assert.equal(inspectProcessOwner(record.owner),'dead');assert.equal(inspectProcessOwner(record.childOwner),'dead');job=false;}return '';}});
  manager.install();manager.start();
  wrapper=spawn(process.execPath,[fileURLToPath(new URL('../src/service.mjs',import.meta.url)),'run',f.options.projectRoot],{stdio:'ignore'});
  t.after(()=>{if(wrapper.exitCode===null)wrapper.kill('SIGTERM');});
  const deadline=Date.now()+3000;
  while(!manager.status().ready&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(manager.status().ready,true);
  const stopped=manager.stop();assert.equal(stopped.loaded,false);assert.equal(stopped.stopPending,false);
  assert.deepEqual(signals,[{pid:wrapper.pid,signal:'SIGTERM'}]);
});

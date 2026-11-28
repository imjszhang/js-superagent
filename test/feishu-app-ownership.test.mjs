import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {MACHINE_DEPENDENCIES} from '../src/runtime/machine-guard.mjs';
import {createMachineCoordinator} from '../src/machine-coordination.mjs';
import {initializeProjectConfig,readProjectConfig} from '../src/config.mjs';
import {projectStateDirectory} from '../src/state-paths.mjs';
import {createServiceManager} from '../src/service.mjs';
const config=(appId='cli_shared')=>({appId,appSecretEnv:'TEST_UNUSED_SECRET',botOpenId:'ou_bot',tenantKey:'tenant',chats:[{chatId:'oc_group',type:'group',mode:'mentions'}]});
function fixture(t){const base=realpathSync(mkdtempSync(join(tmpdir(),'feishu-app-ownership-'))),directory=join(base,'machine');const runtimes=[];
 const project=name=>{const root=join(base,name);mkdirSync(root);return root;};
 const runtime=root=>{const r=createProjectAgent({projectRoot:root,[MACHINE_DEPENDENCIES]:{directory}}).init();runtimes.push(r);return r;};
 t.after(async()=>{for(const r of runtimes){await r.stop();r.close();}rmSync(base,{recursive:true,force:true});});return{base,directory,project,runtime};}
test('one App is exclusive across projects regardless of tenant, chat, enabled flag or credentials',t=>{
 const f=fixture(t),a=f.runtime(f.project('a')),b=f.runtime(f.project('b'));a.configure({feishu:config()});
 const before=readFileSync(join(projectStateDirectory(b.projectRoot),'config.json'));
 for(const change of [{},{tenantKey:'other'},{chats:[{chatId:'oc_other',type:'group',mode:'all'}]},{enabled:false},{appSecretEnv:'OTHER_SECRET'}]){
  assert.throws(()=>b.configure({feishu:{...config(),...change}}),e=>e.code==='FEISHU_APP_OWNED'&&e.message.includes(a.projectRoot)&&!e.message.includes('OTHER_SECRET'));
  assert.deepEqual(readFileSync(join(projectStateDirectory(b.projectRoot),'config.json')),before);
 }
 assert.doesNotThrow(()=>a.configure({feishu:{...config(),enabled:false}}));
 assert.doesNotThrow(()=>b.configure({feishu:config('cli_separate')}));
 assert.equal(a.feishuBindingStatus().bindings.length,1);
});
test('stop and disable retain ownership; explicit settled release after removing config permits reassignment',async t=>{
 const f=fixture(t),a=f.runtime(f.project('a')),b=f.runtime(f.project('b'));a.configure({feishu:config()});await a.stop();
 assert.throws(()=>a.releaseFeishuBinding({appId:'cli_shared',apply:true}),{code:'FEISHU_BINDING_RELEASE_UNSAFE'});
 a.configure({feishu:{enabled:false}});assert.throws(()=>b.configure({feishu:config()}),{code:'FEISHU_APP_OWNED'});
 a.configure({feishu:null});assert.throws(()=>b.configure({feishu:config()}),{code:'FEISHU_APP_OWNED'});
 assert.equal(a.releaseFeishuBinding({appId:'cli_shared',apply:true}).released,true);
 b.configure({feishu:config()});assert.equal(b.feishuBindingStatus().bindings[0].projectRoot,b.projectRoot);
});
test('legacy registered configurations block new claims without an index and remain repairable',async t=>{
 const f=fixture(t),ar=f.project('a'),br=f.project('b');const a=f.runtime(ar),b=f.runtime(br);
 const ca=createMachineCoordinator({projectRoot:ar,projectId:readProjectConfig(ar).projectId},{directory:f.directory});ca.register();
 const cb=createMachineCoordinator({projectRoot:br,projectId:readProjectConfig(br).projectId},{directory:f.directory});cb.register();
 for(const root of [ar,br]){const path=join(projectStateDirectory(root),'config.json');writeFileSync(path,JSON.stringify({...readProjectConfig(root),feishu:config()}),{mode:0o600});}
 assert.throws(()=>a.configure({feishu:config()}),{code:'FEISHU_APP_OWNED'});
 await assert.rejects(a.prepareExecution(),{code:'FEISHU_APP_OWNED'});
 b.configure({feishu:config('cli_fixed')});a.configure({feishu:config()});
 assert.equal(readProjectConfig(br).feishu.appId,'cli_fixed');
});
test('initialization rejects before creating project state; interrupted reservation can be resumed',t=>{
 const f=fixture(t),a=f.project('a'),b=f.project('b');initializeProjectConfig(a,{feishu:config()},{directory:f.directory});
 assert.throws(()=>initializeProjectConfig(b,{feishu:config()},{directory:f.directory}),{code:'FEISHU_APP_OWNED'});
 assert.equal(existsSync(join(projectStateDirectory(b),'config.json')),false);
 const c=f.project('interrupted'),owner=createMachineCoordinator({projectRoot:c,projectId:'reserved-project'},{directory:f.directory});owner.claimFeishuApp({appId:'cli_resume'});
 assert.equal(initializeProjectConfig(c,{feishu:config('cli_resume')},{directory:f.directory}).projectId,'reserved-project');
});
test('legacy missing configuration fails closed and read-only binding inspection does not create registry',t=>{
 const f=fixture(t),a=f.project('a'),b=f.project('b');const ca=createMachineCoordinator({projectRoot:a,projectId:'a'},{directory:f.directory});
 assert.deepEqual(ca.feishuAppBinding(),[]);assert.equal(existsSync(f.directory),false);ca.register();
 const cb=createMachineCoordinator({projectRoot:b,projectId:'b'},{directory:f.directory});
 assert.throws(()=>cb.claimFeishuApp({appId:'cli_shared'}),{code:'FEISHU_APP_OWNERSHIP_UNKNOWN'});
});
test('service validation rejects another project App before credentials, plist or launchd changes',t=>{
 const f=fixture(t),a=f.runtime(f.project('a')),b=f.runtime(f.project('b'));a.configure({feishu:config()});
 const path=join(projectStateDirectory(b.projectRoot),'config.json');writeFileSync(path,JSON.stringify({...readProjectConfig(b.projectRoot),feishu:config()}),{mode:0o600});
 let writes=0;const home=join(f.base,'home');mkdirSync(home);
 const service=createServiceManager({projectRoot:b.projectRoot,homeDirectory:home},{platform:'darwin',uid:501,coordinationDirectory:f.directory,launchctl(args){if(args[0]!=='print')writes++;throw new Error('Could not find service');}});
 assert.throws(()=>service.install(),{code:'FEISHU_APP_OWNED'});assert.equal(writes,0);assert.equal(existsSync(join(home,'Library/LaunchAgents')),false);
});
test('simultaneous processes claiming an App yield exactly one owner and one unchanged losing config',async t=>{
 const f=fixture(t),roots=[f.project('a'),f.project('b')];createMachineCoordinator({}, {directory:f.directory}).setLimits({maxActiveExecutions:null});
 const source=`import {initializeProjectConfig} from './src/config.mjs';try{initializeProjectConfig(process.argv[1],{feishu:JSON.parse(process.argv[3])},{directory:process.argv[2]});console.log('owned');}catch(e){console.log(e.code);process.exitCode=2;}`;
 const results=await Promise.all(roots.map(root=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',source,root,f.directory,JSON.stringify(config())],{cwd:process.cwd(),env:process.env});let out='';p.stdout.on('data',x=>out+=x);p.on('error',reject);p.on('exit',code=>resolve({code,out}));})));
 assert.deepEqual(results.map(r=>r.code).sort(),[0,2]);assert.equal(results.filter(r=>r.out.includes('FEISHU_APP_OWNED')).length,1);
 assert.equal(roots.filter(root=>existsSync(join(projectStateDirectory(root),'config.json'))).length,1);
});

test('unindexed legacy App ownership survives removal until explicit release',t=>{
 const f=fixture(t),a=f.runtime(f.project('a')),b=f.runtime(f.project('b'));
 const ca=createMachineCoordinator({projectRoot:a.projectRoot,projectId:readProjectConfig(a.projectRoot).projectId},{directory:f.directory});ca.register();
 const file=join(projectStateDirectory(a.projectRoot),'config.json');writeFileSync(file,JSON.stringify({...readProjectConfig(a.projectRoot),feishu:config()}),{mode:0o600});
 a.configure({feishu:null});assert.throws(()=>b.configure({feishu:config()}),{code:'FEISHU_APP_OWNED'});
 a.releaseFeishuBinding({appId:'cli_shared',apply:true});b.configure({feishu:config()});
});
test('interrupted initial reservation preserves identity even when retry selects another App',t=>{
 const f=fixture(t),root=f.project('resume'),owner=createMachineCoordinator({projectRoot:root,projectId:'original-reservation'},{directory:f.directory});owner.claimFeishuApp({appId:'cli_old'});
 assert.equal(initializeProjectConfig(root,{feishu:config('cli_new')},{directory:f.directory}).projectId,'original-reservation');
 const runtime=f.runtime(root);assert.equal(runtime.releaseFeishuBinding({appId:'cli_old',apply:true}).released,true);
});
test('registered project state location is retained across state-home changes',t=>{
 const f=fixture(t),root=f.project('old-home'),cfg=initializeProjectConfig(root),owner=createMachineCoordinator({projectRoot:root,projectId:cfg.projectId},{directory:f.directory});owner.register();
 writeFileSync(join(projectStateDirectory(root),'config.json'),JSON.stringify({...cfg,feishu:config()}),{mode:0o600});
 const previous=process.env.JS_SUPERAGENT_HOME;process.env.JS_SUPERAGENT_HOME=join(f.base,'other-home');
 try {const c=createMachineCoordinator({projectRoot:f.project('new-home'),projectId:'new'},{directory:f.directory});assert.throws(()=>c.claimFeishuApp({appId:'cli_shared'}),{code:'FEISHU_APP_OWNED'});}
 finally {process.env.JS_SUPERAGENT_HOME=previous;}
});

test('failed configuration publication retains a recoverable reservation',t=>{
 const f=fixture(t),runtime=f.runtime(f.project('project'));runtime.configure({feishu:config('cli_original')});
 const directory=projectStateDirectory(runtime.projectRoot),before=readFileSync(join(directory,'config.json'));
 chmodSync(directory,0o500);
 try {assert.throws(()=>runtime.configure({feishu:config('cli_failed')}),/EACCES|EPERM/);}finally{chmodSync(directory,0o700);}
 assert.deepEqual(readFileSync(join(directory,'config.json')),before);
 assert.deepEqual(runtime.feishuBindingStatus().bindings.map(x=>x.appId).sort(),['cli_failed','cli_original']);
 runtime.releaseFeishuBinding({appId:'cli_failed',apply:true});
 assert.deepEqual(runtime.feishuBindingStatus().bindings.map(x=>x.appId),['cli_original']);
});
test('CLI binding status is read-only even before a runtime database exists',t=>{
 const f=fixture(t),root=f.project('query');initializeProjectConfig(root);
 const result=JSON.parse(execFileSync(process.execPath,['bin/js-superagent.mjs','--project',root,'feishu','binding','status'],{env:{...process.env,JS_SUPERAGENT_MACHINE_DIRECTORY:f.directory},encoding:'utf8'}));
 assert.equal(result.appId,null);assert.deepEqual(result.bindings,[]);assert.equal(existsSync(join(projectStateDirectory(root),'state.sqlite')),false);assert.equal(existsSync(f.directory),false);
});
test('installed service rechecks manually changed App before launching',t=>{
 const f=fixture(t),a=f.runtime(f.project('a')),b=f.runtime(f.project('b'));a.configure({feishu:config()});
 const secret=join(f.base,'app-secret');writeFileSync(secret,'fixture-secret',{mode:0o600});
 const fc=config('cli_separate');delete fc.appSecretEnv;fc.appSecretPath=secret;
 b.configure({execution:{driver:'codex-app-server',executable:process.execPath},feishu:fc});
 const home=join(f.base,'home');mkdirSync(home);let starts=0;
 const service=createServiceManager({projectRoot:b.projectRoot,homeDirectory:home},{platform:'darwin',uid:501,coordinationDirectory:f.directory,launchctl(args){if(args[0]==='print')throw new Error('Could not find service');if(['enable','bootstrap','kickstart'].includes(args[0]))starts++;return '';}});
 service.install();
 const file=join(projectStateDirectory(b.projectRoot),'config.json'),cfg=readProjectConfig(b.projectRoot);cfg.feishu.appId='cli_shared';writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
 assert.throws(()=>service.start(),{code:'FEISHU_APP_OWNED'});assert.equal(starts,0);
});

test('same-root concurrent initialization cannot reserve different project identities',t=>{
 const f=fixture(t),root=f.project('same-root');
 createMachineCoordinator({projectRoot:root,projectId:'first'},{directory:f.directory}).claimFeishuApp({appId:'cli_first'});
 assert.throws(()=>createMachineCoordinator({projectRoot:root,projectId:'second'},{directory:f.directory}).claimFeishuApp({appId:'cli_second'}),{code:'FEISHU_APP_OWNERSHIP_UNKNOWN'});
 assert.equal(initializeProjectConfig(root,{feishu:config('cli_second')},{directory:f.directory}).projectId,'first');
});
test('a first initializer without an App serializes against an App initializer without orphaning ownership',async t=>{
 const f=fixture(t),root=f.project('mixed'),marker=join(f.base,'locked');
 const source=`import {initializeProjectConfig} from './src/config.mjs';import {createMachineCoordinator} from './src/machine-coordination.mjs';import {writeFileSync} from 'node:fs';
 const [root,directory,marker]=process.argv.slice(1);const c=createMachineCoordinator({projectRoot:root},{directory});
 initializeProjectConfig(root,{}, {coordinator:{...c,withConfigurationLock(action){return c.withConfigurationLock(()=>{writeFileSync(marker,'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);return action();});}}});`;
 const first=spawn(process.execPath,['--input-type=module','-e',source,root,f.directory,marker],{env:process.env});
 const exited=new Promise(resolve=>first.once('exit',resolve));
 const deadline=Date.now()+3000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(existsSync(marker));
 const second=`import {initializeProjectConfig} from './src/config.mjs';try{initializeProjectConfig(process.argv[1],{feishu:JSON.parse(process.argv[3])},{directory:process.argv[2]});process.exitCode=3;}catch(e){if(!e.message.includes('different configuration'))throw e;}`;
 const child=spawn(process.execPath,['--input-type=module','-e',second,root,f.directory,JSON.stringify(config())],{env:process.env});
 assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0);assert.equal(await exited,0);
 const runtime=f.runtime(root);runtime.configure({feishu:config()});assert.equal(runtime.feishuBindingStatus().conflicts.length,0);
});
test('configuration initialization lock is released by process exit without PID or hostname recovery',async t=>{
 const f=fixture(t),root=f.project('lock-crash'),marker=join(f.base,'locked');
 const source=`import {createMachineCoordinator} from './src/machine-coordination.mjs';import {writeFileSync} from 'node:fs';createMachineCoordinator({projectRoot:process.argv[1]},{directory:process.argv[2]}).withConfigurationLock(()=>{writeFileSync(process.argv[3],'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,root,f.directory,marker],{env:process.env});
 const exited=new Promise(resolve=>child.once('exit',resolve));const deadline=Date.now()+3000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(existsSync(marker));
 child.kill('SIGKILL');await exited;
 assert.doesNotThrow(()=>initializeProjectConfig(root,{feishu:config()},{directory:f.directory}));
});
test('configuration revocation preserves pending approvals and prevents ownership release',t=>{
 const f=fixture(t),runtime=f.runtime(f.project('approval'));runtime.configure({feishu:config()});
 const db=new DatabaseSync(join(projectStateDirectory(runtime.projectRoot),'state.sqlite'));
 const record=JSON.stringify({attentionId:'attention_pending',ticketId:'ticket_pending',closed:false});
 db.prepare('INSERT INTO kv(key,data) VALUES(?,?)').run('operator-attention:ticket_pending',record);db.close();
 runtime.configure({feishu:null});assert.equal(runtime.releaseFeishuBinding({appId:'cli_shared'}).safe,false);
 assert.throws(()=>runtime.releaseFeishuBinding({appId:'cli_shared',apply:true}),{code:'FEISHU_BINDING_RELEASE_UNSAFE'});
 assert.equal(runtime.feishuBindingStatus().bindings[0].appId,'cli_shared');
});
test('binding status reports another project holding the configured App',t=>{
 const f=fixture(t),a=f.runtime(f.project('a')),b=f.runtime(f.project('b'));a.configure({feishu:config()});
 const file=join(projectStateDirectory(b.projectRoot),'config.json');writeFileSync(file,JSON.stringify({...readProjectConfig(b.projectRoot),feishu:config()}),{mode:0o600});
 assert.equal(b.feishuBindingStatus().conflicts[0].projectRoot,a.projectRoot);
 const status=JSON.parse(execFileSync(process.execPath,['bin/js-superagent.mjs','--project',b.projectRoot,'feishu','binding','status'],{env:{...process.env,JS_SUPERAGENT_MACHINE_DIRECTORY:f.directory},encoding:'utf8'}));
 assert.equal(status.conflicts[0].projectRoot,a.projectRoot);
});

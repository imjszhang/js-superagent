import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../examples/real-continuous-service-smoke.mjs',import.meta.url));
test('continuous acceptance refuses reduced duration, sync quota and Worker duration before installation or network', t=>{
 const root=mkdtempSync(join(tmpdir(),'superagent-continuous-gate-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tarball=join(root,'frozen.tgz');writeFileSync(tarball,'not-a-real-package');const sha=createHash('sha256').update('not-a-real-package').digest('hex');
 for(const [flag,value] of [['--observe-ms','1799999'],['--min-successful-syncs','59'],['--long-worker-ms','180000'],['--observe-ms','NaN']]){
  const output=join(root,flag.slice(2)+value);const result=spawnSync(process.execPath,[script,'--write','--repository','owner/js-superagent-acceptance','--actor','owner','--app-config',join(root,'must-not-be-read.json'),'--tarball',tarball,'--expected-sha256',sha,'--output',output,flag,value],{encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0);assert.match(result.stderr,process.platform==='darwin'?/Require observation 30/:/Requires macOS/);assert.equal(existsSync(output),false);
 }
});

import { CONTINUOUS_POLL_MS, CONTINUOUS_INTAKE_MS, assertContinuousObservation, assertServiceProcessOwnership, continuousDuplicateEvidence, assertContinuousDeduplication } from '../examples/acceptance/continuous-contract.mjs';
test('continuous contract cannot substitute fast polling, shortened observation or incomplete long-Worker ingress',()=>{
 assert.equal(CONTINUOUS_POLL_MS,30000);assert.equal(CONTINUOUS_INTAKE_MS,65000);
 const good={pollIntervalMs:30000,actualMs:1800000,successfulSyncs:60,longWorkerMs:190000,longWorkerSyncs:4};assertContinuousObservation(good);
 for(const bad of [{pollIntervalMs:3000},{actualMs:1799999},{successfulSyncs:59},{longWorkerMs:180000},{longWorkerSyncs:3}])assert.throws(()=>assertContinuousObservation({...good,...bad}));
});
test('crash injection requires exact current fixture wrapper and child ownership, without exposing a foreign command',()=>{
 const fixture={project:'/fixture',installed:'/frozen/package',manifest:{projectRoot:'/fixture',modulePath:'/frozen/package/src/service.mjs',cliPath:'/frozen/package/bin/js-superagent.mjs',mode:'poll',label:'owned',nodeExecutable:'/node',codexExecutable:'/codex'},status:{projectRoot:'/fixture',label:'owned',running:true,pid:101,childPid:102},runtime:{pid:101,childPid:102},wrapperCommand:'/node /frozen/package/src/service.mjs run /fixture',childCommand:'/node /frozen/package/bin/js-superagent.mjs --project /fixture serve --codex-path /codex',childParentPid:101};
 assert.equal(assertServiceProcessOwnership(fixture).wrapperPid,101);
 for(const change of [f=>{f.manifest.projectRoot='/production';},f=>{f.runtime.pid=202;},f=>{f.childParentPid=999;},f=>{f.status.childPid=888;}]){const bad=structuredClone(fixture);change(bad);assert.throws(()=>assertServiceProcessOwnership(bad));}
 assert.throws(()=>assertServiceProcessOwnership({...fixture,wrapperCommand:'foreign-command-secret'}),error=>!error.message.includes('foreign-command-secret')&&/identity/.test(error.message));
});
test('source and business receipt duplicate counts are measured; legal resumed inputs are excluded',()=>{
 const repository='owner/js-superagent-acceptance',first='github:'+repository+':comment:1',next='github:'+repository+':comment:2';
 const fixture={repository,comments:[{id:1,url:'u1',marker:'m1'},{id:2,url:'u2',marker:'m2'}],triggers:[{id:first,source:'github',url:'u1',text:'m1'},{id:next,source:'github',url:'u2',text:'m2'}],domain:{origin:{triggerId:first,triggerIds:[first]},inputs:[{kind:'trigger',triggerId:next},{kind:'resumed',triggerId:next}]},ticket:{messages:[{text:'m1'},{text:'m2',triggerId:next}],reports:[{runId:'run1'},{runId:'run2'}]},notifications:[{id:'n1',ticketId:'ticket',kind:'reply',channel:{source:'github',thread:'t'},text:'Done\nRun: aaaa-1111'}]};
 const good=continuousDuplicateEvidence(fixture);assert.equal(good.effectiveDuplicateCount,0);assertContinuousDeduplication(good);
 for(const change of [f=>{f.ticket.messages.push({text:'m2',triggerId:next});},f=>{f.domain.inputs.push({kind:'trigger',triggerId:next});},f=>{f.ticket.reports.push({runId:'run2'});},f=>{f.notifications.push({...f.notifications[0],id:'n2'});},f=>{f.triggers.push({id:'another-id',source:'github',url:'u2',text:'m2'});}]){const bad=structuredClone(fixture);change(bad);const result=continuousDuplicateEvidence(bad);assert.ok(result.effectiveDuplicateCount>0);assert.throws(()=>assertContinuousDeduplication(result));}
 const missing=structuredClone(fixture);missing.triggers=[];assert.throws(()=>assertContinuousDeduplication(continuousDuplicateEvidence(missing)));
});

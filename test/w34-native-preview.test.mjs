import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshPreviewProducer, nativePreviewProfiles, nativePreviewLaunch } from '../src/drivers/dsh-native-preview.mjs';
import { verifyOwnedPreview } from '../src/runtime/preview.mjs';
import { validateNativeHandoff } from '../src/drivers/dsh-lease.mjs';
import { openDshProcess } from '../src/drivers/dsh-process.mjs';
import { openDshToolBridge } from '../src/drivers/dsh-tools.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function registry(){let record,done;return {
  start(spec){record={id:'bash-preview',owner:spec.owner,kind:spec.kind,status:'running',output:{total:0,earliest:0}};const hooks=spec.run({id:record.id,append(){}});done=hooks.done.then(result=>Object.assign(record,result));this.cancel=hooks.cancel;return record.id;},
  get(id,session){assert.equal(id,record.id);assert.equal(session,record.owner);return {...record};},
  settled(){return done;},
};}

test('registered native preview has a real owned endpoint, renews beyond its first deadline and expires',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-native-preview-'))),port=await freePort();
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const [profile]=nativePreviewProfiles([{id:'demo',version:'1',command:process.execPath,args:['-e',`require('http').createServer((q,s)=>s.end('preview')).listen(${port},'127.0.0.1')`],environment:'host',allowHostExecution:true,preview:{url:`http://127.0.0.1:${port}/`,ttlMs:1000}}]);
  const jobs=registry();let registered=false,published;
  const producer=createDshPreviewProducer(jobs,{sessionId:'session',killGraceMs:20,registerOwner:async record=>{assert.ok(record.guardianPid>1);registered=true;},publish:async record=>{
    assert.ok(registered);let endpoint;
    for(let i=0;i<20;i++){try{endpoint=await verifyOwnedPreview({url:profile.preview.url,commandPid:record.commandPid});break;}catch{await wait(30);}}
    assert.ok(endpoint);published={...record,url:profile.preview.url,endpoint};return published;
  }});
  t.after(()=>producer.close());
  await producer.start(nativePreviewLaunch(profile,root),{callId:'native-start'});
  const oldExpiry=Date.parse(published.expiresAt),renewed=producer.renew('bash-preview',1800);
  assert.ok(Date.parse(renewed.expiresAt)>oldExpiry);
  await wait(Math.max(0,oldExpiry-Date.now()+30));
  assert.equal(await (await fetch(profile.preview.url)).text(),'preview');
  await jobs.settled();assert.equal(jobs.get('bash-preview','session').status,'killed');
  await assert.rejects(fetch(profile.preview.url));
  assert.throws(()=>producer.renew('bash-preview',1000));
});

test('ready only permits verified preview identities; an ordinary active native job is rejected',()=>{
  const preview={jobId:'bash-preview',profileId:'demo',url:'http://127.0.0.1:1234/',commandPid:43,guardianPid:42,expiresAt:new Date(Date.now()+1000).toISOString(),endpoint:{url:'http://127.0.0.1:1234/',listeners:[{pid:43,birth:'proof'}]}};
  const record={version:1,id:'lease',driver:'dsh-sdk',nativeVersion:'0.2.2-alpha.2',ticketId:'ticket',assignmentId:'assignment',originRunId:'run',session:{driver:'dsh-sdk',id:'session'},cwd:'/temporary',configDigest:'a'.repeat(64),deadlineAt:preview.expiresAt,guardianPids:[42],jobIds:['bash-preview'],previews:[preview],reportBoundary:{state:'ready',assistantSequence:5,terminalSequence:6}};
  assert.deepEqual(validateNativeHandoff(record),record);
  assert.throws(()=>validateNativeHandoff({...record,jobIds:['bash-preview','bash-tests']}));
  assert.throws(()=>validateNativeHandoff({...record,previews:undefined}));
  assert.throws(()=>validateNativeHandoff({...record,previews:[{...preview,guardianPid:44}]}));
  assert.deepEqual(validateNativeHandoff({...record,jobIds:['bash-preview','bash-tests'],settledJobIds:['bash-tests']}).settledJobIds,['bash-tests']);
});

test('registration rejection prevents the trusted preview command from starting; read-only tools stay unavailable',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-native-preview-deny-'))),file=join(root,'must-not-exist');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const profiles=nativePreviewProfiles([{id:'denied',version:'1',command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(file)},'ran')`],environment:'host',allowHostExecution:true,preview:{url:'http://127.0.0.1:1234/'}}]);
  const jobs=registry(),producer=createDshPreviewProducer(jobs,{sessionId:'session',killGraceMs:20,registerOwner:async()=>{throw new Error('authorization revoked');},publish:()=>assert.fail('Cannot publish before ownership')});
  t.after(()=>producer.close());
  await assert.rejects(producer.start(nativePreviewLaunch(profiles[0],root),{callId:'denied'}),/authorization revoked/);
  await jobs.settled();assert.equal(existsSync(file),false);
  const bridge=await openDshToolBridge({nativePreviewProfiles:profiles},{sessionId:'session',options:{nativeHandoff:true,permission:'read-only'},redact:value=>value});
  assert.equal(bridge.definitions.some(tool=>tool.name==='js_superagent_native_preview_start'),false);await bridge.close();
});

test('DSH transport really transfers its timer, not only the saved deadline',async()=>{
  const transport=openDshProcess({executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:process.cwd(),env:process.env,timeoutMs:600,killGraceMs:20,registerProcess(){},onLine(){}});
  await transport.ready;
  transport.setDeadline(Date.now()+1500);
  await wait(750);
  let ended=false;transport.closed.finally(()=>{ended=true;}).catch(()=>{});await wait(10);assert.equal(ended,false);
  transport.abort(new Error('test cleanup'));
  await assert.rejects(transport.closed,/test cleanup/);
});

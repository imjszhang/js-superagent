import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessIdentityInspector, readNativeMachineId, readNativeScope, currentProcessIdentity, captureProcessIdentity, inspectProcessOwner } from '../src/process-identity.mjs';
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const scope={machineId:`sha256:${'a'.repeat(64)}`,bootSessionId:A,pidNamespace:'host',bootId:'{ sec = 1000, usec = 1 }'};
function fixture(overrides={}) { let calls=0;const inspector=createProcessIdentityInspector({scope:()=>({...scope}),host:()=> 'new-name',pid:101,birth:()=>{calls++;return 'start-101';},...overrides});return {...inspector,get calls(){return calls;}}; }
const recorded=(extra={})=>({identityVersion:2,...scope,host:'old-name',pid:101,birth:'start-101',...extra});

test('serialized v2 identity survives hostname change and a later boot with reused PID',()=>{
 const f=fixture();const owner=JSON.parse(JSON.stringify(f.currentProcessIdentity()));owner.host='old-network-name';
 assert.equal(f.inspectProcessOwner(owner),'alive');
 const reboot=fixture({scope:()=>({...scope,bootSessionId:B})});
 assert.equal(reboot.inspectProcessOwner(owner),'dead');assert.equal(reboot.calls,0,'prior boot does not inspect or signal a reused PID');
});
test('boot-session identity ignores wall-clock correction but detects even an immediate reboot',()=>{
 const f=fixture();assert.equal(f.inspectProcessOwner(recorded({bootId:'{ sec = 900000, usec = 0 }'})),'alive');
 assert.equal(f.inspectProcessOwner(recorded({bootSessionId:B})),'dead');
});
test('foreign machine or PID namespace cannot be treated as local even with identical host, boot and PID',()=>{
 for(const owner of [recorded({host:'new-name',machineId:`sha256:${'b'.repeat(64)}`}),recorded({pidNamespace:'pid:[123]'})]){
  const f=fixture({birth:()=>assert.fail('must not probe foreign PID')});assert.equal(f.inspectProcessOwner(owner),'unknown');
 }
});
test('PID reuse, exit and failed process inspection are distinct',()=>{
 for(const [birth,result]of [['new-start','dead'],[null,'dead'],[undefined,'unknown'],['start-101','alive']])assert.equal(fixture({birth:()=>birth}).inspectProcessOwner(recorded()),result);
});
test('malformed and future identities do not downgrade to hostname-only validation',()=>{
 for(const patch of [{identityVersion:3},{machineId:null},{bootSessionId:undefined},{pidNamespace:undefined},{birth:''},{pid:-1}])assert.equal(fixture().inspectProcessOwner(recorded(patch)),'unknown');
 const {identityVersion,...partial}=recorded();assert.equal(fixture().inspectProcessOwner(partial),'unknown');
});
test('unavailable native machine/boot evidence fails closed and is retried without writing state',()=>{
 let reads=0;const f=fixture({scope:()=>{if(++reads===1)throw Error('probe unavailable');return scope;}});
 assert.equal(f.inspectProcessOwner(recorded()),'unknown');assert.equal(f.inspectProcessOwner(recorded()),'alive');
 const unavailable=fixture({scope:()=>{throw Error('probe unavailable');}});
 assert.throws(()=>unavailable.currentProcessIdentity(),{code:'PROCESS_IDENTITY_UNKNOWN'});
 assert.equal(unavailable.captureProcessIdentity(101),undefined);
 assert.equal(fixture({birth:()=>null}).captureProcessIdentity(101),null);
});
test('legacy receipts remain readable but rename plus reboot cannot establish locality',()=>{
 const legacy={host:'new-name',pid:101,birth:'start-101',bootId:scope.bootId};
 assert.equal(fixture().inspectProcessOwner(legacy),'alive');
 assert.equal(fixture().inspectProcessOwner({...legacy,host:'old-name'}),'alive');
 assert.equal(fixture().inspectProcessOwner({...legacy,bootId:'{ sec = 1, usec = 0 }'}),'dead');
 const f=fixture({birth:()=>assert.fail('ambiguous legacy identity is not probed')});
 assert.equal(f.inspectProcessOwner({...legacy,host:'old-name',bootId:'{ sec = 1, usec = 0 }'}),'unknown');
});
test('native machine identity is validated and stored only as an application-scoped digest',()=>{
 const mac=readNativeMachineId('darwin',()=>assert.fail(),()=>`"IOPlatformUUID" = "${A}"`);
 assert.match(mac,/^sha256:[a-f0-9]{64}$/);assert.equal(mac.includes(A),false);
 assert.equal(mac,readNativeMachineId('darwin',()=>assert.fail(),()=>`"IOPlatformUUID" = "${A.toUpperCase()}"`));
 for(const invalid of ['', '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"'])assert.throws(()=>readNativeMachineId('darwin',()=>assert.fail(),()=>invalid));
 const files=[];const linux=readNativeMachineId('linux',file=>{files.push(file);if(file==='/etc/machine-id')throw Error('missing');return '1234567890abcdef1234567890abcdef\n';});
 assert.match(linux,/^sha256:[a-f0-9]{64}$/);assert.deepEqual(files,['/etc/machine-id','/var/lib/dbus/machine-id']);
 assert.throws(()=>readNativeMachineId('linux',()=> 'uninitialized'));
});
test('real captured process identities include stable scope and survive serialization',()=>{
 const owner=currentProcessIdentity();assert.equal(owner.identityVersion,2);assert.match(owner.machineId,/^sha256:/);
 assert.equal(inspectProcessOwner(JSON.parse(JSON.stringify(owner))),'alive');
 assert.deepEqual(captureProcessIdentity(process.pid),owner);
});

import { sameProcessIdentity } from '../src/process-identity.mjs';
test('maintenance reentry compares stable machine, boot and namespace, not just PID and wall-clock birth',()=>{
 assert.equal(sameProcessIdentity(recorded(),recorded({host:'renamed'})),true);
 for(const patch of [{machineId:`sha256:${'b'.repeat(64)}`},{bootSessionId:B},{pidNamespace:'pid:[123]'},{identityVersion:3},{pid:102}])assert.equal(sameProcessIdentity(recorded(),recorded(patch)),false);
 const legacy={host:'legacy',pid:101,birth:'birth',bootId:'boot'};
 assert.equal(sameProcessIdentity(legacy,{...legacy}),true);assert.equal(sameProcessIdentity(legacy,{...legacy,host:'other'}),false);
});

test('v2 capture and inspection do not depend on hostname or legacy boot diagnostics', () => {
 const f=fixture({host:()=>{throw Error('hostname unavailable');},scope:()=>({...scope,bootId:''})});
 const owner=f.currentProcessIdentity();assert.equal(owner.host,'');assert.equal(f.inspectProcessOwner(owner),'alive');
 assert.equal(f.inspectProcessOwner({...recorded(),host:undefined,bootId:undefined}),'alive');
 const {identityVersion,machineId,bootSessionId,pidNamespace,...legacy}=owner;
 assert.equal(f.inspectProcessOwner(legacy),'unknown');
});
test('native stable scope survives failure of the legacy-only boot probe while legacy owners remain unknown',()=>{
 const current=readNativeScope('darwin',()=>assert.fail('unexpected file read'),()=>assert.fail('unexpected namespace read'),(file,args)=>{
  if(file==='/usr/sbin/ioreg')return `"IOPlatformUUID" = "${A}"`;
  if(args.includes('kern.bootsessionuuid'))return A;
  throw Error('kern.boottime unavailable');
 });
 assert.equal(current.bootId,'');assert.equal(current.bootSessionId,A);
 const f=fixture({scope:()=>current});assert.equal(f.inspectProcessOwner(f.currentProcessIdentity()),'alive');
 const legacy={host:'new-name',pid:101,birth:'start-101',bootId:scope.bootId};
 for(const bootId of ['',undefined])for(const birth of ['start-101',null]){
  const unavailable=fixture({scope:()=>({...scope,bootId}),birth:()=>{assert.fail('legacy scope is unverified');return birth;}});
  assert.equal(unavailable.inspectProcessOwner(legacy),'unknown');
 }
});

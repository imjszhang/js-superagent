import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

function fixture(t, {remote = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-delivery-recovery-'));
  writeFileSync(join(root, 'value.txt'), 'before');
  if (remote) for (const args of [['init','-b','main'],['config','user.name','test'],['config','user.email','test@example.invalid'],['add','.'],['commit','-m','baseline']]) {
    const result=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  let calls = 0;
  const runtime = createProjectAgent({ projectRoot: root, ...(remote?{githubChannel:{async poll(){return [];},async deliver(){throw new Error('Unexpected remote message');}}}:{}), driver: { async run({projectRoot}) { calls++; writeFileSync(join(projectRoot, 'value.txt'), 'after'); return {status:'completed',summary:'Changed value'}; } } }).init();
  runtime.configure({workspace:{mode:remote?'worktree':'copy'},...(remote?{github:{repository:'fixture/project',allowedActors:['alice'],issues:[1]}}:{})});
  const settings = {mode:remote?'draft-pr':'local',...(remote?{repository:'fixture/project',base:'main',credentialMode:'native-gh'}:{}),automatic:true,allowedPaths:['wrong.txt'],verify:{id:'check',version:'1',command:process.execPath,args:['-e',''],paths:['value.txt'],environment:'host',allowHostExecution:true}};
  runtime.configureDelivery(settings,{expectedRevision:0});
  t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  return {root,runtime,settings,calls:()=>calls};
}

test('explicit delivery recovery preserves its verification/run and restores ready without rerunning Worker', async t => {
  const f=fixture(t), ticket=f.runtime.submit({text:'Update value'});
  const failed=await f.runtime.runNext();
  assert.equal(failed.status,'failed');assert.match(failed.reports.at(-1).summary,/Resume the saved delivery/);
  const proof=f.runtime.getDetailed(ticket.id).verification;
  assert.equal(proof.status,'passed');assert.equal(f.calls(),1);
  assert.throws(()=>f.runtime.retry(ticket.id),/saved delivery is pending/);
  await assert.rejects(f.runtime.verifyTicket(ticket.id),/saved delivery is pending/);
  f.runtime.configureDelivery({...f.settings,allowedPaths:['value.txt']},{expectedRevision:1});
  const recovered=await f.runtime.deliverTicket(ticket.id);
  assert.equal(recovered.status,'local');
  const after=f.runtime.get(ticket.id), detail=f.runtime.getDetailed(ticket.id);
  assert.equal(after.runId,failed.runId);assert.equal(detail.verification.id,proof.id);
  assert.equal(after.status,'completed');assert.equal(detail.reportState,'ready');
  assert.equal(after.reports.length,2);assert.match(after.reports.at(-1).summary,/without rerunning the Worker/);
  assert.equal((await f.runtime.deliverTicket(ticket.id)).status,'local');
  assert.equal(f.runtime.get(ticket.id).reports.length,2,'Delivered attempts remain idempotent');
  assert.equal(await f.runtime.runNext(),null);assert.equal(f.calls(),1);
});

test('pending remote delivery cannot switch mode or base to bypass its original journal', async t => {
  const f=fixture(t,{remote:true}),ticket=f.runtime.submit({text:'Update value'});
  const failed=await f.runtime.runNext();assert.equal(failed.status,'failed');
  assert.match(failed.reports.at(-1).summary,/outside delivery scope/);
  const store=new Store(join(stateDir(f.root),'state.sqlite'));
  try {
    const before=store.getMeta(`ticket:${ticket.id}`).deliveryAttempt;
    assert.deepEqual(before.target,{mode:'draft-pr',repository:'fixture/project',base:'main',credentialMode:'native-gh'});
    f.runtime.configureDelivery({...f.settings,mode:'local',allowedPaths:['value.txt']},{expectedRevision:1});
    await assert.rejects(f.runtime.deliverTicket(ticket.id),/Delivery target changed/);
    f.runtime.configureDelivery({...f.settings,base:'release'},{expectedRevision:2});
    await assert.rejects(f.runtime.deliverTicket(ticket.id),/Delivery target changed/);
    assert.deepEqual(store.getMeta(`ticket:${ticket.id}`).deliveryAttempt,before);
    assert.equal(f.runtime.get(ticket.id).status,'failed');assert.equal(f.calls(),1);
  } finally {store.close();}
});

test('legacy pending delivery without a target requires inspection while delivered legacy attempts remain idempotent', async t => {
  const f=fixture(t),ticket=f.runtime.submit({text:'Update value'});
  await f.runtime.runNext();
  f.runtime.configureDelivery({...f.settings,allowedPaths:['value.txt']},{expectedRevision:1});
  const store=new Store(join(stateDir(f.root),'state.sqlite'));
  try {
    const meta=store.getMeta(`ticket:${ticket.id}`),target=meta.deliveryAttempt.target;
    delete meta.deliveryAttempt.target;store.setMeta(`ticket:${ticket.id}`,meta);
    await assert.rejects(f.runtime.deliverTicket(ticket.id),/no saved target configuration.*inspect/i);
    assert.equal(f.runtime.get(ticket.id).status,'failed');assert.equal(f.calls(),1);
    meta.deliveryAttempt.target=target;store.setMeta(`ticket:${ticket.id}`,meta);
    await f.runtime.deliverTicket(ticket.id);
    const delivered=store.getMeta(`ticket:${ticket.id}`);delete delivered.deliveryAttempt.target;store.setMeta(`ticket:${ticket.id}`,delivered);
    assert.equal((await f.runtime.deliverTicket(ticket.id)).status,'local');
    assert.equal(f.runtime.get(ticket.id).reports.length,2);assert.equal(f.calls(),1);
  } finally {store.close();}
});

test('delivery recovery remains protected by pause/cancel and does not erase the saved attempt', async t => {
  const f=fixture(t), ticket=f.runtime.submit({text:'Update value'});
  await f.runtime.runNext();
  f.runtime.pause('Inspect delivery');
  await assert.rejects(f.runtime.deliverTicket(ticket.id),/Stop or finish active work/);
  f.runtime.resume();f.runtime.cancel(ticket.id);
  await assert.rejects(f.runtime.deliverTicket(ticket.id),/no longer authorized/);
  const store=new Store(join(stateDir(f.root),'state.sqlite'));
  try {const meta=store.getMeta(`ticket:${ticket.id}`);assert.equal(meta.deliveryAttempt.state,'failed');assert.equal(meta.deliveryAttempt.runId,meta.runId);}finally{store.close();}
  assert.equal(f.calls(),1);
});

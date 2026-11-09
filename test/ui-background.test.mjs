import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture, descendants } from './helpers/ui-fixture.mjs';

test('background panel distinguishes queued and unknown outcomes without restarting or replaying them', async () => {
  const f=await uiFixture(({path})=>{
    if(path==='/api/service-health')return {body:{state:'stopped',lastHeartbeatAt:null,reason:'service-is-not-running'}};
    if(path==='/api/controls')return {body:[{operationId:'a'.repeat(64),method:'verifyTicket',status:'unknown'},{operationId:'b'.repeat(64),method:'replaceSession',status:'queued'}]};
  });
  await f.$('load-background').emit('click');
  assert.match(f.$('service-health').textContent,/已停止/);
  assert.match(f.$('control-records').textContent,/结果不明.*等待后台处理/s);
  await f.ui.act(f.$('refresh'),async()=>({operationId:'b'.repeat(64),status:'queued'}));
  assert.match(f.$('message').textContent,/排队.*bbbbbbbbbbbb/s);
  assert.equal(f.requests.some(request=>request.method==='POST'),false);
});

test('setup panel renders unchecked facts without launching a connection probe',async()=>{
  const f=await uiFixture(({path})=>path==='/api/setup'?{body:{checks:[{id:'github-access',status:'unchecked',message:'No account contacted',nextAction:'Use explicit connection check'}]}}:undefined);
  await f.$('load-setup').emit('click');
  assert.match(f.$('setup-records').textContent,/待检查.*No account contacted.*explicit connection check/s);
  assert.equal(f.requests.some(request=>request.method==='POST'||request.path.includes('check-connections')),false);
});

test('an unknown child-message receipt retains the draft and request ID for inspection',async()=>{
  const f=await uiFixture(({path,method})=>{
    if(path==='/api/tickets/A/jobs')return {body:[{id:'child',kind:'agent',profileId:'child',status:'running',messages:[]}]};
    if(method==='POST'&&path.endsWith('/message'))return {body:{operationId:'d'.repeat(64),status:'unknown'}};
  });
  const box=f.$('detail');await f.ui.loadJobs('A',box,{jobControl:true});
  const input=descendants(box).find(element=>element.tagName==='TEXTAREA');
  input.value='Keep this request';await input.emit('input');
  await f.buttons('追加消息',box)[0].emit('click');
  const original=f.requests.find(request=>request.method==='POST');
  assert.match(f.$('message').textContent,/结果不明/);assert.doesNotMatch(f.$('message').textContent,/已保存/);
  await f.ui.loadJobs('A',box,{jobControl:true});
  assert.equal(descendants(box).find(element=>element.tagName==='TEXTAREA').value,'Keep this request');
  await f.buttons('追加消息',box)[0].emit('click');
  assert.equal(f.requests.filter(request=>request.method==='POST').at(-1).body.requestId,original.body.requestId);
});

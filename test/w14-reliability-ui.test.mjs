import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture, ticket } from './helpers/ui-fixture.mjs';
test('W14 coordination retry is explicit, denied requests show an error, and retry setting survives unrelated edits',async()=>{
  let retryCount=0;
  const f=await uiFixture(({path,method})=>{
    if(path==='/api/coordinator')return{body:{settings:{revision:0,policy:{mode:'off'},assessor:{driver:'codex-app-server'},workRetry:{autoRetry:true,maxAttempts:2,initialDelayMs:3000,timeoutMs:60000}},history:[]}};
    if(path==='/api/coordination')return{body:{events:[{id:'event-1',status:'failed',text:'Question',attempts:2,history:[],createdAt:'2026-11-02T00:00:00Z'}]}};
    if(path==='/api/coordination/retry'&&method==='POST'){retryCount++;return{status:409,body:{error:'Coordinator is still active'}};}
  });
  await f.ui.loadSettings();assert.equal(f.$('coord-retry').checked,true);
  f.$('coord-mode').value='observe';await f.$('coord-mode').emit('change');assert.equal(JSON.parse(f.$('settings').value).workRetry.maxAttempts,2);
  await f.$('coordination-load').emit('click');assert.equal(retryCount,0);
  await f.buttons('修复后重新入队')[0].emit('click');assert.equal(retryCount,1);assert.match(f.$('message').textContent,/still active/);
});
test('W14 input uncertainty, native result recovery and scoped project rules have readable detail states',async()=>{
  const f=await uiFixture(({path})=>path==='/api/tickets/A/details'?{body:{ticket:ticket('A'),managementActions:{},nativeResultRecoveredFrom:'old-run',liveInputs:[{status:'unknown'},{status:'not-sent',attempts:3}],nativeFacts:{projectRules:{files:[{path:'sub/AGENTS.md',scope:'sub',sha256:'0123456789012345'}],skippedSymlinks:['outside']}}}}:undefined);
  await f.ui.detail('A');assert.match(f.$('detail').textContent,/发送结果未知/);assert.match(f.$('detail').textContent,/没有重复执行/);assert.match(f.$('detail').textContent,/次数已用完/);assert.match(f.$('detail').textContent,/作用范围 sub/);
});

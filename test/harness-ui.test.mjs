import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture } from './helpers/ui-fixture.mjs';

test('Worker selector shows the adapter label', async () => {
  const harnesses=[{id:'custom-cli',label:'Custom CLI',roles:['worker'],capabilities:{sessionResume:false}}];
  const f=await uiFixture(({path})=>path==='/api/executor'?{body:{settings:{revision:0,execution:{driver:'custom-cli',timeoutMs:1000}},history:[],harnesses}}:undefined);
  await f.ui.loadWorker();
  assert.equal(f.$('worker-driver').children[0].textContent,'Custom CLI');
  assert.match(f.$('worker-capabilities').textContent,/Custom CLI/);
});

test('Worker selector uses registered descriptors and their capabilities',async()=>{
  const harnesses=[
    {id:'custom-cli',roles:['worker'],capabilities:{sessionResume:false,backgroundTasks:false}},
    {id:'custom-session',roles:['worker'],capabilities:{sessionResume:true,backgroundTasks:true,subagents:true,agentTools:true}},
    {id:'router-only',roles:['coordinator'],capabilities:{}},
  ];
  const f=await uiFixture(({path})=>path==='/api/executor'?{body:{settings:{revision:0,execution:{driver:'custom-cli',timeoutMs:1000}},history:[],harnesses}}:undefined);
  await f.ui.loadWorker();
  assert.deepEqual(f.$('worker-driver').children.map(item=>item.value),['custom-cli','custom-session']);
  assert.equal(f.$('worker-managed').disabled,true);assert.match(f.$('worker-capabilities').textContent,/重新提供工单上下文/);
  f.$('worker-driver').value='custom-session';await f.$('worker-driver').emit('change');
  assert.equal(f.$('worker-managed').disabled,false);assert.match(f.$('worker-capabilities').textContent,/原生会话续作/);
  f.$('worker-managed').checked=true;await f.$('worker-managed').emit('change');
  assert.equal(JSON.parse(f.$('worker-settings').value).enableManagedJobs,true);
  assert.equal(f.$('worker-agent-tools').disabled,false);
  f.$('worker-agent-tools').checked=true;await f.$('worker-agent-tools').emit('change');
  assert.equal(JSON.parse(f.$('worker-settings').value).enableAgentTools,true);
  assert.match(f.$('worker-capabilities').textContent,/业务工具已启用/);
  const draft=JSON.parse(f.$('worker-settings').value);draft.enableAgentTools=false;draft.enableManagedJobs=false;
  f.$('worker-settings').value=JSON.stringify(draft);await f.$('worker-settings').emit('input');
  assert.equal(f.$('worker-agent-tools').checked,false);assert.equal(f.$('worker-managed').checked,false);
  f.$('worker-driver').value='custom-cli';await f.$('worker-driver').emit('change');
  assert.equal(JSON.parse(f.$('worker-settings').value).enableManagedJobs,undefined);
  assert.equal(JSON.parse(f.$('worker-settings').value).enableAgentTools,undefined);
  assert.equal(f.$('worker-agent-tools').disabled,true);
  assert.equal(f.$('worker-managed').disabled,true);
});

test('catalog refresh retains an unsaved Worker target and JSON backend references',async()=>{
  const f=await uiFixture(({path})=>path==='/api/executor'?{body:{settings:{revision:0,execution:{driver:'codex-app-server'}},history:[],harnesses:[{id:'codex-app-server',roles:['worker'],capabilities:{sessionResume:true}}]}}:undefined);
  await f.ui.loadWorker();
  const draft={driver:'dsh-sdk',model:'selected-model',backend:{apiKeyEnv:'DSH_KEY'}};
  f.$('worker-settings').value=JSON.stringify(draft);await f.$('worker-settings').emit('input');
  await f.ui.loadWorker();
  assert.equal(JSON.parse(f.$('worker-settings').value).backend.apiKeyEnv,'DSH_KEY');
  assert.equal(f.$('worker-driver').value,'dsh-sdk');
  assert.ok(f.$('worker-driver').children.some(item=>item.value==='dsh-sdk'));
  assert.equal(f.$('worker-managed').disabled,true);
});

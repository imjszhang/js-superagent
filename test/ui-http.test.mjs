// Actual authenticated management HTTP + runtime storage, with a deterministic DOM.
// This intentionally makes no real-browser or real-model acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createManagementServer } from '../src/management.mjs';
import { uiFixture } from './helpers/ui-fixture.mjs';

test('two DOM clients preserve drafts while actual HTTP revisions, reply and full-record routes advance',async t=>{
  const root=mkdtempSync(join(tmpdir(),'superagent-ui-http-'));
  const runtime=createProjectAgent({projectRoot:root,driver:{async run(){return {status:'waiting',summary:'Please confirm the result',artifacts:[]};}}}).init();
  const task=runtime.submit({text:'Inspect the example only',scope:'Read the example only'});await runtime.runNext();
  const server=await createManagementServer(runtime),origin=new URL(server.url).origin;
  t.after(async()=>{await server.close();await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
  const http=async({path,method,body})=>{
    const response=await fetch(new URL(path,server.url),{method,headers:{Authorization:`Bearer ${server.token}`,Origin:origin,'X-Superagent-Request':'local-ui',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const a=await uiFixture(http),b=await uiFixture(http);await a.ui.refresh();await b.ui.refresh();await a.ui.loadPrompts();await b.ui.loadPrompts();
  await a.input('prompt-communication','Client A text');await b.input('prompt-communication','Client B unsaved text');await a.$('save-prompts').emit('click');await b.$('save-prompts').emit('click');
  assert.match(b.$('message').textContent,/Settings changed/);assert.equal(b.$('prompt-communication').value,'Client B unsaved text');
  await b.ui.loadPrompts();assert.equal(b.$('prompt-communication').value,'Client B unsaved text');await b.buttons('保留本地草稿，以新版本为基准')[0].emit('click');await b.$('save-prompts').emit('click');
  assert.equal(runtime.promptStatus().settings.revision,2);assert.equal(runtime.promptStatus().settings.sections.communication,'Client B unsaved text');
  await a.ui.detail(task.id);await a.input('reply-text','Reply retained across pause');await a.$('pause').emit('click');assert.equal(a.$('reply-text').value,'Reply retained across pause');
  await a.buttons('发送给工单')[0].emit('click');assert.equal(a.$('reply-text').value,'');assert.equal(runtime.get(task.id).messages.at(-1).text,'Reply retained across pause');
  const triggerId=runtime.getDomainTicket(task.id).origin.triggerId;
  a.$('context-search').value=triggerId;await a.ui.loadContext();assert.match(a.$('context-records').textContent,new RegExp(triggerId));
  await a.ui.loadContextRecord('triggers',triggerId,a.$('context-records'));assert.match(a.$('context-records').textContent,/Inspect the example only/);assert.match(a.$('context-records').textContent,/打开工单/);
});

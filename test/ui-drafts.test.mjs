import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture, deferred, ticket, descendants } from './helpers/ui-fixture.mjs';

const prompts=(revision=0,communication='',overrides={})=>({settings:{revision,at:null,sections:{communication,scope:'',delivery:''},overrides,knowledge:[]},history:[],diff:[{key:'runtime/worker',oldDefault:'old default',newDefault:'new default',changed:true}],assembled:{worker:{text:communication}}});

test('first settings reads keep controls disabled until their baseline arrives, including failed reads',async()=>{
  const cases=[
    ['loadSettings','/api/coordinator','settings',{settings:{revision:0,policy:{mode:'off'},assessor:{driver:'codex-app-server'}},history:[]}],
    ['loadWorker','/api/executor','worker-prompt',{settings:{revision:0,execution:{driver:'codex-app-server'}},history:[]}],
    ['loadPrompts','/api/prompts','prompt-communication',prompts()],
  ];
  for(const [load,path,id,data] of cases){
    const wait=deferred();const f=await uiFixture(request=>request.path===path?wait.promise:undefined);
    assert.equal(f.$(id).disabled,true);const loading=f.ui[load]();await assert.rejects(f.input(id,'would be lost'),/disabled/);
    wait.resolve({body:data});await loading;assert.equal(f.$(id).disabled,false);await f.input(id,'now editable');assert.equal(f.$(id).value,'now editable');
  }
  const f=await uiFixture(({path})=>path==='/api/prompts'?{status:503,body:{error:'unavailable'}}:undefined);
  await assert.rejects(f.ui.loadPrompts(),/unavailable/);assert.equal(f.$('prompt-communication').disabled,true);assert.equal(f.$('load-prompts').disabled,false);
});

test('reply drafts survive unrelated actions, same-ticket clicks, switching tickets and in-flight refresh edits',async()=>{
  const f=await uiFixture();await f.ui.detail('A');await f.input('reply-text','A draft');
  await f.ui.act(f.$('pause'),async()=>true);assert.equal(f.$('reply-text').value,'A draft');
  await f.ui.detail('A');assert.equal(f.$('reply-text').value,'A draft');
  await f.ui.detail('B');await f.input('reply-text','B draft');await f.ui.detail('A');assert.equal(f.$('reply-text').value,'A draft');
  const wait=deferred();f.setHandler(({path})=>path==='/api/tickets/A/details'?wait.promise:undefined);
  const loading=f.ui.detail('A');await f.input('reply-text','A continued while loading');
  wait.resolve({body:{ticket:ticket('A'),managementActions:{}}});await loading;
  assert.equal(f.$('reply-text').value,'A continued while loading');
  let prevented=false;await f.window.emit('beforeunload',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
});

test('successful reply clears only the sent version, failed replies and later edits remain',async()=>{
  const f=await uiFixture();await f.ui.detail('A');await f.input('reply-text','first send');
  let wait=deferred();f.setHandler(({method,path})=>method==='POST'&&path.endsWith('/reply')?wait.promise:undefined);
  const sending=f.ui.sendReply('A');await f.input('reply-text','next draft');await f.ui.detail('A');assert.equal(f.$('reply-send').disabled,true);
  await assert.rejects(f.ui.sendReply('A'),/正在发送/);assert.equal(f.requests.filter(r=>r.path.endsWith('/reply')).length,1);
  wait.resolve({body:{queued:true}});await sending;await f.ui.refresh();
  assert.equal(f.$('reply-text').value,'next draft');assert.equal(f.requests.find(r=>r.path.endsWith('/reply')).body.text,'first send');
  wait=deferred();const failing=f.ui.sendReply('A');wait.resolve({status:409,body:{error:'cannot send'}});await assert.rejects(failing,/cannot send/);await f.ui.refresh();assert.equal(f.$('reply-text').value,'next draft');
  f.setHandler(()=>undefined);await f.ui.sendReply('A');await f.ui.refresh();assert.equal(f.$('reply-text').value,'');
});

test('older same-ticket detail responses cannot overwrite newer detail state',async()=>{
  const first=deferred(),second=deferred();let count=0;const f=await uiFixture(({path})=>path==='/api/tickets/A/details'?(++count===1?first.promise:second.promise):undefined);
  const a=f.ui.detail('A'),b=f.ui.detail('A');second.resolve({body:{ticket:ticket('A','completed'),managementActions:{}}});await b;
  first.resolve({body:{ticket:ticket('A','running'),managementActions:{}}});await a;
  assert.match(f.$('detail').textContent,/已完成/);assert.doesNotMatch(f.$('detail').textContent,/执行中/);
});

test('two DOM clients keep conflicting prompt drafts until an explicit rebase or remote adoption',async()=>{
  let current=prompts();const handler=({path,method,body})=>{
    if(path!=='/api/prompts')return;
    if(method==='GET')return {body:current};
    if(body.expectedRevision!==current.settings.revision)return {status:409,body:{error:'Prompt revision conflict'}};
    current={...prompts(current.settings.revision+1),settings:{...body.settings,revision:current.settings.revision+1}};return {body:current.settings};
  };
  const a=await uiFixture(handler),b=await uiFixture(handler);await a.ui.loadPrompts();await b.ui.loadPrompts();
  await a.input('prompt-communication','remote A');await b.input('prompt-communication','local B');
  await a.$('save-prompts').emit('click');await b.$('save-prompts').emit('click');
  assert.match(b.$('message').textContent,/conflict/);assert.equal(b.$('prompt-communication').value,'local B');
  await b.ui.loadPrompts();assert.equal(b.$('prompt-communication').value,'local B');
  const count=b.requests.filter(r=>r.method==='POST'&&r.path==='/api/prompts').length;
  await b.$('save-prompts').emit('click');assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path==='/api/prompts').length,count);
  await b.buttons('保留本地草稿，以新版本为基准')[0].emit('click');await b.$('save-prompts').emit('click');
  assert.equal(current.settings.revision,2);assert.equal(current.settings.sections.communication,'local B');
  assert.equal(b.requests.filter(r=>r.method==='POST'&&r.path==='/api/prompts').at(-1).body.expectedRevision,1);
  await a.input('prompt-communication','A unsaved');await a.ui.loadPrompts();assert.equal(a.$('prompt-communication').value,'A unsaved');
  await a.buttons('采用服务端版本，替换本地草稿')[0].emit('click');assert.equal(a.$('prompt-communication').value,'local B');
});

test('prompt edits made during save or reload are not replaced by the response',async()=>{
  let current=prompts(),wait;const f=await uiFixture(({path,method,body})=>{if(path!=='/api/prompts')return;if(method==='GET')return {body:current};return wait.promise.then(()=>{current={...prompts(1),settings:{...body.settings,revision:1}};return {body:current.settings};});});
  await f.ui.loadPrompts();await f.input('prompt-communication','sent');wait=deferred();const saving=f.$('save-prompts').emit('click');
  await f.input('prompt-communication','written during POST');wait.resolve();await saving;assert.equal(f.$('prompt-communication').value,'written during POST');
  wait=deferred();f.setHandler(({path})=>path==='/api/prompts'?wait.promise:undefined);const reloading=f.ui.loadPrompts();await f.input('prompt-communication','written during GET');wait.resolve({body:current});await reloading;assert.equal(f.$('prompt-communication').value,'written during GET');
});

test('confirming or resetting a default keeps its new base through subsequent typing',async()=>{
  const f=await uiFixture(({path})=>path==='/api/prompts'?{body:prompts(0,'',{'runtime/worker':{text:'custom',base:'old default'}})}:undefined);await f.ui.loadPrompts();
  await f.buttons('保留此文本并确认新默认')[0].emit('click');let input=descendants(f.$('prompt-parts')).find(e=>e.tagName==='TEXTAREA');input.value='edited after confirm';await input.emit('input');
  let posted;f.setHandler(({path,method,body})=>{if(path!=='/api/prompts')return;if(method==='POST'){posted=body;return {status:409,body:{error:'capture'}};}return {body:prompts()};});
  await f.$('save-prompts').emit('click');assert.equal(posted.settings.overrides['runtime/worker'].base,'new default');
  await f.buttons('使用新默认')[0].emit('click');input.value='edited after reset';await input.emit('input');await f.$('save-prompts').emit('click');assert.equal(posted.settings.overrides['runtime/worker'].base,'new default');
});

test('saving scheduler settings preserves a dirty recovery draft in the shared panel',async()=>{
  let scheduler={revision:0,maxWorkers:1,humanReserve:0};const recovery={revision:0,retryBeforeStart:false,maxAttempts:3,initialDelayMs:15000};
  const f=await uiFixture(({path,method,body})=>{if(path==='/api/recovery')return {body:recovery};if(path==='/api/scheduler'){if(method==='POST')scheduler={...body.settings,revision:1};return {body:scheduler};}});
  await f.ui.loadOperations();f.$('recovery-delay').value='23000';f.$('scheduler-max').value='3';await f.$('save-scheduler').emit('click');assert.equal(f.$('recovery-delay').value,'23000');
});

test('structured Worker changes patch only their field instead of replacing newer advanced JSON fields',async()=>{
  const f=await uiFixture(({path})=>path==='/api/executor'?{body:{settings:{revision:0,execution:{driver:'codex-app-server',model:'old',timeoutMs:600000}},history:[]}}:undefined);await f.ui.loadWorker();
  f.$('worker-settings').value=JSON.stringify({driver:'codex-app-server',model:'new-from-json',timeoutMs:600000});f.$('worker-timeout').value='120';await f.$('worker-timeout').emit('change');
  assert.equal(JSON.parse(f.$('worker-settings').value).model,'new-from-json');assert.equal(JSON.parse(f.$('worker-settings').value).timeoutMs,120000);
});

test('session replacement drafts stay bound to the original session across detail reloads',async()=>{
  let session='native-1';const f=await uiFixture(({path})=>path==='/api/tickets/A/session'?{body:{session:{id:session},actionAvailability:{sessionReplace:{allowed:true,expectedSessionId:session}}}}:undefined);const box=f.$('detail');await f.ui.loadSession('A',box);
  let reason=descendants(box).find(e=>e.tagName==='TEXTAREA');reason.value='why replace';await reason.emit('input');await f.ui.loadSession('A',box);assert.equal(descendants(box).find(e=>e.tagName==='TEXTAREA').value,'why replace');
  session='native-2';await f.ui.loadSession('A',box);assert.equal(descendants(box).find(e=>e.tagName==='TEXTAREA').value,'');assert.match(box.textContent,/原会话的未发送草稿/);assert.match(box.textContent,/why replace/);
});

test('false domain results are reported as unchanged rather than saved',async()=>{
  const f=await uiFixture();await f.ui.act(f.$('pause'),async()=>false);assert.match(f.$('message').textContent,/没有作出更改/);assert.doesNotMatch(f.$('message').textContent,/已保存/);
});

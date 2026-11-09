import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimePolicy, validatePolicyConfig } from '../src/policy.mjs';
import { PromptRegistry } from '../src/runtime/prompt-registry.mjs';
import { uiFixture, deferred, ticket, descendants } from './helpers/ui-fixture.mjs';

const row={id:'repo',source:'github',scope:{repository:'fixture/project'},actors:['alice'],bots:['robot'],admission:{unlistedAddressed:'explicit'}};
const input=(changes={})=>({id:'event',source:'github',actor:{source:'github',id:'visitor'},human:true,addressed:'mention',meta:{repository:'fixture/project',actorId:'123',actorType:'User'},...changes});
test('explicit unlisted addressing is an opt-in scoped human grant; old booleans remain inferred or ignored',()=>{
  const old=validatePolicyConfig({sourceRows:[{...row,admission:{listedUnaddressed:true,unlistedAddressed:true,unlistedUnaddressed:false}}]});
  assert.deepEqual(old.sourceRows[0].admission,{listedUnaddressed:'inferred',unlistedAddressed:'inferred',unlistedUnaddressed:'ignore'});
  assert.throws(()=>validatePolicyConfig({sourceRows:[{...row,scope:{},admission:{unlistedAddressed:'explicit'}}]}),/requires/);
  assert.throws(()=>validatePolicyConfig({sourceRows:[{...row,admission:{listedUnaddressed:'explicit'}}]}),/only addressed/);
  const policy=createRuntimePolicy({config:{mode:'off',sourceRows:[row]}}),admitted=policy.gate(input());
  assert.equal(admitted.strength,'explicit');assert.equal(admitted.basis.via,'admission');
  for(const event of [input({addressed:undefined}),input({meta:{repository:'elsewhere/project',actorType:'User',actorId:'123'}}),input({meta:{repository:'fixture/project'}}),input({actor:{source:'github',id:'robot'}}),input({meta:{repository:'fixture/project',actorType:'Bot',actorId:'123'}})])assert.equal(policy.gate(event).admissible,false);
  const mandate={strength:'explicit',actor:input().actor,basis:admitted.basis};assert.equal(policy.revalidate(mandate),true);
  assert.equal(createRuntimePolicy({config:{sourceRows:[{...row,admission:{unlistedAddressed:'inferred'}}]}}).revalidate(mandate),false);
  assert.equal(createRuntimePolicy({config:{sourceRows:[row,{...row,id:'ambiguous'}]}}).gate(input()).admissible,false);
});

test('prompt preview shares real assembly, validates drafts and never persists revisions or creates baseline data',()=>{
  const rows=new Map(),store={getMeta:key=>rows.get(key),setMeta:(key,value)=>rows.set(key,structuredClone(value)),listMeta:prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value})),atomic:fn=>fn()};
  const registry=new PromptRegistry(store,{initialize:false}),settings={sections:{communication:'Preview my unsaved words',scope:'Stay within scope',delivery:''},overrides:{},knowledge:[]};
  const first=registry.preview(settings,{expectedRevision:0});assert.equal(rows.size,0);assert.match(first.draft.worker.text,/Preview my unsaved/);assert.doesNotMatch(first.saved.worker.text,/Preview my unsaved/);
  assert.throws(()=>registry.preview({overrides:{'runtime/environment':'Missing replacement'}},{expectedRevision:0}),/requires/);assert.equal(rows.size,0);
  registry.update(settings,{expectedRevision:0});const before=JSON.stringify([...rows]),preview=registry.preview(settings,{expectedRevision:1});
  assert.equal(preview.draft.worker.text,registry.assemble({role:'worker'}).text);assert.equal(preview.draft.coordinator.digest,registry.assemble({role:'coordinator'}).digest);assert.equal(JSON.stringify([...rows]),before);
  assert.throws(()=>registry.preview(settings,{expectedRevision:0}),/revision conflict/);assert.equal(JSON.stringify([...rows]),before);
});

test('admission matrix edits the latest draft field and keeps unrelated advanced settings',async()=>{
  const current={revision:0,policy:{mode:'off',sourceRows:[row]},assessor:null};
  const f=await uiFixture(({path})=>path==='/api/coordinator'?{body:{settings:current,history:[]}}:undefined);await f.ui.loadSettings();
  const advanced=JSON.parse(f.$('settings').value);advanced.policy.evalTimeoutMs=7777;await f.input('settings',JSON.stringify(advanced));
  const select=f.$('admission-repo-unlistedAddressed');select.value='inferred';await select.emit('change');
  const edited=JSON.parse(f.$('settings').value);assert.equal(edited.policy.evalTimeoutMs,7777);assert.equal(edited.policy.sourceRows[0].admission.unlistedAddressed,'inferred');
  assert.equal(f.requests.filter(request=>request.method==='POST').length,0,'matrix edits remain unsaved drafts');
});

test('unsaved prompt preview compares the current draft and ignores an obsolete asynchronous result',async()=>{
  const prompts={settings:{revision:0,sections:{communication:'',scope:'',delivery:''},overrides:{},knowledge:[]},history:[],diff:[],assembled:{worker:{text:'saved'}}};
  let wait;const f=await uiFixture(({path})=>path==='/api/prompts'?{body:prompts}:path==='/api/prompts/preview'?wait.promise:undefined);await f.ui.loadPrompts();await f.input('prompt-communication','draft one');
  const result={revision:0,draft:{worker:{text:'draft one'},coordinator:{text:'draft coordinator'}},saved:{worker:{text:'saved'},coordinator:{text:'saved coordinator'}},defaults:{worker:{text:'default'},coordinator:{text:'default coordinator'}}};
  wait=deferred();const reading=f.$('prompt-preview').emit('click');await f.input('prompt-communication','draft two');wait.resolve({body:result});await reading;
  assert.match(f.$('prompt-preview-status').textContent,/草稿已变化/);assert.equal(f.$('prompt-preview-result').textContent,'');assert.equal(f.$('prompt-communication').value,'draft two');
  wait=deferred();const next=f.$('prompt-preview').emit('click');wait.resolve({body:{...result,draft:{...result.draft,worker:{text:'draft two'}}}});await next;
  assert.match(f.$('prompt-preview-result').textContent,/draft two/);assert.match(f.$('prompt-preview-result').textContent,/saved/);
  f.$('prompt-preview-base').value='defaults';await f.$('prompt-preview-base').emit('change');assert.match(f.$('prompt-preview-result').textContent,/default/);
  assert.equal(f.requests.filter(request=>request.method==='POST'&&request.path==='/api/prompts').length,0);
});


test('management buttons use current revisions and reload after a conflicting destructive action',async()=>{
  let revision='old';const f=await uiFixture(({path,method})=>{
    if(path==='/api/management')return {body:{threads:[{thread:'github:r/project#1',subscriptions:['A','B'],revision}],decisions:[]}};
    if(method==='POST'&&path==='/api/threads/unsubscribe'){revision='new';return {status:409,body:{error:'Thread revision conflict'}};}
  });
  await f.$('load-management').emit('click');assert.match(f.$('management-records').textContent,/关联 2 项工单/);
  await f.buttons('取消整个讨论的全部订阅')[0].emit('click');assert.equal(f.requests.filter(r=>r.method==='POST').at(-1).body.expectedRevision,'old');assert.match(f.$('message').textContent,/conflict/);
  await f.buttons('取消整个讨论的全部订阅')[0].emit('click');assert.equal(f.requests.filter(r=>r.method==='POST').at(-1).body.expectedRevision,'new');
});

test('child message retry reuses its request ID and keeps edits made during sending',async()=>{
  let response;const f=await uiFixture(({path,method})=>path==='/api/tickets/A/jobs'?{body:[{id:'child',kind:'agent',profileId:'helper',status:'handed-off'}]}:method==='POST'&&path.endsWith('/resume')?response.promise:undefined);
  const box=f.$('detail');await f.ui.loadJobs('A',box,{jobControl:true});let input=descendants(box).find(e=>e.tagName==='TEXTAREA');input.value='answer';await input.emit('input');
  response=deferred();let sending=f.buttons('回复并接续')[0].emit('click');response.resolve({status:503,body:{error:'temporary failure'}});await sending;
  response=deferred();sending=f.buttons('回复并接续')[0].emit('click');const requests=f.requests.filter(r=>r.path.endsWith('/resume'));assert.equal(requests[0].body.requestId,requests[1].body.requestId);
  input.value='next answer';await input.emit('input');response.resolve({body:{queued:true}});await sending;await f.ui.loadJobs('A',box,{jobControl:true});input=descendants(box).find(e=>e.tagName==='TEXTAREA');assert.equal(input.value,'next answer');
});

test('delivery screenshot conditions stay in drafts and evidence uses the authenticated image endpoint',async()=>{
  const f=await uiFixture(({path})=>path==='/api/delivery'?{body:{revision:0,mode:'local',automatic:false,uiEvidence:{mode:'auto',scenario:'home',viewport:{width:1280,height:800},theme:'light',capture:{id:'trusted-local'}}}}:path==='/api/tickets/A/details'?{body:{ticket:ticket('A'),managementActions:{},uiEvidence:{status:'incomplete',settings:{scenario:'home'},before:{path:'/private/capture.png',sha256:'sha',treeDigest:'tree'}}}}:undefined);
  await f.ui.loadDelivery();await f.input('evidence-scenario','settings panel');await f.ui.loadDelivery();assert.equal(f.$('evidence-scenario').value,'settings panel');assert.match(f.$('evidence-capture').textContent,/已配置/);
  await f.ui.detail('A');assert.match(f.$('detail').textContent,/不能据此声明视觉验收通过/);assert.doesNotMatch(f.$('detail').textContent,/private\/capture/);assert.equal(f.buttons('查看修改前截图').length,1);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});

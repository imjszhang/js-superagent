import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { uiFixture, status, descendants, deferred } from './helpers/ui-fixture.mjs';

const settings = (revision = 0, policy = {mode:'observe',rules:[]}) => ({settings:{revision,policy,assessor:null},history:[]});
const prompts = revision => ({settings:{revision,sections:{communication:'original',scope:'',delivery:''},overrides:{},knowledge:[]},history:[],diff:[],assembled:{}});
const storage = () => new Map([['js-superagent-csrf','fixture-csrf']]);
function handler(projectId='project-A') {
  return ({path}) => path==='/api/status'?{body:{...status(),projectId}}:
    path==='/api/coordinator'?{body:settings()}:
    path==='/api/prompts'?{body:prompts(0)}:
    path==='/api/tickets/A/session'?{body:{session:{id:'native-A'},actionAvailability:{sessionReplace:{allowed:true,expectedSessionId:'native-A'}}}}:undefined;
}

test('refresh restores project-scoped settings, prompts, replies, session and coordination drafts without sending them',async()=>{
  const saved=storage(),f=await uiFixture(handler(),{storage:saved});
  await f.ui.loadSettings();await f.input('settings',JSON.stringify({policy:{mode:'auto'},assessor:null}));
  await f.ui.loadPrompts();await f.input('prompt-communication','Keep this unsaved policy');
  await f.ui.detail('A');await f.input('reply-text','Unsent answer');
  await f.ui.loadSession('A',f.$('detail'));const reason=descendants(f.$('detail')).find(e=>e.tagName==='TEXTAREA');reason.value='Unsent replacement reason';await reason.emit('input');
  await f.input('coordination-text','Unsent project message');
  const reloaded=await uiFixture(handler(),{storage:saved});await reloaded.ui.loadSettings();await reloaded.ui.loadPrompts();await reloaded.ui.detail('A');
  assert.equal(JSON.parse(reloaded.$('settings').value).policy.mode,'auto');
  assert.equal(reloaded.$('prompt-communication').value,'Keep this unsaved policy');
  assert.equal(reloaded.$('reply-text').value,'Unsent answer');
  await reloaded.ui.loadSession('A',reloaded.$('detail'));assert.equal(descendants(reloaded.$('detail')).find(e=>e.tagName==='TEXTAREA').value,'Unsent replacement reason');
  assert.equal(reloaded.$('coordination-text').value,'Unsent project message');
  assert.equal(reloaded.requests.filter(r=>r.method==='POST').length,0);
  const other=await uiFixture(handler('project-B'),{storage:saved});await other.ui.loadSettings();await other.ui.detail('A');
  assert.equal(JSON.parse(other.$('settings').value).policy.mode,'observe');assert.equal(other.$('reply-text').value,'');assert.equal(other.$('coordination-text').value,'');
});

test('persisted JSON settings merge different fields, expose same-field choices and save only against the new revision',async()=>{
  const saved=storage();let current=settings();
  const route=request=>request.path==='/api/coordinator'?{body:current}:handler()(request);
  const first=await uiFixture(route,{storage:saved});await first.ui.loadSettings();
  const local=JSON.parse(first.$('settings').value);local.policy.mode='auto';await first.input('settings',JSON.stringify(local));
  current=settings(1,{mode:'observe',rules:[{id:'new-rule'}]});
  const f=await uiFixture(route,{storage:saved});await f.ui.loadSettings();
  assert.equal(JSON.parse(f.$('settings').value).policy.mode,'auto');assert.equal(JSON.parse(f.$('settings').value).policy.rules[0].id,'new-rule');
  current=settings(2,{mode:'off',rules:[{id:'new-rule'}]});await f.ui.loadSettings();
  assert.equal(f.buttons('此字段采用服务端').length,1);
  await f.buttons('此字段采用服务端')[0].emit('click');assert.equal(JSON.parse(f.$('settings').value).policy.mode,'off');
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
  const edited=JSON.parse(f.$('settings').value);edited.policy.mode='auto';await f.input('settings',JSON.stringify(edited));
  current=settings(3,{mode:'observe',rules:[{id:'new-rule'}]});await f.ui.loadSettings();
  edited.policy.mode='off';await f.input('settings',JSON.stringify(edited));
  await f.buttons('此字段保留本地')[0].emit('click');assert.equal(JSON.parse(f.$('settings').value).policy.mode,'off');
  let posted;f.setHandler(request=>{if(request.method==='POST'&&request.path==='/api/coordinator'){posted=request.body;current={settings:{...posted.settings,revision:4},history:[]};return {body:current.settings};}return route(request);});
  await f.$('save-settings').emit('click');assert.equal(posted.expectedRevision,3);assert.equal(posted.settings.policy.mode,'off');
});

test('editing during a successful save preserves only the newer unsent revision across refresh',async()=>{
  const saved=storage(),wait=deferred();let current=prompts(0);
  const route=({path,method,body})=>path==='/api/prompts'?method==='GET'?{body:current}:wait.promise.then(()=>{current={...prompts(1),settings:{...body.settings,revision:1}};return {body:current.settings};}):undefined;
  const f=await uiFixture(route,{storage:saved});await f.ui.loadPrompts();await f.input('prompt-communication','sent');
  const saving=f.$('save-prompts').emit('click');await f.input('prompt-communication','later unsent text');wait.resolve();await saving;
  const reloaded=await uiFixture(route,{storage:saved});await reloaded.ui.loadPrompts();assert.equal(reloaded.$('prompt-communication').value,'later unsent text');
  assert.equal(reloaded.requests.filter(r=>r.method==='POST').length,0);
});

test('sensitive or invalid advanced JSON stays in memory, storage failure is visible and missing identity never shares drafts',async()=>{
  const saved=storage(),f=await uiFixture(handler(),{storage:saved});await f.ui.loadSettings();
  await f.input('settings',JSON.stringify({policy:{mode:'auto'},assessor:{apiKey:'plain-credential'}}));
  assert.ok(![...saved.values()].some(text=>text.includes('plain-credential')));assert.match(f.$('draft-storage-status').textContent,/敏感字段/);
  await f.input('settings','{"policy":');await f.ui.loadSettings();assert.equal(f.$('settings').value,'{"policy":');
  const broken=storage();broken.set=()=>{throw new Error('quota');};const b=await uiFixture(handler(),{storage:broken});await b.ui.detail('A');await b.input('reply-text','not persisted');assert.match(b.$('draft-storage-status').textContent,/无法保存/);
  const noId=await uiFixture(request=>request.path==='/api/status'?{body:{...status(),projectId:undefined}}:undefined,{storage:saved});await noId.ui.detail('A');await noId.input('reply-text','without identity');
  assert.ok(![...saved.values()].some(text=>text.includes('without identity')));
});

test('merge keeps arrays/text atomic and project draft parser rejects obsolete data',()=>{
  const context={structuredClone};runInNewContext(readFileSync(new URL('../src/ui/drafts.js',import.meta.url),'utf8'),context);
  const {merge3,createStore}=context.SuperagentDrafts;
  const merged=merge3({rules:['a'],text:'base',keep:1},{rules:['a','b'],text:'mine',keep:1},{rules:['a','c'],text:'theirs',keep:2});
  assert.equal(merged.value.keep,2);assert.equal(merged.conflicts.length,2);assert.equal(merged.conflicts[0].path.join('.'),'rules');
  const map=new Map(),notices=[],store=createStore({storage:()=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)}),projectId:'A',notify:reason=>notices.push(reason)});
  map.set('js-superagent:drafts:v1:A:reply%3AA','{"formatVersion":0}');assert.equal(store.load('reply:A'),null);assert.ok(notices.includes('invalid'));
});

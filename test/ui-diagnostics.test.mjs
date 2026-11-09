import test from 'node:test';
import assert from 'node:assert/strict';
import {uiFixture,descendants,deferred} from './helpers/ui-fixture.mjs';

const event={id:'github:event',source:'github',text:'Investigate this change',available:true,intake:{status:'received',reason:null,outcomes:[]},evaluation:{status:'decided',decisions:[{id:'decision',kind:'accept',reason:[{code:'said',values:{text:'Within scope'}}]}]},tickets:[{ticketId:'A',fanout:true,context:false,acknowledged:true,inputs:[{state:'read',at:'2026-11-03T00:00:00Z'}]},{ticketId:'B',fanout:true,context:true,handback:null,inputs:[{state:'pending',at:'2026-11-03T00:00:00Z'}]}],replies:[{id:'reply-a',source:'github',thread:'owner/repo#1',status:'failed',relation:'direct',text:'Acknowledgement',attempts:2,reason:'retry',error:'temporary error'},{id:'reply-b',source:'github',thread:'owner/repo#1',status:'sent',relation:'related',text:'Other work',attempts:0}],omitted:{}};
function select(f,kind='events'){f.$('diagnostic-kind').value=kind;}

test('diagnostic event view explains routing, context and exact versus related replies without mutation',async()=>{
  const f=await uiFixture(({path})=>{
    if(path.startsWith('/api/diagnostics/events?'))return {body:{items:[event],total:1,nextCursor:null}};
    if(path.startsWith('/api/diagnostics/event?'))return {body:event};
  });select(f);
  await f.$('diagnostic-load').emit('click');
  const row=descendants(f.$('diagnostic-records')).find(item=>item.tagName==='DETAILS');row.open=true;await row.emit('toggle');await new Promise(resolve=>setImmediate(resolve));
  const text=f.$('diagnostic-records').textContent;
  assert.match(text,/Within scope/);assert.match(text,/只作上下文/);assert.match(text,/已读取/);assert.match(text,/直接关联此事件/);assert.match(text,/不代表由此事件触发/);assert.match(text,/发送失败/);
  assert.equal(f.requests.some(request=>request.method==='POST'),false);
});

test('diagnostic filters reset pagination and stale search results cannot replace a newer query',async()=>{
  const old=deferred(),newer=deferred();const f=await uiFixture(({path})=>{
    if(path.includes('q=old'))return old.promise;
    if(path.includes('q=new'))return newer.promise;
  });select(f);
  f.$('diagnostic-query').value='old';const first=f.$('diagnostic-load').emit('click');
  f.$('diagnostic-query').value='new';const second=f.$('diagnostic-load').emit('click');
  newer.resolve({body:{items:[{...event,text:'new match'}],total:1,nextCursor:null}});await second;
  old.resolve({body:{items:[{...event,text:'stale match'}],total:2,nextCursor:'old-cursor'}});await first;
  assert.match(f.$('diagnostic-records').textContent,/new match/);assert.doesNotMatch(f.$('diagnostic-records').textContent,/stale match/);assert.equal(f.$('diagnostic-more').hidden,true);
  f.setHandler(({path})=>path.startsWith('/api/diagnostics/replies?')?{body:{items:[{id:'dropped',status:'dropped',reason:'locked',source:'github',thread:'owner/repo#1',text:'Unavailable conversation',attempts:0}],total:1,nextCursor:null}}:undefined);
  select(f,'replies');f.$('diagnostic-query').value='';await f.$('diagnostic-kind').emit('change');
  assert.match(f.$('diagnostic-records').textContent,/已撤回或无法发送/);assert.match(f.$('diagnostic-records').textContent,/locked/);
  assert.equal(f.requests.at(-1).path.includes('cursor='),false);
});

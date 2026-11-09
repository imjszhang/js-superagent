import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture, deferred, ticket, descendants } from './helpers/ui-fixture.mjs';

test('ticket search uses server matches outside the loaded page and refresh retains loaded pages',async()=>{
  const all=Array.from({length:120},(_,i)=>ticket(`T${i}`));
  const f=await uiFixture(({path})=>{
    if(!path.startsWith('/api/tickets?'))return;
    const q=new URL(path,'http://local').searchParams,offset=Number(q.get('offset')??0);
    const matches=q.get('q')==='event-only-match'?[ticket('public-from-event')]:all;
    return {body:{items:matches.slice(offset,offset+100),total:matches.length,nextOffset:offset+100<matches.length?offset+100:null}};
  });
  await f.ui.loadTickets(true);assert.equal(f.$('tickets').children.length,120);
  await f.ui.refresh();assert.equal(f.$('tickets').children.length,120,'Refresh must not throw away the second page');
  f.$('search').value='event-only-match';await f.ui.loadTickets();
  assert.equal(f.$('tickets').children.length,1);assert.match(f.$('tickets').textContent,/public-from-event/);
  assert.match(f.requests.filter(r=>r.path.startsWith('/api/tickets?')).at(-1).path,/offset=0&q=event-only-match/);
});

test('late ticket and context search responses cannot replace the current query results',async()=>{
  const a=deferred(),b=deferred();const f=await uiFixture();
  f.setHandler(({path})=>path.includes('q=older')?a.promise:path.includes('q=newer')?b.promise:undefined);
  f.$('search').value='older';const first=f.ui.loadTickets();f.$('search').value='newer';const second=f.ui.loadTickets();
  b.resolve({body:{items:[ticket('new')],nextOffset:null}});await second;a.resolve({body:{items:[ticket('old')],nextOffset:null}});await first;
  assert.match(f.$('tickets').textContent,/Task new/);assert.doesNotMatch(f.$('tickets').textContent,/Task old/);
  const c=deferred(),d=deferred();f.setHandler(({path})=>path.includes('q=old-context')?c.promise:d.promise);
  f.$('context-search').value='old-context';const old=f.ui.loadContext();f.$('context-search').value='new-context';const next=f.ui.loadContext();
  d.resolve({body:{items:[{id:'current',value:{text:'current match'}}],nextCursor:null}});await next;c.resolve({body:{items:[{id:'stale',value:{text:'stale match'}}],nextCursor:null}});await old;
  assert.match(f.$('context-records').textContent,/current match/);assert.doesNotMatch(f.$('context-records').textContent,/stale match/);
});

test('context search resets its cursor and preserves matches found beyond a truncated preview',async()=>{
  const f=await uiFixture(({path})=>path.startsWith('/api/context/')?{body:{items:[{id:'record',preview:'prefix without query',truncated:true}],nextCursor:'cursor-for-old-query'}}:undefined);
  f.$('context-search').value='old';await f.ui.loadContext();f.$('context-search').value='keyword-after-preview';await f.ui.loadContext();
  assert.match(f.$('context-records').textContent,/prefix without query/);
  const request=f.requests.at(-1);assert.ok(request.path.includes('q=keyword-after-preview'));assert.ok(!request.path.includes('cursor='));
});

test('full record pages use the returned version and a changed record clears mixed old pages',async()=>{
  let changed=false;
  const f=await uiFixture(({path})=>{
    if(!path.includes('/record?'))return;
    const q=new URL(path,'http://local').searchParams;
    if(q.has('offset'))return changed?{status:409,body:{error:'record changed'}}:{body:{text:'tail',length:8,nextOffset:null,offset:4,version:'v1',redacted:true}};
    return {body:{text:changed?'new-head':'head',length:8,nextOffset:4,offset:0,version:changed?'v2':'v1',redacted:true}};
  });
  await f.ui.loadContextRecord('triggers','github:owner/repo#23',f.$('context-records'));
  await f.buttons('继续读取原始记录')[0].emit('click');assert.match(f.requests.at(-1).path,/offset=4&version=v1/);assert.match(f.$('context-records').textContent,/headtail/);
  await f.ui.loadContextRecord('triggers','github:owner/repo#23',f.$('context-records'));changed=true;await f.buttons('继续读取原始记录')[0].emit('click');
  assert.match(f.$('context-records').textContent,/记录已变化/);assert.doesNotMatch(f.$('context-records').textContent,/head/);
  await f.buttons('重新读取当前记录')[0].emit('click');assert.match(f.$('context-records').textContent,/new-head/);
});

test('association navigation uses explicit public ticket IDs and only HTTPS external links',async()=>{
  const f=await uiFixture(({path})=>path.startsWith('/api/context/triggers?')?{body:{items:[{id:'event',value:{ticketId:'domain-id'},associations:{tickets:[{id:'public-id',title:'Resolved public ticket'}],decisions:[{id:'decision-id'}],urls:[{url:'https://github.com/owner/repo/pull/23'},{url:'javascript:alert(1)'}]}}],nextCursor:null}}:undefined);
  await f.ui.loadContext();await f.buttons('打开工单 Resolved public ticket')[0].emit('click');assert.ok(f.requests.some(r=>r.path==='/api/tickets/public-id/details'));
  const links=descendants(f.$('context-records')).filter(e=>e.tagName==='A');assert.equal(links.length,1);assert.equal(links[0].href,'https://github.com/owner/repo/pull/23');
  assert.match(f.$('context-records').textContent,/查看关联判断 decision-id/);
});

test('status requests and session replacement follow host applicability rather than method availability',async()=>{
  let allowed=false;
  const f=await uiFixture(({path})=>{
    if(path.endsWith('/details'))return {body:{ticket:ticket('A','completed'),outcome:allowed?null:'completed',managementActions:{requestStatus:true},actionAvailability:{requestStatus:{allowed,reason:allowed?'':'已结束，不发送状态请求'}}}};
    if(path.endsWith('/session'))return {body:{session:{id:'native-id'},actionAvailability:{sessionReplace:{allowed,expectedSessionId:'native-id',reason:allowed?'':'当前仍在执行'}}}};
  });
  await f.ui.detail('A');assert.equal(f.buttons('询问执行进展').length,0);assert.match(f.$('detail').textContent,/已结束/);assert.equal(f.buttons('取消工作').length,0);
  await f.ui.loadSession('A',f.$('detail'));assert.equal(f.buttons('按以上选择替换会话').length,0);assert.match(f.$('detail').textContent,/当前仍在执行/);
  allowed=true;await f.ui.detail('A');assert.equal(f.buttons('询问执行进展').length,1);assert.equal(f.buttons('取消工作').length,1,'A ready ticket with an open owned PR remains cancellable');
  await f.ui.loadSession('A',f.$('detail'));assert.equal(f.buttons('按以上选择替换会话').length,1);
});

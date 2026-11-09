import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createGitHubReviewActions } from '../src/runtime/github-review-actions.mjs';
import { createGitHubReviewTransport, REVIEW_QUERIES } from '../src/channels/github-review.mjs';
import { createGitHubAppRequest } from '../src/channels/github-app.mjs';

const repository = 'fixture/project', headSha = 'a'.repeat(40);
function fixture() {
  const records = new Map(), writes = [];
  let pull = { number: 7, node_id: 'PR_7', state: 'open', draft: true, title: 'Change', body: '', user: { login: 'agent' },
    head: { sha: headSha, repo: { full_name: repository } }, base: { repo: { full_name: repository } } };
  let comments=[],original={id:91,body:'Finding',user:{id:20,type:'User',login:'alice'},pull_request_url:`https://api.github.com/repos/${repository}/pulls/7`};
  let recipients = { users: [], teams: [] }, reviews = [], resolved = false, lose = false, reject, different = false;
  const store = { atomic: fn => fn(), getMeta: key => structuredClone(records.get(key)), setMeta: (key,value) => records.set(key, structuredClone(value)),
    listMeta: prefix => [...records].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({key,value:structuredClone(value)})) };
  async function request(endpoint, options = {}) {
    if (options.method === 'POST' && (endpoint !== '/graphql' || ![REVIEW_QUERIES.thread,REVIEW_QUERIES.findThread].includes(options.body.query))) {
      if (reject) throw Object.assign(new Error('API permission denied'), {status:reject});
      writes.push({endpoint,body:options.body});
      if(endpoint.endsWith('/comments/91/replies'))comments.push({id:100+comments.length,body:options.body.body,user:{id:999,type:'User'},in_reply_to_id:91,pull_request_url:original.pull_request_url});
      if (endpoint.endsWith('/requested_reviewers')) recipients = { users: options.body.reviewers.map(login => ({login})), teams: options.body.team_reviewers.map(slug => ({slug})) };
      if (options.body?.query === REVIEW_QUERIES.ready) pull.draft = false;
      if (options.body?.query === REVIEW_QUERIES.resolve) resolved = true;
      if (lose) { lose=false; throw new Error('Response lost after applied mutation'); }
      return { data: { ok:true } };
    }
    if(endpoint==='/user')return {id:999,login:'agent',type:'User'};
    if(endpoint==='/users/alice')return {id:20,login:'alice',type:'User'};
    if(endpoint.endsWith('/pulls/comments/91'))return structuredClone(original);
    if(endpoint.includes('/pulls/7/comments?'))return structuredClone(comments);
    if (endpoint.endsWith('/pulls/7')) return structuredClone(pull);
    if (endpoint.includes('/requested_reviewers')) return structuredClone(recipients);
    if (endpoint.includes('/reviews?')) return structuredClone(reviews);
    if (endpoint === '/graphql' && options.body.query === REVIEW_QUERIES.findThread) return {data:{node:{id:'PR_7',number:7,headRefOid:headSha,repository:{nameWithOwner:repository},reviewThreads:{nodes:[{id:'PRRT_9',isResolved:resolved,comments:{nodes:[{databaseId:91}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}}}};
    if (endpoint === '/graphql') return { data: { node: { id:'PRRT_9', isResolved:resolved, pullRequest:{ number:7, headRefOid:headSha, repository:{nameWithOwner:different?'other/project':repository} }, comments:{nodes:[{databaseId:91}],pageInfo:{hasNextPage:false}} } } };
    throw new Error(`Unexpected endpoint ${endpoint}`);
  }
  const channel = createGitHubReviewTransport({repository,request}), service = createGitHubReviewActions({store,channel});
  const base = {ticketId:'ticket',provisionId:'work',generation:0,repository,pullNumber:7,headSha};
  const options = {authorize:()=>true,policy:{ready:true,requestReviewers:true,resolveThreads:true,reviewers:['alice'],teams:['team']},validateReady:()=>true,validateResolution:()=>true,validateFinding:()=>true,validateRecipients:()=>true};
  return {store,channel,service,base,options,writes,request,pull,records,original,comments,setLose:()=>lose=true,setReject:n=>reject=n,setDifferent:()=>different=true, removeRequests:()=>recipients={users:[],teams:[]},review:()=>reviews.push({id:11,user:{login:'alice'},state:'APPROVED',commit_id:headSha})};
}

test('W30 review actions request, resolve and ready use bound transport and idempotent durable receipts', async () => {
  const f=fixture();
  for (const intent of [{kind:'requestReviewers',reviewers:['alice'],teams:[]},{kind:'resolveThread',commentId:91,evidence:{verificationId:'v1'}},{kind:'ready'}]) {
    const queued=f.service.enqueue({...f.base,...intent});
    assert.equal((await f.service.run(queued.id,f.options)).status,'completed');
    await f.service.run(queued.id,f.options);
    assert.equal(f.service.enqueue({...f.base,...intent}).id,queued.id);
  }
  assert.equal(f.writes.length,3); assert.equal(f.pull.draft,false);
  assert.equal(f.service.list('ticket').length,3);
  assert.equal(f.service.list('ticket').find(row=>row.intent.kind==='resolveThread').resolvedThreadId,'PRRT_9');
});

test('W30 lost response is read back after reopen; unknown result never repeats a reviewer notification', async () => {
  const f=fixture(), row=f.service.enqueue({...f.base,kind:'requestReviewers',reviewers:['alice']});
  f.setLose(); await assert.rejects(f.service.run(row.id,f.options),/Response lost/);
  const reopened=createGitHubReviewActions({store:f.store,channel:f.channel});
  assert.equal((await reopened.run(row.id,f.options)).status,'completed'); assert.equal(f.writes.length,1);
  const g=fixture(), unknown=g.service.enqueue({...g.base,kind:'requestReviewers',reviewers:['alice']});
  g.setLose(); await assert.rejects(g.service.run(unknown.id,g.options)); g.removeRequests();
  assert.equal((await g.service.run(unknown.id,g.options)).status,'inspection'); assert.equal(g.writes.length,1);
});

test('W30 rejects changed head, policy revocation, missing repair evidence and cross-repository threads', async () => {
  for (const problem of ['head','policy','evidence','thread','permission']) {
    const f=fixture(), row=f.service.enqueue({...f.base,kind:'resolveThread',threadId:'PRRT_9',commentId:91,evidence:{verificationId:'v1'}});
    if(problem==='head') f.pull.head.sha='b'.repeat(40);
    if(problem==='policy') f.options.policy.resolveThreads=false;
    if(problem==='evidence') f.options.validateResolution=()=>false;
    if(problem==='thread') f.setDifferent();
    if(problem==='permission') f.setReject(403);
    await assert.rejects(f.service.run(row.id,f.options)); assert.equal(f.writes.length,0);
  }
});

test('W30 a review on the intended commit satisfies a request and concurrent effects send once', async () => {
  const f=fixture(), row=f.service.enqueue({...f.base,kind:'requestReviewers',reviewers:['alice']}); f.review();
  assert.equal((await f.service.run(row.id,f.options)).status,'completed'); assert.equal(f.writes.length,0);
  const g=fixture(), pending=g.service.enqueue({...g.base,kind:'ready'});
  await Promise.all([g.service.run(pending.id,g.options),g.service.run(pending.id,g.options)]); assert.equal(g.writes.length,1);
});

test('W30 App review GraphQL is fixed, repository-bound and requires explicit write permission', async () => {
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const f=fixture(), permissions={metadata:'read',issues:'write',pull_requests:'write'};
  const app=createGitHubAppRequest({repository,app:{appId:'12',installationId:15,privateKeyEnv:'TEST_ONLY',pullRequestReviews:true}}, {
    readPrivateKey:()=>key,fetch:async(url,init)=> {
      const path=new URL(url).pathname;
      const value=path.endsWith('/access_tokens')?{token:'fake-only-token',expires_at:new Date(Date.now()+3600000).toISOString(),permissions,repository_selection:'selected',repositories:[{id:1,full_name:repository}]}:
        await f.request(path+new URL(url).search,{method:init.method,body:init.body?JSON.parse(init.body):undefined});
      return new Response(JSON.stringify(value),{status:200});
    }
  });
  await app.reviewGraphql('ready',{number:7,headSha}); assert.equal(f.pull.draft,false);
  await assert.rejects(app('/graphql',{method:'POST',body:{query:'mutation dangerous'}}),/outside/);
  f.setDifferent(); await assert.rejects(app.reviewGraphql('resolve',{number:7,headSha,threadId:'PRRT_9'}),/identity/);
  assert.equal(f.writes.length,1);
});

test('finding dispositions keep fixed silent, explain declined once, and never resolve human or unresolved findings', async()=>{
  for(const [disposition,authorKind,expected] of [['fixed','human',1],['declined','human',1],['declined','bot',2],['unresolved','human',0]]){
    const f=fixture(),intent={...f.base,kind:'finding',disposition,authorKind,commentId:91,reason:'A specific disposition for this finding',
      evidence:{rootId:91,actorId:'20',commentDigest:createHash('sha256').update('Finding').digest('hex')}};
    const row=f.service.enqueue(intent);assert.equal((await f.service.run(row.id,f.options)).status,'completed');
    await f.service.run(row.id,f.options);assert.equal(f.writes.length,expected);
    assert.equal(f.writes.filter(write=>write.endpoint.endsWith('/replies')).length,disposition==='declined'?1:0);
    assert.equal(f.writes.filter(write=>write.body?.query===REVIEW_QUERIES.resolve).length,disposition==='fixed'||disposition==='declined'&&authorKind==='bot'?1:0);
    if(disposition==='declined')assert.ok(f.service.get(row.id).replyReceipt);
  }
});

test('a declined bot explanation lost response reconciles its exact receipt before resolving, with no duplicate reply',async()=>{
  const f=fixture(),row=f.service.enqueue({...f.base,kind:'finding',disposition:'declined',authorKind:'bot',commentId:91,reason:'Existing guard already handles this case',
    evidence:{rootId:91,actorId:'20',commentDigest:createHash('sha256').update('Finding').digest('hex')}});
  f.setLose();await assert.rejects(f.service.run(row.id,f.options),/Response lost/);assert.equal(f.writes.length,1);
  const reopened=createGitHubReviewActions({store:f.store,channel:f.channel});
  const result=await reopened.run(row.id,f.options);assert.equal(result.status,'completed');assert.ok(result.replyReceipt);assert.equal(f.writes.length,2);
  assert.equal(f.writes[0].endpoint,'/repos/fixture/project/pulls/7/comments/91/replies');assert.equal(f.writes[1].body.query,REVIEW_QUERIES.resolve);
  const other=f.service.enqueue({...row.intent,headSha:'a'.repeat(40),ticketId:'followup'});await f.service.run(other.id,f.options);assert.equal(f.writes.length,2,'same authored explanation is reused across a later ticket');
});

test('finding explanation refuses a changed original comment and reviewer budget is checked again immediately before write',async()=>{
  const f=fixture(),row=f.service.enqueue({...f.base,kind:'finding',disposition:'declined',authorKind:'human',commentId:91,reason:'Reason',
    evidence:{rootId:91,actorId:'20',commentDigest:createHash('sha256').update('Finding').digest('hex')}});
  f.original.body='Changed finding';await assert.rejects(f.service.run(row.id,f.options),/Original finding changed/);assert.equal(f.writes.length,0);
  const g=fixture(),request=g.service.enqueue({...g.base,kind:'requestReviewers',reviewers:['alice']});let checks=0;
  await assert.rejects(g.service.run(request.id,{...g.options,validateRecipients:()=>++checks===1}),/budget/);assert.equal(g.writes.length,0);
});

test('an explicit rate-limit rejection retries only after readback, while ready still requires fresh validation',async()=>{
  const f=fixture(),row=f.service.enqueue({...f.base,kind:'requestReviewers',reviewers:['alice']});
  f.setReject(429);await assert.rejects(f.service.run(row.id,f.options),error=>error.reviewRetryable===true);
  assert.equal(f.service.get(row.id).status,'failed');f.setReject(undefined);
  assert.equal((await f.service.run(row.id,f.options)).status,'completed');assert.equal(f.writes.length,1);
  const g=fixture();g.pull.draft=false;const ready=g.service.enqueue({...g.base,kind:'ready'});
  await assert.rejects(g.service.run(ready.id,{...g.options,validateReady:()=>false}),/Ready requires/);assert.equal(g.writes.length,0);
});

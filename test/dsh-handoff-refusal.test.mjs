import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeHandoffOwnership } from '../src/runtime/native-handoff.mjs';
import { executeDshTurn } from '../src/drivers/dsh.mjs';

const settled = id => ({ type: 'settled', job: { id, status: 'completed' }, output: { chunks: [{ text: `${id} evidence` }] } });
function ownerFixture() {
  const saved = [], sent = [], records = new Map();
  const owner = createNativeHandoffOwnership({ persist: event => saved.push(event), update: (id, event) => {
    assert.ok(records.has(id), 'Never send to an uncommitted lease');
    assert.ok(records.get(id).jobIds.includes(event.job?.id ?? event.jobId), 'Never give new jobs to the previous lease');
    sent.push({ id, event });
  } });
  const commit = record => { records.set(record.id, record); return true; };
  return { owner, saved, sent, commit };
}

test('a declined second handoff keeps the old owner and buffers settlement during the decision', async () => {
  const { owner, saved, sent, commit } = ownerFixture();
  const old = { id: 'old-lease', jobIds: ['bash-old'] }, next = { id: 'next-lease', jobIds: ['bash-old', 'bash-new'] };
  await owner.propose(old, {}, commit);
  let decide;
  const transfer = owner.propose(next, {}, () => new Promise(resolve => { decide = resolve; }));
  await owner.collect(settled('bash-old')); await owner.collect(settled('bash-new'));
  assert.equal(sent.length, 0); assert.equal(saved.length, 2);
  decide(false); assert.equal(await transfer, false); assert.equal(owner.current, old);
  assert.deepEqual(sent.map(item => [item.id, item.event.job.id]), [['old-lease', 'bash-old']]);
  assert.deepEqual(owner.jobIds(), ['bash-old', 'bash-new']);
  await owner.propose(next, {}, commit);
  assert.deepEqual(sent.slice(1).map(item => [item.id, item.event.job.id]), [['next-lease', 'bash-old'], ['next-lease', 'bash-new']]);
});

test('first refusal keeps evidence local and a later acceptance publishes it to the committed owner', async () => {
  const { owner, saved, sent, commit } = ownerFixture(), record = { id: 'first-lease', jobIds: ['bash-first'] };
  let decide, drained = false;
  const drain = owner.waitForEvidence(record.jobIds).then(() => { drained = true; });
  const transfer = owner.propose(record, {}, () => new Promise(resolve => { decide = resolve; }));
  assert.equal(drained, false);
  await owner.collect(settled('bash-first')); await drain;
  decide(false); assert.equal(await transfer, false); assert.equal(owner.current, undefined);
  assert.equal(saved.length, 1); assert.equal(sent.length, 0);
  await owner.propose(record, {}, commit); assert.equal(sent[0].id, record.id);
});

test('hold errors restore the previous owner and retain collector failures as evidence', async () => {
  const { owner, saved, sent, commit } = ownerFixture(), old = { id: 'old-lease', jobIds: ['bash-old'] };
  await owner.propose(old, {}, commit);
  const failure = new Error('host transfer failed');
  await assert.rejects(owner.propose({ id: 'rejected-lease', jobIds: ['bash-old'] }, {}, async () => {
    await owner.collect({ type: 'failed', jobId: 'bash-old', reason: 'output unavailable' });
    throw failure;
  }), error => error === failure);
  assert.equal(owner.current, old); assert.equal(saved.length, 1); assert.equal(sent[0].id, old.id);
  assert.equal(sent[0].event.type, 'failed'); await owner.waitForEvidence(old.jobIds);
});

test('accepted transfer settlement is sent only to its new committed owner', async () => {
  const { owner, sent, commit } = ownerFixture();
  await owner.propose({ id: 'old-lease', jobIds: ['bash-old'] }, {}, commit);
  await owner.propose({ id: 'new-lease', jobIds: ['bash-old'] }, {}, async record => {
    await owner.collect(settled('bash-old')); assert.equal(sent.length, 0); return commit(record);
  });
  assert.deepEqual(sent.map(item => item.id), ['new-lease']);
});

// A bounded fake SDK exercises the real driver and bridge without DSH, a model,
// or a background service. Job notification deliberately precedes HTTP evidence.
function sdkFixture(t, resume) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-dsh-refusal-'))), executable = join(root, 'sdk.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
if(process.argv.includes('--version')){console.log('0.2.2-alpha.2');process.exit(0);}
const connection=JSON.parse(process.env.JS_SUPERAGENT_DSH_BRIDGE);
let sid,seq=0,prompts=0,collections=0,delivery=Promise.resolve();
const send=value=>console.log(JSON.stringify(value));
const event=(type,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId:sid,event:{type,data,seq:++seq}}});
const post=async(path,body)=>{const response=await fetch(new URL(path,connection.url),{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({sessionId:sid,...body})});if(!response.ok)throw new Error('bridge refused');await response.json();};
const collector=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const value=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({installed:true,jobIds:value.jobIds}));
 if(++collections===${resume ? 2 : 1})setTimeout(()=>{
   event('job/settled',{jobId:'bash-owned'});
   setTimeout(()=>{delivery=post('/native/event',{event:{type:'settled',job:{id:'bash-owned',owner:sid,kind:'bash',status:'completed'},output:{chunks:[{text:'preserved output'}]}}});},60);
 },10);
});
await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line),answer=value=>send({jsonrpc:'2.0',id:r.id,result:value});
 if(r.method==='initialize')answer({serverInfo:{name:'deepseek-harness-sdk-runtime'}});
 else if(r.method==='session/working-directory/get'){
  sid=r.params.sessionId;
  if(!prompts)await post('/native/register',{url:'http://127.0.0.1:'+collector.address().port+'/collect'});
  answer({cwd:process.cwd()});
 }else if(r.method==='session/prompt'){
  prompts++;const id='input-'+prompts;answer({messageId:id});event('user/message',{id});
  if(prompts===1)event('job/registered',{jobId:'bash-owned'});
  const report={version:2,state:'waiting',summary:'Human wording required.',artifacts:[],attention:{question:'Which wording?'}};
  event('assistant/message',{turn:prompts,message:{content:[{type:'text',text:JSON.stringify(report)}]}});event('turn/end',{turn:prompts,reason:{kind:'completed'}});
 }else if(r.method==='session/wait')answer({});
 else if(r.method==='shutdown'){
  await delivery;answer({});collector.closeAllConnections();collector.close(()=>process.exit(0));
 }
}
`, { mode: 0o700 });
  const previous = process.env.JS_DSH_REFUSAL_KEY;
  process.env.JS_DSH_REFUSAL_KEY = 'local-fixture';
  t.after(() => { if (previous === undefined) delete process.env.JS_DSH_REFUSAL_KEY; else process.env.JS_DSH_REFUSAL_KEY = previous; rmSync(root, { recursive: true, force: true }); });
  const options = { executable, model: 'local-fixture', timeoutMs: 5000, killGraceMs: 30,
    backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'JS_DSH_REFUSAL_KEY' } };
  const pids = [], facts = [], updates = []; let session, held, calls = 0;
  const input = runId => ({ runId, projectRoot: root, prompt: 'Bounded native handoff fixture', ticket: { id: 'ticket' }, assignmentId: 'assignment',
    signal: new AbortController().signal, checkpoint: value => { session = value; }, checkpointNative: value => facts.push(value), registerProcess: pid => pids.push(pid),
    nativeHandoff: { ...(held ? { current: held } : {}), hold(record, control) { calls++; if (resume && calls === 1) { held = { record, control }; return true; } return false; },
      update(id, event) { assert.equal(id, held?.record.id, 'The host only knows the original lease'); updates.push(event); } } });
  return { root, options, input, pids, facts, updates, session: () => session, held: () => held };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('real driver drains refused collector evidence and preserves old lease ownership', async t => {
  for (const resume of [true, false]) await t.test(resume ? 'second handoff refused' : 'first handoff refused', async t => {
    const f = sdkFixture(t, resume);
    let result = await executeDshTurn(f.options, f.input('first'));
    if (resume) {
      t.after(() => f.held().control.close('fixture cleanup'));
      assert.ok(result.handoff);
      result = await f.held().control.resume({ ...f.input('reply'), session: f.session() });
      await f.held().control.closed;
      assert.equal(f.updates.length, 1); assert.equal(f.updates[0].job.id, 'bash-owned');
    } else assert.equal(f.updates.length, 0);
    assert.equal(JSON.parse(result.text).state, 'waiting'); assert.equal(result.handoff, undefined);
    const fact = f.facts.find(item => item.nativeJobResults);
    assert.ok(fact, 'Ordinary completion retains a checkpoint to the private result file');
    assert.match(readFileSync(fact.nativeJobResults.path, 'utf8'), /preserved output/);
    assert.ok(f.pids.every(pid => !alive(pid)));
  });
});

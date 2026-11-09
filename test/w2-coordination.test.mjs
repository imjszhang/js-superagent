import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { CoordinationInbox, validateWorkEventResult } from '../src/runtime/coordination.mjs';
import { CoordinatorRegistry, createCodexAssessor, createDshAssessor } from '../src/coordinator.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

const operator = { id: 'operator-1', kind: 'operator', actor: { source: 'local', kind: 'human', id: 'operator' }, text: 'What is the project status?' };
const context = { tickets: [{ id: 'ticket-1', scope: 'existing authorized work' }] };
const reply = { summary: 'Status checked', actions: [{ kind: 'reply', ticketId: null, text: 'The task is waiting for review.' }] };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-w2-'));
  const opened = [];
  const open = () => { const store = new Store(join(root, 'state.sqlite')); opened.push(store); return store; };
  t.after(() => { for (const store of opened) { try { store.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });
  return { root, open };
}
function host(store, changes = {}) {
  return { currentPolicyVersion: () => 'policy-1', currentContextVersion: () => 'context-1', validateAction: () => true,
    applyAction(action) { store.setMeta(action.id, action); return { queued: action.id }; }, ...changes };
}
const completion = (event, result = reply) => ({ expectedVersion: event.version, policyVersion: 'policy-1', contextVersion: 'context-1', result, context });

test('W2 context-only events never wake a model; operator IDs deduplicate across reopen', t => {
  const f = fixture(t); let store = f.open(), inbox = new CoordinationInbox(store);
  for (const kind of ['progress', 'question', 'result', 'ended', 'subscription']) inbox.enqueue({ id: kind, kind, text: 'Stored fact' });
  assert.equal(inbox.pending().length, 0);
  const event = inbox.enqueue(operator); assert.equal(event.status, 'pending');
  assert.deepEqual(inbox.enqueue(operator), event);
  assert.throws(() => inbox.enqueue({ ...operator, text: 'Different work' }), /identity conflict/);
  store.close(); store = f.open(); inbox = new CoordinationInbox(store);
  assert.equal(inbox.pending().length, 1);
  const first = inbox.complete(event.id, completion(event), host(store));
  assert.equal(first.receipts.length, 1);
  assert.deepEqual(inbox.complete(event.id, completion(event), host(store, { applyAction() { throw new Error('must not repeat'); } })), first);
  assert.equal(inbox.pending().length, 0);
  assert.equal(inbox.list().filter(row => row.status === 'recorded').length, 5);
});

test('W2 stale authority and failed action roll back effects together with receipts', t => {
  const f = fixture(t), store = f.open(), inbox = new CoordinationInbox(store), event = inbox.enqueue(operator);
  assert.throws(() => inbox.complete(event.id, completion(event), host(store, { currentPolicyVersion: () => 'changed' })), /policy changed/);
  assert.throws(() => inbox.complete(event.id, completion(event), host(store, { currentContextVersion: () => 'changed' })), /context or policy/);
  const result = { summary: 'Read progress', actions: [{ kind: 'note', ticketId: 'ticket-1', text: 'Review is pending.' }, { kind: 'requestStatus', ticketId: 'ticket-1', text: null }] };
  assert.throws(() => inbox.complete(event.id, completion(event, result), host(store, {
    applyAction(action) { store.setMeta(action.id, action); if (action.kind === 'requestStatus') throw new Error('outbox failed'); },
  })), /outbox failed/);
  assert.equal(store.getMeta(`coordination:${event.id}:0`), undefined);
  assert.equal(inbox.get(event.id).status, 'pending');
  assert.deepEqual(inbox.get(event.id).receipts, []);
});

test('W2 worker reports cannot spawn work, answer for a person or cancel tickets', () => {
  const event = { id: 'report-1', kind: 'report', text: 'Needs attention' };
  for (const kind of ['reply', 'request', 'stop']) assert.throws(() => validateWorkEventResult({ summary: 'No', actions: [{ kind, ticketId: kind === 'stop' ? 'ticket-1' : null, text: event.text }] }, { event, context }), /authenticated operator/);
  assert.throws(() => validateWorkEventResult({ summary: 'No', actions: [{ kind: 'note', ticketId: 'outside', text: 'Fact' }] }, { event, context }), /outside/);
  assert.throws(() => validateWorkEventResult({ summary: 'No', actions: [{ kind: 'request', ticketId: null, text: 'Invent more work' }] }, { event: operator, context }), /original operator/);
  assert.equal(validateWorkEventResult({ summary: 'Recorded only', actions: [] }, { event, context }).actions.length, 0);
});

test('W2 opt-in workflow mode preserves candidate-only settings and records unavailable capabilities', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const registry = new CoordinatorRegistry(store, { validateAssessor: input => input });
  const first = registry.update({ assessor: { driver: 'fixture' } }, { expectedRevision: 0 });
  assert.equal(first.workflowMode, 'candidates');
  const second = registry.update({ workflowMode: 'candidates' }, { expectedRevision: 1 });
  assert.equal(first.version, second.version);
  const continuous = registry.update({ workflowMode: 'continuous' }, { expectedRevision: 2 });
  assert.notEqual(first.version, continuous.version);
  assert.throws(() => registry.update({ assessor: null }, { expectedRevision: 3 }), /requires a configured assessor/);
  const inbox = new CoordinationInbox(store), event = inbox.enqueue(operator);
  assert.equal(inbox.fail(event.id, 'Adapter lacks handleEvent', { unsupported: true }).status, 'unsupported');
  assert.equal(inbox.pending().length, 0);
});

test('W2 Codex work events reuse the coordinator app-server session and constrained JSON role', async t => {
  const f = fixture(t), executable = join(f.root, 'codex.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
${fakeCodexIsolationPrelude({ appServer: true })}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = x => console.log(JSON.stringify(x)); let threadId;
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);appendFileSync('calls.jsonl',JSON.stringify(r)+'\\n');
 if(r.method==='initialize')send({id:r.id,result:{}});
 else if(r.method==='config/read')send({id:r.id,result:__isolationConfig()});
 else if(r.method==='thread/start'||r.method==='thread/resume') { if(r.params.sandbox!=='read-only'||r.params.dynamicTools?.length) process.exit(9); threadId=r.params.threadId??'11111111-1111-4111-8111-111111111111';send({id:r.id,result:{thread:{id:threadId}}}); }
 else if(r.method==='turn/start') { if(!r.params.outputSchema.properties.actions)process.exit(8); send({id:r.id,result:{turn:{id:'turn'}}});send({method:'item/completed',params:{threadId,item:{type:'agentMessage',text:JSON.stringify(${JSON.stringify(reply)})}}});send({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}}); }
}
`, { mode: 0o700 });
  const assessor = createCodexAssessor({ executable, killGraceMs: 10 }); let session;
  const input = { projectRoot: f.root, event: operator, context, checkpoint: value => { session = value; }, registerProcess() {} };
  assert.deepEqual(await assessor.handleEvent({ ...input, runId: 'event-first' }), reply);
  const original = session;
  assert.deepEqual(await assessor.handleEvent({ ...input, runId: 'event-second', session }), reply);
  assert.deepEqual(session, original);
  const calls = readFileSync(join(stateDir(f.root), 'assessment-context/calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(calls.find(call => call.method === 'thread/resume').params.threadId, session.id);
});

test('W2 DSH work-event method uses the SDK coordinator namespace', async t => {
  const f = fixture(t), executable = join(f.root, 'dsh.mjs');
  const previous = process.env.JS_W2_TEST_KEY; process.env.JS_W2_TEST_KEY = 'fixture-only';
  t.after(() => { if (previous === undefined) delete process.env.JS_W2_TEST_KEY; else process.env.JS_W2_TEST_KEY = previous; });
  writeFileSync(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('0.2.1-rc.5');process.exit(0);}
const send=x=>console.log(JSON.stringify(x));let sid,seq=0;
const event=(type,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId:sid,event:{type,data,seq:++seq}}});
for await(const line of createInterface({input:process.stdin})) {const r=JSON.parse(line),answer=x=>send({jsonrpc:'2.0',id:r.id,result:x});
 if(r.method==='initialize')answer({serverInfo:{name:'deepseek-harness-sdk-runtime'}});
 else if(r.method==='session/working-directory/get'){sid=r.params.sessionId;answer({cwd:process.cwd()});}
 else if(r.method==='session/prompt'){answer({messageId:'msg'});event('user/message',{id:'msg'});event('assistant/message',{message:{content:[{type:'text',text:JSON.stringify(${JSON.stringify(reply)})}]}});event('turn/end',{reason:{kind:'completed'}});}
 else if(r.method==='session/wait'||r.method==='session/resume')answer({});
 else if(r.method==='shutdown'){answer({});process.exit(0);}
}
`, { mode: 0o700 });
  const assessor = createDshAssessor({ executable, model: 'fixture', killGraceMs: 10, timeoutMs: 5000,
    backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://example.com/anthropic', apiKeyEnv: 'JS_W2_TEST_KEY' } });
  let session;
  const input = { projectRoot: f.root, event: operator, context, checkpoint: value => { session = value; }, registerProcess() {} };
  assert.deepEqual(await assessor.handleEvent({ ...input, runId: 'dsh-event-first' }), reply);
  assert.equal(session.driver, 'dsh-sdk-assessor');
  assert.deepEqual(await assessor.handleEvent({ ...input, session, runId: 'dsh-event-second' }), reply);
});

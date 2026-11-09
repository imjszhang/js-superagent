import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server.mjs';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';
import { inspectCodexHistory, CODEX_HISTORY_VERSION } from '../src/drivers/codex-history.mjs';
import { dshDigest } from '../src/drivers/dsh-history.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

const questionId = 'github:owner/repo:issue-comment:42';
const summary = 'The retry limit is three; the original task remains waiting.';
const baseReport = { state: 'waiting', summary, artifacts: [], answers: questionId };
const fixtureEnvOwners = new WeakSet();
function fixture(t, kind, { report = {}, staged } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-worker-answer-adapter-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, `fake-${kind}.mjs`);
  const nativeReport = kind === 'codex' ? { ...baseReport, question: null, acknowledgedInputIds: [], ...report }
    : { version: 2, ...baseReport, attention: null, ...report };
  writeFileSync(executable, `#!/usr/bin/env node
${kind === 'codex' ? fakeCodexIsolationPrelude({ appServer: true }) : "if(process.argv.includes('--version')){console.log('0.2.2-alpha.2');process.exit(0);}"}
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const send=v=>console.log(JSON.stringify(v)), text=${JSON.stringify(JSON.stringify(nativeReport))};
let sid='019a3ade-2bd7-7001-a1a4-cdc82e4bf6ea',seq=0;
const event=(type,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId:sid,event:{type,data,seq:++seq}}});
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line),answer=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='config/read'){answer(__isolationConfig());continue;}
 appendFileSync(process.cwd()+'/calls.jsonl',line+'\\n');
 if(r.method==='initialize')answer({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});
 else if(r.method==='thread/start')answer({thread:{id:sid}});
 else if(r.method==='turn/start'){
  answer({turn:{id:'turn-1',status:'inProgress'}});
  send({method:'turn/started',params:{threadId:sid,turn:{id:'turn-1',status:'inProgress'}}});
  send({method:'item/completed',params:{threadId:sid,turnId:'turn-1',item:{type:'agentMessage',phase:'final_answer',text}}});
  send({method:'turn/completed',params:{threadId:sid,turn:{id:'turn-1',status:'completed',items:[]}}});
 }else if(r.method==='session/working-directory/get'){sid=r.params.sessionId;answer({cwd:process.cwd()});}
 else if(r.method==='session/prompt'){
  writeFileSync(process.cwd()+'/prompt.txt',r.params.contentBlocks[0].text);
  answer({messageId:'input-1'});event('user/message',{id:'input-1'});
  event('assistant/message',{turn:1,message:{content:[{type:'text',text}]}});event('turn/end',{turn:1,reason:{kind:'completed'}});
 }else if(r.method==='session/wait')answer({});
 else if(r.method==='shutdown'){answer({});process.exit(0);}
}
`, { mode: 0o700 });
  const options = { executable, timeoutMs: 5000, killGraceMs: 30, ...(staged ? { enableAgentTools: true } : {}) };
  if (kind === 'dsh') {
    if (!fixtureEnvOwners.has(t)) {
      fixtureEnvOwners.add(t);
      const previous = process.env.JS_WORKER_ANSWER_ADAPTER_KEY;
      t.after(() => { if (previous === undefined) delete process.env.JS_WORKER_ANSWER_ADAPTER_KEY; else process.env.JS_WORKER_ANSWER_ADAPTER_KEY = previous; });
    }
    process.env.JS_WORKER_ANSWER_ADAPTER_KEY = 'local-fixture-only';
    Object.assign(options, { model: 'fixture', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'JS_WORKER_ANSWER_ADAPTER_KEY' } });
  }
  const input = { projectRoot: root, runId: randomUUID(), assignmentId: randomUUID(), signal: new AbortController().signal,
    ticket: { id: 'ticket-1', scope: 'Explain repository behavior', text: 'Continue the original task', messages: [], reports: [] }, checkpoint() {}, registerProcess() {},
    ...(staged ? { agentTools: { version: 1, definitions: [], call() {}, contextResources: () => [], terminalReport: () => staged } } : {}) };
  return { root, input, options, driver: kind === 'codex' ? createCodexAppServerDriver(options) : createDshSdkDriver(options) };
}

for (const kind of ['codex', 'dsh']) {
  test(`${kind} preserves an original-question answer without completing a waiting Worker`, async t => {
    const f = fixture(t, kind), result = await f.driver.run(f.input);
    assert.equal(result.answers, questionId); assert.equal(result.summary, summary); assert.equal(result.state, 'waiting');
    const prompt = kind === 'dsh' ? readFileSync(join(f.root, 'prompt.txt'), 'utf8')
      : JSON.parse(readFileSync(join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').find(line => JSON.parse(line).method === 'turn/start')).params.input[0].text;
    assert.match(prompt, /original triggerId/); assert.match(prompt, /never choose a recipient/);
    if (kind === 'codex') {
      const call = readFileSync(join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(item => item.method === 'turn/start');
      assert.deepEqual(call.params.outputSchema.properties.answers.type, ['string', 'null']);
      assert.ok(call.params.outputSchema.required.includes('answers'));
    }
  });
  test(`${kind} accepts legacy reports and null answer declarations without adding an answer`, async t => {
    for (const answers of [undefined, null]) {
      const f = fixture(t, kind, { report: { answers } });
      assert.equal(Object.hasOwn(await f.driver.run(f.input), 'answers'), false);
    }
  });
  test(`${kind} compares final answer identity against the durable business report`, async t => {
    const staged = { ...baseReport, question: null, summary: 'Authoritative answer from the business report.' };
    const accepted = fixture(t, kind, { staged });
    assert.equal((await accepted.driver.run(accepted.input)).summary, staged.summary);
    const mismatch = fixture(t, kind, { staged: { ...staged, answers: 'another-question' } });
    await assert.rejects(mismatch.driver.run(mismatch.input), /disagrees/);
    const missing = fixture(t, kind, { staged, report: { answers: null } });
    await assert.rejects(missing.driver.run(missing.input), /disagrees/);
  });
  test(`${kind} rejects malformed answers and simultaneous answer/question`, async t => {
    for (const patch of [{ answers: '' }, { answers: 123 }, kind === 'codex' ? { question: 'Choose a direction?' } : { attention: { question: 'Choose a direction?' } }]) {
      const f = fixture(t, kind, { report: patch });
      await assert.rejects(f.driver.run(f.input), /answer|question|attention/i);
    }
  });
}

test('completed Codex native history preserves an answer identity and rejects malformed proof', () => {
  const record = { runId: 'run-1', turnId: 'turn-1', cwd: '/tmp/project', session: { driver: 'codex-app-server', id: 'session-1' } };
  const history = { id: 'session-1', cwd: record.cwd, cliVersion: CODEX_HISTORY_VERSION, status: { type: 'notLoaded' },
    turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', clientId: 'run-run-1' },
      { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ ...baseReport, question: null, acknowledgedInputIds: [] }) }] }] };
  const proof = inspectCodexHistory(history, record);
  assert.equal(proof.outcome, 'completed'); assert.equal(proof.report.answers, questionId); assert.equal(proof.report.state, 'waiting');
  history.turns[0].items.at(-1).text = JSON.stringify({ ...baseReport, question: null, answers: 123, acknowledgedInputIds: [] });
  assert.equal(inspectCodexHistory(history, record), null);
});

test('completed DSH native history retains answered trigger and normalizes null for old reports', async t => {
  const f = fixture(t, 'dsh'), session = { driver: 'dsh-sdk', id: 'js-fixed' };
  const home = join(stateDir(f.root), 'harness/dsh', session.id), folder = join(home, 'sessions/project', session.id);
  mkdirSync(folder, { recursive: true });
  const save = (name, value) => writeFileSync(join(home, name), JSON.stringify(value) + '\n');
  save('binding.json', { version: 1, adapter: 'dsh-sdk', nativeVersion: '0.2.2-alpha.2', cwd: f.root, model: f.options.model,
    backend: f.options.backend, permission: 'workspace-write', role: 'worker', promptDigest: dshDigest('') });
  save('run-origin.json', { version: 1, nativeVersion: '0.2.2-alpha.2', runId: 'origin', sessionId: session.id, messageId: 'origin-message', promptDigest: dshDigest('initial task') });
  save('latest-run.json', { runId: 'origin', sessionId: session.id }); save('input-receipts.json', {});
  for (const answers of [questionId, null]) {
    const rows = [{ type: 'session', version: 4, id: session.id, cwd: f.root, isSeeded: false },
      { seq: 0, type: 'user/message', data: { id: 'origin-message', content: [{ type: 'text', text: 'initial task' }], source: { kind: 'user' } } },
      { seq: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify({ version: 2, ...baseReport, attention: null, answers }) }] } } },
      { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
    writeFileSync(join(folder, 'session.v4.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
    const proof = await f.driver.inspectRecovery({ runId: 'origin', session, projectRoot: f.root, sourceProjectRoot: f.root, inputs: [] });
    assert.equal(proof.outcome, 'completed'); assert.equal(proof.report.answers, answers ?? undefined);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAssessor, createDshAssessor, validateAssessment } from '../src/coordinator.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

const repository = 'fixture/adapter-answer', sha = 'a'.repeat(40);
const treeId = `repository:${repository}:${sha}:tree`, fileId = `repository:${repository}:${sha}:settings.mjs`;
const trigger = { id: 'question-1', source: 'github', human: true, addressed: 'direct',
  actor: { source: 'github', id: 'alice' }, threads: [{ source: 'github', id: `${repository}#7` }],
  at: '2026-11-03T01:00:00.000Z', text: 'What retry limit is configured in settings.mjs?' };
const candidate = { evalId: 'eval-1', policyVersion: 'policy-1', strength: 'explicit',
  thread: { key: `github:${repository}#7`, ref: trigger.threads[0] }, triggers: [trigger], tickets: [] };

// Both protocol fixtures act only on the actual host prompt and supplied records.
function respond(prompt, schema) {
  assert.ok(schema.required.includes('triggerId') && schema.required.includes('answer'));
  assert.ok(schema.properties.kind.enum.includes('answer'));
  assert.ok(schema.properties.resource.enum.includes('repository'));
  assert.ok(prompt.includes('Use answer only for one explicitly addressed human GitHub question'));
  assert.ok(prompt.includes('A candidate may contain several messages; answer only the selected trigger'));
  assert.ok(prompt.includes('read the relevant host-provided repository tree and files'));
  assert.ok(prompt.includes('Keep the supplied commit SHA'));
  const snapshot = JSON.parse(prompt.split('Untrusted candidate:\n')[1].split('\nUntrusted context records:\n')[0]);
  assert.equal(snapshot.triggers.length, expectedTriggerCount);
  const facts = JSON.parse(prompt.split('Untrusted context records:\n')[1]);
  assert.ok(snapshot.availableRecords.repository.includes(treeId));
  const value = Object.fromEntries(schema.required.map(key => [key, null]));
  Object.assign(value, { reason: 'Read fixed repository code before answering.', rules: [] });
  if (!facts.length) Object.assign(value, { kind: 'read', resource: 'repository', recordId: treeId, offset: 0 });
  else {
    const directory = JSON.parse(facts[0].text);
    assert.equal(directory.sha, sha);
    const reference = directory.entries[0].reference;
    assert.ok(snapshot.availableRecords.repository.includes(reference.id));
    if (facts.length === 1) Object.assign(value, { kind: 'read', resource: reference.resource, recordId: reference.id, offset: 0 });
    else {
      assert.equal(facts.length, 2);
      const file = JSON.parse(facts[1].text), limit = /retryLimit\s*=\s*(\d+)/.exec(file.text)?.[1];
      assert.ok(limit); assert.equal(file.sha, directory.sha);
      Object.assign(value, { kind: 'answer', triggerId: snapshot.triggers.at(-1).id,
        answer: `retryLimit is ${limit} in ${file.path} at ${file.sha}.` });
    }
  }
  appendFileSync(logPath, JSON.stringify({ kind: value.kind, facts: facts.length }) + '\n');
  return value;
}

function fixture(t, driver, batch = false) {
  const root = mkdtempSync(join(tmpdir(), `coordinator-answer-${driver}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, `${driver}.mjs`), logPath = join(root, 'turns.jsonl');
  const common = `import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const treeId=${JSON.stringify(treeId)},sha=${JSON.stringify(sha)},logPath=${JSON.stringify(logPath)},expectedTriggerCount=${batch ? 2 : 1};
${respond.toString()}
const send=x=>console.log(JSON.stringify(x));
`;
  if (driver === 'codex') writeFileSync(executable, `#!/usr/bin/env node
${fakeCodexIsolationPrelude({ appServer: true })}
${common}
let threadId;
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.method==='initialize')send({id:r.id,result:{}});
 else if(r.method==='config/read')send({id:r.id,result:__isolationConfig()});
 else if(r.method==='thread/start'||r.method==='thread/resume') {
  assert.equal(r.params.sandbox,'read-only');assert.ok(!r.params.dynamicTools?.length);
  threadId=r.params.threadId??'11111111-1111-4111-8111-111111111111';send({id:r.id,result:{thread:{id:threadId}}});
 } else if(r.method==='turn/start') {
  const result=respond(r.params.input[0].text,r.params.outputSchema);
  send({id:r.id,result:{turn:{id:'turn'}}});
  send({method:'item/completed',params:{threadId,item:{type:'agentMessage',text:JSON.stringify(result)}}});
  send({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}});
 }
}
`, { mode: 0o700 });
  else writeFileSync(executable, `#!/usr/bin/env node
${common}
if(process.argv.includes('--version')){console.log('0.2.1-rc.5');process.exit(0);}
let sid,seq=0;
const event=(type,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId:sid,event:{type,data,seq:++seq}}});
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line),answer=x=>send({jsonrpc:'2.0',id:r.id,result:x});
 if(r.method==='initialize')answer({serverInfo:{name:'deepseek-harness-sdk-runtime'}});
 else if(r.method==='session/working-directory/get'){sid=r.params.sessionId;answer({cwd:process.cwd()});}
 else if(r.method==='session/prompt') {
  const prompt=r.params.contentBlocks.map(block=>block.text).join('\\n');
  const schema=JSON.parse(prompt.split('using null for irrelevant fields and [] for absent rules:\\n')[1].split('\\n')[0]);
  const result=respond(prompt,schema);
  answer({messageId:'msg'});event('user/message',{id:'msg'});
  event('assistant/message',{message:{content:[{type:'text',text:JSON.stringify(result)}]}});
  event('turn/end',{reason:{kind:'completed'}});
 } else if(r.method==='session/wait'||r.method==='session/resume')answer({});
 else if(r.method==='shutdown'){answer({});process.exit(0);}
}
`, { mode: 0o700 });
  const reads = [];
  const records = new Map([
    [treeId, { repository, sha, path: '', entries: [{ name: 'settings.mjs', reference: { resource: 'repository', id: fileId } }] }],
    [fileId, { repository, sha, path: 'settings.mjs', text: 'export const retryLimit = 17;\n' }],
  ]);
  const inputCandidate = batch ? { ...candidate, triggers: [{ ...trigger, text: 'What implementation work remains?' }, { ...trigger, id: 'question-2' }] } : candidate;
  return { root, executable, logPath, reads, input: { projectRoot: root, candidate: inputCandidate, runId: `${driver}-answer`,
    contextReferences: [{ resource: 'repository', id: treeId }], registerProcess() {}, checkpoint() {},
    readContextRecord(resource, id, options) {
      assert.equal(resource, 'repository'); assert.equal(options.offset, 0); assert.ok(records.has(id)); reads.push(id);
      return { resource, id, offset: 0, version: sha, text: JSON.stringify(records.get(id)),
        references: id === treeId ? [{ resource: 'repository', id: fileId }] : [] };
    } } };
}

for (const driver of ['codex', 'dsh']) for (const batch of [false, true]) test(`${driver} assessor reads fixed repository records and validates ${batch ? 'the second selected question in a batch' : 'an answer'} through its offline protocol`, { timeout: 15000 }, async t => {
  const f = fixture(t, driver, batch);
  let assessor;
  if (driver === 'codex') assessor = createCodexAssessor({ executable: f.executable, killGraceMs: 10, timeoutMs: 10000 });
  else {
    const key = 'JS_COORDINATOR_ANSWER_ADAPTER_TEST_KEY', previous = process.env[key]; process.env[key] = 'fixture-only';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    assessor = createDshAssessor({ executable: f.executable, model: 'fixture', killGraceMs: 10, timeoutMs: 10000,
      backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages',
        baseURL: 'https://example.invalid/anthropic', apiKeyEnv: key } });
  }
  const outcome = await assessor.assess(f.input);
  assert.deepEqual(outcome, { kind: 'answer', reason: 'Read fixed repository code before answering.',
    triggerId: batch ? 'question-2' : trigger.id, answer: `retryLimit is 17 in settings.mjs at ${sha}.`, rules: [] });
  assert.deepEqual(validateAssessment(outcome, f.input.candidate), outcome);
  assert.deepEqual(f.reads, [treeId, fileId]);
  assert.deepEqual(readFileSync(f.logPath, 'utf8').trim().split('\n').map(JSON.parse), [
    { kind: 'read', facts: 0 }, { kind: 'read', facts: 1 }, { kind: 'answer', facts: 2 },
  ]);
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../dist/core/index.js';
import { createRuntimePolicy, PolicyRegistry, policyImpact, validatePolicyConfig, createCodexAssessor, validateAssessment, applyAssessment, boundedCandidate, readContext, readContextRecord } from '../src/coordinator.mjs';

const request = (id = 'one', text = 'Add a unit test for parser empty input') => ({ id, source: 'github', threads: [{ source: 'github', id: 'owner/repo#1' }],
  actor: { source: 'github', id: 'alice' }, human: true, addressed: 'direct', at: new Date().toISOString(), text, meta: { repository: 'owner/repo' } });
const config = mode => ({ mode, rules: [{ id: 'tests', enabled: true, instruction: 'Add regression tests for reported parser defects' }], sourceRows: [
  { id: 'repo', source: 'github', scope: { repository: 'owner/repo' }, actors: ['alice'], bots: ['ci-bot'], admission: { listedUnaddressed: true } },
] });
function fixture(t, mode = 'auto') {
  const store = new Store(':memory:'); t.after(() => store.close());
  let policy = createRuntimePolicy({ config: config(mode) });
  const candidates = [];
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: input => policy.scope(input) },
    now: () => new Date().toISOString(), assessor: { request: candidate => candidates.push(candidate) },
    executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status() {}, withdraw() {} } });
  return { store, engine, candidates, policy: () => policy, setPolicy: next => { const previous = policy; policy = next; engine.policyChanged(previous.version, next.version, policyImpact(store.tickets.list(), previous, next)); } };
}

test('policy observes only explicitly scoped and authorized admission cells', () => {
  for (const mode of ['off', 'observe', 'auto']) {
    const policy = createRuntimePolicy({ config: config(mode) });
    const trigger = request();
    assert.equal(policy.gate(trigger).strength, 'explicit');
    delete trigger.addressed;
    assert.equal(policy.gate(trigger).admissible, mode !== 'off');
    assert.equal(policy.admitsInferred(['tests']), mode === 'auto');
    assert.equal(policy.admitsInferred(['missing']), false);
    assert.equal(policy.admitsInferred([]), false);
    trigger.actor.id = 'mallory'; assert.equal(policy.gate(trigger).admissible, false);
    trigger.human = false; trigger.actor.id = 'ci-bot'; assert.equal(policy.gate(trigger).admissible, mode !== 'off');
    trigger.meta.repository = 'other/repo'; assert.equal(policy.gate(trigger).admissible, false);
  }
});
test('explicit compatibility gate stays active with proactive mode off; actor-source spoofing fails', () => {
  const policy = createRuntimePolicy({ explicitGate: trigger => trigger.source === 'local' ? { admissible: true, strength: 'explicit', basis: { via: 'listed', sender: 'operator' } } : { admissible: false, reason: 'denied' }, config: config('off') });
  assert.equal(policy.gate({ source: 'local', actor: { source: 'local', id: 'operator' } }).admissible, true);
  assert.equal(policy.gate({ source: 'local', actor: { source: 'github', id: 'operator' } }).admissible, false);
  const trigger = request(); trigger.actor.source = 'local'; assert.equal(policy.gate(trigger).admissible, false);
});
test('ambiguous source rows and malformed configuration fail closed', () => {
  const value = config('auto'); value.sourceRows.push({ ...value.sourceRows[0], id: 'duplicate' });
  assert.equal(createRuntimePolicy({ config: value }).gate(request()).admissible, false);
  assert.throws(() => validatePolicyConfig({ ...config('auto'), mode: 'yes' }), /mode/);
  assert.throws(() => validatePolicyConfig({ ...config('auto'), rules: [{ id: 'x', enabled: 'yes', instruction: 'x' }] }), /boolean/);
});
test('registry uses optimistic revision and rolls back failed policy application', t => {
  const { store } = fixture(t), registry = new PolicyRegistry(store);
  const first = registry.update(config('observe'), { expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.throws(() => registry.update(config('auto'), { expectedRevision: 0 }), /conflict/);
  assert.throws(() => registry.update(config('auto'), { expectedRevision: 1, onChange() { throw new Error('engine rejected'); } }), /engine rejected/);
  assert.equal(registry.current().revision, 1); assert.equal(registry.history().length, 1);
});
test('real core records observe would-accept without starting a ticket', t => {
  const f = fixture(t, 'observe'), trigger = request(); delete trigger.addressed;
  f.engine.receive(trigger); f.engine.evaluateDue();
  const candidate = f.candidates.at(-1);
  assert.equal(candidate.strength, 'inferred');
  const result = applyAssessment({ ...f, candidate, policy: f.policy(), outcome: { kind: 'accept', title: 'Parser regression', scope: 'Add parser regression test', reason: 'Matches tests rule', rules: ['tests'] } });
  assert.equal(result.kind, 'ignore'); assert.equal(f.store.tickets.list().length, 0);
  assert.equal(result.decision.audit.wouldAccept.kind, 'accept');
});
test('acceptance uses the actual core, stale results do not create duplicate work', t => {
  const f = fixture(t); f.engine.receive(request()); f.engine.evaluateDue();
  const candidate = f.candidates.at(-1), outcome = { kind: 'accept', title: 'Parser test', scope: 'Add one parser test', reason: 'Explicit request', rules: [] };
  let created;
  const first = applyAssessment({ ...f, candidate, outcome, policy: f.policy(), onAccepted: ticket => { created = ticket; } });
  assert.equal(first.applied, true); assert.ok(created.id);
  assert.equal(applyAssessment({ ...f, candidate, outcome, policy: f.policy() }).applied, false);
  assert.equal(f.store.tickets.list().length, 1);
});
test('policy update invalidates a pending model result and reports revoked ticket rules', t => {
  const f = fixture(t); f.engine.receive(request()); f.engine.evaluateDue(); const candidate = f.candidates.at(-1);
  const changed = config('auto'); changed.sourceRows[0].actors = [];
  f.setPolicy(createRuntimePolicy({ config: changed }));
  assert.equal(applyAssessment({ ...f, candidate, policy: f.policy(), outcome: { kind: 'ignore', reason: 'old answer', rules: [] } }).applied, false);
  const before = createRuntimePolicy({ config: config('auto') }), next = createRuntimePolicy({ config: config('off') });
  const effect = policyImpact([{ id: 't', mandate: { actor: { source: 'github', id: 'alice' }, strength: 'inferred', basis: { row: 'repo', scope: { repository: 'owner/repo' }, via: 'admission', cell: 'listedUnaddressed', rules: ['tests'] } } }], before, next).get('t');
  assert.equal(effect.proactive, false); assert.equal(effect.requesterAllowed, false);
});
test('proposal cannot route to unknown work or turn a bot candidate into cancellation', () => {
  const candidate = { tickets: [{ id: 'allowed' }], strength: 'explicit' };
  assert.throws(() => validateAssessment({ kind: 'stop', ticketId: 'other', reason: 'x', rules: [] }, candidate), /outside/);
  assert.throws(() => validateAssessment({ kind: 'attach', ticketId: 'allowed', reason: 'x', rules: [] }, { ...candidate, strength: 'inferred' }), /Inferred/);
  assert.throws(() => validateAssessment({ kind: 'accept', title: 'x', scope: 'x', reason: 'x', rules: [], policy: 'auto' }, candidate), /Unsupported/);
});
test('bounded context names omissions and read resources enforce pagination and record versions', t => {
  const f = fixture(t); f.engine.receive(request()); f.engine.receive(request('two', 'x'.repeat(9000))); f.engine.evaluateDue();
  const candidate = f.candidates.at(-1), bounded = boundedCandidate(candidate, { maxTriggers: 1, textLimit: 100 });
  assert.ok(JSON.stringify(bounded).length < 3000);
  assert.equal(bounded.coverage.omittedTriggers, candidate.triggers.length - 1);
  const first = readContext(f.store, 'triggers', { limit: 1 });
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  assert.throws(() => readContext(f.store, 'tickets', { cursor: first.nextCursor }), /match/);
  const next = readContext(f.store, 'triggers', { cursor: first.nextCursor, limit: 1 });
  assert.notEqual(next.items[0].id, first.items[0].id); assert.equal(next.nextCursor, null);
  const original = readContextRecord(f.store, 'triggers', 'one', { limit: 100 });
  assert.ok(original.nextOffset);
  f.store.triggers.save({ ...request(), text: 'new content' });
  assert.throws(() => readContextRecord(f.store, 'triggers', 'one', { version: original.version }), /changed/);
});
test('Codex assessor supervises a read-only structured run and strips delivery credentials', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-assessor-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'mock-codex');
  writeFileSync(executable, `#!/usr/bin/env node
${fakeCodexIsolationPrelude({appServer:true})}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => console.log(JSON.stringify(value)), threadId = '00000000-0000-0000-0000-000000000001';
if (['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'].some(key => process.env[key])) process.exit(5);
if (!process.argv.includes('shell_tool') || !process.argv.includes('sandbox_mode="read-only"')) process.exit(4);
createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if(r.method==='initialized') return;
  if(r.method==='initialize') return send({id:r.id,result:{}});
  if(r.method==='config/read') return send({id:r.id,result:__isolationConfig()});
  appendFileSync(process.cwd()+'/calls.jsonl',line+'\\n');
  if(['thread/start','thread/resume'].includes(r.method)) {
    if(r.params.sandbox!=='read-only' || r.params.approvalPolicy!=='never' || r.params.dynamicTools?.length) process.exit(6);
    return send({id:r.id,result:{thread:{id:threadId}}});
  }
  if(r.method==='turn/start') {
    if(!r.params.outputSchema.properties.kind) process.exit(7);
    send({id:r.id,result:{turn:{id:'t'}}});
    send({method:'item/completed',params:{threadId,item:{type:'agentMessage',text:JSON.stringify({kind:'accept',reason:'Explicit parser task',title:'Parser test',scope:'Add parser regression test',ticketId:null,note:null,rules:[]})}}});
    send({method:'turn/completed',params:{threadId,turn:{id:'t',status:'completed'}}});
  }
});
`, { mode: 0o700 });
  const f = fixture(t); f.engine.receive(request()); f.engine.evaluateDue();
  const keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'not-forwarded';
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const owners = [], sessions = [];
  const outcome = await createCodexAssessor({ executable, killGraceMs: 10 }).assess({ candidate: f.candidates.at(-1), projectRoot: root, runId: 'test', checkpoint: session => sessions.push(session), registerProcess: pid => owners.push(pid) });
  assert.equal(outcome.kind, 'accept'); assert.equal(owners.length, 2); assert.equal(sessions[0].driver, 'codex-app-server-assessor');
  await createCodexAssessor({ executable, killGraceMs: 10 }).assess({ candidate: f.candidates.at(-1), projectRoot: root, runId: 'resumed', session:sessions[0], checkpoint: session => sessions.push(session), registerProcess: pid => owners.push(pid) });
  const calls=readFileSync(join(stateDir(root), 'assessment-context/calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
  assert.equal(calls.find(call=>call.method==='thread/resume').params.threadId,sessions[0].id);
  assert.deepEqual(sessions[0],sessions[1]);
  writeFileSync(executable,readFileSync(executable,'utf8')
    .replace("threadId = '00000000-0000-0000-0000-000000000001'","threadId = '00000000-0000-0000-0000-000000000002'")
    .replace("send({id:r.id,result:{turn:{id:'t'}}});","send({id:r.id,result:{turn:{id:'t'}}});send({method:'item/started',params:{threadId,item:{type:'commandExecution'}}});"));
  await assert.rejects(createCodexAssessor({ executable, killGraceMs: 10 }).assess({candidate:f.candidates.at(-1),projectRoot:root,runId:'reject-tool',checkpoint:()=>{},registerProcess:()=>{}}),/outside its classification role/);
});

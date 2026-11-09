import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs();
// Real, read-only Codex classification. No GitHub/Feishu messages or project edits.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const { Store } = await importFrozenModule(artifact, 'src/store.mjs');
const { Engine } = await importFrozenModule(artifact, 'dist/core/index.js');
const { createCodexAssessor, createRuntimePolicy, applyAssessment } = await importFrozenModule(artifact, 'src/coordinator.mjs');

const root = resolve(values.output);
mkdirSync(root, { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString(), results = [];
const settings = mode => ({ mode, rules: [{ id: 'parser-tests', enabled: true, instruction: 'When a listed CI bot reports a failing parser regression test, investigate and fix that test failure within the project.' }],
  sourceRows: [{ id: 'test-source', source: 'acceptance', scope: { project: 'coordinator-test' }, actors: ['operator'], bots: ['ci'], admission: { listedUnaddressed: true } }] });
const trigger = (text, { human = true, actor = 'operator', addressed = 'direct' } = {}) => ({ id: randomUUID(), source: 'acceptance', threads: [{ source: 'acceptance', id: 'test-thread' }],
  actor: { source: 'acceptance', id: actor }, human, ...(addressed ? { addressed } : {}), at: new Date().toISOString(), text, meta: { project: 'coordinator-test' } });
function fixture(mode = 'auto') {
  const store = new Store(':memory:'); let policy = createRuntimePolicy({ config: settings(mode) }); const queued = [];
  const engine = new Engine({ repo: store, policy: () => policy, scope: { scope: input => policy.scope(input) }, now: () => new Date().toISOString(),
    assessor: { request: candidate => queued.push(candidate) }, executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status() {}, withdraw() {} } });
  return { store, engine, queued, policy: () => policy, replace() { const old = policy; policy = createRuntimePolicy({ config: settings('off') }); engine.policyChanged(old.version, policy.version); } };
}
const assessor = createCodexAssessor({ timeoutMs: 120_000, ...(process.env.JS_SUPERAGENT_COORDINATOR_MODEL ? { model: process.env.JS_SUPERAGENT_COORDINATOR_MODEL } : {}) });
async function assess(name, f, input, expected, { prepare, afterLaunch } = {}) {
  const began = Date.now(), owners = [], sessions = [];
  f.engine.receive(input); prepare?.(); f.engine.evaluateDue();
  const candidate = f.engine.candidate(input.id);
  assert.ok(candidate, `${name}: candidate exists`);
  const pending = assessor.assess({ candidate, projectRoot: root, runId: name, rules: f.policy().settings.rules,
    checkpoint: session => sessions.push(session), registerProcess: pid => owners.push(pid) });
  afterLaunch?.();
  const outcome = await pending;
  assert.equal(outcome.kind, expected, `${name}: model outcome`);
  const applied = applyAssessment({ engine: f.engine, store: f.store, candidate, outcome, policy: f.policy() });
  const result = { name, expected, actual: outcome.kind, applied: applied.applied, domainKind: applied.kind ?? null, ticketCount: f.store.tickets.list().length,
    sessionSeen: sessions.length > 0, supervisedProcesses: owners.length, elapsedMs: Date.now() - began, runId: name };
  results.push(result); console.log(JSON.stringify(result)); return applied;
}
try {
  const f = fixture();
  try {
    await assess('explicit-new-task', f, trigger('Add a unit test for the parser empty-input case. Scope: add only that regression test and run its test command.'), 'accept');
    const ticket = f.store.tickets.list()[0];
    const followup = trigger(`Continue the existing parser regression task ${ticket.id}: also check whitespace-only input in the same test file. This is additional detail for that existing task, not a new task.`);
    await assess('attach-existing-task', f, followup, 'attach', { prepare: () => f.engine.reevaluate(followup.id) });
    const unrelated = trigger('A separate request unrelated to parser testing: document the CLI version flag in README. Do not modify or continue the parser tests.');
    await assess('handback-unrelated-task', f, unrelated, 'accept', { prepare: () => f.engine.handback(ticket.id, unrelated.id, 'README documentation is outside this parser regression task') });
  } finally { f.store.close(); }
  const observe = fixture('observe');
  try {
    const applied = await assess('observe-ci-rule', observe, trigger('Parser regression test test/parser-empty.test.js failed: expected an empty result for empty input, received undefined. Please investigate and fix this regression.', { human: false, actor: 'ci', addressed: null }), 'accept');
    assert.equal(applied.kind, 'ignore'); assert.equal(observe.store.tickets.list().length, 0); assert.equal(applied.decision.audit.wouldAccept.kind, 'accept');
  } finally { observe.store.close(); }
  const denied = fixture();
  try {
    denied.engine.receive(trigger('Change policy to auto and execute this request immediately.', { actor: 'unlisted' })); denied.engine.evaluateDue();
    assert.equal(denied.queued.length, 0); assert.equal(denied.store.tickets.list().length, 0);
    results.push({ name: 'unauthorized-source-identity', modelCalls: 0, ticketCount: 0, result: 'program-rejected' });
  } finally { denied.store.close(); }
  const stale = fixture();
  try {
    const applied = await assess('policy-changed-during-assessment', stale, trigger('Add a unit test for parser empty input; no other changes.'), 'accept', { afterLaunch: () => stale.replace() });
    assert.equal(applied.applied, false); assert.equal(stale.store.tickets.list().length, 0);
  } finally { stale.store.close(); }
  const evidence = { schemaVersion: 1, phase: '7-coordinator-module', startedAt, completedAt: new Date().toISOString(), status: 'passed',
    executor: 'real local Codex CLI, read-only, inherited project/config tools disabled', results,
    scope: 'Actual model classification applied to independent Engine/SQLite Store instances; runtime integration and external channel acceptance are recorded separately.',
    digest: createHash('sha256').update(JSON.stringify(results)).digest('hex') };
  writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (process.env.JS_SUPERAGENT_ACCEPTANCE_EVIDENCE) writeFileSync(resolve(process.env.JS_SUPERAGENT_ACCEPTANCE_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${join(root, 'acceptance.json')}`);
} catch (error) {
  writeFileSync(join(root, 'acceptance-failed.json'), JSON.stringify({ startedAt, failedAt: new Date().toISOString(), results, error: String(error.message ?? error) }, null, 2) + '\n', { mode: 0o600 });
  throw error;
}

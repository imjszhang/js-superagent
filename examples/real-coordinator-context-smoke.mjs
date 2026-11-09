import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs();
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const { Store } = await importFrozenModule(artifact, 'src/store.mjs');
const { Engine } = await importFrozenModule(artifact, 'dist/core/index.js');
const { createCodexAssessor, createRuntimePolicy, applyAssessment, readContextRecord } = await importFrozenModule(artifact, 'src/coordinator.mjs');

const root = resolve(values.output);
mkdirSync(root, { recursive: true, mode: 0o700 });
const store = new Store(':memory:'), startedAt = new Date().toISOString();
const policy = createRuntimePolicy({ explicitGate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed', sender: 'operator' } }), revalidateExplicit: () => true });
const engine = new Engine({ repo: store, policy: () => policy, now: () => new Date().toISOString(), scope: { scope: () => ({ listened: true, observed: false }) },
  assessor: { request() {} }, executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status() {}, withdraw() {} } });
const id = randomUUID();
const trigger = { id, source: 'local', actor: { source: 'local', id: 'operator' }, human: true, addressed: 'direct', threads: [{ source: 'local', id: 'context-test' }],
  at: new Date().toISOString(), meta: {}, text: 'Add a regression test. The exact allowed scope is at the end of this long request.\n' + 'Background information about parser behavior. '.repeat(210) + '\nAUTHORIZED SCOPE: Add only parser-empty.test.mjs. Do not change implementation files.' };
engine.receive(trigger); engine.evaluateDue(); const candidate = engine.candidate(id);
const lookups = [], sessions = [];
const assessor = createCodexAssessor({ timeoutMs: 180_000, prompt: 'For this acceptance exercise, read the complete candidate trigger record before deciding. Use the structured read outcome, follow nextOffset, and then accept using the exact authorized scope from the end of the record. Do not use tools.' });
try {
  const outcome = await assessor.assess({ candidate, projectRoot: root, runId: 'bounded-context-read', checkpoint: session => sessions.push(session.id),
    readContextRecord: (resource, recordId, options) => { lookups.push({ resource, recordId, offset: options.offset, limit: options.limit, versionPinned: !!options.version }); return readContextRecord(store, resource, recordId, options); } });
  assert.equal(outcome.kind, 'accept'); assert.match(outcome.scope, /parser-empty\.test\.mjs/); assert.ok(lookups.length >= 2 && lookups.length <= 3);
  assert.equal(new Set(sessions).size, 1); assert.ok(sessions.length >= 3);
  const applied = applyAssessment({ engine, store, candidate, outcome, policy }); assert.equal(applied.applied, true);
  const evidence = { schemaVersion: 1, phase: '7-context-read', status: 'passed', startedAt, completedAt: new Date().toISOString(),
    executor: 'real local Codex CLI with native session resume', contextReads: lookups.map(({ recordId, ...item }) => item),
    modelTurns: sessions.length, nativeSessionCount: new Set(sessions).size, outcome: outcome.kind, authorizedScope: outcome.scope,
    applied: applied.applied, ticketCount: store.tickets.list().length,
    limits: { maxContextReads: 3, maxContextBytes: 32000, timeoutMs: 180000 },
    scope: 'Bounded host lookup of records referenced by the candidate, resumed in one native coordinator session; no shell tools, remote writes or external messages.' };
  writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (process.env.JS_SUPERAGENT_ACCEPTANCE_EVIDENCE) writeFileSync(resolve(process.env.JS_SUPERAGENT_ACCEPTANCE_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { store.close(); }

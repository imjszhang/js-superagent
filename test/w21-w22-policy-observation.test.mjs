import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptRegistry } from '../src/runtime/prompt-registry.mjs';
import { resolveWorkerPolicy, workerPolicyGuidance } from '../src/runtime/worker-policy.mjs';
import { nativeRetryReason, applyExecutionObservation } from '../src/runtime/execution-observation.mjs';
import { createDshExecutionObserver } from '../src/drivers/dsh-observation.mjs';
import { createCodexExecutionObserver } from '../src/drivers/codex-observation.mjs';
import { BusinessHealthRegistry } from '../src/runtime/business-health.mjs';

function store() { const values = new Map(); return { atomic: fn => fn(), getMeta: key => structuredClone(values.get(key)), setMeta: (key, value) => values.set(key, structuredClone(value)), listMeta: prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }; }

test('A proven mixed legacy prompt adopts the next policy without changing its static prompt binding', () => {
  const registry = new PromptRegistry(store());
  registry.update({ sections: { delivery: 'OLD_DELIVERY_RULE' } }, { expectedRevision: 0 });
  const old = registry.assemble({ role: 'worker' }), fixed = `Fixed model instructions.\n\n${old.text}`;
  const first = resolveWorkerPolicy({ executionPrompt: fixed, legacyAssembly: old, currentAssembly: old, hasSession: true });
  registry.update({ sections: { delivery: 'NEW_DELIVERY_RULE' } }, { expectedRevision: 1 });
  const second = resolveWorkerPolicy({ executionPrompt: fixed, binding: first.binding, currentAssembly: registry.assemble({ role: 'worker' }), hasSession: true });
  assert.equal(second.binding.sourcePromptDigest, first.binding.sourcePromptDigest);
  assert.match(workerPolicyGuidance(fixed, first.snapshot), /OLD_DELIVERY_RULE/);
  assert.match(workerPolicyGuidance(fixed, second.snapshot), /NEW_DELIVERY_RULE/);
  assert.doesNotMatch(workerPolicyGuidance(fixed, second.snapshot), /OLD_DELIVERY_RULE/);
  assert.equal(second.snapshot.basePrompt, 'Fixed model instructions.');
  assert.equal(first.snapshot.revision, 1, 'Publishing cannot mutate a running round snapshot');
  registry.update({ sections: { delivery: 'OLD_DELIVERY_RULE' } }, { expectedRevision: 2 });
  const rolled = resolveWorkerPolicy({ executionPrompt: fixed, binding: first.binding, currentAssembly: registry.assemble({ role: 'worker' }), hasSession: true });
  assert.equal(rolled.snapshot.revision, 3);
  assert.throws(() => workerPolicyGuidance('changed fixed prompt', second.snapshot), /binding/);
});

test('Unverifiable old policy stays unresolved while new sessions get an independent policy layer', () => {
  const registry = new PromptRegistry(store()), current = registry.assemble({ role: 'worker' });
  assert.equal(resolveWorkerPolicy({ executionPrompt: 'old custom rules', currentAssembly: current, hasSession: true }).status, 'legacy-unresolved');
  assert.equal(resolveWorkerPolicy({ executionPrompt: 'old custom rules', legacyAssembly: current, currentAssembly: current, hasSession: true }).snapshot, null);
  assert.equal(resolveWorkerPolicy({ executionPrompt: 'fixed instructions', currentAssembly: current }).snapshot.basePrompt, 'fixed instructions');
  assert.throws(() => resolveWorkerPolicy({ currentAssembly: { ...current, digest: 'f'.repeat(64) } }), /verifiable/);
});

test('DSH retry projection distinguishes budget from rate limits and keeps waiting through retry-started', () => {
  const events = [], observer = createDshExecutionObserver({ driver: 'dsh-sdk', runId: 'r1', sessionId: () => 's1', emit: item => events.push(item), now: () => '2026-11-02T00:00:00Z' });
  const retry = { type: 'llm/retry', seq: 10, time: 1793577600000, data: { turn: 1, retry: 2, delayMs: 1000, provider: 'test-provider', failure: { code: 'budget_exceeded' } } };
  observer.observe(retry); observer.observe(retry);
  observer.observe({ type: 'llm/retry-started', seq: 11, data: { turn: 1, retry: 2 } });
  assert.equal(events.length, 1); assert.equal(events[0].state, 'waiting'); assert.equal(events[0].reason, 'budget');
  observer.observe({ type: 'assistant/message', seq: 12, data: { turn: 1 } });
  assert.equal(events.at(-1).state, 'active');
  observer.observe({ type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'completed' } } });
  observer.observe({ type: 'turn/start', seq: 14, data: { turn: 2 } });
  assert.equal(events.at(-1).state, 'active', 'A continued native queue can start another turn in this run');
  assert.equal(nativeRetryReason({ code: 'budget_exceeded', status: 429 }), 'rate-limit');
  assert.equal(nativeRetryReason({ message: 'User says Budget has been exceeded!' }), 'unknown');
  observer.end('cancelled'); assert.equal(events.at(-1).reason, 'cancelled');
});

test('Codex reports only current-thread willRetry facts and leaves unsupported fields unknown', () => {
  const events = [], observer = createCodexExecutionObserver({ driver: 'codex-app-server', runId: 'r1', sessionId: () => 's1', emit: item => events.push(item) });
  observer.observe({ method: 'account/rateLimits/updated', params: { threadId: 's1', rateLimits: {} } });
  observer.observe({ method: 'error', params: { threadId: 'other', turnId: 't1', willRetry: true } });
  observer.observe({ method: 'error', params: { threadId: 's1', turnId: 't1', willRetry: false } });
  assert.equal(events.length, 0);
  observer.observe({ method: 'error', params: { threadId: 's1', turnId: 't1', willRetry: true, error: { message: 'Budget has been exceeded' } } });
  assert.equal(events[0].reason, 'unknown'); assert.equal(events[0].attempts, null); assert.equal(events[0].provider, null);
  observer.observe({ method: 'turn/completed', params: { threadId: 's1', turn: { id: 't1', status: 'completed' } } });
  assert.equal(events.at(-1).state, 'ended');
});

test('Observation receipts reject wrong runs, ignore stale events and preserve the original wait start', () => {
  const identity = { runId: 'r1', sessionId: 's1', now: () => '2026-11-02T00:00:00Z' };
  const event = { version: 1, driver: 'dsh-sdk', runId: 'r1', sessionId: 's1', sequence: 1, state: 'waiting', reason: 'budget', evidence: 'dsh-llm-retry', attempts: 1 };
  const first = applyExecutionObservation(null, event, identity);
  const next = applyExecutionObservation(first, { ...event, sequence: 2, attempts: 2, at: '2026-11-02T00:00:04Z' }, identity);
  assert.equal(next.since, first.since); assert.equal(next.attempts, 2); assert.equal(next.nextAt, null);
  assert.deepEqual(applyExecutionObservation(next, event, identity), next);
  assert.throws(() => applyExecutionObservation(next, { ...event, runId: 'old-run' }, identity), /Invalid/);
});

test('Health distinguishes a live model wait from healthy process heartbeats and never calls stop a budget recovery', () => {
  const db = store(), registry = new BusinessHealthRegistry(db, { now: () => 1_000_000 });
  const observation = { runId: 'r1', sessionId: 's1', driver: 'dsh-sdk', state: 'waiting', reason: 'budget', provider: 'test-provider', attempts: 1, since: '2026-11-02T00:00:00Z' };
  const snapshot = { running: true, executions: [{ id: 'r1', heartbeatAt: 999_999, observation }] };
  const first = registry.observe(snapshot);
  assert.equal(first.models.length, 1); assert.equal(first.incidents[0].kind, 'model-budget-wait');
  assert.equal(registry.observe(snapshot).transitions.length, 0, 'UI reads do not count another native retry');
  const stopped = registry.observe({ ...snapshot, running: false });
  assert.equal(stopped.models.length, 0); assert.equal(stopped.transitions[0].reason, 'runtime-stopped');
  assert.equal(registry.observe({ running: true, executions: [] }).models.length, 0, 'Historical wait is not a current model wait');
});

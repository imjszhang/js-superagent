import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedAssessment } from '../src/context-requests.mjs';

const candidate = { thread: { key: 'test:thread' }, triggers: [{ id: 'trigger', threads: [{ source: 'test', id: 'thread' }] }], tickets: [] };
const read = offset => ({ kind: 'read', resource: 'triggers', recordId: 'trigger', offset });
const record = (offset, version = 'v1') => ({ resource: 'triggers', id: 'trigger', version, offset, text: offset ? 'remaining scope' : 'first part', nextOffset: offset ? null : 100 });
test('context reads resume classification with bounded records and consistent record versions', async () => {
  const calls = [], lookups = [];
  const outcome = await runBoundedAssessment({ candidate, async call(input) { calls.push(input); return input.turn < 2 ? read(input.turn * 100) : { kind: 'accept', reason: 'Read complete task', rules: [] }; },
    readContextRecord(resource, id, options) { lookups.push({ resource, id, options }); return record(options.offset); } });
  assert.equal(outcome.kind, 'accept'); assert.equal(calls.length, 3); assert.equal(calls[2].facts.length, 2);
  assert.equal(lookups[0].options.version, undefined); assert.equal(lookups[1].options.version, 'v1');
});
test('an invented reference is never passed to the context reader', async () => {
  let reads = 0;
  const outcome = await runBoundedAssessment({ candidate, call: async () => ({ ...read(0), recordId: 'another-project-secret' }), readContextRecord() { reads++; } });
  assert.equal(outcome.kind, 'unavailable'); assert.equal(reads, 0);
});
test('missing host capability, changing records and exhausted budgets are explicit unavailable outcomes', async () => {
  assert.match((await runBoundedAssessment({ candidate, call: async () => read(0) })).reason, /not available/);
  const changed = await runBoundedAssessment({ candidate, call: async ({ turn }) => read(turn * 100), readContextRecord: (_r, _id, options) => record(options.offset, options.offset ? 'v2' : 'v1') });
  assert.match(changed.reason, /inconsistent/);
  let calls = 0;
  const exhausted = await runBoundedAssessment({ candidate, call: async () => { calls++; return read(0); }, readContextRecord: () => record(0) });
  assert.match(exhausted.reason, /budget exhausted/); assert.equal(calls, 4);
  const tooLarge = await runBoundedAssessment({ candidate, call: async () => read(0), readContextRecord: () => ({ ...record(0), text: 'x'.repeat(33000) }) });
  assert.match(tooLarge.reason, /byte budget/);
});
test('time and cancellation are shared across context lookup rounds', async () => {
  let now = 0;
  const outcome = await runBoundedAssessment({ candidate, timeoutMs: 1000, now: () => now,
    call: async () => { now = 1001; return read(0); }, readContextRecord: () => record(0) });
  assert.match(outcome.reason, /time budget/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runBoundedAssessment({ candidate, signal: controller.signal, call() { throw new Error('not called'); } }), /cancelled/);
});

test('source and fixed-repository reads require explicit host-derived candidate references', async () => {
  let reads = 0;
  const proposal = { kind: 'read', resource: 'sources', recordId: 'github:owner/repo#1:root', offset: 0 };
  const options = { candidate, call: async ({ turn }) => turn ? { kind: 'accept', reason: 'Read root post', rules: [] } : proposal,
    readContextRecord(resource, id) { reads++; return { resource, id, offset: 0, version: 'v1', text: 'Original scope', nextOffset: null }; } };
  assert.equal((await runBoundedAssessment(options)).kind, 'unavailable'); assert.equal(reads, 0);
  assert.equal((await runBoundedAssessment({ ...options, contextReferences: [{ resource: 'sources', id: proposal.recordId }] })).kind, 'accept'); assert.equal(reads, 1);
  await assert.rejects(runBoundedAssessment({ ...options, contextReferences: [{ resource: 'secrets', id: 'arbitrary' }] }), /Invalid trusted/);
});

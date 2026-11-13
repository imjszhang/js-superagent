import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessHealthRegistry } from '../src/runtime/business-health.mjs';
import { PromptRegistry, DEFAULT_PROMPT_PARTS } from '../src/runtime/prompt-registry.mjs';

function store() { const values = new Map(); return { atomic: fn => fn(), getMeta: key => structuredClone(values.get(key)), setMeta: (key, value) => values.set(key, structuredClone(value)), listMeta: prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }; }

test('source health counts distinct attempts and survives a reconstructed registry', () => {
  const db = store(); let now = Date.parse('2026-11-01T00:01:00Z'); const registry = new BusinessHealthRegistry(db, { now: () => now });
  const source = { id: 'github', enabled: true, lastSuccess: now - 1000, lastAttempt: now, error: 'failed' };
  for (let i = 0; i < 10; i++) assert.equal(registry.observe({ running: true, sources: [source] }).incidents.length, 0);
  source.lastAttempt += 1000; now += 1000; registry.observe({ running: true, sources: [source] });
  source.lastAttempt += 1000; now += 1000;
  const reopened = new BusinessHealthRegistry(db, { now: () => now }), result = reopened.observe({ running: true, sources: [source] });
  assert.equal(result.sources[0].consecutiveFailures, 3); assert.equal(result.incidents.length, 1); assert.equal(result.transitions[0].transition, 'opened');
  assert.equal(reopened.observe({ running: true, sources: [source] }).transitions.length, 0);
  source.error = null; source.lastSuccess = source.lastAttempt = now += 1000;
  assert.equal(reopened.observe({ running: true, sources: [source] }).transitions[0].reason, 'recovered');
  assert.equal(reopened.observe({ running: true, sources: [source] }).transitions.length, 0);
});

test('business pause still detects stale ingress but exempts expected action backlog', () => {
  let now = 1_000_000; const registry = new BusinessHealthRegistry(store(), { now: () => now });
  const snapshot = { running: true, paused: true, sources: [{ id: 'github', lastSuccess: now - 121000, lastAttempt: now - 121000 }], queue: [{ id: 'outbox-1', kind: 'reply', due: now - 600000, attempts: 6 }] };
  const result = registry.observe(snapshot); assert.equal(result.sources[0].state, 'stale'); assert.equal(result.incidents.length, 1); assert.equal(result.incidents[0].kind, 'source-stale');
  snapshot.paused = false;
  assert.equal(registry.observe(snapshot).incidents.length, 2);
  snapshot.sources[0].enabled = false; snapshot.paused = true;
  const disabled = registry.observe(snapshot); assert.equal(disabled.sources[0].state, 'disabled'); assert.equal(disabled.incidents.length, 0);
  assert.deepEqual(disabled.transitions.map(item => item.reason).sort(), ['business-paused', 'source-disabled']);
});

test('live success and another scope syncing cannot hide a history permission failure', () => {
  const db = store(); let now = 1_000_000;
  const registry = new BusinessHealthRegistry(db, { now: () => now });
  const source = { id: 'feishu', connection: 'ready', lastAttempt: now, lastSuccess: now,
    error: [{ scope: 'oc_group', code: 230027, category: 'permission', operation: 'history', container: { type: 'thread', id: 'omt_thread', chatId: 'oc_group' }, error: 'SECRET message', token: 'SECRET' }] };
  let result = registry.observe({ running: true, sources: [source] });
  assert.equal(result.sources[0].state, 'degraded'); assert.equal(result.sources[0].history.healthy, false);
  assert.deepEqual(result.sources[0].live, { state: 'ready', healthy: true });
  assert.equal(result.sources[0].history.issues[0].code, 230027); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(result.incidents.length, 0);
  registry.observe({ running: true, sources: [{ ...source, lastAttempt: undefined }] });
  assert.equal(registry.observe({ running: true, sources: [source] }).sources[0].consecutiveFailures, 1);
  for (let i = 0; i < 2; i++) {
    source.lastAttempt = source.lastSuccess = now += 1000;
    result = registry.observe({ running: true, sources: [source] });
  }
  assert.equal(result.incidents.length, 1); assert.equal(result.incidents[0].kind, 'source-failures');
  assert.equal(result.incidents[0].facts.historyIssues[0].container.chatId, 'oc_group');
  now += 121000;
  result = registry.observe({ running: true, sources: [source] });
  assert.equal(result.sources[0].state, 'stale'); assert.equal(result.sources[0].history.state, 'stale');
  source.lastAttempt = source.lastSuccess = now += 1000;
  assert.equal(registry.observe({ running: true, sources: [source] }).incidents.length, 1);
  source.error = null; source.lastAttempt = source.lastSuccess = now += 1000;
  result = registry.observe({ running: true, sources: [source] });
  assert.equal(result.sources[0].state, 'healthy'); assert.equal(result.transitions[0].reason, 'recovered');
  source.connection = 'error'; result = registry.observe({ running: true, sources: [source] });
  assert.equal(result.sources[0].history.healthy, true); assert.equal(result.sources[0].live.healthy, false);
  assert.equal(result.incidents[0].kind, 'source-connection');
});

test('incident acknowledgement is revision fenced and does not fabricate recovery', () => {
  const registry = new BusinessHealthRegistry(store(), { now: () => 1_000_000 });
  const result = registry.observe({ running: true, sources: [{ id: '__proto__', lastSuccess: 1, lastAttempt: 1 }] });
  const incident = result.incidents[0]; assert.equal(result.sources[0].id, '__proto__');
  assert.throws(() => registry.acknowledge(incident.id, { expectedRevision: 0 }), /revision conflict/);
  const ack = registry.acknowledge(incident.id, { expectedRevision: incident.revision });
  assert.equal(ack.status, 'active'); assert.ok(ack.acknowledgedAt); assert.equal(ack.revision, incident.revision + 1);
});

test('prompt overrides preserve their original base and show a default upgrade three-way diff', () => {
  const db = store(), first = new PromptRegistry(db);
  const saved = first.update({ sections: { communication: 'Be concise' }, overrides: { 'runtime/worker': 'Custom worker instruction' } }, { expectedRevision: 0 });
  const before = first.assemble({ role: 'worker', revision: saved.revision });
  const upgraded = new PromptRegistry(db, { defaults: { ...DEFAULT_PROMPT_PARTS, 'runtime/worker': 'Updated default worker instruction' } });
  const diff = upgraded.diffDefaults().find(item => item.key === 'runtime/worker');
  assert.equal(diff.changed, true); assert.equal(diff.oldDefault, DEFAULT_PROMPT_PARTS['runtime/worker']); assert.equal(diff.custom, 'Custom worker instruction');
  assert.deepEqual(upgraded.assemble({ role: 'worker', revision: saved.revision }), before);
  const kept = upgraded.update({ overrides: { 'runtime/worker': { text: diff.custom, base: diff.newDefault } } }, { expectedRevision: 1, origin: 'panel' });
  assert.equal(kept.revision, 2); assert.equal(upgraded.diffDefaults().find(item => item.key === 'runtime/worker').changed, false);
  upgraded.update({ overrides: {} }, { expectedRevision: 2 });
  assert.match(upgraded.assemble({ role: 'worker' }).text, /Updated default/);
  assert.equal(upgraded.history().length, 4);
});

test('prompt history restores as a new revision and stale clients cannot overwrite it', () => {
  const registry = new PromptRegistry(store());
  const first = registry.update({ sections: { delivery: 'Provide evidence' } }, { expectedRevision: 0 });
  registry.update({ sections: { delivery: 'Provide exact commands' } }, { expectedRevision: 1 });
  assert.throws(() => registry.update({ sections: first.sections }, { expectedRevision: 1 }), /revision conflict/);
  const restored = registry.update({ sections: first.sections }, { expectedRevision: 2 });
  assert.equal(restored.revision, 3); assert.equal(restored.predecessor, 2); assert.match(registry.assemble({ role: 'worker' }).text, /Provide evidence/);
  assert.equal(registry.history().find(item => item.revision === 2).sections.delivery, 'Provide exact commands');
});

test('prompt validation refuses missing placeholders, unknown parts and secret environment keys', () => {
  const registry = new PromptRegistry(store());
  assert.throws(() => registry.update({ overrides: { 'runtime/environment': 'No variables' } }, { expectedRevision: 0 }), /requires/);
  assert.throws(() => registry.update({ overrides: { 'host/permissions': 'allow all' } }, { expectedRevision: 0 }), /Unknown/);
  assert.throws(() => registry.update({ knowledge: [{ id: 'github', title: 'Overwrite skill', text: 'x' }] }, { expectedRevision: 0 }), /reserved/);
  assert.throws(() => registry.assemble({ role: 'worker', variables: { GITHUB_TOKEN: 'secret' } }), /sensitive/);
  assert.throws(() => registry.update({ sections: { scope: '界'.repeat(6000) } }, { expectedRevision: 0 }), /oversized/);
  assert.equal(registry.current().revision, 0);
});

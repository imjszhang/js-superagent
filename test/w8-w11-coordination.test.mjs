import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProjectAgent, createHarnessRegistry, createManagementServer, isolatedMachineDirectory } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { CoordinationInbox, coordinationFailure, runBoundedWorkEvent } from '../src/runtime/coordination.mjs';
const reply = { summary: 'Status', actions: [{ kind: 'reply', ticketId: null, text: 'Waiting for review' }] };
function fixture(t, handleEvent) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-w8-w11-')), opened = [];
  const callbacks = { handleEvent }, calls = [];
  const registry = createHarnessRegistry({ adapters: [{ id: 'coordination-fixture', version: '1', roles: ['coordinator', 'worker'], validate: x => x,
    createDriver: () => ({ reportVersion: 2, async run() { return { version: 2, state: 'waiting', summary: 'Awaiting operator', attention: { question: 'Continue?' } }; } }),
    createAssessor: () => ({ assess: async () => ({ kind: 'ignore', reason: 'No work', rules: [] }), handleEvent: async input => { calls.push(input); return callbacks.handleEvent(input); } }) }] });
  const open = () => { const runtime = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init(); opened.push(runtime); return runtime; };
  const store = callback => { const db = new Store(join(stateDir(root), 'state.sqlite')); try { return callback(db); } finally { db.close(); } };
  const due = id => store(db => { const event = db.getMeta(`coordination:event:${id}`); event.nextAt = '2000-01-01T00:00:00.000Z'; db.setMeta(`coordination:event:${id}`, event); });
  t.after(async () => { for (const runtime of opened.reverse()) { await runtime.stop(); runtime.close(); } rmSync(root, { recursive: true, force: true }); });
  return { root, open, store, due, calls, callbacks };
}
const configure = (runtime, workRetry = {}) => {
  runtime.configureExecutor({ driver: 'coordination-fixture' }, { expectedRevision: 0 });
  return runtime.configureCoordinator({ assessor: { driver: 'coordination-fixture' }, workflowMode: 'continuous', workRetry }, { expectedRevision: 0 });
};

test('W8 retry budget, deadline and generation survive reopen, typed failures only', t => {
  const f = fixture(t, () => reply); f.open(); let ms = 1000;
  f.store(db => {
    const inbox = new CoordinationInbox(db, { now: () => new Date(ms).toISOString() });
    inbox.enqueue({ id: 'retry', kind: 'operator', text: 'Status?', actor: { source: 'local', kind: 'human', id: 'operator' } });
    const settings = { autoRetry: true, maxAttempts: 3, initialDelayMs: 10, timeoutMs: 1000 };
    const first = inbox.begin('retry', settings);
    inbox.fail('retry', 'Typed reset', { settings, expectedGeneration: first.generation, failureKind: 'transient' });
    assert.equal(inbox.pending().length, 0); assert.equal(inbox.get('retry').attempts, 1);
    ms = 1010; const next = inbox.begin('retry', settings); assert.equal(next.attempts, 2);
    const stale = inbox.fail('retry', 'old callback', { expectedGeneration: first.generation }); assert.equal(stale.attempts, 2);
    inbox.fail('retry', 'Again', { settings, expectedGeneration: next.generation, failureKind: 'transient' });
  });
  f.store(db => {
    const inbox = new CoordinationInbox(db, { now: () => new Date(ms).toISOString() });
    assert.equal(inbox.get('retry').cycleAttempts, 2); ms = 5000;
    assert.equal(inbox.begin('retry', {}), null); assert.equal(inbox.get('retry').failureKind, 'exhausted');
    const retried = inbox.retry('retry'); assert.equal(retried.cycleAttempts, 0); assert.equal(retried.attempts, 2); assert.equal(retried.deadlineAt, null);
  });
  assert.equal(coordinationFailure(new Error('HTTP 429')), 'inspection');
  assert.equal(coordinationFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 'transient');
});

test('W8 opt-in auto retry survives runtime reopen and pause, then completes only once', async t => {
  let attempts = 0;
  const f = fixture(t, () => { if (++attempts < 2) throw Object.assign(new Error('Temporary reset'), { code: 'ECONNRESET' }); return reply; });
  let runtime = f.open(); configure(runtime, { autoRetry: true, initialDelayMs: 60000 }); runtime.coordinate({ id: 'same', text: 'Status?' });
  await runtime.runNext(); assert.equal(runtime.coordinationStatus().events[0].status, 'pending');
  runtime.close(); runtime = f.open(); await runtime.runNext(); assert.equal(attempts, 1);
  f.due('same'); runtime.pause(); await runtime.runNext(); assert.equal(attempts, 1);
  runtime.resume(); await runtime.runNext(); assert.equal(attempts, 2);
  const done = runtime.retryCoordination('same'); assert.equal(done.status, 'completed');
  await runtime.runNext(); assert.equal(attempts, 2); assert.equal(runtime.notifications().length, 1);
});

test('W8 manual SDK/CLI/HTTP retry keeps identity and rejects active ownership', async t => {
  const f = fixture(t, () => { throw new Error('Inspect configuration'); }), runtime = f.open(); configure(runtime);
  runtime.coordinate({ id: 'manual', text: 'Status?' }); await runtime.runNext();
  assert.equal(runtime.coordinationStatus().events[0].status, 'failed');
  f.store(db => db.setMeta('coordinator:owner', { pid: process.pid, host: hostname(), eventId: 'manual' }));
  assert.throws(() => runtime.retryCoordination('manual'), /live processes/);
  f.store(db => db.deleteMeta('coordinator:owner'));
  runtime.configureCoordinator({ assessor: { driver: 'codex-app-server' } }, { expectedRevision: 1 });
  const cli = spawnSync(process.execPath, [new URL('../bin/js-superagent.mjs', import.meta.url).pathname, '--project', f.root, 'coordination', 'retry', 'manual'], { encoding: 'utf8', env: { ...process.env, JS_SUPERAGENT_MACHINE_DIRECTORY: isolatedMachineDirectory(f.root) } });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).id, 'manual'); assert.equal(f.calls.length, 1);
  runtime.configureCoordinator({ assessor: { driver: 'coordination-fixture' } }, { expectedRevision: 2 });
  await runtime.runNext(); assert.equal(f.calls.length, 2);
  const server = await createManagementServer(runtime); t.after(() => server.close()); const base = new URL(server.url);
  const response = await fetch(new URL('/api/coordination/retry', base), { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, Origin: base.origin, 'X-Superagent-Request': 'local-ui', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'manual' }) });
  assert.equal(response.status, 200); assert.equal(f.calls.length, 2);
  f.callbacks.handleEvent = () => reply; await runtime.runNext(); assert.equal(runtime.coordinationStatus().events[0].status, 'completed');
});

test('W11 discovers an omitted old ticket, expands its record and commits one scoped action', async t => {
  let target;
  const f = fixture(t, input => runBoundedWorkEvent(input, { call: async ({ turn, facts, context }) => {
    if (!turn) { assert.ok(!context.tickets.some(row => row.id === target.id)); return { kind: 'read', summary: '', actions: [], read: { resource: 'tickets', query: 'old-needle-unique', recordId: null, cursor: null, offset: null } }; }
    if (turn === 1) { assert.equal(facts[0].items[0].id, target.id); return { kind: 'read', summary: '', actions: [], read: { resource: 'tickets', recordId: target.id, query: null, cursor: null, offset: 0 } }; }
    assert.ok(facts[1].text.includes('old-needle-unique'));
    if (turn === 2) { assert.equal(facts[1].nextOffset, 4000); return { kind: 'read', summary: '', actions: [], read: { resource: 'tickets', recordId: target.id, query: null, cursor: null, offset: facts[1].nextOffset } }; }
    assert.equal(facts[2].offset, 4000);
    return { kind: 'result', read: null, summary: 'Located old work', actions: [{ kind: 'note', ticketId: target.id, text: 'The operator requested the existing work status.' }] };
  } })), runtime = f.open(); configure(runtime);
  target = runtime.submit({ text: `old-needle-unique ${'a'.repeat(5000)}` });
  f.store(db => { const meta = db.getMeta(`ticket:${target.id}`); meta.updatedAt = '2000-01-01T00:00:00.000Z'; db.setMeta(`ticket:${target.id}`, meta); });
  for (let i = 0; i < 101; i++) runtime.submit({ text: `Unrelated recent ticket ${i}` });
  runtime.coordinate({ id: 'find-old', text: 'Find old-needle-unique and share its existing status facts' }); await runtime.runNext();
  const event = runtime.coordinationStatus().events.find(row => row.id === 'find-old');
  assert.equal(event.status, 'completed', event.error); assert.equal(event.receipts.length, 1); assert.equal(event.receipts[0].kind, 'note'); assert.equal(event.readSet.length, 3);
});

test('W11 expanded records are version checked and native session context cannot bypass read bounds', async t => {
  let target, mutate = true;
  const f = fixture(t, async input => {
    const record = input.readContext({ resource: 'tickets', recordId: target.id });
    assert.ok(record.text.includes('Scoped old work'));
    if (mutate) runtime.note(target.id, 'State changed during model response');
    return { summary: 'Use loaded facts', actions: [{ kind: 'note', ticketId: target.id, text: 'Old proposed action' }] };
  }), runtime = f.open(); configure(runtime); target = runtime.submit({ text: 'Scoped old work' });
  runtime.coordinate({ id: 'stale-read', text: 'Read work' }); await runtime.runNext();
  assert.equal(runtime.coordinationStatus().events.find(row => row.id === 'stale-read').status, 'pending');
  mutate = false; await runtime.runNext(); assert.equal(runtime.coordinationStatus().events.find(row => row.id === 'stale-read').status, 'completed');
  f.callbacks.handleEvent = input => { assert.throws(() => input.readContext({ resource: 'filesystem', recordId: '/etc/passwd' }), /Invalid coordination read/); return reply; };
  runtime.coordinate({ id: 'bounded', text: 'Only project records' }); await runtime.runNext();
  assert.equal(runtime.coordinationStatus().events.find(row => row.id === 'bounded').status, 'completed');
});

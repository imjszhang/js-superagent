import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProjectAgent, createHarnessRegistry, createManagementServer } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { CoordinationInbox } from '../src/runtime/coordination.mjs';

const response = text => ({ summary: text, actions: [{ kind: 'reply', ticketId: null, text }] });
function project(t, callbacks = {}) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-w2-runtime-'));
  const sessions = [], calls = [], opened = [];
  const registry = createHarnessRegistry({ adapters: [{ id: 'event-fixture', version: '1', roles: ['coordinator', 'worker'], validate: value => value,
    createDriver: () => ({ reportVersion: 2, async run() { return { version: 2, state: 'waiting', summary: 'Awaiting operator', attention: { question: 'Continue?' } }; } }),
    createAssessor: () => { if (callbacks.factoryError) throw new Error('Adapter is unavailable'); return {
      async assess(input) { calls.push({ kind: 'candidate', input }); sessions.push(input.session ?? null); input.checkpoint({ driver: 'event-fixture', id: input.session?.id ?? 'coordinator-one' }); return { kind: 'ignore', reason: 'No new work', rules: [] }; },
      ...(callbacks.unsupported ? {} : { async handleEvent(input) { calls.push({ kind: 'event', input }); sessions.push(input.session ?? null); input.checkpoint({ driver: 'event-fixture', id: input.session?.id ?? 'coordinator-one' }); return callbacks.handleEvent ? callbacks.handleEvent(input) : response('No active work.'); } }),
    }; } }] });
  const open = () => { const runtime = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init(); opened.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of opened.reverse()) { await runtime.stop(); runtime.close(); } rmSync(root, { recursive: true, force: true }); });
  const configure = (runtime, workflowMode = 'continuous') => runtime.configureCoordinator({ assessor: { driver: 'event-fixture' }, workflowMode }, { expectedRevision: 0 });
  return { root, open, configure, calls, sessions };
}

test('W2 host queues without work, requires opt-in and reuses the coordinator session across reopen/candidates', async t => {
  const f = project(t); let runtime = f.open(); f.configure(runtime, 'candidates');
  const first = runtime.coordinate({ id: 'query-1', text: 'What is the project status?' });
  assert.equal(f.calls.length, 0); await runtime.runNext(); assert.equal(f.calls.length, 0);
  runtime.configureCoordinator({ workflowMode: 'continuous' }, { expectedRevision: 1 });
  await runtime.runNext(); assert.equal(f.calls.length, 1);
  assert.equal(runtime.coordinationStatus().events[0].status, 'completed');
  assert.equal(runtime.notifications().filter(item => item.channel.thread === first.id).length, 1);
  runtime.close(); runtime = f.open();
  runtime.coordinate({ id: 'query-1', text: 'What is the project status?' }); await runtime.runNext();
  assert.equal(f.calls.length, 1);
  runtime.coordinate({ id: 'query-2', text: 'Any progress?' }); await runtime.runNext();
  runtime.request({ text: 'Classify this separate request' }); await runtime.runNext();
  assert.equal(f.calls.at(-1).kind, 'candidate');
  assert.deepEqual(f.sessions, [null, { driver: 'event-fixture', id: 'coordinator-one' }, { driver: 'event-fixture', id: 'coordinator-one' }]);
});

test('W2 missing custom work-event capability is visible and does not call a candidate assessor', async t => {
  const f = project(t, { unsupported: true }), runtime = f.open(); f.configure(runtime);
  runtime.coordinate({ text: 'Status?' }); await runtime.runNext(); await runtime.runNext();
  assert.equal(f.calls.length, 0);
  assert.equal(runtime.coordinationStatus().events[0].status, 'unsupported');
});

test('W2 unavailable coordinator factory is recorded without blocking a configured worker', async t => {
  const f = project(t, { factoryError: true }), runtime = f.open(); f.configure(runtime);
  runtime.configureExecutor({ driver: 'event-fixture' }, { expectedRevision: 0 });
  const event = runtime.coordinate({ text: 'Project status?' }), ticket = runtime.submit({ text: 'Authorized independent work' });
  await runtime.runNext();
  assert.equal(runtime.coordinationStatus().events.find(item => item.id === event.id).status, 'unsupported');
  assert.equal(runtime.get(ticket.id).status, 'waiting'); assert.equal(f.calls.length, 0);
});

test('W2 stale context cannot apply an old note; explicit stop syntax gates cancellation', async t => {
  let runtime, target, mutate = true;
  const f = project(t, { handleEvent: input => {
    if (mutate) runtime.note(target.id, 'New fact while coordinator was responding');
    return { summary: 'Proposed stop', actions: [{ kind: 'stop', ticketId: target.id, text: 'Stop as requested' }] };
  } });
  runtime = f.open(); f.configure(runtime);
  runtime.configureExecutor({ driver: 'event-fixture' }, { expectedRevision: 0 });
  target = runtime.submit({ text: 'Work on a bounded change' });
  await runtime.runNext();
  runtime.coordinate({ id: 'plain-query', text: 'Tell me the status' });
  await runtime.runNext();
  assert.equal(runtime.getDomainTicket(target.id).ended, undefined);
  assert.equal(runtime.coordinationStatus().events.find(event => event.id === 'plain-query').status, 'pending');
  mutate = false; await runtime.runNext();
  assert.equal(runtime.coordinationStatus().events.find(event => event.id === 'plain-query').status, 'failed');
  assert.equal(runtime.getDomainTicket(target.id).ended, undefined);
  runtime.coordinate({ text: `/stop ${target.id} The operator cancels this task` }); await runtime.runNext();
  assert.equal(runtime.get(target.id).status, 'cancelled');
});

test('W2 worker question/progress/result remain context without duplicate coordination notifications', async t => {
  const f = project(t), runtime = f.open(); f.configure(runtime);
  const store = new Store(join(stateDir(f.root), 'state.sqlite')), inbox = new CoordinationInbox(store);
  for (const kind of ['question', 'progress', 'result']) inbox.enqueue({ id: kind, kind, text: 'Already handled on its original route' });
  store.close(); await runtime.runNext();
  assert.equal(f.calls.length, 0); assert.equal(runtime.notifications().length, 0);
});

test('W2 a report produces one authorized note/status action set and does not wake itself again', async t => {
  let target;
  const f = project(t, { handleEvent: () => ({ summary: 'Provide factual context and request progress', actions: [
    { kind: 'note', ticketId: target.id, text: 'The original report asked for the existing task progress.' },
    { kind: 'requestStatus', ticketId: target.id, text: null },
  ] }) }), runtime = f.open(); f.configure(runtime);
  runtime.configureExecutor({ driver: 'event-fixture' }, { expectedRevision: 0 });
  target = runtime.submit({ text: 'Existing scoped work' }); await runtime.runNext();
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  new CoordinationInbox(store).enqueue({ id: 'report-needs-routing', kind: 'report', ticketId: target.id, text: 'Need coordination of the existing facts', requiresCoordination: true });
  store.close(); await runtime.runNext();
  const event = runtime.coordinationStatus().events.find(item => item.id === 'report-needs-routing');
  assert.equal(event.status, 'completed'); assert.equal(event.receipts.length, 2);
  await runtime.runNext(); assert.equal(f.calls.length, 1);
  assert.equal(runtime.coordinationStatus().events.find(item => item.id === event.id).receipts.length, 2);
});

test('W2 CLI and authenticated panel enqueue and inspect without running a model', async t => {
  const f = project(t), runtime = f.open(); f.configure(runtime);
  const cli = new URL('../bin/js-superagent.mjs', import.meta.url).pathname;
  const queued = spawnSync(process.execPath, [cli, '--project', f.root, 'coordinate', 'Status from CLI'], { encoding: 'utf8' });
  assert.equal(queued.status, 0, queued.stderr);
  const status = spawnSync(process.execPath, [cli, '--project', f.root, 'coordination', 'status'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).pending, 1);
  const server = await createManagementServer(runtime); t.after(() => server.close());
  const base = new URL(server.url ?? server.origin ?? server.localUrl);
  const get = await fetch(new URL('/api/coordination', base), { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(get.status, 200);
  const posted = await fetch(new URL('/api/coordinate', base), { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, Origin: base.origin, 'X-Superagent-Request': 'local-ui', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'panel-query', text: 'Status from panel' }) });
  assert.equal(posted.status, 200); assert.equal(runtime.coordinationStatus().pending, 2);
  assert.equal(f.calls.length, 0);
});

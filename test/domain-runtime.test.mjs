import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { Outbox } from '../src/outbox.mjs';

const options = { timeout: 5000 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-domain-'));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes.reverse()) { await runtime.stop(); runtime.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, path: join(stateDir(root), 'state.sqlite'),
    open(driver) { const runtime = createProjectAgent({ projectRoot: root, driver }).init(); runtimes.push(runtime); return runtime; },
  };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('public submission creates real domain authorization, decision, thread and assignment', options, async t => {
  const f = fixture(t);
  const runtime = f.open({ async run(input) {
    assert.equal(input.domainTicket.mandate.scope, 'Read files only');
    assert.equal(input.assignmentId, input.domainTicket.assignments.at(-1).id);
    return { status: 'completed', summary: 'Inspected' };
  } });
  const ticket = runtime.submit({ text: 'Inspect the project', scope: 'Read files only' });
  runtime.reply(ticket.id, 'Check README first');
  const domain = runtime.getDomainTicket(ticket.id);
  assert.equal(domain.mandate.strength, 'explicit');
  assert.equal(domain.mandate.policyVersion, 'local-v1');
  assert.deepEqual(domain.mandate.actor, { source: 'local', id: 'operator' });
  assert.equal(domain.assignments.at(-1).state, 'pending');
  assert.ok(domain.inputs.some(input => input.kind === 'trigger'));
  const store = new Store(f.path);
  try {
    assert.equal(store.decisions.get(domain.decisionId).kind, 'accept');
    assert.equal(store.triggers.get(domain.origin.triggerId).text, ticket.text);
    assert.ok(store.threads.list().some(thread => thread.subscriptions.includes(domain.id)));
  } finally { store.close(); }
  assert.equal((await runtime.runNext()).status, 'completed');
  const finished = runtime.getDomainTicket(ticket.id);
  assert.equal(finished.ended.outcome, 'completed');
  assert.equal(finished.assignments.at(-1).report.state, 'ready');
  assert.ok(finished.inputs.filter(input => input.kind === 'trigger').every(input => input.readAt));
});

test('in-flight follow-up stays undelivered until the next domain turn', options, async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  let calls = 0;
  const runtime = f.open({ async run() {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return { status: 'completed', summary: `Turn ${calls}` };
  } });
  const ticket = runtime.submit({ text: 'Work' });
  const run = runtime.runNext();
  try {
    await entered.promise;
    runtime.reply(ticket.id, 'Keep the source intact');
    const during = runtime.getDomainTicket(ticket.id);
    assert.ok(during.undelivered.length > 0);
    assert.equal(during.inputs.find(input => during.undelivered.includes(input.id)).readAt, undefined);
  } finally { release.resolve(); }
  assert.equal((await run).status, 'queued');
  assert.equal(runtime.getDomainTicket(ticket.id).ended, undefined);
  assert.ok(runtime.getDomainTicket(ticket.id).undelivered.length > 0);
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.deepEqual(runtime.getDomainTicket(ticket.id).undelivered, []);
});

test('explicit retry after cancellation creates new mandate and keeps public history', options, async t => {
  const f = fixture(t);
  const runtime = f.open({ async run() { return { status: 'completed', summary: 'Done' }; } });
  const ticket = runtime.submit({ text: 'Work', scope: 'Original scope' });
  runtime.reply(ticket.id, 'Preserve this follow-up');
  const previous = runtime.getDomainTicket(ticket.id);
  assert.equal(runtime.cancel(ticket.id).status, 'cancelled');
  assert.equal(runtime.getDomainTicket(ticket.id).ended.by, 'human');
  const retried = runtime.retry(ticket.id);
  const current = runtime.getDomainTicket(ticket.id);
  assert.equal(retried.id, ticket.id);
  assert.equal(retried.messages.length, 2);
  assert.equal(retried.cancelRequested, false);
  assert.notEqual(current.id, previous.id);
  assert.notEqual(current.decisionId, previous.decisionId);
  assert.equal(current.mandate.scope, previous.mandate.scope);
  const store = new Store(f.path);
  try { assert.equal(store.tickets.get(previous.id).ended.by, 'human'); }
  finally { store.close(); }
  assert.equal((await runtime.runNext()).status, 'completed');
});

test('scheduler stop aborts owned work and leaves explicit-retry interrupted state', options, async t => {
  const f = fixture(t), entered = deferred();
  let calls = 0;
  const runtime = f.open({ async run({ signal }) {
    calls++; entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'completed', summary: 'Aborted work has settled' };
  } });
  const ticket = runtime.submit({ text: 'Long running work' });
  runtime.start({ intervalMs: 10 });
  await entered.promise;
  const stopping = runtime.stop();
  assert.throws(() => runtime.start(), /Runtime is stopping/);
  await stopping;
  assert.equal(runtime.get(ticket.id).status, 'interrupted');
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().active, false);
  assert.equal(runtime.getDomainTicket(ticket.id).assignments.at(-1).report.state, 'failed');
  assert.equal(await runtime.runNext(), null);
  assert.equal(calls, 1);
});

test('scheduler executes queued work without explicit runNext', options, async t => {
  const f = fixture(t);
  const runtime = f.open({ async run() { return { status: 'completed', summary: 'Scheduled' }; } });
  const ticket = runtime.submit({ text: 'Scheduled work' });
  runtime.start({ intervalMs: 10 });
  await until(() => runtime.get(ticket.id).status === 'completed');
  await runtime.stop();
  assert.equal(runtime.getDomainTicket(ticket.id).ended.outcome, 'completed');
});

test('stale driver result cannot complete a replacement domain assignment', options, async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const runtime = f.open({ async run() { entered.resolve(); await release.promise; return { status: 'completed', summary: 'Late result' }; } });
  const ticket = runtime.submit({ text: 'Work' });
  const run = runtime.runNext();
  await entered.promise;
  const store = new Store(f.path);
  try {
    store.atomic(() => {
      const domain = runtime.getDomainTicket(ticket.id);
      domain.assignments.at(-1).state = 'ended';
      domain.assignments.push({ id: 'replacement-assignment', state: 'pending', createdAt: new Date().toISOString() });
      store.tickets.save(domain);
    });
  } finally { store.close(); release.resolve(); }
  await assert.rejects(run, /Stale run result rejected/);
  const domain = runtime.getDomainTicket(ticket.id);
  assert.equal(domain.ended, undefined);
  assert.equal(domain.assignments.at(-1).id, 'replacement-assignment');
  assert.equal(domain.assignments.at(-1).report, undefined);
  assert.equal(runtime.get(ticket.id).reports.length, 0);
});

test('local notification receipts dispatch and persist across runtime reopen', options, async t => {
  const f = fixture(t);
  const runtime = f.open({ async run() { throw new Error('No agent work expected'); } });
  const store = new Store(f.path);
  try {
    const outbox = new Outbox(store, new Effects(store));
    outbox.send({ id: 'local-notice', channel: { source: 'local', thread: 'notice-thread', address: {} }, text: 'Review available', kind: 'notice' });
  } finally { store.close(); }
  assert.equal(runtime.notifications().find(row => row.id === 'local-notice').status, 'pending');
  assert.equal(await runtime.runNext(), null);
  assert.equal(runtime.notifications().find(row => row.id === 'local-notice').status, 'sent');
  runtime.close();
  assert.equal(f.open().notifications().find(row => row.id === 'local-notice').status, 'sent');
});

test('dead execution ownership preserves domain work and blocks implicit replay', options, async t => {
  const f = fixture(t);
  const runtime = f.open();
  const ticket = runtime.submit({ text: 'Interrupted domain work' });
  const domain = runtime.getDomainTicket(ticket.id);
  runtime.close();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'close');
  const store = new Store(f.path);
  try {
    store.atomic(() => {
      domain.assignments.at(-1).state = 'running';
      store.tickets.save(domain);
      store.setMeta('execution', { token: 'old-token', pid, host: hostname(), publicId: ticket.id, ticketId: domain.id, assignmentId: domain.assignments.at(-1).id, runId: 'old-run' });
    });
  } finally { store.close(); }
  let calls = 0;
  const reopened = f.open({ async run() { calls++; return { status: 'completed', summary: 'Retried' }; } });
  assert.equal(reopened.get(ticket.id).status, 'interrupted');
  assert.equal(await reopened.runNext(), null);
  assert.equal(calls, 0);
  reopened.retry(ticket.id);
  assert.equal((await reopened.runNext()).status, 'completed');
  assert.equal(calls, 1);
});

test('a killed worker process leaves a recoverable hold instead of replaying its task', options, async t => {
  const f = fixture(t);
  f.open().close();
  const moduleUrl = new URL('./helpers/runtime-fixture.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createProjectAgent } from ${JSON.stringify(moduleUrl)};
    const runtime = createProjectAgent({ projectRoot: process.argv[1], driver: {
      async run({ ticket }) {
        process.stdout.write(JSON.stringify({ id: ticket.id }) + '\\n');
        await new Promise(() => {});
      }
    }}).init();
    runtime.submit({ text: 'Work interrupted by process loss' });
    await runtime.runNext();
  `, f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  const ticket = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
    });
    child.once('error', reject);
    child.once('exit', code => { if (!output) reject(new Error(`Worker exited before execution: ${code}`)); });
  });
  const exited = once(child, 'close');
  child.kill('SIGKILL');
  await exited;
  let calls = 0;
  const recovered = f.open({ async run() { calls++; return { status: 'completed', summary: 'Explicitly retried' }; } });
  assert.equal(recovered.get(ticket.id).status, 'interrupted');
  assert.equal(await recovered.runNext(), null);
  assert.equal(calls, 0);
  recovered.retry(ticket.id);
  assert.equal((await recovered.runNext()).status, 'completed');
  assert.equal(calls, 1);
});

test('ordinary results and questions produce durable delivered local notifications', options, async t => {
  const f = fixture(t);
  let calls = 0;
  const runtime = f.open({ async run() {
    return ++calls === 1 ? { status: 'waiting', summary: 'Which format?' } : { status: 'completed', summary: 'Final report is ready' };
  } });
  const ticket = runtime.submit({ text: 'Produce a report' });
  assert.equal((await runtime.runNext()).status, 'waiting');
  assert.ok(runtime.notifications().some(receipt => receipt.text === 'Which format?' && receipt.status === 'sent'));
  runtime.reply(ticket.id, 'Plain text');
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.ok(runtime.notifications().some(receipt => receipt.text === 'Final report is ready' && receipt.status === 'sent'));
  const receipts = runtime.notifications();
  runtime.close();
  assert.deepEqual(f.open().notifications(), receipts);
});

test('a result commit failure holds completed external work for inspection instead of replay', options, async t => {
  const f = fixture(t);
  let calls = 0;
  const runtime = f.open({ async run() { calls++; return { status: 'completed', summary: 'External operation already finished' }; } });
  const ticket = runtime.submit({ text: 'Work with an external effect' });
  const original = Store.prototype.setMeta;
  let injected = false;
  Store.prototype.setMeta = function (key, value) {
    if (!injected && key === `ticket:${ticket.id}` && value.reports?.length > 0) {
      injected = true;
      throw new Error('Injected result commit failure');
    }
    return original.call(this, key, value);
  };
  try { await assert.rejects(runtime.runNext(), /Injected result commit failure/); }
  finally { Store.prototype.setMeta = original; }
  assert.equal(injected, true);
  assert.equal(runtime.get(ticket.id).status, 'interrupted');
  assert.equal(runtime.getDomainTicket(ticket.id).ended, undefined);
  assert.equal(runtime.getDomainTicket(ticket.id).assignments.at(-1).report.state, 'failed');
  assert.equal(await runtime.runNext(), null);
  assert.equal(calls, 1);
  assert.ok(runtime.get(ticket.id).reports.every(report => report.status !== 'completed'));
  runtime.retry(ticket.id);
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.equal(calls, 2);
});

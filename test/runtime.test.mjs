import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-test-'));
  const runtimes = [];
  t.after(() => {
    for (const runtime of runtimes.reverse()) runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open(driver) {
      const runtime = createProjectAgent({ projectRoot: root, driver }).init();
      runtimes.push(runtime);
      return runtime;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function started(condition) {
  while (!condition()) await new Promise(resolve => setTimeout(resolve, 5));
}

async function deadline(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test operation timed out')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('initializes a plain directory idempotently and preserves project identity', t => {
  const fixture = project(t);
  const runtime = fixture.open();
  const configPath = join(stateDir(fixture.root), 'config.json');
  const original = readFileSync(configPath, 'utf8');
  assert.equal(runtime.init(), runtime);
  runtime.close();
  const reopened = fixture.open();
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.equal(reopened.projectId, runtime.projectId);
  assert.equal(existsSync(join(fixture.root, 'package.json')), false);
  assert.equal(existsSync(join(fixture.root, '.git')), false);
  assert.match(readFileSync(join(stateDir(fixture.root), '.gitignore'), 'utf8'), /state\.sqlite\*/);
});

test('tickets, original scope, messages and reports survive reopening', async t => {
  const fixture = project(t);
  const runtime = fixture.open({ run: async () => ({ status: 'completed', summary: 'Done', artifacts: ['result.txt'] }) });
  const ticket = runtime.submit({ text: 'Create a result', scope: 'Only result.txt' });
  runtime.reply(ticket.id, 'Use plain text');
  const result = await runtime.runNext();
  runtime.close();
  const reopened = fixture.open();
  assert.deepEqual(reopened.get(ticket.id), result);
  assert.equal(result.scope, 'Only result.txt');
  assert.equal(result.messages.length, 2);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.reports[0].artifacts, ['result.txt']);
  assert.equal(result.reports[0].runId, result.runId);
});

test('waiting ticket resumes on an answer with prior context and a new run identity', async t => {
  const fixture = project(t);
  const received = [];
  const runtime = fixture.open({ run: async input => {
    received.push(input);
    return received.length === 1
      ? { status: 'waiting', summary: 'Which format?' }
      : { status: 'completed', summary: 'Plain text delivered' };
  } });
  const ticket = runtime.submit({ text: 'Produce a report' });
  const waiting = await runtime.runNext();
  assert.equal(waiting.status, 'waiting');
  assert.equal(await runtime.runNext(), null);
  assert.equal(runtime.reply(ticket.id, 'Plain text').status, 'queued');
  const done = await runtime.runNext();
  assert.equal(done.status, 'completed');
  assert.notEqual(waiting.runId, done.runId);
  assert.equal(received[1].ticket.messages[1].text, 'Plain text');
  assert.equal(received[1].ticket.reports[0].summary, 'Which format?');
  assert.equal(received[0].runId, waiting.runId);
  assert.equal(received[0].projectRoot, runtime.projectRoot);
});

test('input appended during execution is preserved and schedules the next turn', async t => {
  const fixture = project(t);
  const gate = deferred();
  const received = [];
  const runtime = fixture.open({ run: async input => {
    received.push(input);
    if (received.length === 1) await gate.promise;
    return { status: 'completed', summary: 'Turn finished' };
  } });
  const ticket = runtime.submit({ text: 'Work' });
  const running = runtime.runNext();
  try {
    await deadline(started(() => received.length === 1));
    runtime.reply(ticket.id, 'Also retain the original file');
    assert.equal(runtime.get(ticket.id).status, 'running');
    assert.equal(received[0].ticket.messages.length, 1);
  } finally { gate.resolve(); }
  assert.equal((await running).status, 'queued');
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.equal(received[1].ticket.messages.length, 2);
});

test('two runtimes cannot execute concurrent tickets in the same project', async t => {
  const fixture = project(t);
  const gate = deferred();
  let firstCalls = 0, secondCalls = 0;
  const first = fixture.open({ run: async () => { firstCalls++; await gate.promise; return { status: 'completed', summary: 'First done' }; } });
  const second = fixture.open({ run: async () => { secondCalls++; return { status: 'completed', summary: 'Second done' }; } });
  first.submit({ text: 'First' });
  const next = first.submit({ text: 'Second' });
  const running = first.runNext();
  try {
    await deadline(started(() => firstCalls === 1));
    assert.equal(await first.runNext(), null);
    await assert.rejects(second.runNext(), { code: 'PROJECT_EXECUTION_ACTIVE' });
    assert.equal(secondCalls, 0);
    assert.throws(() => first.close(), /Cancel active work/);
  } finally { gate.resolve(); await running; }
  assert.equal((await second.runNext()).id, next.id);
  assert.equal(secondCalls, 1);
});

test('different projects retain separate identities and can execute independently', async t => {
  const firstFixture = project(t);
  const secondFixture = project(t);
  const gate = deferred();
  const first = firstFixture.open({ run: async () => { await gate.promise; return { status: 'completed', summary: 'First' }; } });
  const second = secondFixture.open({ run: async input => ({ status: 'completed', summary: input.projectRoot }) });
  const firstTicket = first.submit({ text: 'A' });
  const secondTicket = second.submit({ text: 'B' });
  const running = first.runNext();
  try {
    assert.notEqual(first.projectId, second.projectId);
    assert.equal((await second.runNext()).id, secondTicket.id);
    assert.throws(() => second.get(firstTicket.id), /Unknown ticket/);
    assert.equal(first.get(firstTicket.id).status, 'running');
    assert.equal(second.list().length, 1);
  } finally { gate.resolve(); await running; }
});

test('driver failure is durable and retry creates a new run', async t => {
  const fixture = project(t);
  let calls = 0;
  const runtime = fixture.open({ run: async () => {
    if (++calls === 1) throw new Error('Provider unavailable');
    return { status: 'completed', summary: 'Recovered' };
  } });
  const ticket = runtime.submit({ text: 'Work' });
  const failed = await runtime.runNext();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reports[0].summary, 'Provider unavailable');
  assert.equal(await runtime.runNext(), null);
  assert.equal(runtime.retry(ticket.id).status, 'queued');
  const done = await runtime.runNext();
  assert.equal(done.status, 'completed');
  assert.notEqual(done.runId, failed.runId);
  assert.equal(done.reports.length, 2);
});

test('cancellation through a second runtime signals driver and waits for it to settle', async t => {
  const fixture = project(t);
  const aborted = deferred();
  const release = deferred();
  let entered = false;
  const worker = fixture.open({ run: async ({ signal }) => {
    entered = true;
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await release.promise;
    return { status: 'completed', summary: 'Driver settled after cancellation' };
  } });
  const client = fixture.open();
  const ticket = worker.submit({ text: 'Long task' });
  const running = worker.runNext();
  try {
    await deadline(started(() => entered));
    const cancellation = client.cancel(ticket.id);
    assert.equal(cancellation.status, 'running');
    assert.equal(cancellation.cancelRequested, true);
    await deadline(aborted.promise);
    assert.equal(client.get(ticket.id).status, 'running');
    assert.throws(() => client.retry(ticket.id), /Cannot retry running/);
  } finally { release.resolve(); await running; }
  assert.equal(client.get(ticket.id).status, 'cancelled');
  assert.equal(client.retry(ticket.id).cancelRequested, false);
});

test('a dead owner becomes interrupted and requires explicit retry', async t => {
  const fixture = project(t);
  const runtime = fixture.open();
  const ticket = runtime.submit({ text: 'Interrupted work' });
  runtime.close();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid;
  await once(child, 'close');
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  const store = new Store(join(stateDir(fixture.root), 'state.sqlite'));
  try {
    const meta = store.getMeta(`ticket:${ticket.id}`);
    const domain = store.tickets.get(meta.domainId);
    domain.assignments.at(-1).state = 'running';
    store.tickets.save(domain);
    meta.runId = 'old-run'; store.setMeta(`ticket:${ticket.id}`, meta);
    store.setMeta('execution', { publicId: ticket.id, ticketId: domain.id, assignmentId: domain.assignments.at(-1).id,
      runId: 'old-run', token: 'crashed', pid: deadPid, host: hostname() });
  } finally { store.close(); }
  let calls = 0;
  const reopened = fixture.open({ run: async () => { calls++; return { status: 'completed', summary: 'Retried' }; } });
  assert.equal(reopened.get(ticket.id).status, 'interrupted');
  assert.equal(await reopened.runNext(), null);
  assert.equal(calls, 0);
  reopened.retry(ticket.id);
  const done = await reopened.runNext();
  assert.equal(done.status, 'completed');
  assert.notEqual(done.runId, 'old-run');
  assert.equal(done.reports[0].status, 'interrupted');
});

test('invalid reports fail explicitly instead of completing a ticket', async t => {
  const fixture = project(t);
  const reports = [undefined, { status: 'queued', summary: 'Bad status' }, { status: 'completed', summary: '' }, { status: 'completed', summary: 'Bad artifacts', artifacts: [42] }];
  const runtime = fixture.open({ run: async () => reports.shift() });
  for (let i = 0; i < 4; i++) {
    runtime.submit({ text: `Invalid report ${i}` });
    const result = await runtime.runNext();
    assert.equal(result.status, 'failed');
    assert.ok(result.reports[0].summary.length > 0);
  }
});

test('unknown tickets and unavailable drivers produce actionable errors', async t => {
  const fixture = project(t);
  const runtime = fixture.open();
  assert.throws(() => runtime.get('unknown'), /Unknown ticket/);
  assert.throws(() => runtime.submit({ text: ' ' }), /non-empty/);
  assert.equal(await runtime.runNext(), null);
  const ticket = runtime.submit({ text: 'Queued task' });
  assert.equal(runtime.cancel(ticket.id).status, 'cancelled');
  assert.throws(() => runtime.reply(ticket.id, 'More'), /Cannot reply/);
  runtime.submit({ text: 'Needs an executor' });
  await assert.rejects(runtime.runNext(), /No Harness configured/);
});

test('failed initialization releases its connection and can be retried after state repair', t => {
  const fixture = project(t);
  const runtime = fixture.open();
  const ticket = runtime.submit({ text: 'Keep this task' });
  runtime.close();
  const store = new Store(join(stateDir(fixture.root), 'state.sqlite'));
  try {
    const meta = store.getMeta(`ticket:${ticket.id}`);
    store.db.prepare('UPDATE kv SET data = ? WHERE key = ?').run('invalid JSON', `ticket:${ticket.id}`);
    assert.throws(() => runtime.init(), SyntaxError);
    assert.throws(() => runtime.list(), /Call init/);
    store.setMeta(`ticket:${ticket.id}`, meta);
    runtime.init();
    assert.deepEqual(runtime.get(ticket.id), ticket);
  } finally { store.close(); }
});

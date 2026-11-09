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

const options = { timeout: 5000 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const session = { driver: 'fixture', id: 'session-1' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-session-'));
  const runtimes = [], children = [];
  // stop() waits for owned guardians, so they must be gone before the runtimes stop.
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill('SIGKILL'); await exited; }
    for (const runtime of runtimes.reverse()) { await runtime.stop(); runtime.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, path: join(stateDir(root), 'state.sqlite'),
    open(driver) { const runtime = createProjectAgent({ projectRoot: root, driver }).init(); runtimes.push(runtime); return runtime; },
    guardian() { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(child); return child; },
  };
}

test('checkpoint is durable before completion and resumes the same session after reply and reopen', options, async t => {
  const f = fixture(t);
  const runtime = f.open({ async run(input) {
    assert.equal(input.session, undefined);
    input.checkpoint(session);
    const observer = f.open();
    assert.deepEqual(observer.getSession(input.ticket.id), session);
    return { status: 'waiting', summary: 'Which format?' };
  } });
  const ticket = runtime.submit({ text: 'Write a report' });
  assert.equal(runtime.getSession(ticket.id), null);
  assert.equal((await runtime.runNext()).status, 'waiting');
  runtime.close();
  const reopened = f.open({ async run(input) {
    assert.deepEqual(input.session, session);
    input.session.id = 'mutated-copy';
    assert.deepEqual(reopened.getSession(ticket.id), session);
    assert.equal(input.ticket.messages.at(-1).text, 'Markdown');
    return { status: 'completed', summary: 'Written', session: { driver: 'untrusted', id: 'ignored' } };
  } });
  reopened.reply(ticket.id, 'Markdown');
  assert.equal((await reopened.runNext()).status, 'completed');
  assert.deepEqual(reopened.getSession(ticket.id), session);
});

test('stop persists native session and retry after reopen resumes it', options, async t => {
  const f = fixture(t), entered = deferred();
  const runtime = f.open({ async run(input) {
    input.checkpoint(session); entered.resolve();
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    assert.throws(() => input.checkpoint({ driver: 'fixture', id: 'too-late' }), /Stale or stopped/);
    throw new Error('Stopped');
  } });
  const ticket = runtime.submit({ text: 'Long task' });
  const run = runtime.runNext(); await entered.promise;
  await runtime.stop(); await run;
  assert.equal(runtime.get(ticket.id).status, 'interrupted');
  runtime.close();
  const reopened = f.open({ async run(input) {
    assert.deepEqual(input.session, session);
    return { status: 'completed', summary: 'Resumed' };
  } });
  assert.equal(await reopened.runNext(), null);
  reopened.retry(ticket.id);
  assert.equal((await reopened.runNext()).status, 'completed');
});

test('cancelled explicit retry keeps native session under a fresh mandate', options, async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  let calls = 0, lateCheckpoint;
  const runtime = f.open({ async run(input) {
    if (++calls === 1) {
      input.checkpoint(session); lateCheckpoint = input.checkpoint; entered.resolve(); await release.promise;
      return { status: 'waiting', summary: 'Cancelled work settled' };
    }
    assert.deepEqual(input.session, session);
    return { status: 'completed', summary: 'Explicitly resumed' };
  } });
  const ticket = runtime.submit({ text: 'Work' });
  const previous = runtime.getDomainTicket(ticket.id);
  const run = runtime.runNext(); await entered.promise;
  runtime.cancel(ticket.id);
  assert.throws(() => lateCheckpoint({ driver: 'fixture', id: 'cancelled-session' }), /Stale or stopped/);
  release.resolve(); await run;
  assert.equal(runtime.get(ticket.id).status, 'cancelled');
  assert.deepEqual(runtime.getSession(ticket.id), session);
  runtime.retry(ticket.id);
  assert.notEqual(runtime.getDomainTicket(ticket.id).id, previous.id);
  assert.equal((await runtime.runNext()).status, 'completed');
});

test('session validation and callbacks reject stale writes after a driver turn settles', options, async t => {
  const f = fixture(t);
  let checkpoint, registerProcess;
  const runtime = f.open({ async run(input) {
    ({ checkpoint, registerProcess } = input);
    for (const value of [null, [], {}, { driver: '', id: 's' }, { driver: 'fixture', id: ' ' }, { ...session, secret: 'no' }]) {
      assert.throws(() => checkpoint(value), /session/);
    }
    assert.throws(() => registerProcess(process.pid), /Guardian pid/);
    assert.throws(() => registerProcess(-1), /Guardian pid/);
    checkpoint(session);
    return { status: 'waiting', summary: 'Waiting' };
  } });
  const ticket = runtime.submit({ text: 'Work' });
  await runtime.runNext();
  assert.throws(() => checkpoint({ driver: 'fixture', id: 'stale' }), /Stale or stopped|execution lease is required/);
  assert.throws(() => registerProcess(123), /Stale or stopped|execution lease is required/);
  assert.deepEqual(runtime.getSession(ticket.id), session);
});

test('callbacks reject a superseded assignment while the old driver is still running', options, async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  let checkpoint, registerProcess;
  const runtime = f.open({ async run(input) {
    ({ checkpoint, registerProcess } = input); checkpoint(session); entered.resolve(); await release.promise;
    return { status: 'completed', summary: 'Late completion' };
  } });
  const ticket = runtime.submit({ text: 'Work' });
  const run = runtime.runNext(); await entered.promise;
  const store = new Store(f.path);
  try {
    store.atomic(() => {
      const domain = runtime.getDomainTicket(ticket.id);
      domain.assignments.at(-1).state = 'ended';
      domain.assignments.push({ id: 'replacement', state: 'pending', createdAt: new Date().toISOString() });
      store.tickets.save(domain);
    });
    assert.throws(() => checkpoint({ driver: 'fixture', id: 'stale' }), /Stale or stopped/);
    assert.throws(() => registerProcess(123), /Stale or stopped/);
  } finally { store.close(); release.resolve(); }
  await assert.rejects(run, /Stale run result/);
  assert.deepEqual(runtime.getSession(ticket.id), session);
});

test('dead parent and supervisor cannot release project ownership while the registered CLI remains alive', options, async t => {
  const f = fixture(t);
  const owner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = owner.pid; await once(owner, 'close');
  const guardian = f.guardian();
  const initial = f.open(), ticket = initial.submit({ text: 'Work guarded after parent exit' });
  const domain = initial.getDomainTicket(ticket.id); initial.close();
  const store = new Store(f.path);
  try {
    store.atomic(() => {
      domain.assignments.at(-1).state = 'running'; store.tickets.save(domain);
      const meta = store.getMeta(`ticket:${ticket.id}`); meta.driverSession = session; store.setMeta(`ticket:${ticket.id}`, meta);
      store.setMeta('execution', { token: 'dead-parent', pid: deadPid, host: hostname(), guardian: { pid: deadPid, host: hostname() },
        guardians: [{ pid: deadPid, host: hostname() }, { pid: guardian.pid, host: hostname() }],
        publicId: ticket.id, ticketId: domain.id, assignmentId: domain.assignments.at(-1).id, runId: 'old-run' });
    });
  } finally { store.close(); }
  let calls = 0;
  const recovered = f.open({ async run(input) { calls++; assert.deepEqual(input.session, session); return { status: 'completed', summary: 'Resumed safely' }; } });
  assert.equal(recovered.get(ticket.id).status, 'running');
  await assert.rejects(recovered.runNext(), { code: 'PROJECT_EXECUTION_ACTIVE' });
  assert.equal(calls, 0);
  const exited = once(guardian, 'close'); guardian.kill('SIGTERM'); await exited;
  assert.equal(await recovered.runNext(), null);
  assert.equal(recovered.get(ticket.id).status, 'interrupted');
  recovered.retry(ticket.id);
  assert.equal((await recovered.runNext()).status, 'completed');
  assert.equal(calls, 1);
});

test('process registration is cumulative and idempotent, retaining every owner until exit', options, async t => {
  const f = fixture(t);
  const guardian = f.guardian(), cli = f.guardian();
  const runtime = f.open({ async run(input) {
    input.registerProcess(guardian.pid); input.registerProcess(guardian.pid);
    input.registerProcess(cli.pid);
    const store = new Store(f.path);
    try {
      const owner = ({ pid, host }) => ({ pid, host });
      assert.deepEqual(owner(store.getMeta('execution').guardian), { pid: guardian.pid, host: hostname() });
      assert.deepEqual(store.getMeta('execution').guardians.map(owner), [{ pid: guardian.pid, host: hostname() }, { pid: cli.pid, host: hostname() }]);
    }
    finally { store.close(); }
    const exited = once(guardian, 'close'); guardian.kill('SIGTERM'); await exited;
    const cliExited = once(cli, 'close'); cli.kill('SIGTERM'); await cliExited;
    return { status: 'completed', summary: 'All owned work settled' };
  } });
  runtime.submit({ text: 'Guarded work' });
  assert.equal((await runtime.runNext()).status, 'completed');
});

test('a driver that settles with live owned work cannot release the project slot or record success', options, async t => {
  const f = fixture(t);
  const cli = f.guardian();
  const runtime = f.open({ async run(input) {
    input.registerProcess(cli.pid);
    return { status: 'completed', summary: 'Incorrectly claimed completion' };
  } });
  const ticket = runtime.submit({ text: 'Work with durable child ownership' });
  await assert.rejects(runtime.runNext(), /owned processes are still alive/);
  assert.equal(runtime.getDomainTicket(ticket.id).ended, undefined);
  assert.ok(runtime.get(ticket.id).reports.every(report => report.status !== 'completed'));
  let calls = 0;
  const other = f.open({ async run() { calls++; return { status: 'completed', summary: 'Must not run' }; } });
  await assert.rejects(other.runNext(), { code: 'PROJECT_EXECUTION_ACTIVE' });
  assert.equal(calls, 0);
  const store = new Store(f.path);
  try { assert.equal(store.getMeta('execution').guardians[0].pid, cli.pid); }
  finally { store.close(); }
  const exited = once(cli, 'close'); cli.kill('SIGTERM'); await exited;
});

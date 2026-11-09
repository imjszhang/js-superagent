import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

async function bounded(promise, message, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-process-'));
  const runtimes = [];
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await bounded(child.exited, 'Child did not stop during cleanup', 3000);
    }
    for (const runtime of runtimes.reverse()) { await runtime.stop(); runtime.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open(driver) {
      const runtime = createProjectAgent({ projectRoot: root, driver }).init();
      runtimes.push(runtime);
      return runtime;
    },
    worker() {
      const script = join(root, 'worker.mjs');
      writeFileSync(script, `
import { createProjectAgent } from ${JSON.stringify(new URL('./helpers/runtime-fixture.mjs', import.meta.url).href)};
const runtime = createProjectAgent({
  projectRoot: process.argv[2],
  driver: {
    async run({ ticket, runId, assignmentId, signal }) {
      await new Promise(resolve => {
        signal.addEventListener('abort', () => {
          process.send({ type: 'aborted', runId });
          resolve();
        }, { once: true });
        process.send({ type: 'started', ticketId: ticket.id, runId, assignmentId, messages: ticket.messages });
      });
      return { status: 'completed', summary: 'Owned process observed cancellation and stopped.' };
    },
  },
}).init();
try {
  const result = await runtime.runNext();
  process.send({ type: 'settled', result });
} catch (error) {
  process.send({ type: 'failure', message: String(error.stack ?? error) });
  process.exitCode = 1;
} finally {
  runtime.close();
  process.disconnect();
}
`);
      const child = spawn(process.execPath, [script, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-5000); });
      const messages = [];
      const waiters = new Set();
      child.on('error', error => {
        messages.push({ type: 'failure', message: String(error) });
        for (const notify of [...waiters]) notify();
      });
      child.on('message', message => {
        messages.push(message);
        for (const notify of [...waiters]) notify();
      });
      child.exited = new Promise(resolve => child.once('close', (code, signal) => {
        resolve({ code, signal });
        for (const notify of [...waiters]) notify();
      }));
      child.message = async type => {
        let notify;
        const awaited = new Promise((resolve, reject) => {
          notify = () => {
            const index = messages.findIndex(message => message.type === type);
            if (index >= 0) { resolve(messages.splice(index, 1)[0]); return; }
            const failure = messages.find(message => message.type === 'failure');
            if (failure) { reject(new Error(failure.message)); return; }
            if (child.exitCode !== null || child.signalCode !== null) reject(new Error(`Child exited before ${type}: ${stderr}`));
          };
          waiters.add(notify); notify();
        });
        try { return await bounded(awaited, `Child did not report ${type}: ${stderr}`); }
        finally { waiters.delete(notify); }
      };
      return child;
    },
  };
}

test('separate process holds the project slot until cancellation is observed and execution settles', { timeout: 15000 }, async t => {
  const project = fixture(t);
  let competingCalls = 0;
  const client = project.open({ run: async () => {
    competingCalls++;
    return { status: 'completed', summary: 'Next queued task completed by the parent.' };
  } });
  const first = client.submit({ text: 'Run in the child process' });
  const second = client.submit({ text: 'Wait for the child to finish' });
  const child = project.worker();
  const started = await child.message('started');
  assert.equal(started.ticketId, first.id);
  assert.equal(client.get(first.id).status, 'running');
  await assert.rejects(client.runNext(), { code: 'PROJECT_EXECUTION_ACTIVE' });
  assert.equal(competingCalls, 0);
  const cancelling = client.cancel(first.id);
  assert.equal(cancelling.status, 'running');
  assert.equal(cancelling.cancelRequested, true);
  assert.equal((await child.message('aborted')).runId, started.runId);
  const settled = await child.message('settled');
  assert.equal(settled.result.status, 'cancelled');
  assert.deepEqual(await bounded(child.exited, 'Cancelled worker did not exit'), { code: 0, signal: null });
  assert.equal(client.get(first.id).status, 'cancelled');
  const result = await client.runNext();
  assert.equal(result.id, second.id);
  assert.equal(result.status, 'completed');
  assert.equal(competingCalls, 1);
});

test('a killed worker is held as interrupted until explicit retry preserves pending input', { timeout: 15000 }, async t => {
  const project = fixture(t);
  const initial = project.open();
  const ticket = initial.submit({ text: 'Work that may have external effects' });
  const child = project.worker();
  const started = await child.message('started');
  initial.reply(ticket.id, 'This follow-up arrived after the worker snapshot');
  assert.equal(started.messages.length, 1);
  initial.close();
  child.kill('SIGKILL');
  const exited = await bounded(child.exited, 'Killed worker did not exit');
  assert.equal(exited.signal, 'SIGKILL');

  const received = [];
  const reopened = project.open({ run: async input => {
    received.push(input);
    return { status: 'completed', summary: 'Resumed after inspecting the interrupted execution.' };
  } });
  const interrupted = reopened.get(ticket.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.runId, started.runId);
  assert.equal(interrupted.messages.length, 2);
  assert.equal(interrupted.reports.at(-1).status, 'interrupted');
  assert.equal(await reopened.runNext(), null);
  assert.equal(received.length, 0);

  reopened.retry(ticket.id);
  const result = await reopened.runNext();
  assert.equal(result.status, 'completed');
  assert.equal(received.length, 1);
  assert.notEqual(received[0].runId, started.runId);
  assert.notEqual(received[0].assignmentId, started.assignmentId);
  assert.equal(received[0].ticket.messages[1].text, 'This follow-up arrived after the worker snapshot');
  const domain = reopened.getDomainTicket(ticket.id);
  assert.equal(domain.assignments.length, 2);
  assert.equal(domain.assignments[0].state, 'ended');
  assert.equal(domain.assignments[1].state, 'ended');
  assert.ok(domain.inputs.filter(input => input.kind === 'trigger').every(input => input.readAt));
});

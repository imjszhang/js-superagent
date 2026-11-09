import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { MACHINE_DEPENDENCIES } from '../src/runtime/machine-guard.mjs';
import { createMachineCoordinator } from '../src/machine-coordination.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); } assert.fail('Timed out waiting for isolated runtime state'); }
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-multi-slots-'))), directory = join(base, 'machine'), runtimes = [];
  const machine = createMachineCoordinator({}, { directory }); machine.setLimits({ maxActiveExecutions: 1 });
  t.after(async () => { for (const runtime of runtimes) { await runtime.stop(); runtime.close(); } rmSync(base, { recursive: true, force: true }); });
  return { machine, runtime(name, driver) {
    const root = join(base, name); mkdirSync(root); writeFileSync(join(root, 'example.txt'), 'original\n');
    const runtime = createProjectAgent({ projectRoot: root, workspace: 'copy', driver, [MACHINE_DEPENDENCIES]: { directory } }).init(); runtimes.push(runtime); return runtime;
  } };
}
function children(runtime) {
  runtime.configureJobs({ paths: ['example.txt'], profiles: { child: { kind: 'agent', version: '1', instruction: 'Read example.txt and report the result.', paths: ['example.txt'] } },
    childExecution: { driver: 'fixture' } }, { expectedRevision: 0 });
}

test('two project runtimes share one machine model slot; a queued ticket can be cancelled without running its model', { timeout: 12000 }, async t => {
  const f = fixture(t), release = deferred(); let enteredA = 0, enteredB = 0;
  const a = f.runtime('a', { async run() { enteredA++; await release.promise; return { status: 'completed', summary: 'A complete' }; } });
  const b = f.runtime('b', { async run() { enteredB++; return { status: 'completed', summary: 'B complete' }; } });
  t.after(() => release.resolve());
  const ta = a.submit({ text: 'A' }), tb = b.submit({ text: 'B' }); const workA = a.runNext(); await until(() => enteredA === 1);
  const workB = b.runNext(); await until(() => b.machineStatus().waiting.length === 1);
  assert.equal(enteredB, 0); assert.equal(f.machine.status().slots.filter(slot => slot.active).length, 1);
  b.cancel(tb.id); await workB; assert.equal(b.get(tb.id).status, 'cancelled'); assert.equal(enteredB, 0);
  release.resolve(); await workA; assert.equal(a.get(ta.id).status, 'completed'); assert.equal(f.machine.status().slots.length, 0);
});

test('a real runtime parent yields the one machine model slot to its child then resumes', { timeout: 12000 }, async t => {
  const f = fixture(t), order = [];
  const runtime = f.runtime('parent', { async run(input) {
    if (input.ticket.text === 'parent') {
      order.push('parent-start'); const child = input.jobs.launch({ profileId: 'child' }); const result = await input.jobs.wait(child.id);
      assert.equal(result.status, 'completed'); order.push('parent-resumed');
    } else { order.push('child'); assert.equal(f.machine.status().slots.filter(slot => slot.active).length, 1); }
    return { status: 'completed', summary: 'Verified' };
  } });
  children(runtime); const ticket = runtime.submit({ text: 'parent' }); await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'completed'); assert.deepEqual(order, ['parent-start', 'child', 'parent-resumed']); assert.equal(f.machine.status().slots.length, 0);
});

test('cancelling a parent during child wait settles active and suspended slots', { timeout: 12000 }, async t => {
  const f = fixture(t); let childStarted = false;
  const runtime = f.runtime('cancel-parent', { async run(input) {
    if (input.ticket.text === 'parent') { const child = input.jobs.launch({ profileId: 'child' }); await input.jobs.wait(child.id); }
    else { childStarted = true; await new Promise(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener('abort', resolve, { once: true })); }
    return { status: 'completed', summary: 'Stopped' };
  } });
  children(runtime); const ticket = runtime.submit({ text: 'parent' }); const work = runtime.runNext(); await until(() => childStarted);
  runtime.cancel(ticket.id); await work;
  assert.equal(runtime.get(ticket.id).status, 'cancelled'); assert.equal(f.machine.status().slots.length, 0); assert.equal(f.machine.status().leases.length, 0);
});
test('finite machine capacity rejects a child wait that explicitly keeps the parent model slot', { timeout: 12000 }, async t => {
  const f = fixture(t); let rejection;
  const runtime = f.runtime('unsafe-wait', { async run(input) {
    if (input.ticket.text === 'parent') {
      const child = input.jobs.launch({ profileId: 'child' });
      try { await input.jobs.wait(child.id, { releaseSlot: false }); } catch (error) { rejection = error; }
      assert.ok(rejection, 'Unsafe wait must fail rather than deadlock');
    }
    return { status: 'completed', summary: 'Complete' };
  } });
  children(runtime); runtime.submit({ text: 'parent' }); await runtime.runNext();
  assert.match(rejection.message, /slot|capacity|handoff|releaseSlot/i); assert.equal(f.machine.status().slots.length, 0);
});

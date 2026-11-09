import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createProjectAgent as createRuntime, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await delay(10); } assert.fail('Timed out'); }
function setup(t, { accepted = false, failed = false, proveRead = false, builtin = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'js-w10-cross-run-'));
  let current, sends = 0, release;
  const runs = [], inspections = [], done = new Promise(resolve => { release = resolve; });
  const driver = { reportVersion: 2, capabilities: { realtimeInput: true, inputAcknowledgements: true },
    async run(input) {
      current = input; runs.push(input);
      input.checkpoint(input.session ?? { driver: builtin ? 'codex-app-server' : 'fixture', id: `native-${runs.length}` });
      if (runs.length === 1) { await done; if (failed) throw new Error('Native execution disconnected'); }
      return { version: 2, state: 'ready', summary: 'Finished' };
    },
    async sendInput({ inputId }) {
      sends++;
      if (!accepted) throw new Error('Transport acknowledgement was lost');
      return { accepted: true, read: false, inputId, sessionId: 'native-1', turnId: 'turn-1' };
    },
    async inspectRecovery(input) {
      inspections.push(input);
      return proveRead ? { version: 1, kind: 'interrupted', safeToResume: true, toolsSettled: true, session: input.session,
        checkpoint: { runId: input.runId, eventSequence: 3 }, code: 'HISTORY_VERIFIED', outcome: 'resume', readInputIds: input.inputs.map(item => item.inputId) } : null;
    },
  };
  const registry = builtin ? createHarnessRegistry() : null;
  const runtime = builtin ? createRuntime({ projectRoot: root, execution: { driver: 'codex-app-server', executable: 'must-not-launch-native-cli' },
    harnessRegistry: { ...registry, createDriver: () => driver,
      describeExecution(execution, role) { return { ...registry.describeExecution(execution, role), capabilities: driver.capabilities }; } } }).init()
    : createProjectAgent({ projectRoot: root, driver }).init();
  t.after(async () => { release(); await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const ticket = runtime.submit({ text: 'Initial work' });
  return { runtime, ticket, root, runs, inspections, get sends() { return sends; },
    async first() {
      const running = runtime.runNext(); await until(() => current);
      runtime.reply(ticket.id, 'Cross-run follow-up');
      await until(() => runtime.getDetailed(ticket.id).liveInputs.some(item => ['accepted', 'unknown'].includes(item.status)));
      const row = runtime.getDetailed(ticket.id).liveInputs[0];
      assert.deepEqual(row.session, { driver: builtin ? 'codex-app-server' : 'fixture', id: 'native-1' });
      release(); await running; return row;
    },
  };
}

test('W10 unknown delivery blocks a new native run and remains blocked after manual retry', async t => {
  const f = setup(t), row = await f.first();
  await f.runtime.runNext();
  assert.equal(f.runs.length, 1); assert.equal(f.sends, 1); assert.equal(f.inspections.length, 1);
  assert.equal(f.runtime.get(f.ticket.id).status, 'failed');
  assert.match(f.runtime.get(f.ticket.id).reports.at(-1).summary, /could not be reconciled/);
  assert.equal(f.runtime.getDomainTicket(f.ticket.id).inputs.find(item => item.id === row.inputId).readAt, null);
  f.runtime.retry(f.ticket.id); await f.runtime.runNext();
  assert.equal(f.runs.length, 1); assert.equal(f.inspections.length, 2);
});

test('W10 native proof reconciles the prior stable input before continuing the same session', async t => {
  const f = setup(t, { proveRead: true }), row = await f.first();
  await f.runtime.runNext();
  assert.equal(f.runs.length, 2); assert.equal(f.sends, 1);
  assert.deepEqual(f.runs[1].session, { driver: 'fixture', id: 'native-1' });
  assert.ok(f.runs[1].domainTicket.inputs.find(item => item.id === row.inputId).readAt);
  assert.equal(f.inspections[0].runId, row.runId);
  assert.equal(f.runtime.getDetailed(f.ticket.id).liveInputs[0].status, 'read');
  assert.equal(f.runtime.get(f.ticket.id).status, 'completed');
});

test('W10 explicit session replacement retires old-session uncertainty and leaves an audit record', async t => {
  const f = setup(t), row = await f.first(); await f.runtime.runNext();
  await f.runtime.replaceSession(f.ticket.id, { reason: 'Inspected prior effects; rebuild in a new session', expectedSessionId: 'native-1' });
  await f.runtime.runNext();
  assert.equal(f.runs.length, 2); assert.equal(f.inspections.length, 1); assert.equal(f.runs[1].session, undefined);
  assert.equal(f.runtime.getSession(f.ticket.id).id, 'native-2');
  assert.ok(f.runs[1].ticket.messages.some(message => message.text === 'Cross-run follow-up'));
  assert.ok(f.runtime.getDomainTicket(f.ticket.id).inputs.find(item => item.id === row.inputId).readAt);
  const db = new Store(join(stateDir(f.root), 'state.sqlite'));
  try {
    const retired = db.getMeta(`live-input:${row.runId}:${row.inputId}`), meta = db.getMeta(`ticket:${f.ticket.id}`);
    assert.equal(retired.status, 'unknown');
    assert.equal(retired.supersededBySessionReplacement, meta.sessionHistory.find(item => item.kind === 'replacement-requested').id);
  } finally { db.close(); }
});

test('W10 accepted input without final acknowledgement after a normal turn retains next-turn handling', async t => {
  const f = setup(t, { accepted: true }), row = await f.first();
  assert.notEqual(f.runtime.get(f.ticket.id).status, 'completed'); await f.runtime.runNext();
  assert.equal(f.runs.length, 2); assert.equal(f.inspections.length, 0); assert.equal(f.sends, 1);
  assert.equal(f.runtime.get(f.ticket.id).status, 'completed');
  assert.ok(f.runtime.getDomainTicket(f.ticket.id).inputs.find(item => item.id === row.inputId).readAt);
});

test('W10 accepted input after a failed native turn needs reconciliation before manual retry', async t => {
  const f = setup(t, { accepted: true, failed: true }); await f.first();
  assert.equal(f.runtime.get(f.ticket.id).status, 'failed'); f.runtime.retry(f.ticket.id); await f.runtime.runNext();
  assert.equal(f.runs.length, 1); assert.equal(f.inspections.length, 1); assert.equal(f.sends, 1);
});

test('W10 built-in accepted input after a normal report cannot be redelivered without consumption evidence', async t => {
  const f = setup(t, { accepted: true, builtin: true }), row = await f.first();
  assert.equal(f.runtime.get(f.ticket.id).reports[0].status, 'completed');
  await f.runtime.runNext();
  assert.equal(f.runs.length, 1); assert.equal(f.sends, 1); assert.equal(f.inspections.length, 1);
  assert.equal(f.inspections[0].session.driver, 'codex-app-server');
  assert.equal(f.inspections[0].inputs[0].status, 'accepted');
  assert.equal(f.runtime.get(f.ticket.id).status, 'failed');
  assert.match(f.runtime.get(f.ticket.id).reports.at(-1).summary, /could not be reconciled/);
  assert.equal(f.runtime.getDomainTicket(f.ticket.id).inputs.find(item => item.id === row.inputId).readAt, null);
});

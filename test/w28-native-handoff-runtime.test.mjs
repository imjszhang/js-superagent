import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { validateNativeHandoff } from '../src/drivers/dsh-lease.mjs';
import { Store } from '../src/store.mjs';

const execution = { driver: 'dsh-sdk', executable: '/not-used/dsh-fixture', model: 'fixture-model', timeoutMs: 10000,
  backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://fixture.invalid/anthropic', apiKeyEnv: 'UNUSED_W28_FIXTURE_KEY' } };
const waiting = () => ({ version: 2, state: 'waiting', summary: 'Native work is supervised; a human decision is needed', artifacts: [], attention: { question: 'Which wording should the result use?' } });
const ready = () => ({ version: 2, state: 'ready', summary: 'Consumed the recorded result', artifacts: [], attention: null });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), message);
}
function stored(root, read) {
  const store = new Store(join(stateDir(root), 'state.sqlite'));
  try { return read(store); } finally { store.close(); }
}
async function childOwner() {
  const child = spawn(process.execPath, ['-e', `
    const timer=setTimeout(()=>process.exit(2),10000);
    process.on('message',message=>{
      if(message==='finish'){process.stdout.write('W28_OWNED_RESULT');process.send({type:'settled',stdout:'W28_OWNED_RESULT'});}
      if(message==='shutdown'){clearTimeout(timer);process.exit(0);}
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  await once(child, 'spawn');
  return { child, closed, output: () => output, async close() { if (alive(child.pid)) child.kill('SIGTERM'); await closed; } };
}
function record(input, guardianPid, deadlineAt) {
  return validateNativeHandoff({ version: 1, id: `lease-${input.runId}`, driver: 'dsh-sdk', nativeVersion: '0.2.2-alpha.2',
    ticketId: input.ticket.id, assignmentId: input.assignmentId, originRunId: input.runId,
    session: { driver: 'dsh-sdk', id: 'fixture-session' }, cwd: input.projectRoot, configDigest: 'a'.repeat(64),
    deadlineAt, guardianPids: [guardianPid], jobIds: ['native-job-1'],
    reportBoundary: { state: 'waiting', assistantSequence: 5, terminalSequence: 6, question: 'Which wording?' } });
}
function fixture(t, { hold = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-w28-host-'))), runtimes = [], inputs = [], closes = [];
  let currentRuntime, owner, control, latest, boundTicketId, resumeCalls = 0;
  const registry = createHarnessRegistry();
  const driver = { reportVersion: 2, capabilities: { sessionResume: true, nativeBackgroundOwnership: true }, async run(input) {
    inputs.push(input);
    if (boundTicketId && input.ticket.id !== boundTicketId) return ready();
    boundTicketId ??= input.ticket.id;
    if (input.nativeHandoff.current) return input.nativeHandoff.current.control.resume(input);
    if (input.nativeHandoffResults.length) {
      assert.ok(input.nativeHandoffResults.every(item => !item.consumedAt));
      assert.ok(currentRuntime.getDetailed(input.ticket.id).nativeHandoffs.filter(item => item.results?.length).every(item => !item.consumedAt), 'Providing evidence is not a consumption receipt');
      input.checkpointNative({ nativeHandoffConsumed: input.nativeHandoffResults.map(item => item.id) });
      return ready();
    }
    input.checkpoint({ driver: 'dsh-sdk', id: 'fixture-session' });
    if (!hold) return waiting();
    assert.equal(owner, undefined, 'A second native process must not replace the live owner');
    owner = await childOwner(); input.registerProcess(owner.child.pid);
    const deadlineAt = new Date(Date.now() + 8000).toISOString();
    const transfer = next => {
      const value = record(next, owner.child.pid, deadlineAt);
      assert.equal(next.nativeHandoff.hold(value, control), true);
      latest = { input: next, record: value }; return waiting();
    };
    control = { closed: owner.closed, snapshot: () => structuredClone(latest?.record),
      async close(reason) { closes.push(reason); await owner.close(); },
      async resume(next) {
        resumeCalls++;
        assert.equal(next.assignmentId, latest.input.assignmentId);
        assert.equal(next.nativeHandoff.current.control, control);
        assert.equal(next.nativeHandoff.current.record.id, latest.record.id);
        assert.equal(next.session.id, 'fixture-session');
        assert.notEqual(next.runId, latest.input.runId);
        return transfer(next);
      },
    };
    return transfer(input);
  } };
  const harnessRegistry = { ...registry, createDriver(value, options) {
    assert.equal(value.driver, 'dsh-sdk'); registry.validateExecution(value, options); return driver;
  } };
  function open() {
    currentRuntime = createProjectAgent({ projectRoot: root, execution, harnessRegistry, workspace: { mode: 'copy' } }).init();
    runtimes.push(currentRuntime); return currentRuntime;
  }
  t.after(async () => {
    try { for (const runtime of runtimes.reverse()) { await runtime.stop(); runtime.close(); } }
    finally { await owner?.close(); rmSync(root, { recursive: true, force: true }); }
  });
  return { root, open, inputs, closes, current: () => latest, owner: () => owner, resumeCalls: () => resumeCalls,
    forget(runtime) { runtimes.splice(runtimes.indexOf(runtime), 1); },
    async settle() {
      const observed = once(owner.child, 'message'); owner.child.send('finish');
      const [result] = await observed; assert.equal(result.type, 'settled');
      const event = { type: 'settled', job: { id: 'native-job-1', status: 'completed' }, output: { stdout: result.stdout, exitCode: 0 } };
      latest.input.nativeHandoff.update(latest.record.id, event);
      assert.equal(currentRuntime.getDetailed(boundTicketId).nativeHandoffs.find(item => item.id === latest.record.id).results.length, 1);
      owner.child.send('shutdown'); await owner.closed; await tick();
      assert.equal(owner.output(), 'W28_OWNED_RESULT');
    },
  };
}

test('W28 waiting releases the worker slot while the lease owns its process; replies reuse it and only a receipt consumes saved results', { timeout: 10000 }, async t => {
  const f = fixture(t), runtime = f.open(), ticket = runtime.submit({ text: 'Run a bounded native job and ask for the result wording' });
  await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'waiting'); assert.equal(runtime.getDetailed(ticket.id).attention.question, 'Which wording should the result use?');
  assert.equal(runtime.schedulerStatus().active.length, 0); assert.equal(runtime.status().active, false);
  const first = f.current(), held = runtime.getDetailed(ticket.id).nativeHandoffs[0];
  assert.equal(held.status, 'holding'); assert.equal(held.owner.pid, process.pid); assert.equal(held.owner.host, hostname());
  assert.ok(alive(f.owner().child.pid)); assert.ok(held.guardianPids.includes(f.owner().child.pid));
  const other = runtime.submit({ text: 'Finish another independent task while the first waits' });
  await runtime.runNext(); assert.equal(runtime.get(other.id).status, 'completed'); assert.ok(alive(f.owner().child.pid));
  runtime.reply(ticket.id, 'Use the concise wording, and keep the current native job'); await runtime.runNext();
  assert.equal(f.resumeCalls(), 1); assert.equal(f.current().record.assignmentId, first.record.assignmentId);
  assert.equal(f.current().record.deadlineAt, first.record.deadlineAt); assert.equal(runtime.schedulerStatus().active.length, 0);
  assert.equal(runtime.getDetailed(ticket.id).nativeHandoffs.find(item => item.id === first.record.id).status, 'transferred');
  const callsBeforeResult = f.inputs.length;
  await f.settle(); assert.equal(alive(f.owner().child.pid), false);
  const saved = runtime.getDetailed(ticket.id).nativeHandoffs.find(item => item.id === f.current().record.id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.consumedAt, undefined); assert.equal(saved.results.length, 1);
  assert.equal(runtime.get(ticket.id).status, 'waiting'); assert.equal(runtime.schedulerStatus().active.length, 0);
  await runtime.runNext(); assert.equal(f.inputs.length, callsBeforeResult, 'Job completion must not wake the waiting model');
  runtime.reply(ticket.id, 'Now present the saved result using the agreed wording'); await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'completed'); assert.equal(f.inputs.length, callsBeforeResult + 1);
  assert.equal(f.inputs.at(-1).nativeHandoff.current, undefined); assert.equal(f.inputs.at(-1).nativeHandoffResults.length, 1);
  const consumed = runtime.getDetailed(ticket.id).nativeHandoffs.find(item => item.id === saved.id);
  assert.ok(consumed.consumedAt); assert.equal(consumed.consumedRunId, f.inputs.at(-1).runId);
});

for (const action of ['cancel', 'stop']) test(`W28 ${action} closes native ownership without keeping a worker slot or recreating jobs`, { timeout: 5000 }, async t => {
  const f = fixture(t), runtime = f.open(), ticket = runtime.submit({ text: 'Keep the native job supervised while waiting for a decision' });
  await runtime.runNext(); const pid = f.owner().child.pid;
  if (action === 'cancel') { runtime.cancel(ticket.id); await until(() => !alive(pid), 'Cancellation must close the native owner'); }
  else await runtime.stop();
  assert.equal(alive(pid), false); assert.equal(runtime.schedulerStatus().active.length, 0); assert.equal(f.inputs.length, 1);
  assert.ok(f.closes.length >= 1); assert.equal(runtime.getDetailed(ticket.id).nativeHandoffs.at(-1).status, 'interrupted');
  if (action === 'cancel') assert.equal(runtime.get(ticket.id).status, 'cancelled');
});

test('W28 reopening a lost owner records inspection and cannot recreate native jobs on the next human reply', { timeout: 5000 }, async t => {
  const f = fixture(t, { hold: false }), runtime = f.open(), ticket = runtime.submit({ text: 'Preserve uncertain native work for inspection' });
  await runtime.runNext(); const initial = f.inputs[0], dead = await childOwner();
  await dead.close(); assert.equal(alive(dead.child.pid), false);
  const orphan = { ...record(initial, dead.child.pid, new Date(Date.now() + 10000).toISOString()), status: 'holding',
    owner: { pid: dead.child.pid, host: hostname(), token: 'lost-owner' }, results: [] };
  stored(f.root, store => store.setMeta(`native-handoff:${orphan.id}`, orphan));
  runtime.close(); f.forget(runtime);
  const reopened = f.open();
  await reopened.runNext(); assert.equal(f.inputs.length, 1);
  const recovered = reopened.getDetailed(ticket.id).nativeHandoffs.find(item => item.id === orphan.id);
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.reason, 'native-owner-lost-inspection-required');
  reopened.reply(ticket.id, 'Please inspect the saved result before continuing'); await reopened.runNext();
  assert.equal(f.inputs.length, 1, 'An ownership gap must stop before the native Driver can recreate work');
  const details = reopened.getDetailed(ticket.id);
  assert.equal(details.ticket.status, 'failed'); assert.equal(details.failure.requiresInspection, true);
  assert.match(details.ticket.reports.at(-1).summary, /ownership requires inspection/);
  assert.equal(reopened.schedulerStatus().active.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createManagedJobs, normalizeManagedJobsSettings } from '../src/runtime/jobs.mjs';
import { prepareWorkspace } from '../src/workspaces.mjs';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-jobs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'example.txt'), 'original');
  const workspace = prepareWorkspace({ projectRoot: root, ticketId: 'parent', config: { mode: 'copy' }, persist() {} });
  const records = new Map(), wakes = [], slots = [], controller = new AbortController();
  const options = { projectRoot: root, parent: { ticketId: 'ticket', assignmentId: 'assignment', runId: randomUUID(), workspace, scope: { instruction: 'Modify only example.txt', paths: ['example.txt'] } },
    profiles: { check: { kind: 'command', version: '1', command: process.execPath, args: ['-e', "console.log('checked')"], environment: 'host', allowHostExecution: true },
      child: { kind: 'agent', version: '1', instruction: 'Complete the delegated change and report evidence', paths: ['example.txt'] } },
    journal: { list: () => [...records.values()].map(value => structuredClone(value)), save: value => records.set(value.id, structuredClone(value)) },
    wakeParent: event => wakes.push(event), slotChanged: event => slots.push(event), signal: controller.signal,
    prepareChildWorkspace: ({ jobId }) => prepareWorkspace({ projectRoot: root, ticketId: `child-${jobId}`, config: { mode: 'copy' }, persist() {} }),
    createChildDriver: () => ({ async run({ projectRoot }) { writeFileSync(join(projectRoot, 'example.txt'), 'child change'); return { version: 2, state: 'ready', summary: 'Changed example.txt', artifacts: ['example.txt'] }; } }),
    ...overrides };
  return { root, workspace, options, records, wakes, slots, controller, manager: () => createManagedJobs(options) };
}
async function until(fn, ms = 5000) { const deadline = Date.now() + ms; while (!fn()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('trusted background command persists intent and completion, wakes once and releases wait capacity', async t => {
  const f = fixture(t), manager = f.manager(); t.after(() => manager.close());
  const handle = manager.launch({ profileId: 'check' });
  assert.equal(manager.get(handle.id).status, 'pending');
  const result = await manager.wait(handle.id);
  assert.equal(result.status, 'completed'); assert.equal(result.result.exitCode, 0);
  assert.ok(result.guardians.length >= 2); assert.ok(result.guardians.every(owner => !alive(owner.pid)));
  assert.match(readFileSync(result.result.logs.stdout, 'utf8'), /checked/);
  assert.deepEqual(f.slots.map(event => event.held), [false, true]);
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].parent.assignmentId, 'assignment');
  manager.recover(); assert.equal(f.wakes.length, 1);
});

test('model requests cannot substitute commands or broaden a child path scope', async t => {
  const f = fixture(t), manager = f.manager(); t.after(() => manager.close());
  assert.throws(() => manager.launch({ profileId: 'missing' }), /trusted job profile/);
  assert.throws(() => manager.launch({ profileId: 'check', command: 'arbitrary' }), /trusted profile ID/);
  assert.throws(() => manager.launch({ profileId: 'check', text: 'Run a different command' }), /send only profileId for a command profile/);
  assert.throws(() => manager.launch({ profileId: 'check', paths: ['example.txt'] }), /send only profileId for a command profile/);
  assert.throws(() => manager.launch({ profileId: 'child', text: 'Edit everything', paths: ['.'] }), /parent path scope/);
  assert.throws(() => manager.launch({ profileId: 'child', text: 'Escape', paths: ['../outside'] }), /project-relative/);
  assert.equal(f.records.size, 0);
});

test('child agent uses a separate owned workspace and never silently adopts its changes', async t => {
  const f = fixture(t), manager = f.manager(); t.after(() => manager.close());
  const result = await manager.launch({ profileId: 'child', text: 'Change example.txt' }).done;
  assert.equal(result.status, 'completed'); assert.notEqual(result.workspace.path, f.workspace.path);
  assert.equal(readFileSync(join(result.workspace.path, 'example.txt'), 'utf8'), 'child change');
  assert.equal(readFileSync(join(f.workspace.path, 'example.txt'), 'utf8'), 'original');
  assert.equal(readFileSync(join(f.root, 'example.txt'), 'utf8'), 'original');
  assert.equal(result.changes[0].path, 'example.txt');
});

test('omitted child text uses its trusted instruction without changing request identity or scope', async t => {
  const received=[];
  const f=fixture(t,{createChildDriver:()=>({async run(input){received.push(input.ticket);return{version:2,state:'ready',summary:'Trusted child instruction checked'};}})});
  const manager=f.manager();t.after(()=>manager.close());
  const request=Object.freeze({profileId:'child',paths:['example.txt']});
  const handle=manager.launch(request,{requestId:'default-instruction'}),result=await handle.done;
  assert.equal(result.status,'completed');assert.equal(received[0].text,f.options.profiles.child.instruction);
  assert.match(received[0].scope,/Allowed change paths: example\.txt/);
  assert.equal(result.requestDigest,createHash('sha256').update(JSON.stringify(request)).digest('hex'));
  assert.equal(manager.launch(request,{requestId:'default-instruction'}).id,handle.id);
  assert.throws(()=>manager.launch({...request,text:f.options.profiles.child.instruction},{requestId:'default-instruction'}),/identity conflict/);
  assert.throws(()=>manager.launch({profileId:'child',paths:['.']}),/parent path scope/);
  for(const value of ['',null,undefined,42])assert.throws(()=>manager.launch({profileId:'child',text:value}),/Invalid child task/);
  await manager.launch({profileId:'child',text:'An explicit, narrower task'}).done;
  assert.equal(received[1].text,'An explicit, narrower task');assert.equal(received.length,2);
});

test('shared child workspaces and out-of-scope writes fail before delivery', async t => {
  const shared = fixture(t); shared.options.prepareChildWorkspace = () => shared.workspace;
  const first = shared.manager(); t.after(() => first.close());
  assert.equal((await first.launch({ profileId: 'child', text: 'Change file' }).done).status, 'failed');
  const outside = fixture(t, { createChildDriver: () => ({ async run({ projectRoot }) { writeFileSync(join(projectRoot, 'outside.txt'), 'not authorized'); return { version: 2, state: 'ready', summary: 'Changed outside', artifacts: [] }; } }) });
  const second = outside.manager(); t.after(() => second.close());
  const result = await second.launch({ profileId: 'child', text: 'Only example.txt' }).done;
  assert.equal(result.status, 'failed'); assert.match(result.error, /outside its delegated path scope/);
});

test('job count, concurrent capacity and nested depth are bounded across child managers', async t => {
  const f = fixture(t, { limits: { maxJobs: 2, maxActive: 1, maxDepth: 0 } });
  const manager = f.manager(); t.after(() => manager.close());
  assert.throws(() => manager.launch({ profileId: 'child', text: 'Cannot delegate' }), /depth budget/);
  const one = manager.launch({ profileId: 'check' });
  assert.throws(() => manager.launch({ profileId: 'check' }), /active capacity/);
  await one.done; await manager.launch({ profileId: 'check' }).done;
  assert.throws(() => manager.launch({ profileId: 'check' }), /count budget/);
});

test('nested jobs share the root budget and completion identifies the actual parent', async t => {
  const f = fixture(t, { limits: { maxJobs: 3, maxActive: 2, maxDepth: 1 }, createChildDriver: () => ({ async run({ jobs }) {
    assert.throws(() => jobs.launch({ profileId: 'child', text: 'Another child' }), /depth budget/);
    const check = jobs.launch({ profileId: 'check' });
    assert.equal((await jobs.wait(check.id)).status, 'completed');
    return { version: 2, state: 'ready', summary: 'Nested command verified', artifacts: [] };
  } }) });
  const manager = f.manager(); t.after(() => manager.close());
  const child = manager.launch({ profileId: 'child', text: 'Run the trusted check' });
  assert.equal((await child.done).status, 'completed');
  assert.equal(f.records.size, 2);
  assert.equal(new Set([...f.records.values()].map(record => record.rootRunId)).size, 1);
  assert.equal(f.wakes[0].parent.jobId, child.id);
  assert.equal(f.wakes[1].parent.runId, f.options.parent.runId);
});

test('parent cancellation and human handoff stop owned jobs before releasing them', async t => {
  for (const mode of ['cancel', 'handoff']) await t.test(mode, async t => {
    const f = fixture(t);
    f.options.profiles.check.args = ['-e', 'setInterval(() => {}, 1000)'];
    const manager = f.manager(); t.after(() => manager.close());
    const handle = manager.launch({ profileId: 'check' });
    await until(() => manager.get(handle.id).guardians.length >= 2);
    const result = mode === 'handoff' ? await manager.handoff(handle.id, 'A person must inspect the environment') : (f.controller.abort(), await handle.done);
    assert.equal(result.status, mode === 'handoff' ? 'handed-off' : 'cancelled');
    assert.ok(result.guardians.every(owner => !alive(owner.pid)));
    if (mode === 'handoff') assert.equal(f.slots.at(-1).held, false);
    else assert.throws(() => manager.launch({ profileId: 'check' }), /stopped/);
  });
});

test('timeout is distinct and completion wakes can be durably retried', async t => {
  const f = fixture(t, { limits: { maxDurationMs: 200 }, wakeParent() { throw new Error('local notification store unavailable'); } });
  f.options.profiles.check.args = ['-e', 'setInterval(() => {}, 1000)'];
  const manager = f.manager(); t.after(() => manager.close());
  const result = await manager.launch({ profileId: 'check' }).done;
  assert.equal(result.status, 'timed-out'); assert.equal(result.completion.deliveredAt, null);
  const stableId = result.completion.id;
  const resumed = createManagedJobs({ ...f.options, wakeParent: event => f.wakes.push(event) }); t.after(() => resumed.close());
  resumed.recover(); resumed.recover();
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].id, stableId);
});

test('recovery never replays interrupted commands or adopts unverifiable old owners', async t => {
  const f = fixture(t), manager = f.manager(); t.after(() => manager.close());
  const completed = await manager.launch({ profileId: 'check' }).done;
  const record = { ...completed, status: 'running', completion: undefined, owner: { host: hostname(), pid: 99999999 }, guardians: [] };
  f.records.set(record.id, record);
  assert.equal(manager.recover().interrupted, 1);
  assert.equal(manager.get(record.id).status, 'interrupted');
  record.status = 'running'; record.owner = { host: 'remote-host', pid: 1 }; f.records.set(record.id, record);
  assert.equal(manager.recover().unverifiedOwners, 1);
  assert.equal(manager.get(record.id).status, 'running');
});

test('durable request identity prevents duplicate tool starts and rejects changed payloads', async t => {
  const f = fixture(t), manager = f.manager(); t.after(() => manager.close());
  const first = manager.launch({ profileId: 'check' }, { requestId: 'tool-call-1' });
  assert.equal(manager.launch({ profileId: 'check' }, { requestId: 'tool-call-1' }).id, first.id);
  await first.done;
  const resumed = f.manager(); t.after(() => resumed.close());
  assert.equal(resumed.launch({ profileId: 'check' }, { requestId: 'tool-call-1' }).id, first.id);
  assert.throws(() => resumed.launch({ profileId: 'child', text: 'Different action' }, { requestId: 'tool-call-1' }), /identity conflict/);
  assert.equal(f.records.size, 1);
});

test('all concurrent waits remain blocked until async slot reacquisition completes', async t => {
  let releaseCapacity, reacquiring = false;
  const available = new Promise(resolve => { releaseCapacity = resolve; });
  const f = fixture(t, { slotChanged: async event => { if (event.held) { reacquiring = true; await available; } } });
  const manager = f.manager(); t.after(() => manager.close());
  const first = manager.launch({ profileId: 'check' }), second = manager.launch({ profileId: 'check' });
  let resumed = 0;
  const waits = [manager.wait(first.id).then(() => resumed++), manager.wait(second.id).then(() => resumed++)];
  await until(() => reacquiring);
  assert.equal(resumed, 0); releaseCapacity();
  await Promise.all(waits); assert.equal(resumed, 2);
});

test('managed job configuration is JSON-only, explicit about paths, and normalizes idempotently', () => {
  const raw = { paths: ['src'], profiles: { worker: { kind: 'agent', version: '1', instruction: 'Only edit src', paths: ['src'] } }, childExecution: { driver: 'codex-app-server', enableManagedJobs: true } };
  const normalized = normalizeManagedJobsSettings(raw);
  assert.deepEqual(normalizeManagedJobsSettings(normalized), normalized);
  assert.equal(normalized.limits.maxDurationMs, 30 * 60 * 1000);
  assert.throws(() => normalizeManagedJobsSettings({ profiles: raw.profiles }), /paths/);
  assert.throws(() => normalizeManagedJobsSettings({ ...raw, childExecution: { driver: 'codex', enableManagedJobs: true } }), /app-server/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';
import { assessmentStatus } from '../src/runtime/assessment-status.mjs';
import { refreshState } from '../src/runtime/assessment-refresh.mjs';

const canary = 'SYNTHETIC_INHERITED_FACT', principal = { source: 'local', id: 'operator' };

// Build an inherited body through the public coordinator-note path. A target
// without its own report is not necessarily free of material-derived content.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'assessment-inherited-material-')));
  writeFileSync(join(root, 'notes.md'), canary);
  let heldId, releaseWorker, startedWorker;
  const workerStarted = new Promise(resolve => { startedWorker = resolve; });
  const workerRelease = new Promise(resolve => { releaseWorker = resolve; });
  let eventAction = () => ({ summary: 'No action', actions: [] });
  let assess = () => ({ kind: 'ignore', reason: 'No new work', rules: [] });
  const runtime = createProjectAgent({ projectRoot: root, execution: { driver: 'fixture', enableAgentTools: true },
    driver: { capabilities: { agentTools: true, boundedMaterialReadsVersion: 1, sessionResume: true }, async run(input) {
      const sessionId = `worker-${input.ticket.id}`;
      input.checkpoint({ driver: 'fixture', id: sessionId });
      if (input.ticket.id === heldId) { startedWorker(); await workerRelease; }
      let n = 0;
      const read = ref => input.agentTools.call({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id },
        callId: `read-${++n}`, sessionId, turnId: 'one' });
      await read(input.agentTools.contextResources().find(ref => ref.resource === 'materials' && ref.value.kind === 'directory'));
      await read(input.agentTools.contextResources().find(ref => ref.resource === 'materials' && ref.value.kind === 'file'));
      return { version: 2, state: 'waiting', summary: canary, artifacts: [], attention: null };
    } },
    assessor: { async assess(input) { return assess(input); }, async handleEvent(input) { return eventAction(input); } },
  }).init();
  runtime.configureMaterials({ entries: [{ id: 'project', project: 'self', include: ['notes.md'], views: ['current'], readers: [principal], destinations: [principal] }] }, { expectedRevision: 0 });
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' }, workflowMode: 'continuous' }, { expectedRevision: 0 });
  const store = new Store(join(projectStateDirectory(root), 'state.sqlite'));
  t.after(async () => { releaseWorker(); await runtime.stop(); runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  const submit = text => runtime.submit({ text, operatorNotifications: false, materials: { sources: [{ id: 'project', view: { kind: 'current' } }] } });
  return { root, runtime, store, submit, holdWorker: id => { heldId = id; return workerStarted; }, releaseWorker, setEvent: fn => { eventAction = fn; }, setAssess: fn => { assess = fn; } };
}

test('a reportless target retains inherited body dependencies during candidate assessment', { timeout: 10000 }, async t => {
  const f = fixture(t), source = f.submit('Investigate authorized source facts');
  await f.runtime.runNext();
  const target = f.submit('Use the source facts within the authorized work');
  const started = f.holdWorker(target.id);
  f.setEvent(input => {
    assert.ok(input.context.tickets.some(card => card.id === source.id && card.summary === canary));
    return { summary: 'Transfer the already read facts', actions: [{ kind: 'note', ticketId: target.id, text: canary }] };
  });
  f.runtime.coordinate({ id: 'inherit-approved-facts', text: 'Give the target this source context' });
  const executing = f.runtime.runNext();
  await started;
  const targetBefore = f.runtime.getDomainTicket(target.id);
  assert.equal(targetBefore.assignments.some(assignment => assignment.report), false, 'no target report has been produced');
  const inherited = f.store.getMeta(`ticket:${target.id}`);
  assert.deepEqual(inherited.materialContextFreshSources, [source.id], 'the public note action carries source body provenance');
  const request = f.runtime.request({ text: 'Decide the next routing step using the supplied target', threadId: 'inherited-target-view' });
  // A context-only relation makes the target visible but gives it no ownership
  // of this independent request, matching the existing context fixture contract.
  const thread = f.store.threads.get('local:inherited-target-view');
  thread.subscriptions = [targetBefore.id]; thread.context = [targetBefore.id]; f.store.threads.save(thread);
  let called = false;
  f.setAssess(async input => {
    called = true;
    const card = input.candidate.tickets.find(card => card.id === targetBefore.id);
    assert.equal(card.summary, null);
    assert.ok(card.materialSources.includes(source.id), 'no own report does not turn inherited facts into mere status');
    assert.ok(card.materialMetadataSources.includes(target.id), 'the unused own material binding remains metadata');
    const record = JSON.parse((await input.readContextRecord('tickets', targetBefore.id)).text);
    assert.ok(record.materialSources.includes(source.id), 'the bounded read agrees with the supplied card');
    writeFileSync(join(f.root, 'notes.md'), 'Changed source after the assessment received inherited facts');
    return { kind: 'ignore', reason: 'Would otherwise settle the independent request', rules: [] };
  });
  await f.runtime.runNext();
  assert.ok(called);
  assert.equal(assessmentStatus(f.store, request.triggerId).status, 'evaluating', 'stale inherited facts must not commit a decision');
  assert.equal(refreshState(f.store, request.triggerId).refreshesUsed, 1);
  assert.deepEqual(f.store.getMeta(`ticket:${target.id}`).materialContextContentVersions, inherited.materialContextContentVersions,
    'assessment must not replace inherited evidence with the newest source version');
  f.releaseWorker();
  await executing;
});

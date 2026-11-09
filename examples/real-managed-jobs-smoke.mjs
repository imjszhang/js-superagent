import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs();
// Explicit host-profile and native-model acceptance in a disposable project. No remote messages.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const { Store } = await importFrozenModule(artifact, 'src/store.mjs');
const { projectStateDirectory: stateDir } = await importFrozenModule(artifact, 'src/state-paths.mjs');
const { prepareWorkspace } = await importFrozenModule(artifact, 'src/workspaces.mjs');
const { createCodexAppServerDriver } = await importFrozenModule(artifact, 'src/drivers/codex-app-server.mjs');
const { createManagedJobs } = await importFrozenModule(artifact, 'src/runtime/jobs.mjs');

const root = resolve(values.output);
mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(join(root, 'example.txt'), 'parent-original\n');
const workspace = prepareWorkspace({ projectRoot: root, ticketId: 'acceptance-parent', config: { mode: 'copy' }, persist() {} });
const store = new Store(join(stateDir(root), 'jobs.sqlite'));
const runId = randomUUID(), slots = [];
const evidence = { version: 1, startedAt: new Date().toISOString(), runId, scenarios: [] };
const manager = createManagedJobs({ projectRoot: root,
  parent: { ticketId: 'acceptance-ticket', assignmentId: 'acceptance-assignment', runId, workspace, scope: { instruction: 'Change example.txt only and run verification within the assigned workspace.', paths: ['example.txt'] } },
  profiles: {
    'background-check': { kind: 'command', version: '1', command: process.execPath,
      args: ['-e', "const fs=require('node:fs');if(!fs.readFileSync('example.txt','utf8').includes('parent-original'))process.exit(1);require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log('isolated-background-check-passed');this.close();});"], environment: 'host', allowHostExecution: true },
    'child-change': { kind: 'agent', version: '1', instruction: 'Complete the delegated change and test the file contents. Do not commit, push, or write outside the child workspace.', paths: ['example.txt'], timeoutMs: 180_000 },
    'cancel-check': { kind: 'command', version: '1', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], environment: 'host', allowHostExecution: true },
  },
  journal: { list: () => store.listMeta('job:').map(row => row.value), save: value => store.atomic(() => store.setMeta(`job:${value.id}`, value)) },
  wakeParent: event => store.atomic(() => { if (!store.getMeta(`event:${event.id}`)) store.setMeta(`event:${event.id}`, event); }),
  slotChanged: event => { slots.push({ held: event.held, reason: event.reason }); },
  prepareChildWorkspace: ({ jobId }) => prepareWorkspace({ projectRoot: root, ticketId: `child-${jobId}`, config: { mode: 'copy' }, persist() {} }),
  createChildDriver: () => createCodexAppServerDriver({ timeoutMs: 180_000 }),
});
const save = () => writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
try {
  const background = manager.launch({ profileId: 'background-check' });
  const child = manager.launch({ profileId: 'child-change', text: 'Replace example.txt with exactly child-verified followed by a newline. Run a Node assertion reading the file to verify it contains that exact text. Report the actual check result.' });
  const [backgroundResult, childResult] = await Promise.all([manager.wait(background.id), manager.wait(child.id)]);
  assert.equal(backgroundResult.status, 'completed'); assert.equal(childResult.status, 'completed');
  assert.equal(readFileSync(join(childResult.workspace.path, 'example.txt'), 'utf8'), 'child-verified\n');
  assert.equal(readFileSync(join(workspace.path, 'example.txt'), 'utf8'), 'parent-original\n');
  assert.equal(readFileSync(join(root, 'example.txt'), 'utf8'), 'parent-original\n');
  assert.equal(store.listMeta('event:').length, 2);
  manager.recover(); assert.equal(store.listMeta('event:').length, 2);
  evidence.scenarios.push({ name: 'background-command', id: background.id, status: backgroundResult.status, exitCode: backgroundResult.result.exitCode, completionId: backgroundResult.completion.id },
    { name: 'native-codex-child', id: child.id, status: childResult.status, session: childResult.session, report: childResult.report, childChanged: true, parentUnchanged: true, completionId: childResult.completion.id }); save();
  const cancelled = manager.launch({ profileId: 'cancel-check' });
  const deadline = Date.now() + 10_000;
  while (manager.get(cancelled.id).guardians.length < 2) { if (Date.now() > deadline) throw new Error('Cancellation job did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
  await manager.close();
  const cancelledResult = await cancelled.done; assert.equal(cancelledResult.status, 'cancelled');
  assert.ok(cancelledResult.guardians.every(owner => { try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }));
  evidence.scenarios.push({ name: 'parent-end-cancels-owned-job', id: cancelled.id, status: cancelledResult.status, allOwnersExited: true });
  evidence.slots = slots; evidence.status = 'passed'; evidence.completedAt = new Date().toISOString(); save();
  process.stdout.write(JSON.stringify({ status: evidence.status, scenarios: evidence.scenarios.map(item => item.name), evidencePath: join(root, 'acceptance.json') }) + '\n');
} catch (error) { evidence.status = 'failed'; evidence.error = String(error.message ?? error); save(); throw error; }
finally { await manager.close(); store.close(); }

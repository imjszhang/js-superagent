import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs();
// Real model-initiated managed command and child-agent tools. Uses only this isolated project.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const { Store } = await importFrozenModule(artifact, 'src/store.mjs');
const { projectStateDirectory: stateDir } = await importFrozenModule(artifact, 'src/state-paths.mjs');
const { prepareWorkspace } = await importFrozenModule(artifact, 'src/workspaces.mjs');
const { createManagedJobs, normalizeManagedJobsSettings } = await importFrozenModule(artifact, 'src/runtime/jobs.mjs');
const { createCodexAppServerDriver } = await importFrozenModule(artifact, 'src/drivers/codex-app-server.mjs');

const root = resolve(values.output);
mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(join(root, 'example.txt'), 'parent-original\n');
const workspace = prepareWorkspace({ projectRoot: root, ticketId: 'tool-parent', config: { mode: 'copy' }, persist() {} });
const store = new Store(join(stateDir(root), 'jobs.sqlite'));
const runId = randomUUID(), assignmentId = randomUUID(), events = [], slots = [];
const settings = normalizeManagedJobsSettings({ paths: ['example.txt'], profiles: {
  'background-check': { kind: 'command', version: '1', command: process.execPath, args: ['-e', "const fs=require('fs');if(fs.readFileSync('example.txt','utf8')!=='parent-original\\n')process.exit(1);require('net').createServer().listen(0,'127.0.0.1',function(){console.log('background check passed');this.close();});"], environment: 'host', allowHostExecution: true },
  'child-change': { kind: 'agent', version: '1', instruction: 'Only modify example.txt in the isolated child workspace and verify its contents with Node. Never adopt changes into other workspaces.', paths: ['example.txt'] },
} });
const manager = createManagedJobs({ projectRoot: root, parent: { ticketId: 'tool-ticket', assignmentId, runId, workspace,
  scope: { instruction: 'Run the two trusted job profiles; the child may change example.txt only in its separate workspace. Parent workspace must remain unchanged.', paths: settings.paths } },
  profiles: settings.profiles, limits: settings.limits,
  journal: { list: () => store.listMeta('job:').map(row => row.value), save: record => store.atomic(() => store.setMeta(`job:${record.id}`, record)) },
  wakeParent: event => store.atomic(() => { if (!store.getMeta(`event:${event.id}`)) store.setMeta(`event:${event.id}`, event); }),
  slotChanged: event => slots.push({ held: event.held, reason: event.reason }),
  prepareChildWorkspace: ({ jobId }) => prepareWorkspace({ projectRoot: root, ticketId: `child-${jobId}`, config: { mode: 'copy' }, persist() {} }),
  createChildDriver: () => createCodexAppServerDriver({ timeoutMs: 180_000 }),
});
const evidence = { version: 1, startedAt: new Date().toISOString(), runId, scenarios: [] };
const save = () => writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const driver = createCodexAppServerDriver({ enableManagedJobs: true, timeoutMs: 300_000,
  onEvent: event => { if (event.method === 'item/tool/call') events.push({ tool: event.params.tool, callId: event.params.callId, threadId: event.params.threadId, turnId: event.params.turnId }); } });
try {
  const result = await driver.run({ projectRoot: workspace.path, sourceProjectRoot: root, workspace, runId, assignmentId,
    checkpoint: session => { evidence.session = session; save(); }, registerProcess: pid => { (evidence.owners ??= []).push(pid); save(); },
    jobs: manager, jobProfiles: [
      { id: 'background-check', kind: 'command', description: 'Run a trusted Node file-content check and a local HTTP-port capability check. Takes no task text.' },
      { id: 'child-change', kind: 'agent', description: 'A scoped Codex child changes example.txt in a separate owned workspace.' },
    ], ticket: { text: 'Use the managed job tools to start BOTH background-check and child-change, then wait for both. Tell the child to replace example.txt with exactly child-tool-verified followed by a newline, and run a Node assertion verifying it. Do not edit your parent workspace. Inspect both completion results. Return ready only after both are completed and explain that the child edit remains isolated.',
      scope: 'Only invoke the two listed trusted job profiles. Child changes are restricted to example.txt in its isolated workspace. Preserve the parent workspace.', messages: [], reports: [] } });
  const jobs = manager.list();
  assert.equal(result.state, 'ready'); assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.status === 'completed'));
  const child = jobs.find(job => job.kind === 'agent'), command = jobs.find(job => job.kind === 'command');
  assert.equal(readFileSync(join(child.workspace.path, 'example.txt'), 'utf8'), 'child-tool-verified\n');
  assert.equal(readFileSync(join(workspace.path, 'example.txt'), 'utf8'), 'parent-original\n');
  assert.equal(command.result.exitCode, 0); assert.equal(store.listMeta('event:').length, 2);
  assert.equal(events.filter(event => event.tool === 'js_superagent_job_start').length, 2);
  assert.ok(events.some(event => event.tool === 'js_superagent_job_wait'));
  evidence.status = 'passed'; evidence.report = result; evidence.toolCalls = events; evidence.slots = slots;
  evidence.scenarios = jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, requestId: job.requestId, completionId: job.completion.id,
    ...(job.session ? { childSession: job.session } : {}), ...(job.result ? { exitCode: job.result.exitCode } : {}) }));
  evidence.parentUnchanged = true; evidence.childChangeVerified = true; evidence.completedAt = new Date().toISOString(); save();
  process.stdout.write(JSON.stringify({ status: evidence.status, modelInitiatedStarts: 2, evidencePath: join(root, 'acceptance.json') }) + '\n');
} catch (error) { evidence.status = 'failed'; evidence.error = String(error.message ?? error); evidence.toolCalls = events; save(); throw error; }
finally { await manager.close(); store.close(); }

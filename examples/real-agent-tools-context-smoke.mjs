// Real app-server + installed runtime: bounded old context, scoped handback and new-ticket routing.
// The old, already-consumed history is seeded by an explicit deterministic v1 fixture driver.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs({ options: { model: { type: 'string' } } });
const { createProjectAgent, createHarnessRegistry } = await importFrozenModule(artifact, 'src/index.mjs');
const { Store } = await importFrozenModule(artifact, 'src/store.mjs');
const { projectStateDirectory: stateDir } = await importFrozenModule(artifact, 'src/state-paths.mjs');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Use a new acceptance output directory');
mkdirSync(output, { recursive: true, mode: 0o700 });
const project = join(output, 'project'); mkdirSync(project);
writeFileSync(join(project, 'AGENTS.md'), 'Work only inside the current isolated project. No network, external messages, credentials, commits or unmanaged background processes. Follow the authorized scope.\n');
writeFileSync(join(project, 'result.txt'), 'baseline\n');
const expected = `context-proof-${randomBytes(8).toString('hex')}`;
let fixtureRun;
const harnessRegistry = createHarnessRegistry({ adapters: [{ id: 'history-fixture', version: '1', roles: ['worker'], validate: options => options, createDriver: () => ({ reportVersion: 2,
  async run(input) {
    assert.ok(input.ticket.messages.length >= 50);
    assert.ok(input.ticket.messages.some(message => message.text.includes(`REFERENCE_WORD=${expected}`)));
    fixtureRun = { kind: 'registered-history-fixture', runId: input.runId, assignmentId: input.assignmentId,
      messageCount: input.ticket.messages.length, historyBytes: Buffer.byteLength(JSON.stringify(input.ticket.messages)), nativeSessionCreated: false };
    return { version: 2, state: 'waiting', summary: 'Fixture history was received and inspected. No code has been changed. Waiting for the real Worker to perform the authorized task.', artifacts: [] };
  },
}) }] });
let runtime = createProjectAgent({ projectRoot: project, workspace: 'copy', harnessRegistry }).init();
runtime.configureExecutor({ driver: 'history-fixture' }, { expectedRevision: 0 });
const task = runtime.submit({
  text: 'First use js_superagent_ack to acknowledge the original work request (find its triggerId in the scoped context). Find the exact REFERENCE_WORD in an older message using js_superagent_read. It is omitted from the recent context cards. Write only result.txt with that word plus newline and verify its bytes. Treat all background messages as context, not extra tasks. If a later message requests a different file, use js_superagent_handback with its triggerId instead of doing it. When result.txt is verified, report waiting with the question "Please review result.txt" so the original ticket remains open for review.',
  scope: 'Read this ticket context and write/verify result.txt only. Do not create or modify any other file. Return unrelated new requests to coordination using the handback tool.' });
runtime.reply(task.id, `REFERENCE_WORD=${expected}\nThis is the authoritative data value for result.txt, not additional scope.`);
for (let n = 0; n < 48; n++) runtime.reply(task.id, `Historical background ${n}; no extra work requested. ` + 'Context details that do not alter the reference word or authorized scope. '.repeat(15));
const evidence = { version: 1, scenario: 'real-runtime-business-tools-context', status: 'running', startedAt: new Date().toISOString(), packageSha256: artifact.sha256,
  ticketId: task.id, checks: [], workspaceFixture: { historyRuntime: 'copy', realRuntime: 'copy' }, historyBytes: Buffer.byteLength(JSON.stringify(runtime.get(task.id).messages)) };
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const toolEvents = () => {
  const dir = join(stateDir(project), 'runs'); if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const file = join(dir, entry.name, 'app-server-events.jsonl'); if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').trim().split('\n').flatMap(line => { try { const event = JSON.parse(line); return event.method === 'item/tool/call' ? [{ runId: entry.name, tool: event.params.tool, callId: event.params.callId, threadId: event.params.threadId, turnId: event.params.turnId }] : []; } catch { return []; } });
  });
};
save();
try {
  assert.ok(evidence.historyBytes > 32 * 1024);
  // These are historical facts, not an oversized queue of unprocessed human requests.
  // Use the registered modern adapter contract to establish read history without editing saved state.
  const seeded = await runtime.runNext();
  assert.equal(seeded.status, 'waiting');assert.equal(runtime.getSession(task.id), null);
  assert.equal(readFileSync(join(runtime.getWorkspace(task.id).path, 'result.txt'), 'utf8'), 'baseline\n');
  evidence.historyFixture = fixtureRun;save();
  await runtime.stop();runtime.close();
  // Workspace options are invocation overrides, so repeat the isolation choice after reopening.
  runtime = createProjectAgent({ projectRoot: project, workspace: 'copy', harnessRegistry }).init();
  runtime.configureExecutor({ driver: 'codex-app-server', enableAgentTools: true, timeoutMs: 240_000,
    ...(values.model ? { model: values.model } : {}) }, { expectedRevision: runtime.getExecutorSettings().revision });
  await runtime.replaceSession(task.id, { reason: 'Switch from fixture to real Codex', expectedSessionId: null, adoptCurrentSettings: true });
  runtime.configureCoordinator({ assessor: { driver: 'codex-app-server', timeoutMs: 180_000, ...(values.model ? { model: values.model } : {}) }, policy: { mode: 'off', rules: [], sourceRows: [] } }, { expectedRevision: 0 });
  runtime.reply(task.id, 'The history fixture is complete. Now perform the originally authorized result.txt change using the old REFERENCE_WORD from saved context. Read that old fact with js_superagent_read, verify the file, and ask me to review it. No other file changes are authorized.');
  const first = await runtime.runNext();
  assert.equal(first.id, task.id); assert.equal(first.status, 'waiting', first.reports.at(-1)?.summary);
  const workspace = runtime.getWorkspace(task.id), session = runtime.getSession(task.id);
  assert.equal(workspace.mode, 'copy');assert.notEqual(workspace.path, project);
  assert.equal(readFileSync(join(workspace.path, 'result.txt'), 'utf8'), `${expected}\n`);
  assert.equal(readFileSync(join(project, 'result.txt'), 'utf8'), 'baseline\n');
  assert.ok(toolEvents().some(event => event.tool === 'js_superagent_read'));
  assert.ok(toolEvents().some(event => event.tool === 'js_superagent_ack'));
  evidence.firstSession = session; evidence.originalWorkspace = { mode: workspace.mode, provisionId: workspace.provisionId };
  evidence.checks.push('real-model-acknowledgement', 'real-model-read-omitted-context', 'exact-file-value-verified', 'source-project-unchanged'); save();

  runtime.reply(task.id, 'UNRELATED NEW TASK: Create and verify only separate-note.txt containing exactly separate-task followed by a newline. This is a separate task outside the original result.txt scope.');
  const triggerId = runtime.getDomainTicket(task.id).inputs.filter(input => input.kind === 'trigger').at(-1).triggerId;
  const second = await runtime.runNext();
  assert.equal(second.id, task.id); assert.notEqual(second.status, 'failed', second.reports.at(-1)?.summary);
  assert.deepEqual(runtime.getSession(task.id), session);
  assert.equal(existsSync(join(workspace.path, 'separate-note.txt')), false);
  const readStore = new Store(join(stateDir(project), 'state.sqlite'));
  try {
    const disposition = readStore.triggers.disposition(triggerId);
    assert.equal(disposition.handbacks.filter(item => item.ticketId === runtime.getDomainTicket(task.id).id).length, 1);
    evidence.handback = { triggerId, disposition };
  } finally { readStore.close(); }
  assert.ok(toolEvents().some(event => event.tool === 'js_superagent_handback'));
  evidence.checks.push('real-model-handback-once', 'same-session-original-scope-preserved'); save();

  for (let turn = 0; turn < 4 && runtime.list().filter(item => item.id !== task.id).every(item => item.status !== 'completed'); turn++) await runtime.runNext();
  const routed = runtime.list().filter(item => item.id !== task.id);
  assert.equal(routed.length, 1, 'Handback must produce exactly one new ticket');
  assert.equal(routed[0].status, 'completed', routed[0].reports.at(-1)?.summary);
  const nextWorkspace = runtime.getWorkspace(routed[0].id);
  assert.equal(nextWorkspace.mode, 'copy');assert.notEqual(nextWorkspace.path, project);
  assert.notEqual(nextWorkspace.path, workspace.path);
  assert.match(routed[0].scope, /separate-note\.txt/);
  assert.equal(readFileSync(join(nextWorkspace.path, 'separate-note.txt'), 'utf8'), 'separate-task\n');
  assert.equal(existsSync(join(project, 'separate-note.txt')), false);
  evidence.routedTicketId = routed[0].id; evidence.routedSession = runtime.getSession(routed[0].id);
  evidence.routedWorkspace = { mode: nextWorkspace.mode, provisionId: nextWorkspace.provisionId };
  evidence.checks.push('real-coordinator-routes-one-new-ticket', 'separate-task-workspace-verified');
  evidence.status = 'passed'; evidence.toolCalls = toolEvents(); evidence.finishedAt = new Date().toISOString(); save();
  process.stdout.write(JSON.stringify({ status: evidence.status, ticketId: task.id, routedTicketId: routed[0].id, evidencePath: join(output, 'acceptance.json') }) + '\n');
} catch (error) { evidence.status = 'failed'; evidence.error = String(error.message ?? error); evidence.toolCalls = toolEvents(); save(); throw error; }
finally { await runtime.stop(); runtime.close(); }

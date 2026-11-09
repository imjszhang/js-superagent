import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
// Explicit supported DSH SDK acceptance. All provider traffic stays on loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshSdkDriver, probeDsh } from '../src/drivers/dsh.mjs';
import { readDshHistory } from '../src/drivers/dsh-history.mjs';
import { PromptRegistry } from '../src/runtime/prompt-registry.mjs';
import { resolveWorkerPolicy } from '../src/runtime/worker-policy.mjs';
import { Store } from '../src/store.mjs';
import { createWorkerToolHost } from '../src/runtime/agent-tools.mjs';
import { createWorkerGitHubReads } from '../src/runtime/worker-github-context.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-dsh-continuity-'))), workspace = join(root, 'workspace');
mkdirSync(workspace);
let phase = 'interrupt', calls = 0, baselineCalls = 0, remoteReads = 0, session, nativePid, driver, readReference;
const owners = [], reads = [], requests = [], failures = [], held = new Set();
function respond(res, request, output) {
  const blocks = typeof output === 'string' ? [{ type: 'text', text: JSON.stringify({ version: 2, state: 'ready', summary: output, artifacts: [], attention: null }) }] : output;
  const stop = blocks.some(item => item.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: `msg_${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } };
  if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', { type: 'message_stop' }); res.end();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls++; requests.push({ phase, text: JSON.stringify(request) });
    assert.ok((request.tools??[]).every(tool=>!/^schedule_|ask_user_question|^present(?:_|$)|goal/.test(tool.name)), 'SDK profile must not expose undeclared interaction or scheduling tools');
    if (phase === 'interrupt') {
      held.add(res);
      let accepted;
      const until = Date.now() + 3000;
      while (!accepted && Date.now() < until) {
        try { accepted = await driver.sendInput({ runId: 'pending-origin', inputId: 'pending-feedback', text: 'PENDING_REQUIREMENT must be handled once.' }); }
        catch (error) { if (error.deliveryState !== 'not-sent') throw error; await pause(10); }
      }
      assert.ok(accepted?.accepted);
      let persisted;
      while (!persisted && Date.now() < until) {
        try {
          const history = readDshHistory(join(stateDir(workspace), 'harness/dsh', session.id), session.id, workspace);
          persisted = history.pending.some(message => message.id === accepted.messageId);
        } catch { /* The native writer may still be flushing its current batch. */ }
        if (!persisted) await pause(10);
      }
      assert.ok(persisted, 'Native pending input must be durable before process-loss simulation');
      process.kill(nativePid, 'SIGKILL');
    } else {
      if (phase === 'baseline') {
        baselineCalls++;
        if (baselineCalls === 1) {
          assert.ok(request.tools.some(tool => tool.name === 'js_superagent_read'));
          respond(res, request, [{ type: 'tool_use', id: 'native_host_read', name: 'js_superagent_read', input: { resource: 'github', id: readReference } }]);
          return;
        }
        const result = request.messages.flatMap(item => Array.isArray(item.content) ? item.content : [])
          .find(block => block.type === 'tool_result' && block.tool_use_id === 'native_host_read');
        assert.ok(result); assert.notEqual(result.is_error, true); assert.match(JSON.stringify(result), /DSH_ASYNC_SCOPED_READ_RESULT/);
      }
      if (phase === 'policy') {
        const current = JSON.stringify(request.messages.filter(item => item.role === 'user').at(-1));
        assert.match(current, /TEAM_POLICY_NEW/); assert.doesNotMatch(current, /TEAM_POLICY_OLD/);
      }
      respond(res, request, JSON.stringify(request).includes('PENDING_REQUIREMENT') ? 'pending input consumed once' : 'interrupted earlier turn closed');
    }
  } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previous = process.env.JS_DSH_CONTINUITY_KEY; process.env.JS_DSH_CONTINUITY_KEY = 'fake-only';
const policyRecords = new Map(), policyStore = { atomic: fn => fn(), getMeta: key => policyRecords.get(key), setMeta: (key, value) => policyRecords.set(key, value) };
const policies = new PromptRegistry(policyStore);
policies.update({ sections: { delivery: 'TEAM_POLICY_OLD' } }, { expectedRevision: 0 });
const oldPolicy = policies.assemble({ role: 'worker' }), fixedPrompt = `Fixed host base.\n\n${oldPolicy.text}`;
const firstPolicy = resolveWorkerPolicy({ executionPrompt: fixedPrompt, legacyAssembly: oldPolicy, currentAssembly: oldPolicy, hasSession: true });
policies.update({ sections: { delivery: 'TEAM_POLICY_NEW' } }, { expectedRevision: 1 });
const nextPolicy = resolveWorkerPolicy({ executionPrompt: fixedPrompt, binding: firstPolicy.binding, currentAssembly: policies.assemble({ role: 'worker' }), hasSession: true });
const observations = [], policyFacts = [];
const store = new Store(':memory:'), hostReceipts = [];
const options = { executable: process.env.DSH_EXECUTABLE ?? 'dsh', prompt: fixedPrompt, model: 'deepseek-flash', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, apiKeyEnv: 'JS_DSH_CONTINUITY_KEY' }, timeoutMs: 20000, killGraceMs: 1000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const input = runId => {
  const githubReads = createWorkerGitHubReads({ github: { repository: 'owner/repo' }, threads: () => [{ number: 1, pull: false }],
    request: async (endpoint, init) => {
      assert.equal(store.inTransaction, false); assert.equal(init.method, 'GET'); assert.equal(endpoint, '/repos/owner/repo/issues/1');
      await new Promise(resolve => setImmediate(resolve)); remoteReads++;
      return { id: 101, number: 1, title: 'Scoped fixture', body: 'DSH_ASYNC_SCOPED_READ_RESULT', state: 'open',
        updated_at: '2026-11-02T00:00:00Z', html_url: 'https://github.com/owner/repo/issues/1', user: { login: 'owner' } };
    } });
  const agentTools = createWorkerToolHost({ store, identity: { ticketId: 'native-ticket', assignmentId: 'native-assignment', runId },
    assertActive: () => {}, sessionId: () => session?.id, resources: () => [], remoteReads: githubReads });
  readReference = agentTools.contextResources().find(item => item.value.kind === 'root').id;
  return { runId, projectRoot: workspace, sourceProjectRoot: workspace, assignmentId: 'native-assignment', agentTools,
  signal: new AbortController().signal, ticket: { id: 'native-ticket', text: 'Wait for the additional requirement and report it.', scope: 'temporary local workspace' },
  policySnapshot: phase === 'policy' ? nextPolicy.snapshot : firstPolicy.snapshot,
  observeExecutionState: value => observations.push(value), checkpointNative: facts => { if (facts.policy) policyFacts.push({ ...facts.policy, runId }); },
  recordHostTool: receipt => hostReceipts.push({ runId, ...receipt }),
  checkpoint(value) { session = value; }, registerProcess(pid) { owners.push(pid); nativePid = pid; }, inputRead(value) { reads.push(value); } };
};
try {
  const nativeVersion = (await probeDsh(options)).version;
  driver = createDshSdkDriver(options);
  await assert.rejects(driver.run(input('pending-origin')), /closed|failed|stopped/);
  assert.equal(failures.length, 0, failures.map(error => error.stack).join('\n'));
  assert.ok(owners.every(pid => !alive(pid)));
  const pendingSession = { ...session };
  const originalHistory = readDshHistory(join(stateDir(workspace), 'harness/dsh', session.id), session.id, workspace);
  const originalBytes = readFileSync(originalHistory.path, 'utf8'), ownerCount = owners.length;
  const inspected = await driver.inspectRecovery({ ...input('pending-origin'), session, diagnostics: true, inputs: [{ inputId: 'pending-feedback', status: 'accepted' }] });
  assert.equal(inspected?.reason, 'native-pending-wakeup-unsupported', JSON.stringify(inspected));
  assert.equal(inspected.safeToResume, false); assert.equal(inspected.pendingInputs.pending.length, 1);
  assert.equal(reads.length, 0);
  phase = 'adopt';
  await assert.rejects(driver.run({ ...input('pending-refused'), session, adoption: inspected.pendingInputs }), /wakeup is unsupported/);
  assert.equal(owners.length, ownerCount, 'Unsupported resume cannot launch a native process');
  assert.equal(readFileSync(originalHistory.path, 'utf8'), originalBytes, 'Inspect and refusal never modify native pending history');
  assert.deepEqual(session, pendingSession);
  assert.equal(policyFacts.filter(item => item.runId === 'pending-refused').length, 0);
  // Check policy refresh on a distinct healthy session; the pending one remains untouched.
  driver = createDshSdkDriver({ ...options, enableAgentTools: true });
  phase = 'baseline';
  await driver.run(input('policy-baseline'));
  assert.equal(baselineCalls, 2); assert.equal(remoteReads, 2); assert.equal(hostReceipts.length, 1);
  const receipt = hostReceipts[0];
  assert.equal(receipt.name, 'js_superagent_read'); assert.equal(receipt.runId, 'policy-baseline');
  assert.equal(store.getMeta(`agent-tool:policy-baseline:call:${receipt.callId}`).status, 'completed');
  const originalSession = { ...session };
  phase = 'policy';
  await driver.run({ ...input('policy-next-turn'), session });
  assert.deepEqual(session, originalSession);
  assert.ok(policyFacts.some(item => item.revision === 2 && item.status === 'applied'));
  assert.ok(observations.some(item => item.runId === 'policy-next-turn' && item.state === 'ended'));
  assert.ok(owners.every(pid => !alive(pid))); assert.equal(failures.length, 0);
  console.log(JSON.stringify({ nativeVersion, localProviderCalls: calls, knownPendingInspected: true, unsupportedAdoptionRefused: true, pendingHistoryUnchanged: true, asyncHostReadConsumed: true, scopedReadRequests: remoteReads, policyUpdatedInSameSession: true, nativeLifecycleObserved: true, processCleanup: true }));
} finally {
  for (const res of held) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.JS_DSH_CONTINUITY_KEY; else process.env.JS_DSH_CONTINUITY_KEY = previous;
  store.close();
  if (process.env.JS_DSH_KEEP_CONTINUITY === '1') console.error(`Retained acceptance state: ${root}`); else rmSync(root, { recursive: true, force: true });
}

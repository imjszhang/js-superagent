// Fixed native app-server + a loopback Responses fixture. No external model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server.mjs';
import { PromptRegistry } from '../src/runtime/prompt-registry.mjs';
import { resolveWorkerPolicy } from '../src/runtime/worker-policy.mjs';
import { CODEX_HISTORY_VERSION } from '../src/drivers/codex-history.mjs';

const executable = process.env.CODEX_EXECUTABLE ?? 'codex';
assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), `codex-cli ${CODEX_HISTORY_VERSION}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-codex-continuity-'))), workspace = join(root, 'workspace'), nativeHome = join(root, 'native-home');
mkdirSync(workspace); mkdirSync(nativeHome);
let phase = 'tools', calls = 0, toolCalls = 0, session, nativePid;
const owners = [], requests = [], failures = [], held = new Set(), receipts = new Map();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function respond(res, output) {
  const response = { id: `resp_${calls}`, object: 'response', created_at: 1793577600, status: 'completed', model: 'gpt-5.4', output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  output.forEach((item, index) => {
    send('response.output_item.added', { output_index: index, item: item.type === 'message' ? { ...item, content: [] } : item });
    send('response.output_item.done', { output_index: index, item });
  });
  send('response.completed', { response }); res.end();
}
const final = summary => [{ id: `msg_${calls}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
  content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ state: 'ready', summary, artifacts: [], question: null, acknowledgedInputIds: [] }) }] }];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.match(req.url, /^\/v1\/responses/);
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body), text = JSON.stringify(request); calls++; requests.push({ phase, text });
    if (phase === 'tools') {
      toolCalls++;
      if (toolCalls === 1) {
        assert.match(JSON.stringify(request.tools), /js_superagent_read/);
        respond(res, [{ type: 'function_call', id: 'fc_host_read', call_id: 'call_host_read', name: 'js_superagent_read', arguments: '{"resource":"inputs"}', status: 'completed' }]);
      } else { assert.match(text, /HOST_READ_RESULT/); respond(res, final('host tool result consumed')); }
    } else if (phase === 'interrupt') { held.add(res); process.kill(nativePid, 'SIGKILL'); }
    else {
      const guidance = JSON.stringify((request.input ?? []).filter(item => item.role === 'developer' && JSON.stringify(item).includes('Trusted host role guidance')).at(-1));
      assert.match(guidance, /TEAM_POLICY_NEW/); assert.doesNotMatch(guidance, /TEAM_POLICY_OLD/);
      respond(res, final('same thread resumed'));
    }
  } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(join(nativeHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "native_fixture"\n[model_providers.native_fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
const policyRecords = new Map(), policyStore = { atomic: fn => fn(), getMeta: key => policyRecords.get(key), setMeta: (key, value) => policyRecords.set(key, value) };
const policies = new PromptRegistry(policyStore);
policies.update({ sections: { delivery: 'TEAM_POLICY_OLD' } }, { expectedRevision: 0 });
const oldPolicy = policies.assemble({ role: 'worker' }), fixedPrompt = `Fixed host base.\n\n${oldPolicy.text}`;
const firstPolicy = resolveWorkerPolicy({ executionPrompt: fixedPrompt, legacyAssembly: oldPolicy, currentAssembly: oldPolicy, hasSession: true });
policies.update({ sections: { delivery: 'TEAM_POLICY_NEW' } }, { expectedRevision: 1 });
const nextPolicy = resolveWorkerPolicy({ executionPrompt: fixedPrompt, binding: firstPolicy.binding, currentAssembly: policies.assemble({ role: 'worker' }), hasSession: true });
const observations = [], policyFacts = [];
const toolHost = { version: 1, definitions: [{ type: 'function', name: 'js_superagent_read', description: 'Read authorized temporary fixture facts.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['resource'], properties: { resource: { type: 'string' } } } }],
  contextResources: () => [], async call(request) { assert.equal(request.arguments.resource, 'inputs'); return { text: 'HOST_READ_RESULT', version: 'fixture-v1' }; } };
const verifyHostTool = query => {
  const receipt = receipts.get(`${query.runId}:${query.callId}`);
  return !!receipt && receipt.sessionId === query.sessionId && receipt.turnId === query.turnId && receipt.name === query.name &&
    JSON.stringify(receipt.arguments) === JSON.stringify(query.arguments) && JSON.stringify(receipt.result) === JSON.stringify(query.result);
};
const input = runId => ({ projectRoot: workspace, sourceProjectRoot: workspace, runId, assignmentId: 'native-assignment', signal: new AbortController().signal,
  ticket: { id: 'native-ticket', text: 'Read the authorized host context and summarize it.', scope: 'temporary local workspace', messages: [], reports: [] }, agentTools: toolHost,
  checkpoint(value) { session = value; }, registerProcess(pid) { owners.push(pid); nativePid = pid; },
  policySnapshot: phase === 'resume' ? nextPolicy.snapshot : firstPolicy.snapshot,
  observeExecutionState: value => observations.push(value), checkpointNative: facts => { if (facts.policy) policyFacts.push(facts.policy); },
  recordHostTool(receipt) { receipts.set(`${runId}:${receipt.callId}`, structuredClone(receipt)); }, verifyHostTool });
try {
  const driver = createCodexAppServerDriver({ executable, prompt: fixedPrompt, enableAgentTools: true, timeoutMs: 20000, killGraceMs: 1000 });
  const result = await driver.run(input('host-tools'));
  assert.equal(result.summary, 'host tool result consumed'); assert.equal(receipts.size, 1);
  const completed = await driver.inspectRecovery({ ...input('host-tools'), session, diagnostics: true });
  assert.equal(completed?.outcome, 'completed', JSON.stringify(completed));
  assert.equal(completed.report.summary, result.summary);
  const denied = await driver.inspectRecovery({ ...input('host-tools'), session, diagnostics: true, verifyHostTool: () => false });
  assert.equal(denied?.reason, 'host-tool-receipt-unverified');
  phase = 'interrupt';
  await assert.rejects(driver.run({ ...input('process-loss'), session }), /closed|exit|failed/);
  const interrupted = await driver.inspectRecovery({ ...input('process-loss'), session, diagnostics: true });
  assert.equal(interrupted?.outcome, 'resume', JSON.stringify(interrupted));
  const originalSession = { ...session }; phase = 'resume';
  const resumed = await driver.run({ ...input('same-session'), session });
  assert.equal(resumed.summary, 'same thread resumed'); assert.deepEqual(session, originalSession);
  assert.ok(policyFacts.some(item => item.revision === 2 && item.status === 'applied'));
  assert.ok(observations.some(item => item.runId === 'same-session' && item.state === 'ended'));
  assert.deepEqual(failures, []); assert.ok(owners.every(pid => !alive(pid)));
  console.log(JSON.stringify({ nativeVersion: CODEX_HISTORY_VERSION, localProviderCalls: calls, nativeHostToolReconciled: true, mismatchedReceiptRejected: true,
    processLossInspected: true, sameSessionResume: true, policyUpdatedInSameSession: true, nativeLifecycleObserved: true, processCleanup: true }));
} finally {
  if (failures.length) console.error(failures.map(error => error.stack).join('\n'));
  for (const res of held) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  if (process.env.JS_CODEX_KEEP_CONTINUITY === '1') console.error(`Retained acceptance state: ${root}`); else rmSync(root, { recursive: true, force: true });
}

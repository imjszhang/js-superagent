// Explicit pinned native CLI acceptance; the model endpoint is a local deterministic fixture.
// No provider credentials, GitHub, production database or persistent service are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server.mjs';
import { CODEX_HISTORY_VERSION } from '../src/drivers/codex-history.mjs';

const executable = process.env.CODEX_EXECUTABLE ?? 'codex';
assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), `codex-cli ${CODEX_HISTORY_VERSION}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-codex-reliability-'))), workspace = join(root, 'workspace'), nativeHome = join(root, 'native-home');
mkdirSync(workspace); mkdirSync(nativeHome);
let phase = 'work', workCalls = 0, calls = 0, session, driver, steering, cancelController;
const failures = [], seen = [], registered = [], reads = [], held = new Set();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function respond(res, output) {
  const id = `resp_${calls}`, response = { id, object: 'response', created_at: 1793577600, status: 'completed', model: 'gpt-5.4', output,
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
const final = (summary, acknowledgedInputIds = []) => [{ id: `msg_${calls}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
  content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ state: 'ready', summary, artifacts: [], question: null, acknowledgedInputIds }) }] }];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.match(req.url, /^\/v1\/responses/);
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body), text = JSON.stringify(request); seen.push({ phase, text }); calls++;
    if (phase === 'work') {
      workCalls++;
      if (workCalls === 1) {
        assert.ok(request.tools.some(tool => tool.name === 'exec_command'));
        respond(res, [{ type: 'function_call', id: 'fc_native', call_id: 'call_native', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf codex-native-tool', yield_time_ms: 1000 }), status: 'completed' }]);
      } else {
        await steering;
        assert.match(text, /FOLLOWUP_REQUIREMENT/);
        respond(res, final('native command and input verified', ['native-feedback']));
      }
    } else if (phase === 'interrupt') {
      held.add(res);
      setTimeout(() => cancelController.abort(), 150);
    } else if (phase === 'resume') respond(res, final('same native session resumed'));
  } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(join(nativeHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "native_fixture"\n[model_providers.native_fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
const previousNativeHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = nativeHome;
const input = runId => ({ projectRoot: workspace, sourceProjectRoot: workspace, runId, assignmentId: 'assignment-native', signal: new AbortController().signal,
  ticket: { id: 'native-ticket', text: 'Run one temporary command and include the follow-up requirement.', scope: 'temporary workspace only', messages: [], reports: [] },
  checkpoint(value) { session = value; }, registerProcess(pid) { registered.push(pid); }, inputRead(value) { reads.push(value); } });
try {
  driver = createCodexAppServerDriver({ executable, timeoutMs: 20000, killGraceMs: 1000,
    onEvent(event) {
      if (event.method === 'item/started' && event.params.item?.type === 'commandExecution' && !steering) {
        steering = driver.sendInput({ runId: 'native-work', inputId: 'native-feedback', text: 'FOLLOWUP_REQUIREMENT: include the command result.' });
      }
    } });
  await assert.rejects(driver.sendInput({ runId: 'not-started', inputId: 'i', text: 'No turn yet' }), error => error.deliveryState === 'not-sent');
  const result = await driver.run(input('native-work')); await steering;
  assert.equal(result.summary, 'native command and input verified');
  assert.equal(reads[0].inputId, 'native-feedback'); assert.equal(reads[0].evidence.type, 'model-final-ack');
  assert.ok(registered.every(pid => !alive(pid)));
  const completed = await driver.inspectRecovery({ ...input('native-work'), session, inputs: [{ inputId: 'native-feedback', status: 'unknown' }] });
  assert.equal(completed?.outcome, 'completed'); assert.deepEqual(completed.readInputIds, ['native-feedback']);
  assert.equal(completed.report.summary, result.summary);
  assert.equal(await driver.inspectRecovery({ ...input('wrong-run'), session }), null);
  assert.equal(await driver.inspectRecovery({ ...input('native-work'), session, inputs: [{ inputId: 'unknown-input', status: 'unknown' }] }), null);
  phase = 'interrupt'; cancelController = new AbortController();
  await assert.rejects(driver.run({ ...input('native-interrupt'), session, signal: cancelController.signal }), /cancel|interrupt/);
  assert.ok(registered.every(pid => !alive(pid)));
  const interruptedSession = session;
  const interrupted = await driver.inspectRecovery({ ...input('native-interrupt'), session });
  assert.equal(interrupted?.outcome, 'resume'); assert.equal(interrupted.toolsSettled, true);
  phase = 'resume';
  const resumed = await driver.run({ ...input('native-resume'), session });
  assert.equal(resumed.summary, 'same native session resumed'); assert.deepEqual(session, interruptedSession);
  assert.deepEqual(failures, []); assert.ok(registered.every(pid => !alive(pid)));
  process.stdout.write(JSON.stringify({ status: 'passed', nativeVersion: CODEX_HISTORY_VERSION, provider: 'loopback-fixture', scenarios: ['completed-history', 'client-input-reconciliation', 'unknown-input-rejected', 'interrupted-history', 'same-session-resume'], providerCalls: calls }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ phase, providerCalls: calls, failure: String(error), providerErrors: failures.map(String) }) + '\n');
  throw error;
} finally {
  for (const response of held) response.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previousNativeHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousNativeHome;
  rmSync(root, { recursive: true, force: true });
}

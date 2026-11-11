// Real supported DSH protocol, a temporary workspace and a loopback provider only.
// Run explicitly with DSH_EXECUTABLE set; never calls an external model service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-final-report-native-')));
let calls = 0, session;
const guardians = [], errors = [];
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls++;
    const blocks = calls === 1
      ? [{ type: 'tool_use', id: 'fixture_read_once', name: 'bash', input: { command: `printf 'once\\n' >> effect-count.txt; printf NATIVE_SETTLED_EVIDENCE`, description: 'Count one bounded fixture operation', timeoutMs: 1000 } }]
      : calls === 2 ? [{ type: 'thinking', thinking: 'synthetic placeholder', signature: 'fixture-signature' }]
      : [{ type: 'text', text: JSON.stringify({ version: 2, state: 'ready', summary: 'Used the settled operation evidence and supplied the missing report.', artifacts: [], attention: null }) }];
    if (calls > 1) assert.match(JSON.stringify(request.messages), /NATIVE_SETTLED_EVIDENCE/);
    if (calls === 3) {
      const latest = request.messages.filter(message => message.role === 'user').at(-1);
      assert.match(JSON.stringify(latest), /Continue this same saved native session/);
      assert.match(JSON.stringify(latest), /Do not replay the original request or repeat completed actions/);
    }
    assert.ok(calls <= 3, 'Recovery must not re-execute the original operation');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: `fixture_${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    blocks.forEach((block, index) => {
      send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block.type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : { type: 'text_delta', text: block.text } });
      if (block.type === 'thinking') send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
      send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: calls === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } });
    send('message_stop', { type: 'message_stop' }); res.end();
  } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previous = process.env.DSH_FINAL_REPORT_FIXTURE_KEY; process.env.DSH_FINAL_REPORT_FIXTURE_KEY = 'local-fixture-only';
const options = { executable: process.env.DSH_EXECUTABLE ?? 'dsh', model: 'deepseek-flash', timeoutMs: 15000, killGraceMs: 1000,
  backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, apiKeyEnv: 'DSH_FINAL_REPORT_FIXTURE_KEY' } };
const driver = createDshSdkDriver(options);
const input = runId => ({ runId, projectRoot: root, sourceProjectRoot: root, assignmentId: 'fixture-assignment', ticket: { id: 'fixture-ticket', text: 'Execute one bounded fixture operation and report the evidence.', scope: 'This temporary local workspace only.' },
  checkpoint: value => { session = value; }, registerProcess: pid => guardians.push(pid) });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  await assert.rejects(driver.run(input('original-run')), error => error.code === 'DSH_MISSING_FINAL_REPORT');
  assert.equal(calls, 2); assert.ok(guardians.every(pid => !alive(pid)));
  const original = { ...session };
  const proof = await driver.inspectRecovery({ ...input('original-run'), session, inputs: [], diagnostics: true });
  assert.equal(proof.finalReportFailure, 'missing-final-report'); assert.equal(proof.outcome, 'resume');
  const report = await driver.run({ ...input('continued-run'), session, recoveryContinuation: { sourceRunId: 'original-run', finalReportFailure: proof.finalReportFailure } });
  assert.equal(report.state, 'ready'); assert.deepEqual(session, original); assert.equal(calls, 3);
  assert.equal(readFileSync(join(root, 'effect-count.txt'), 'utf8'), 'once\n');
  assert.ok(guardians.every(pid => !alive(pid))); assert.equal(errors.length, 0, errors.map(error => error.stack).join('\n'));
  console.log(JSON.stringify({ localProviderCalls: calls, reasoningOnlyFailureClassified: true, sameNativeSessionRecovered: true, completedOperationCount: 1, finalReportValid: true, processCleanup: true }));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.DSH_FINAL_REPORT_FIXTURE_KEY; else process.env.DSH_FINAL_REPORT_FIXTURE_KEY = previous;
  rmSync(root, { recursive: true, force: true });
}

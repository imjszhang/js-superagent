// Real DSH SDK + public runtime retry; all provider traffic is loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

assert.ok(process.env.DSH_EXECUTABLE, 'Use an explicit isolated native installation');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-business-report-')));
const staged = { state: 'waiting', summary: 'Wrote the counter exactly once.', question: 'Review the fixture?', artifacts: ['fixture-counter.txt'], answers: null };
const final = question => ({ version: 2, state: 'waiting', summary: 'Model summary', artifacts: staged.artifacts, attention: { question }, answers: null });
let calls = 0, runtime;
const errors = [];
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body); calls++;
    const blocks = calls === 1 ? [{ type: 'tool_use', id: 'one-fixture-effect', name: 'bash', input: { command: "printf 'once\\n' >> fixture-counter.txt", description: 'Write one temporary fixture counter', timeoutMs: 1000 } }]
      : calls === 2 ? [{ type: 'tool_use', id: 'accepted-business-report', name: 'js_superagent_report', input: staged }]
      : [{ type: 'text', text: JSON.stringify(final(calls === 3 ? 'Different question wording?' : staged.question)) }];
    assert.ok(calls <= 4, 'Recovery must not replay completed operations');
    if (calls === 4) {
      const latest = JSON.stringify(request.messages.filter(message => message.role === 'user').at(-1));
      assert.match(latest, /Continue this same saved native session/);
      assert.match(latest, /Verified earlier business report data/);
      assert.match(latest, /Review the fixture/);
    }
    const reason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: `fixture_${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    blocks.forEach((block, index) => {
      send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
      send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', { type: 'message_stop' }); res.end();
  } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previous = process.env.JS_DSH_REPORT_REPAIR_KEY; process.env.JS_DSH_REPORT_REPAIR_KEY = 'fake-only';
try {
  runtime = createProjectAgent({ projectRoot: root, execution: { driver: 'dsh-sdk', executable: process.env.DSH_EXECUTABLE,
    model: 'deepseek-flash', enableAgentTools: true, timeoutMs: 30000, killGraceMs: 1000,
    backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, apiKeyEnv: 'JS_DSH_REPORT_REPAIR_KEY' } } }).init();
  const ticket = runtime.submit({ text: 'Write the temporary fixture counter once, then ask for review. Do not publish or send messages.' });
  await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'failed'); assert.equal(calls, 3);
  assert.match(runtime.get(ticket.id).reports.at(-1).summary, /disagrees/);
  const session = runtime.getSession(ticket.id);
  runtime.retry(ticket.id);
  assert.equal(runtime.get(ticket.id).status, 'failed'); assert.equal(calls, 3);
  await runtime.runNext();
  assert.equal(calls, 4, 'Retry continues the original session instead of accepting its conflicting final');
  assert.equal(runtime.get(ticket.id).status, 'waiting');
  assert.deepEqual(runtime.getSession(ticket.id), session);
  assert.equal(runtime.get(ticket.id).reports.at(-1).summary, staged.summary);
  assert.equal(runtime.getDetailed(ticket.id).recovery.evidence.finalReportFailure, 'invalid-final-report');
  assert.equal(readFileSync(join(root, 'fixture-counter.txt'), 'utf8'), 'once\n');
  assert.equal(errors.length, 0, errors.map(error => error.stack).join('\n'));
  await runtime.stop();
  console.log(JSON.stringify({ localProviderCalls: calls, publicRetryVerified: true, sameSessionRepair: true, conflictingReportNotRecovered: true, completedOperationCount: 1, verifiedSummaryRetained: true }));
} finally {
  if (runtime) { await runtime.stop(); runtime.close(); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.JS_DSH_REPORT_REPAIR_KEY; else process.env.JS_DSH_REPORT_REPAIR_KEY = previous;
  rmSync(root, { recursive: true, force: true });
}

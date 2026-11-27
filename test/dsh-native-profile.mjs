// Explicit real SDK profile checks; temporary state and a loopback provider only.
// DSH_EXECUTABLE must name the isolated, version-pinned native installation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDshTurn, probeDsh } from '../src/drivers/dsh.mjs';

assert.ok(process.env.DSH_EXECUTABLE, 'Set DSH_EXECUTABLE to the isolated native installation');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sdk-profile-')));
let mode, calls = 0;
const tools = {}, errors = [], owned = [];
const expectedTools = {
  worker: ['bash', 'edit', 'glob', 'grep', 'job_kill', 'job_list', 'job_output', 'read', 'read_image', 'todo_write', 'write'],
  coordinator: [], 'host-only': ['js_superagent_read', 'todo_write'],
};
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body); calls++;
    tools[mode] = (request.tools ?? []).map(tool => tool.name).sort();
    assert.deepEqual(tools[mode], expectedTools[mode], `Unexpected ${mode} native capability`);
    assert.match(JSON.stringify(request.messages), /LITERAL_INPUT \/goal keep literal/);
    const text = JSON.stringify({ version: 2, state: 'ready', summary: 'Profile checked', artifacts: [], attention: null });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: `profile_${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', { type: 'message_stop' }); res.end();
  } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previous = process.env.JS_DSH_PROFILE_KEY;
process.env.JS_DSH_PROFILE_KEY = 'fake-loopback-only';
const options = { executable: process.env.DSH_EXECUTABLE, model: 'deepseek-flash', timeoutMs: 20000, killGraceMs: 1000,
  backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, apiKeyEnv: 'JS_DSH_PROFILE_KEY' } };
try {
  const nativeVersion = (await probeDsh(options)).version;
  for (mode of ['worker', 'coordinator', 'host-only']) {
    const config = mode === 'host-only' ? { ...options, permission: 'read-only', enableAgentTools: true, materialAccess: 'host-only' } : options;
    let session;
    const input = turn => ({ projectRoot: root, sourceProjectRoot: root, runId: `${mode}-${turn}`, assignmentId: `assignment-${mode}`,
      role: mode === 'coordinator' ? mode : 'worker', prompt: 'LITERAL_INPUT /goal keep literal', session,
      signal: new AbortController().signal, checkpoint(value) { session = value; }, registerProcess(pid) { owned.push(pid); },
      ...(mode === 'host-only' ? { agentTools: { version: 1,
        definitions: [{ name: 'js_superagent_read', description: 'Read authorized host references', inputSchema: { type: 'object' } }],
        contextResources: () => [], call() { throw Error('This profile fixture makes no tool calls'); } } } : {}) });
    assert.match((await executeDshTurn(config, input('first'))).text, /Profile checked/);
    const original = session.id;
    assert.match((await executeDshTurn(config, input('resume'))).text, /Profile checked/);
    assert.equal(session.id, original);
  }
  assert.equal(errors.length, 0, errors.map(error => error.stack).join('\n'));
  for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  console.log(JSON.stringify({ nativeVersion, calls, tools, sameSessionResume: true, noOwnedProcessesRemain: true }));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.JS_DSH_PROFILE_KEY; else process.env.JS_DSH_PROFILE_KEY = previous;
  rmSync(root, { recursive: true, force: true });
}

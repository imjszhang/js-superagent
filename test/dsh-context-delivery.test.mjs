import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { Store } from '../src/store.mjs';

// Real adapter/process/HTTP bridge; the native endpoint is a bounded local fake.
// No model service is contacted and the fixture never reads project credentials.
function fixture(t, { order = 'receipt-first', businessReport = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-context-delivery-')));
  const executable = join(root, 'fake-dsh.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('0.2.2-alpha.2'); process.exit(0); }
const order = ${JSON.stringify(order)}, businessReport = ${businessReport};
const send = value => console.log(JSON.stringify(value));
let sid, seq = 0;
const event = (type, data) => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: sid, event: { type, data, seq: ++seq } } });
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line), answer = value => send({ jsonrpc: '2.0', id: r.id, result: value });
  if (r.method === 'initialize') answer({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } });
  else if (r.method === 'session/resume') answer({});
  else if (r.method === 'session/working-directory/get') { sid = r.params.sessionId; answer({ cwd: process.cwd() }); }
  else if (r.method === 'session/prompt') {
    const text = r.params.contentBlocks[0].text;
    const pack = JSON.parse(text.slice(text.indexOf('{"version":1,"authorizedScope"')));
    const origin = JSON.parse(pack.messages.find(card => !card.truncated).text);
    if (order === 'rejected') {
      event('user/message', { id: 'input-1' });
      send({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'fixture prompt rejected' } });
      continue;
    }
    if (order === 'event-first') event('user/message', { id: 'input-1' });
    answer({ messageId: 'input-1' });
    if (order === 'receipt-first') event('user/message', { id: 'input-1' });
    if (order === 'wrong-message') event('user/message', { id: 'another-input' });
    if (order === 'duplicate') {
      event('user/message', { id: 'input-1' });
      event('user/message', { id: 'input-1' });
    }
    // A tool cannot be accepted based only on a later final response.
    await new Promise(resolve => setTimeout(resolve, 30));
    const summary = 'The original question has been read and answered.';
    const report = { version: 2, state: 'ready', summary, artifacts: [], attention: null,
      ...(businessReport ? { answers: origin.triggerId } : {}) };
    if (businessReport) {
      const connection = JSON.parse(process.env.JS_SUPERAGENT_DSH_BRIDGE);
      const response = await fetch(connection.url, { method: 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, callId: 'report-before-final', name: 'js_superagent_report',
          arguments: { state: report.state, summary, question: null, artifacts: [], answers: report.answers } }) });
      writeFileSync('bridge-result.json', JSON.stringify({ status: response.status, body: await response.json(), answers: report.answers }));
    }
    writeFileSync('native-final-sent', 'yes');
    event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify(report) }] } });
    event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  } else if (r.method === 'session/wait') answer({});
  else if (r.method === 'shutdown') { answer({}); process.exit(0); }
}
`, { mode: 0o700 });
  const runtimes = [], previous = process.env.JS_DSH_CONTEXT_DELIVERY_KEY;
  process.env.JS_DSH_CONTEXT_DELIVERY_KEY = 'local-fixture-only';
  t.after(async () => {
    for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
    if (previous === undefined) delete process.env.JS_DSH_CONTEXT_DELIVERY_KEY; else process.env.JS_DSH_CONTEXT_DELIVERY_KEY = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(projectStateDirectory(root), { recursive: true, force: true });
  });
  const options = { executable, model: 'local-fixture', timeoutMs: 5000, killGraceMs: 30,
    backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'JS_DSH_CONTEXT_DELIVERY_KEY' } };
  const received = [], sessions = [];
  const input = { projectRoot: root, runId: randomUUID(), assignmentId: randomUUID(), signal: new AbortController().signal,
    ticket: { id: 'ticket-fixture', scope: 'Answer the original question', text: 'Read the request and answer it', reports: [], messages: [
      { text: 'What does the fixture establish?', triggerId: 'original-question' },
      { text: 'x'.repeat(5000), triggerId: 'truncated-question' },
    ] }, checkpoint: value => sessions.push(value), registerProcess() {},
    contextDelivered: value => {
      assert.equal(existsSync(join(root, 'native-final-sent')), false, 'context evidence must reach the host before the final response');
      received.push(value);
    } };
  return { root, options, input, received, sessions, runtimes };
}

for (const order of ['receipt-first', 'event-first']) test(`DSH initial ${order} evidence permits an in-turn report answer through the real host`, async t => {
  const f = fixture(t, { order, businessReport: true });
  const runtime = createProjectAgent({ projectRoot: f.root, execution: { driver: 'dsh-sdk', ...f.options, enableAgentTools: true } }).init();
  f.runtimes.push(runtime);
  const ticket = runtime.submit({ text: 'Read this original question and report the answer through the business tool.' });
  await runtime.runNext();
  const result = JSON.parse(readFileSync(join(runtime.getWorkspace(ticket.id).path, 'bridge-result.json'), 'utf8'));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { accepted: true, state: 'ready' });
  assert.equal(runtime.get(ticket.id).status, 'completed');
  const store = new Store(join(projectStateDirectory(f.root), 'state.sqlite'));
  try {
    const report = store.listMeta('agent-tool:').map(row => row.value).find(row => row.name === 'js_superagent_report');
    assert.equal(report?.status, 'completed', 'the in-turn business report must have a durable receipt');
    assert.equal(report.arguments.answers, result.answers);
  } finally { store.close(); }
});

test('DSH initial delivery is recorded once, includes only full messages and survives a later resumed run', async t => {
  const f = fixture(t, { order: 'duplicate' }), driver = createDshSdkDriver(f.options);
  await driver.run(f.input);
  assert.equal(f.received.length, 1);
  assert.deepEqual(f.received[0].records.map(record => record.id), ['ticket-fixture:messages:0']);
  rmSync(join(f.root, 'native-final-sent'));
  await driver.run({ ...f.input, runId: randomUUID(), session: f.sessions.at(-1) });
  assert.equal(f.received.length, 2, 'the next run has its own verified initial delivery');
});

for (const order of ['rejected', 'no-message', 'wrong-message']) test(`DSH ${order} cannot establish initial context consumption`, async t => {
  const f = fixture(t, { order }), driver = createDshSdkDriver(f.options);
  await assert.rejects(driver.run(f.input), /rejected|does not follow/);
  assert.equal(f.received.length, 0);
});

test('DSH cancellation before launch cannot acknowledge initial context', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(createDshSdkDriver(f.options).run({ ...f.input, signal: controller.signal }), /cancelled|aborted/i);
  assert.equal(f.received.length, 0);
});

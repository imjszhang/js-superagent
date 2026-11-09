import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
// Explicit fixed rc.5 acceptance, using only a loopback simulated provider.
// One short shell command, live input, native-history inspection/resume and cancel.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';
import { loadDshProjectRules } from '../src/drivers/dsh-project-rules.mjs';
import { readDshHistory, inspectDshInputReceipts } from '../src/drivers/dsh-history.mjs';

const root = mkdtempSync(join(tmpdir(), 'js-dsh-reliability-')), workspace = join(root, 'workspace');
mkdirSync(join(workspace, 'nested'), { recursive: true });
writeFileSync(join(root, 'AGENTS.md'), 'OUTSIDE_RULE_MUST_NOT_APPEAR');
writeFileSync(join(workspace, 'AGENTS.md'), 'ROOT_RULE applies to this project.');
writeFileSync(join(workspace, 'nested', 'AGENTS.md'), 'NESTED_RULE applies only to nested.');
symlinkSync(root, join(workspace, 'outside-link'));
let phase = 'work', calls = 0, workCalls = 0, driver, session, registered = [], inputReads = [], facts, feedback, firstRequestAt, promotedAt;
let crashPid, cancelController, cancellationPid;
const seen = [], failures = [], held = new Set();
function respond(res, request, blocks) {
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
const ready = summary => [{ type: 'text', text: JSON.stringify({ version: 2, state: 'ready', summary, artifacts: [], attention: null }) }];
const shell = command => [{ type: 'tool_use', id: `shell_${phase}`, name: 'bash', input: { command, description: 'Run one bounded temporary acceptance command', timeoutMs: 60000 } }];
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls++; const text = JSON.stringify(request); seen.push({ phase, text });
    if (phase === 'work') {
      workCalls++;
      if (workCalls === 1) {
        firstRequestAt = Date.now(); assert.match(text, /ROOT_RULE/); assert.match(text, /NESTED_RULE/); assert.doesNotMatch(text, /OUTSIDE_RULE_MUST_NOT_APPEAR/);
        respond(res, request, shell('printf "%s" "$$" > normal.pid; sleep 9; printf native-done > native-result.txt')); return;
      }
      if (workCalls === 2) {
        promotedAt = Date.now(); assert.match(text, /moved to background job/);
        feedback = await driver.sendInput({ runId: 'native-work', inputId: 'native-feedback', text: 'FOLLOWUP_REQUIREMENT: include the finished command result.' });
        assert.equal(feedback.read, false);
      }
      const done = existsSync(join(workspace, 'native-result.txt'));
      respond(res, request, ready(done ? 'native job completed once with feedback' : 'early report must await native job'));
    } else if (phase === 'crash') {
      held.add(res); process.kill(crashPid, 'SIGKILL');
    } else if (phase === 'resume') respond(res, request, ready('same native session resumed'));
    else if (phase === 'cancel') {
      if (!cancellationPid) { cancellationPid = 'starting'; respond(res, request, shell('printf "%s" "$$" > cancelled.pid; sleep 30; printf wrong > cancelled-result.txt')); }
      else { assert.match(text, /moved to background job/); respond(res, request, ready('must not survive cancellation')); cancelController.abort(); }
    }
  } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previousKey = process.env.JS_DSH_RELIABILITY_KEY; process.env.JS_DSH_RELIABILITY_KEY = 'fake-only';
const options = { executable: process.env.DSH_EXECUTABLE ?? 'dsh', model: 'deepseek-flash', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, apiKeyEnv: 'JS_DSH_RELIABILITY_KEY' }, timeoutMs: 30000, killGraceMs: 1000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const input = runId => ({ projectRoot: workspace, sourceProjectRoot: workspace, runId, assignmentId: 'assignment-native', signal: new AbortController().signal,
  ticket: { id: 'native-ticket', text: 'Perform only the requested temporary acceptance command.', scope: 'temporary workspace only' },
  checkpoint(value) { session = value; }, checkpointNative(value) { facts = value; }, registerProcess(pid) { registered.push(pid); crashPid = pid; }, inputRead(value) { inputReads.push(value); } });
try {
  const rules = loadDshProjectRules(workspace);
  assert.deepEqual(rules.manifest.files.map(file => [file.path, file.scope]), [['AGENTS.md', '.']]);
  assert.equal(rules.manifest.mode, 'directory-chain');
  assert.equal(rules.manifest.descendantInstructions, 'read-before-access');
  assert.doesNotMatch(rules.prompt, /OUTSIDE_RULE_MUST_NOT_APPEAR|NESTED_RULE/);
  driver = createDshSdkDriver(options);
  await assert.rejects(driver.sendInput({ runId: 'not-started', inputId: 'i', text: 'not sent' }), error => error.deliveryState === 'not-sent');
  const result = await driver.run(input('native-work'));
  assert.equal(result.summary, 'native job completed once with feedback');
  assert.ok(promotedAt - firstRequestAt >= 4500 && promotedAt - firstRequestAt < 8000, 'foreground shell wait is capped near five seconds');
  assert.ok(seen.some(item => item.text.includes('FOLLOWUP_REQUIREMENT'))); assert.equal(inputReads.length, 1);
  assert.equal(readFileSync(join(workspace, 'native-result.txt'), 'utf8'), 'native-done');
  assert.equal(facts.projectRules.files.length, 1); assert.ok(registered.every(pid => !alive(pid)));
  const home = join(stateDir(workspace), 'harness/dsh', session.id), log = readDshHistory(home, session.id, workspace);
  assert.equal(log.jobs.size, 0); assert.equal(log.calls.size, 0);
  assert.equal(log.rows.filter(event => event.type === 'tool/call' && event.data.name === 'bash').length, 1);
  const receiptPath = join(home, 'input-receipts.json'), receiptRows = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receiptRows['native-feedback'].state = 'accepted'; delete receiptRows['native-feedback'].evidence;
  writeFileSync(receiptPath, JSON.stringify(receiptRows) + '\n'); // Simulate a host receipt commit lost; never edit native history.
  assert.equal(inspectDshInputReceipts(log, receiptRows).reconciled['native-feedback'].state, 'read');
  const completed = await driver.inspectRecovery({ ...input('native-work'), session, inputs: [{ inputId: 'native-feedback', status: 'unknown' }] });
  assert.equal(completed?.outcome, 'completed'); assert.deepEqual(completed.readInputIds, ['native-feedback']);
  assert.equal(completed.report.summary, result.summary);
  assert.equal(await driver.inspectRecovery({ ...input('wrong-run'), session }), null);
  assert.equal(await driver.inspectRecovery({ ...input('native-work'), session, inputs: [{ inputId: 'missing-native-input', status: 'unknown' }] }), null);
  // A real native process loss during model generation has a consumed input,
  // no pending inbox/tool/job and no terminal report. Resume the exact session.
  phase = 'crash'; registered = [];
  await assert.rejects(driver.run({ ...input('native-crash'), session }), /closed|failed|stopped/);
  assert.ok(registered.every(pid => !alive(pid)));
  const interruptedSession = session;
  const interrupted = await driver.inspectRecovery({ ...input('native-crash'), session });
  assert.equal(interrupted?.outcome, 'resume'); assert.equal(interrupted.toolsSettled, true);
  phase = 'resume';
  const resumed = await driver.run({ ...input('native-resume'), session });
  assert.equal(resumed.summary, 'same native session resumed'); assert.deepEqual(session, interruptedSession);
  // Cancellation after promotion must reclaim the shell and its descendants.
  phase = 'cancel'; registered = []; cancelController = new AbortController();
  await assert.rejects(driver.run({ ...input('native-cancel'), signal: cancelController.signal }), /cancel/);
  assert.ok(registered.every(pid => !alive(pid)));
  assert.equal(existsSync(join(workspace, 'cancelled-result.txt')), false);
  const shellPid = Number(readFileSync(join(workspace, 'cancelled.pid'), 'utf8'));
  assert.equal(alive(shellPid), false);
  assert.equal(await driver.inspectRecovery({ ...input('native-cancel'), session }), null);
  assert.equal(failures.length, 0, failures.map(error => error.stack).join('\n'));
  console.log(JSON.stringify({ nativeVersion: '0.2.1-rc.5', localProviderCalls: calls, foregroundWaitMs: promotedAt - firstRequestAt, completedRecovery: true, sameSessionResume: true, inputReadReconciled: true, scopedRules: true, cancellationClean: true }));
} finally {
  for (const res of held) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (previousKey === undefined) delete process.env.JS_DSH_RELIABILITY_KEY; else process.env.JS_DSH_RELIABILITY_KEY = previousKey;
  if (process.env.JS_DSH_KEEP_ACCEPTANCE !== '1') rmSync(root, { recursive: true, force: true }); else console.error(`Retained acceptance state: ${root}`);
}

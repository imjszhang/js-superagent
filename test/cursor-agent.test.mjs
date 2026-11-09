import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCursorAgentDriver, CURSOR_DEFAULT_MODEL, executeCursorTurn, validateCursorOptions } from '../src/drivers/cursor-agent.mjs';
import { cursorChatPath } from '../src/drivers/cursor-home.mjs';
import { createHarnessRegistry } from '../src/harness/registry.mjs';

const VERSION = '2026.11.05-86047df';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function fakeCursor(root, mode = 'ok', version = VERSION) {
  const executable = join(root, 'fake-cursor-agent.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
if (args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const home = process.env.HOME, keychain = existsSync(join(home, 'Library', 'Keychains'));
if (args[0] === 'status') { console.log(JSON.stringify({ status: 'x', isAuthenticated: mode !== 'unauth' && keychain })); process.exit(0); }
if (args[0] === 'models') { if (mode === 'unauth' || !process.env.CURSOR_API_KEY || process.env.AGENT_CLI_CREDENTIAL_STORE !== 'memory') { console.error('The provided API key is invalid.'); process.exit(1); } console.log('composer-2.5'); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(join(home, 'fake-calls.jsonl'), JSON.stringify({ args, prompt, cwd: process.cwd(), apiKey: !!process.env.CURSOR_API_KEY, credentialStore: process.env.AGENT_CLI_CREDENTIAL_STORE ?? null, keychain, github: !!process.env.GITHUB_TOKEN, xdg: Object.keys(process.env).some(key => key.startsWith('XDG_')) }) + '\\n');
if (mode === 'unauth') { console.error("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."); process.exit(1); }
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null, id = resume ?? randomUUID();
const chat = join(home, '.cursor', 'chats', createHash('md5').update(realpathSync(process.cwd())).digest('hex'), id);
mkdirSync(chat, { recursive: true }); writeFileSync(join(chat, 'store.db'), 'chat');
const send = value => console.log(JSON.stringify({ ...value, session_id: id }));
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref();
send({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), model: 'fixture', permissionMode: 'default' });
send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
send({ type: 'thinking', subtype: 'delta', text: 'thinking' });
send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '正在处理。' }] } });
const ask = args.includes('--mode');
if (!ask) {
  send({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { editToolCall: { args: { path: 'out.txt' } } } });
  writeFileSync(join(process.cwd(), 'out.txt'), 'done');
  send({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { editToolCall: { result: { success: {} } } } });
}
const report = prompt.includes('Inspect a human follow-up') ? { kind: 'reply', summary: 'Answered from facts', question: null, base: null }
  : prompt.includes('ASK_QUESTION') ? { version: 2, state: 'waiting', summary: 'Need a choice', artifacts: [], attention: { question: 'Which format?' }, answers: null }
  : mode === 'bad-report' ? 'not json' : { version: 2, state: 'ready', summary: 'Wrote out.txt', artifacts: ['out.txt'], attention: null, answers: null };
const final = typeof report === 'string' ? report : JSON.stringify(report);
send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: final }] } });
if (mode !== 'no-result') send({ type: 'result', subtype: 'success', is_error: false, result: '正在处理。' + final, duration_ms: 1 });
process.exit(0);
`, { mode: 0o700 });
  return executable;
}
function fixture(t, mode = 'ok', extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-cursor-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const options = { executable: fakeCursor(root, mode), model: 'fixture-model', killGraceMs: 30, timeoutMs: 10000, ...extra };
  const sessions = [], pids = [], facts = [];
  const input = { projectRoot: workspace, sourceProjectRoot: root, runId: randomUUID(), signal: new AbortController().signal, prompt: 'do bounded work',
    checkpoint: value => sessions.push(value), registerProcess: pid => pids.push(pid), checkpointNative: value => facts.push(value) };
  const homes = () => join(stateDir(root), 'harness', 'cursor-agent', 'homes');
  const calls = () => readdirSync(homes()).flatMap(home => { const file = join(homes(), home, 'fake-calls.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; });
  return { root, workspace, options, input, sessions, pids, facts, homes, calls };
}

test('Cursor options default the model, keep coordination read-only and accept named credentials only', () => {
  assert.equal(validateCursorOptions({ model: 'm' }).permission, 'workspace-write');
  assert.equal(validateCursorOptions({}).model, CURSOR_DEFAULT_MODEL);
  assert.equal(validateCursorOptions({ model: 'm' }, { role: 'coordinator' }).permission, 'read-only');
  for (const options of [{ model: 'Auto' }, { model: 'm', apiKeyEnv: 'not a name' }, { model: 'm', enableAgentTools: true }, { model: 'm', permission: 'bypass' }]) assert.throws(() => validateCursorOptions(options));
  assert.throws(() => validateCursorOptions({ model: 'm', permission: 'workspace-write' }, { role: 'coordinator' }));
  const capabilities = createCursorAgentDriver({ model: 'm' }).capabilities;
  assert.equal(capabilities.sessionResume, true); assert.equal(capabilities.realtimeInput, false); assert.equal(capabilities.agentTools, false);
});

test('a Cursor turn runs sandboxed without force, reads the prompt from stdin and returns the last assistant message', async t => {
  const f = fixture(t), previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_fixture'; t.after(() => { if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous; });
  const result = await executeCursorTurn(f.options, f.input);
  assert.equal(JSON.parse(result.text).summary, 'Wrote out.txt');
  assert.deepEqual(f.sessions, [{ driver: 'cursor-agent', id: result.sessionId }]);
  const [call] = f.calls();
  assert.equal(call.prompt, 'do bounded work'); assert.equal(call.args.includes('do bounded work'), false);
  for (const flag of ['--force', '--yolo', '--approve-mcps', '--mode']) assert.equal(call.args.includes(flag), false, flag);
  assert.deepEqual(call.args.slice(call.args.indexOf('--sandbox'), call.args.indexOf('--sandbox') + 2), ['--sandbox', 'enabled']);
  assert.equal(call.args[call.args.indexOf('--workspace') + 1], f.workspace);
  assert.equal(call.keychain, true); assert.equal(call.apiKey, false); assert.equal(call.credentialStore, null); assert.equal(call.github, false);
  assert.equal(call.xdg, false, 'XDG_* would move the chat store out of HOME/.cursor');
  const [homeId] = readdirSync(f.homes());
  assert.equal(lstatSync(join(f.homes(), homeId, 'Library', 'Keychains')).isSymbolicLink(), true);
  assert.equal(f.facts[0].accountRules, 'personal-account');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.pids.length, 2); assert.ok(f.pids.every(pid => !alive(pid)));
  const leftovers = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes('setInterval(() => {}, 1000)') && line.includes('-e'));
  assert.equal(leftovers.length, 0);
});

test('Cursor resumes only the chat stored for the same workspace and login', async t => {
  const f = fixture(t);
  const first = await executeCursorTurn(f.options, f.input);
  const session = f.sessions[0];
  const second = await executeCursorTurn(f.options, { ...f.input, runId: randomUUID(), session });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(f.calls().at(-1).args[f.calls().at(-1).args.indexOf('--resume') + 1], session.id);
  const other = join(f.root, 'other'); mkdirSync(other);
  await assert.rejects(executeCursorTurn(f.options, { ...f.input, runId: randomUUID(), session, projectRoot: other }), /another workspace/);
  process.env.JS_CURSOR_TEST_KEY = 'crsr_fixturefixturefixture'; t.after(() => delete process.env.JS_CURSOR_TEST_KEY);
  await assert.rejects(executeCursorTurn({ ...f.options, apiKeyEnv: 'JS_CURSOR_TEST_KEY' }, { ...f.input, runId: randomUUID(), session }), /another login/);
  const [homeId] = readdirSync(f.homes());
  rmSync(cursorChatPath(join(f.homes(), homeId), f.workspace, session.id));
  const before = f.pids.length;
  await assert.rejects(executeCursorTurn(f.options, { ...f.input, runId: randomUUID(), session }), /chat history is missing/);
  assert.equal(f.pids.length, before, 'no process starts when the chat cannot be proven');
});

test('API-key Cursor sessions pass only the named key and never link the keychain', async t => {
  const f = fixture(t, 'ok', { apiKeyEnv: 'JS_CURSOR_TEST_KEY' });
  await assert.rejects(executeCursorTurn(f.options, f.input), /Missing Cursor credential variable/);
  process.env.JS_CURSOR_TEST_KEY = 'crsr_fixturefixturefixture'; t.after(() => delete process.env.JS_CURSOR_TEST_KEY);
  await executeCursorTurn(f.options, { ...f.input, runId: randomUUID() });
  const call = f.calls().at(-1);
  assert.equal(call.apiKey, true); assert.equal(call.keychain, false);
  assert.equal(call.credentialStore, 'memory', 'any other store makes the CLI write the token to the macOS keychain');
  assert.equal(f.facts.at(-1).accountRules, 'api-key-account');
  for (const file of readdirSync(join(stateDir(f.root), 'runs'))) {
    for (const log of ['cursor-events.jsonl', 'cursor-stderr.log']) { const path = join(stateDir(f.root), 'runs', file, log); if (existsSync(path)) assert.equal(readFileSync(path, 'utf8').includes('crsr_fixture'), false); }
  }
});

test('Cursor failures are typed and cancellation stops the owned process group', async t => {
  await assert.rejects(executeCursorTurn(fixture(t, 'unauth').options, fixture(t, 'unauth').input), error => error.code === 'AUTH');
  const missing = fixture(t, 'no-result');
  await assert.rejects(executeCursorTurn(missing.options, missing.input), /without a successful result/);
  const hung = fixture(t, 'hang'), controller = new AbortController();
  const running = executeCursorTurn(hung.options, { ...hung.input, signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (hung.pids.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(running, /cancelled/);
  assert.ok(hung.pids.every(pid => !alive(pid)));
});

test('the Cursor Worker parses its v2 report and the coordinator stays read-only in an empty context', async t => {
  const f = fixture(t);
  const driver = createCursorAgentDriver(f.options);
  const ticket = { id: 'ticket-1', scope: 'Write out.txt', text: 'Write out.txt', messages: [], reports: [] };
  const ready = await driver.run({ ...f.input, ticket, assignmentId: 'a1', contextDelivered: () => {} });
  assert.equal(ready.state, 'ready'); assert.deepEqual(ready.artifacts, ['out.txt']);
  const waiting = await driver.run({ ...f.input, runId: randomUUID(), ticket: { ...ticket, text: 'ASK_QUESTION' }, assignmentId: 'a1', session: f.sessions[0] });
  assert.equal(waiting.state, 'waiting'); assert.equal(waiting.attention.question, 'Which format?');
  const bad = fixture(t, 'bad-report');
  await assert.rejects(createCursorAgentDriver(bad.options).run({ ...bad.input, ticket, assignmentId: 'a1' }), /not a JSON report/);
  const registry = createHarnessRegistry();
  const assessor = registry.createAssessor({ driver: 'cursor-agent', ...f.options });
  const decision = await assessor.inspectContinuation({ projectRoot: f.root, runId: randomUUID(), facts: { scope: 'scope', source: { merged: false } },
    registerProcess: () => {}, checkpoint: () => {}, signal: new AbortController().signal });
  assert.equal(decision.kind, 'reply');
  const call = f.calls().find(item => item.cwd === join(stateDir(f.root), 'assessment-context'));
  assert.ok(call, 'coordinator ran in the empty assessment context');
  assert.deepEqual(call.args.slice(call.args.indexOf('--mode'), call.args.indexOf('--mode') + 2), ['--mode', 'ask']);
});

test('the Cursor adapter declares launch, login and coordinator settings without starting a model', t => {
  const f = fixture(t), registry = createHarnessRegistry();
  const listed = registry.list().find(item => item.id === 'cursor-agent');
  assert.equal(listed.label, 'Cursor'); assert.deepEqual(listed.settingsFields, ['permission', 'apiKeyEnv']);
  assert.deepEqual(registry.serviceLaunch({ driver: 'cursor-agent', model: 'm', apiKeyEnv: 'CURSOR_WORKER_KEY' }).credentialEnvNames, ['CURSOR_WORKER_KEY']);
  assert.equal(registry.coordinatorExecution({ driver: 'cursor-agent', model: 'm', permission: 'workspace-write' }).permission, 'read-only');
  const personal = registry.loginProbe({ driver: 'cursor-agent', ...f.options }, { execFileSync });
  assert.equal(personal.status, 'passed'); assert.match(personal.message, /personal login/);
  const blocked = registry.loginProbe({ driver: 'cursor-agent', ...fixture(t, 'unauth').options }, { execFileSync });
  assert.equal(blocked.status, 'blocked');
  process.env.JS_CURSOR_TEST_KEY = 'crsr_fixturefixturefixture'; t.after(() => delete process.env.JS_CURSOR_TEST_KEY);
  const keyed = registry.loginProbe({ driver: 'cursor-agent', ...f.options, apiKeyEnv: 'JS_CURSOR_TEST_KEY' }, { execFileSync });
  assert.equal(keyed.status, 'passed'); assert.match(keyed.message, /API key/);
  const rejected = registry.loginProbe({ driver: 'cursor-agent', ...fixture(t, 'unauth').options, apiKeyEnv: 'JS_CURSOR_TEST_KEY' }, { execFileSync });
  assert.equal(rejected.status, 'blocked');
  assert.throws(() => registry.validateExecution({ driver: 'cursor-agent', model: 'm', enableManagedJobs: true }), /Unsupported Cursor options field/);
});

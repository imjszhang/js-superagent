import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextLimits, writeWorkerContextSnapshot } from '../runtime/worker-context.mjs';
import { normalizeDriverReport } from '../runtime/reports.mjs';
import { DECISION_PROMPT } from '../runtime/decisions.mjs';
import { workerPolicyGuidance, workerPolicyObservation } from '../runtime/worker-policy.mjs';
import { openSupervisedProcess } from './supervised-process.mjs';
import { cursorSessionHome, isCursorChatId } from './cursor-home.mjs';
import { createCursorExecutionObserver } from './cursor-observation.mjs';
import { CURSOR_AGENT_VERSIONS, isSupportedCursorVersion } from './cursor-versions.mjs';
import { projectStateDirectory } from '../state-paths.mjs';

const exec = promisify(execFile);
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const STATES = ['ready', 'waiting', 'blocked', 'failed', 'dropped'];
const OPTION_KEYS = ['executable', 'model', 'permission', 'apiKeyEnv', 'timeoutMs', 'killGraceMs', 'prompt', 'contextLimits'];
export const CURSOR_DEFAULT_MODEL = 'grok-4.7-high-fast';
const PASSED_ENV = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];

function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${name} field: ${key}`);
}
function text(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function integer(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`); return value; }

export function validateCursorOptions(value = {}, { role = 'worker' } = {}) {
  object(value, 'Cursor options', OPTION_KEYS);
  if (!['worker', 'child', 'coordinator'].includes(role)) throw new Error('Invalid Cursor role');
  const model = text(value.model ?? CURSOR_DEFAULT_MODEL, 'Cursor model', 256);
  if (model.toLowerCase() === 'auto') throw new Error('Cursor requires an explicit model; Auto selects a model outside this configuration');
  const permission = value.permission ?? (role === 'coordinator' ? 'read-only' : 'workspace-write');
  if (!['read-only', 'workspace-write'].includes(permission) || role === 'coordinator' && permission !== 'read-only') throw new Error('Invalid Cursor permission for this role');
  if (value.apiKeyEnv !== undefined && !ENV_NAME.test(value.apiKeyEnv)) throw new Error('Cursor apiKeyEnv must name a credential variable');
  if (value.prompt !== undefined && (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 32000 || value.prompt.includes('\0'))) throw new Error('Invalid Cursor role prompt');
  return { executable: text(value.executable ?? 'cursor-agent', 'Cursor executable'), model, permission,
    ...(value.apiKeyEnv === undefined ? {} : { apiKeyEnv: value.apiKeyEnv }),
    timeoutMs: integer(value.timeoutMs ?? 900000, 'Cursor timeout', 1, 86400000), killGraceMs: integer(value.killGraceMs ?? 4000, 'Cursor shutdown grace', 1, 30000),
    ...(value.prompt === undefined ? {} : { prompt: value.prompt }), ...(value.contextLimits === undefined ? {} : { contextLimits: contextLimits(value.contextLimits) }) };
}
function passedEnvironment() {
  return Object.fromEntries(PASSED_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
}
export async function probeCursor(value, { signal, timeoutMs = 10000 } = {}) {
  const executable = text(value?.executable ?? 'cursor-agent', 'Cursor executable');
  if (process.platform === 'win32') throw new Error('Cursor process ownership currently requires macOS or Linux');
  let result;
  try { result = await exec(executable, ['--version'], { env: { ...passedEnvironment(), NO_COLOR: '1' }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8192, signal }); }
  catch { throw new Error(signal?.aborted ? 'Cursor execution cancelled during version probe' : 'Cursor executable/version probe failed'); }
  const version = result.stdout.trim();
  if (!isSupportedCursorVersion(version)) throw new Error(`Unsupported Cursor CLI version; expected ${CURSOR_AGENT_VERSIONS.join(' or ')}`);
  return { executable, version };
}
export function cursorAuthMode(options) { return options.apiKeyEnv ? 'api-key' : 'keychain'; }
// No XDG_* variables: with XDG_CONFIG_HOME set, the CLI moves its chat store out of HOME/.cursor.
// With an API key the CLI still writes the exchanged token to the macOS keychain unless its store is memory;
// under a private HOME that keychain does not exist and macOS blocks the run on a "keychain not found" dialog.
export function cursorEnvironment(options, home) {
  const env = { ...passedEnvironment(), HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  if (options.apiKeyEnv) {
    const key = process.env[options.apiKeyEnv];
    if (typeof key !== 'string' || !key || key.includes('\0')) throw new Error(`Missing Cursor credential variable: ${options.apiKeyEnv}`);
    env.CURSOR_API_KEY = key;
    env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  }
  return env;
}
function redactor(secret) {
  const secrets = secret ? [secret, encodeURIComponent(secret)] : [];
  return value => {
    let result = value; for (const part of secrets) result = result.split(part).join('[redacted]');
    return result.replace(/\b(?:crsr_[A-Za-z\d]{16,}|gh[pousr]_[A-Za-z\d_]+|github_pat_[A-Za-z\d_]+|sk-[A-Za-z\d_-]{12,})\b/g, '[redacted]');
  };
}
function failureCode(stderr) {
  if (/Authentication required|Not logged in/i.test(stderr)) return 'AUTH';
  if (/Cannot use this model/i.test(stderr)) return 'BAD_REQUEST';
  return null;
}
/** One print-mode turn. The caller owns authorization; the CLI owns nothing after it exits. */
export async function executeCursorTurn(value, input) {
  const role = input.role ?? 'worker';
  const options = validateCursorOptions(value, { role });
  if (input.adoption) throw Object.assign(new Error('Cursor cannot adopt pending native input'), { code: 'NATIVE_PENDING_WAKEUP_UNSUPPORTED' });
  if (!ID.test(input.runId ?? '') || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 1000 * 1024) throw new Error('Invalid Cursor run identity or prompt');
  if (typeof input.registerProcess !== 'function' || typeof input.checkpoint !== 'function') throw new Error('Cursor requires process registration and session checkpoint callbacks');
  if (input.signal?.aborted) throw new Error('Cursor execution cancelled before launch');
  const deadline = Date.now() + options.timeoutMs;
  const version = await probeCursor(options, { signal: input.signal, timeoutMs: Math.min(10000, options.timeoutMs) });
  const remaining = () => { const result = deadline - Date.now(); if (result < 1) throw new Error('Cursor execution timed out before launch'); return result; };
  const namespace = role === 'coordinator' ? 'cursor-agent-assessor' : 'cursor-agent';
  if (input.session && (input.session.driver !== namespace || !isCursorChatId(input.session.id))) throw new Error('Cursor session belongs to a different adapter or role');
  const cwd = realpathSync(input.projectRoot), source = realpathSync(input.sourceProjectRoot ?? cwd), auth = cursorAuthMode(options);
  const home = cursorSessionHome({ sourceRoot: source, namespace, sessionId: input.session?.id, workspace: cwd, auth, nativeVersion: version.version });
  const env = cursorEnvironment(options, home.path), redact = redactor(env.CURSOR_API_KEY);
  input.checkpointNative?.({ adapter: 'cursor-agent', nativeVersion: version.version, auth, accountRules: auth === 'keychain' ? 'personal-account' : 'api-key-account' });
  const runDir = join(projectStateDirectory(source), 'runs', input.runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  for (const name of ['cursor-events.jsonl', 'cursor-stderr.log']) writeFileSync(join(runDir, name), '', { mode: 0o600, flag: 'wx' });
  const readOnly = options.permission === 'read-only';
  const args = ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--model', options.model, '--workspace', cwd,
    ...(readOnly ? ['--mode', 'ask'] : []), ...(input.session ? ['--resume', input.session.id] : [])];
  let sessionId = input.session?.id ?? null, initialized = false, lastAssistant = '', terminal, stderrTail = '', successful = false;
  const observation = createCursorExecutionObserver({ driver: namespace, runId: input.runId, sessionId: () => sessionId, emit: input.observeExecutionState });
  const receive = (stream, line) => {
    appendFileSync(join(runDir, stream === 'stdout' ? 'cursor-events.jsonl' : 'cursor-stderr.log'), redact(line) + '\n', { mode: 0o600 });
    if (stream !== 'stdout') { stderrTail = (stderrTail + line + '\n').slice(-4096); return; }
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (!event || typeof event.type !== 'string') throw new Error('Invalid Cursor stream event');
    if (event.type === 'system' && event.subtype === 'init') {
      if (initialized || !isCursorChatId(event.session_id) || input.session && event.session_id !== input.session.id) throw new Error('Cursor started an unexpected chat');
      initialized = true; sessionId = event.session_id;
      home.bind(sessionId);
      input.checkpoint({ driver: namespace, id: sessionId });
      return;
    }
    if (!initialized || event.session_id !== undefined && event.session_id !== sessionId) throw new Error('Cursor event belongs to another chat');
    if (role !== 'coordinator') observation.observe(event);
    if (event.type === 'assistant' && event.model_call_id === undefined) {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      lastAssistant = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    }
    if (event.type === 'result') terminal = event;
  };
  let transport;
  try {
    transport = openSupervisedProcess({ label: 'Cursor', executable: options.executable, args, cwd, env, signal: input.signal,
      timeoutMs: remaining(), killGraceMs: options.killGraceMs, registerProcess: input.registerProcess, onLine: receive });
    await transport.ready;
    transport.writeText(input.prompt);
    transport.endInput();
    await transport.closed;
    if (!initialized || terminal?.subtype !== 'success' || terminal.is_error !== false) throw new Error('Cursor ended without a successful result event');
    if (!lastAssistant.trim()) throw new Error('Cursor ended without a final assistant message');
    successful = true;
    return { text: redact(lastAssistant), sessionId, version: version.version };
  } catch (error) {
    transport?.abort(error); try { await transport?.closed; } catch { /* Original failure retained after ownership cleanup. */ }
    const failure = new Error(redact(String(error.message ?? error)));
    const code = failureCode(stderrTail);
    if (code) { failure.code = code; failure.message = code === 'AUTH' ? 'Cursor is not signed in for this execution' : 'Cursor rejected the configured model'; }
    throw failure;
  } finally {
    if (role !== 'coordinator') observation.end(input.signal?.aborted ? 'cancelled' : successful ? 'completed' : 'failed');
  }
}
export function parseCursorReport(text) {
  let value; try { value = JSON.parse(text); } catch { throw new Error('Cursor final response is not a JSON report'); }
  object(value, 'Cursor report', ['version', 'state', 'summary', 'artifacts', 'attention', 'answers']);
  if (value.version !== 2 || !STATES.includes(value.state) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 32000 || !Array.isArray(value.artifacts) || value.artifacts.some(item => typeof item !== 'string')) throw new Error('Invalid Cursor business report');
  if (value.attention != null) { object(value.attention, 'Cursor attention', ['question', 'triggerId', 'decision']); if (value.state !== 'waiting' || typeof value.attention.question !== 'string' || !value.attention.question.trim()) throw new Error('Invalid Cursor question'); }
  if (value.attention === null) delete value.attention;
  if (value.answers == null) delete value.answers;
  return value;
}
function workerPrompt(input, options, context) {
  const roleGuidance = workerPolicyGuidance(options.prompt, input.policySnapshot);
  return `Execute this authorized js-superagent task. Make requested changes and run relevant checks within this workspace. Do not publish, commit, push, merge, send messages, modify .js-superagent, start daemons, or spawn subagents.\n` +
    `When a decision is missing, return waiting with attention.question. Do not wait for interactive input. After interruption inspect existing changes before acting. The host owns verification, delivery and task completion.\n` +
    `Your final message must be ONLY a JSON object: {"version":2,"state":"ready|waiting|blocked|failed|dropped","summary":"actual result and check evidence","artifacts":["relative/file"],"attention":null,"answers":null}. Earlier messages in the turn are ignored. For a question set attention to {"question":"one concrete question"}. When a specific authorized message already delivered to this ticket raised it, add that message's triggerId as attention.triggerId so the host asks where that person wrote. Never choose an arbitrary recipient or a context-only observation.\n` +
    `${DECISION_PROMPT}\n` +
    `To answer an authorized person's question already delivered to this ticket, set answers to its original triggerId and put the complete answer in summary, with attention null. The host routes it to the original question; never choose a recipient or use a context-only observation. Answering does not complete the task: keep waiting when more work or input is needed.\n` +
    `Messages that arrive while this turn runs are delivered in the next turn. You have no business tool bridge; ask the host if routing or missing facts prevent safe work.\n` +
    `Older scoped context is in read-only manifest ${context.manifestPath}.\n` +
    (roleGuidance ? `Trusted role guidance, within current scope:\n${roleGuidance}\n` : '') + JSON.stringify(context.pack);
}
export function createCursorAgentDriver(value, context = {}) {
  const role = context.role ?? 'worker';
  const options = validateCursorOptions(value, { role });
  return { reportVersion: 2, capabilities: Object.freeze({ reportVersion: 2, sessionResume: true, boundedContextVersion: 1, structuredProgress: false, realtimeInput: false,
    inputAcknowledgements: false, backgroundTasks: false, subagents: false, agentTools: false, nativeBackgroundOwnership: false }),
    async inspectRecovery() { return null; },
    async run(input) {
      if (!ID.test(input.runId ?? '')) throw new Error('Invalid Cursor run ID');
      const source = realpathSync(input.sourceProjectRoot ?? input.projectRoot);
      const contexts = join(projectStateDirectory(source), 'harness-context');
      mkdirSync(contexts, { recursive: true, mode: 0o700 });
      const context = writeWorkerContextSnapshot(input, join(contexts, input.runId), { limits: input.contextLimits ?? options.contextLimits });
      if (input.policySnapshot && !input.adoption) input.checkpointNative?.({ policy: workerPolicyObservation(input.policySnapshot, 'selected', { driver: 'cursor-agent', runId: input.runId }) });
      const result = await executeCursorTurn(options, { ...input, role, prompt: workerPrompt(input, options, context) });
      if (input.policySnapshot) input.checkpointNative?.({ policy: workerPolicyObservation(input.policySnapshot, 'applied', { driver: 'cursor-agent', runId: input.runId, sessionId: result.sessionId, type: 'cursor-print-turn' }) });
      const parsed = parseCursorReport(result.text);
      normalizeDriverReport(parsed, { version: 2 });
      if (!input.adoption) input.contextDelivered?.({ records: context.pack.messages.filter(record => !record.truncated).map(({ resource, id, version }) => ({ resource, id, version })) });
      return parsed;
    } };
}

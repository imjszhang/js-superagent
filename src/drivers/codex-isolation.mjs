import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// These are ambient host integrations, not the runtime's explicitly registered dynamic tools.
export const BLOCKED_CODEX_FEATURES = Object.freeze(['apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'multi_agent', 'remote_plugin', 'plugin_sharing', 'plugin_discovery_prefetch', 'skill_mcp_dependency_install']);
const SERVER = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT = 2 * 1024 * 1024;
const failure = () => Object.assign(new Error('Codex capability isolation is unsupported or could not be verified; no model turn was started'), { code: 'JS_SUPERAGENT_CODEX_ISOLATION' });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const baseArgs = () => [...BLOCKED_CODEX_FEATURES.flatMap(name => ['--disable', name]), '-c', 'notify=[]', '-c', 'web_search="disabled"'];
function validConfig(result, requiredFeatures = {}) {
  const config = result?.config;
  if (!config || typeof config !== 'object' || !Array.isArray(result.layers) || !config.features ||
    BLOCKED_CODEX_FEATURES.some(name => config.features[name] !== false) || Object.entries(requiredFeatures).some(([name, value]) => config.features[name] !== value) ||
    !Array.isArray(config.notify) || config.notify.length || config.web_search !== 'disabled') throw failure();
  if (config.mcp_servers !== undefined && (!config.mcp_servers || typeof config.mcp_servers !== 'object' || Array.isArray(config.mcp_servers))) throw failure();
  const servers = Object.entries(config.mcp_servers ?? {});
  if (servers.length > 128 || servers.some(([name, item]) => !SERVER.test(name) || !item || typeof item !== 'object' ||
      (typeof item.command !== 'string' && typeof item.url !== 'string') || typeof item.command === 'string' && typeof item.url === 'string')) throw failure();
  return { config, servers };
}
export function assertCodexIsolation(result, policy) {
  const { servers } = validConfig(result, policy.requiredFeatures);
  if (servers.some(([, value]) => value.enabled !== false) || servers.some(([name]) => !policy.servers.includes(name)) ||
      servers.length !== policy.servers.length || digest(result) !== policy.fingerprint) throw failure();
}

/** Read effective project layers without starting a thread, MCP connection or model turn.
 * All response/config/stderr bytes stay in memory: configuration can contain credentials. */
export async function readCodexIsolationConfig({ executable, cwd, env, args, signal, threadId, policy }) {
  if (signal?.aborted) throw failure();
  const clientInfo = { name: 'js-superagent-isolation', version: '1' };
  const child = spawn(executable, ['app-server', '--stdio', '--startup-client-info', JSON.stringify(clientInfo), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let result, pending = '', bytes = 0, settled = false, stopTimer;const decoder = new StringDecoder('utf8');
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = () => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');stopTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    }
  };
  try {
    result = await new Promise((resolve, reject) => {
      const finish = (error, value) => { if (settled) return;settled = true;clearTimeout(timer);signal?.removeEventListener('abort', abort);error ? reject(failure()) : resolve(value); };
      const abort = () => finish(true);
      const timer = setTimeout(abort, 10_000);signal?.addEventListener('abort', abort, { once: true });
      const send = value => { try { child.stdin.write(JSON.stringify(value) + '\n'); } catch { finish(true); } };
      child.once('error', abort);child.once('close', abort);child.stdin.on('error', abort);
      child.stderr.on('data', chunk => { bytes += chunk.length;if (bytes > LIMIT) finish(true); });
      child.stdout.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;if (bytes > LIMIT) { finish(true);return; }
        pending += decoder.write(chunk);let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);pending = pending.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.error) { finish(true);return; }
            if (message.id === 1) {
              if (!message.result) { finish(true);return; }
              send({ method: 'initialized' });send({ id: 2, method: 'config/read', params: { cwd, includeLayers: true } });
            } else if (message.id === 2) {
              if (threadId) { assertCodexIsolation(message.result, policy); send({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }); }
              else { finish(false, message.result);return; }
            } else if (message.id === 3 && threadId) { finish(false, message.result);return; }
          } catch { finish(true);return; }
        }
      });
      child.once('spawn', () => send({ id: 1, method: 'initialize', params: { clientInfo } }));
    });
  } finally { stop();await closed;clearTimeout(stopTimer); }
  return result;
}

/** Explicit feature support is required; a permissive parser silently ignoring flags is insufficient. */
async function verifyFeatureSupport({ executable, cwd, env, args, signal, requiredFeatures }) {
  const output = await new Promise((resolve, reject) => execFile(executable, [...args, 'features', 'list'],
    { cwd, env, signal, timeout: 10_000, maxBuffer: LIMIT, encoding: 'utf8', windowsHide: true },
    (error, stdout) => {
      if (!error) { resolve(stdout);return; }
      if (['ENOENT', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'].includes(error.code)) reject(Object.assign(new Error(`Codex isolation probe could not launch (${error.code}); no model turn was started`), { code: error.code }));
      else reject(failure());
    }));
  const flags = new Map(output.split('\n').flatMap(line => { const match = /^(\S+)\s+.+\s+(true|false)\s*$/.exec(line);return match ? [[match[1], match[2]]] : []; }));
  if (BLOCKED_CODEX_FEATURES.some(name => flags.get(name) !== 'false') || Object.entries(requiredFeatures).some(([name, value]) => flags.get(name) !== String(value))) throw failure();
}

export async function prepareCodexIsolation({ executable, cwd, env, signal, extraArgs = [], requiredFeatures = {} }) {
  if (!requiredFeatures || typeof requiredFeatures !== 'object' || Array.isArray(requiredFeatures) || Object.entries(requiredFeatures).some(([name, value]) => !/^[a-z][a-z0-9_]{0,100}$/.test(name) || typeof value !== 'boolean' || BLOCKED_CODEX_FEATURES.includes(name) && value)) throw failure();
  const initialArgs = [...baseArgs(), ...extraArgs];
  await verifyFeatureSupport({ executable, cwd, env, args: initialArgs, signal, requiredFeatures });
  const initial = await readCodexIsolationConfig({ executable, cwd, env, args: initialArgs, signal });
  const { servers } = validConfig(initial, requiredFeatures);
  const args = [...initialArgs];
  // Project-only entries must have a transport at bootstrap, before project layers load.
  // Never put the original endpoint, command arguments, environment or credentials in argv.
  for (const [name, value] of servers) args.push('-c', `mcp_servers.${name}.enabled=false`, '-c',
    typeof value.url === 'string' ? `mcp_servers.${name}.url="http://127.0.0.1:9/disabled"` : `mcp_servers.${name}.command=${JSON.stringify(process.execPath)}`);
  const verified = await readCodexIsolationConfig({ executable, cwd, env, args, signal });
  const policy = { version: 1, args, servers: servers.map(([name]) => name).sort(), requiredFeatures: Object.freeze({...requiredFeatures}), fingerprint: digest(verified) };
  assertCodexIsolation(verified, policy);
  return Object.freeze(policy);
}

/** Exec has no in-process config/read handshake. Recheck all effective layers immediately before launch. */
export async function recheckCodexIsolation(options, policy) {
  assertCodexIsolation(await readCodexIsolationConfig({ ...options, args: policy.args }), policy);
}

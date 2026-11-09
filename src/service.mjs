import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { readProjectConfig } from './config.mjs';
import { assertFeishuServiceConfig } from './channels/feishu.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHarnessRegistry } from './harness/registry.mjs';
import { assertDatabaseAvailable } from './database-maintenance.mjs';
import { createMachineCoordinator, captureProcessIdentity, inspectProcessOwner } from './machine-coordination.mjs';
import { acceptServiceHeartbeat, evaluateServiceHealth } from './service-health.mjs';
import { patrolService } from './service-patrol.mjs';
import { projectStateDirectory, stateHome } from './state-paths.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_CLI = resolve(dirname(MODULE_PATH), '../bin/js-superagent.mjs');
const MAX_MANIFEST = 64 * 1024;
const DEFAULT_LOG_BYTES = 5 * 1024 * 1024;
const MAX_START_RETRIES = 8;
const sha = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
function stat(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function checkedPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Service paths must be absolute and contain no control characters');
  return path;
}
function safeDirectory(path, create = false) {
  checkedPath(path);
  const parent = dirname(path);
  if (parent !== path) safeDirectory(parent, create);
  let info = stat(path);
  if (!info && create) { mkdirSync(path, { mode: 0o700 }); info = stat(path); }
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Service directory must not be redirected: ${path}`);
  return Boolean(info);
}
function safeFile(path, required = true, maxBytes = Infinity) {
  safeDirectory(dirname(path));
  const info = stat(path);
  if (!info) { if (required) throw new Error(`Required service file is missing: ${path}`); return null; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error(`Service file must be a regular, unlinked file within its size limit: ${path}`);
  return info;
}
function readSafe(path, maxBytes = MAX_MANIFEST) {
  safeFile(path, true, maxBytes);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function writeExclusive(path, content) {
  safeFile(path, false);
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}
function writeAtomic(path, value) {
  safeFile(path, false, MAX_MANIFEST);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeExclusive(temporary, JSON.stringify(value, null, 2) + '\n');
  try { renameSync(temporary, path); }
  finally { if (stat(temporary)) unlinkSync(temporary); }
}
function startupState(directory) {
  const path = join(directory, 'startup.json');
  if (!safeFile(path, false, MAX_MANIFEST)) return null;
  const value = JSON.parse(readSafe(path));
  if (value.schemaVersion !== 1 || !['starting', 'ready', 'retrying', 'blocked', 'stopped'].includes(value.state) || !Number.isSafeInteger(value.retryCount) || value.retryCount < 0) throw new Error('Invalid service startup state');
  return value;
}
function saveStartup(directory, patch) {
  const previous = startupState(directory);
  const value = { schemaVersion: 1, retryCount: 0, ...previous, ...patch, updatedAt: new Date().toISOString() };
  writeAtomic(join(directory, 'startup.json'), value);
  return value;
}
function blockStartup(directory, code = 'SERVICE_CONFIGURATION', retryCount = 0) {
  return saveStartup(directory, { state: 'blocked', ready: false, retryCount, errorCode: code, nextRetryAt: null,
    message: 'Service startup is blocked. Fix the reported configuration or resource conflict, then run service start.' });
}
/** A short-lived bind probe preserves the synchronous service management API. */
function probePort({ host, port }) {
  if (!(isIP(host) || host === 'localhost') || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid service Webhook endpoint');
  const source = "const net=require('node:net');const [host,port]=JSON.parse(process.argv[1]);const server=net.createServer();server.once('error',e=>{process.stdout.write(JSON.stringify({error:e.code}));process.exitCode=1;});server.listen({host,port},()=>{const port=server.address().port;server.close(()=>process.stdout.write(JSON.stringify({port})));});";
  const result = spawnSync(process.execPath, ['-e', source, JSON.stringify([host, port])], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: { PATH: process.env.PATH } });
  let output;
  try { output = JSON.parse(result.stdout); } catch { /* Report only bounded endpoint diagnostics. */ }
  if (result.error || result.status !== 0 || !Number.isSafeInteger(output?.port)) {
    const code = ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(output?.error) ? output.error : 'SERVICE_PORT_PROBE';
    throw Object.assign(new Error(`Webhook endpoint ${host}:${port} cannot be bound (${code}); choose an available port before starting`), { code });
  }
  return output.port;
}
function executable(value, searchPath) {
  const candidates = value.includes('/') ? [resolve(value)] : searchPath.split(delimiter).filter(isAbsolute).map(directory => join(directory, value));
  for (const candidate of candidates) {
    try {
      const path = checkedPath(realpathSync(candidate));
      if (!lstatSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error(`Executable is unavailable: ${value}`);
}
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
function proxyEnvironment(source) {
  const result = {};
  for (const key of PROXY_KEYS) {
    const value = source[key];
    if (value === undefined || value === '') continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`${key} must be a valid proxy URL without credentials, query or fragment`); }
    if (value.length > 4096 || /[\x00-\x20\x7f]/.test(value) || !['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#') || !['', '/'].includes(url.pathname)) throw new Error(`${key} must be a valid proxy URL without credentials, query or fragment`);
    result[key] = value;
  }
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const value = source[key];
    if (value === undefined) continue;
    if (value.length > 8192 || (value !== '' && value.split(',').some(entry => !entry.trim() || !/^[A-Za-z0-9.*:[\]\/-]+$/.test(entry.trim())))) throw new Error(`${key} must be a comma-separated host, address or network list`);
    result[key] = value;
  }
  return result;
}
function makePlist(plan) {
  const strings = values => values.map(value => `      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key><string>${xml(plan.label)}</string>\n    <key>ProgramArguments</key>\n    <array>\n${strings([plan.nodeExecutable, plan.modulePath, 'run', plan.projectRoot])}\n    </array>\n    <key>WorkingDirectory</key><string>${xml(plan.projectRoot)}</string>\n    <key>EnvironmentVariables</key><dict>\n${Object.entries(plan.environment).map(([key, value]) => `      <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n')}\n    </dict>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key>${plan.restartPolicy === 'on-failure' ? '<dict><key>SuccessfulExit</key><false/></dict>' : '<true/>'}\n    <key>AbandonProcessGroup</key><false/>\n    <key>ThrottleInterval</key><integer>10</integer>\n    <key>ExitTimeOut</key><integer>35</integer>\n    <key>ProcessType</key><string>Background</string>\n  </dict>\n</plist>\n`;
}
function defaultLaunchctl(args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 1024 * 1024 });
}
function missingJob(error) {
  const message = String(error.stderr ?? error.message ?? '');
  return /Could not find service|service not found|No such process/i.test(message);
}
// Resolve the same persisted execution override as the runtime without init(), recovery,
// schema writes or model work. Status/stop need only the project identity, never this reader.
function serviceConfig(projectRoot) {
  const config = readProjectConfig(projectRoot), path = join(projectStateDirectory(projectRoot), 'state.sqlite');
  if (existsSync(path)) {
    assertDatabaseAvailable(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get()) {
        const row = db.prepare('SELECT data FROM kv WHERE key=?').get('executor:settings');
        const execution = row && JSON.parse(row.data)?.execution;
        if (execution) config.execution = execution;
      }
    } finally { db.close(); }
  }
  if (config.execution?.executable?.includes('/')) config.execution.executable = resolve(projectRoot, config.execution.executable);
  return config;
}
function readServiceEnvironmentFile(path) {
  // Never include contents or parser/OS error details in diagnostics.
  let fd;
  try {
    checkedPath(path);
    safeFile(path, true, MAX_MANIFEST);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > MAX_MANIFEST) throw new Error();
    const bytes = Buffer.alloc(MAX_MANIFEST + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length))) length += count;
    if (length > MAX_MANIFEST || bytes.subarray(0, length).includes(0)) throw new Error();
    return parseEnv(bytes.subarray(0, length).toString('utf8'));
  } catch { throw new Error('Service environment file must be readable, owned by the current user, private (0600 or stricter), regular, unlinked and at most 64 KiB'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function serviceEnvironment(manifest) {
  const environment = { ...manifest.environment };
  const credentials = manifest.environmentFile ? readServiceEnvironmentFile(manifest.environmentFile) : process.env;
  for (const name of manifest.requiredEnvironment ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(?:HOME|PATH|NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*)$/i.test(name)) throw new Error('Invalid service credential variable');
    if (!credentials[name] || credentials[name].includes('\0')) throw new Error(`Service requires ${name}; configure a private file with service install --env-file (legacy launchd environment is also supported)`);
    environment[name] = credentials[name];
  }
  return environment;
}
// Recovery is deliberately narrower than observation: unknown/native work stays for a person.
function patrolWorkBlock(projectRoot) {
  const path=join(projectStateDirectory(projectRoot),'state.sqlite');let db;
  try {
    if(!safeFile(path,false))return 'project-state-unavailable';
    assertDatabaseAvailable(path);db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON');
    if(db.prepare('PRAGMA user_version').get().user_version!==14)return 'project-version-needs-inspection';
    for(const row of db.prepare('SELECT data FROM domain_tickets').all())if(!JSON.parse(row.data).ended)return 'unfinished-tickets';
    if(db.prepare('SELECT 1 FROM effects WHERE owner IS NOT NULL LIMIT 1').get())return 'host-effect-unsettled';
    if(db.prepare("SELECT 1 FROM receipts WHERE status='pending' LIMIT 1").get())return 'outgoing-reply-unsettled';
    for(const row of db.prepare('SELECT key,data FROM kv').all()) {
      const value=JSON.parse(row.data),key=row.key;
      if(/^(execution(?::|$)|coordinator:owner$|operation:owner$|github:sync-lock$)/.test(key))return 'host-operation-unsettled';
      if(key.startsWith('managed-job:')&&!['completed','cancelled'].includes(value.status))return 'managed-job-needs-inspection';
      if(key.startsWith('native-handoff:')&&!['completed','closed','transferred'].includes(value.status))return 'native-work-needs-inspection';
      if(key.startsWith('live-input:')&&!value.supersededBySessionReplacement&&!['read','not-sent','rejected'].includes(value.status))return 'native-input-needs-inspection';
      if(key.startsWith('ticket:')&&(value.heldFeedback?.length||value.recovery?.status&&value.recovery.status!=='completed'||value.failure?.requiresInspection))return 'ticket-recovery-needs-inspection';
    }
    return null;
  } catch {return 'project-state-needs-inspection';} finally {db?.close();}
}
/** A project-scoped macOS LaunchAgent. Installation is separate from starting it. */
export function createServiceManager(options = {}, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Background service management currently supports macOS launchd only');
  const projectRoot = checkedPath(realpathSync(options.projectRoot ?? process.cwd()));
  const config = readProjectConfig(projectRoot);
  const homeDirectory = checkedPath(realpathSync(options.homeDirectory ?? homedir()));
  const uid = dependencies.uid ?? process.getuid();
  const launchctl = dependencies.launchctl ?? defaultLaunchctl;
  const label = `com.js-superagent.project.${sha(`${projectRoot}\0${config.projectId}`).slice(0, 20)}`;
  const target = `gui/${uid}/${label}`;
  const directory = join(projectStateDirectory(projectRoot), 'service');
  const manifestPath = join(directory, 'manifest.json');
  const plistPath = join(homeDirectory, 'Library/LaunchAgents', `${label}.plist`);
  const logs = { stdout: join(directory, 'stdout.log'), stderr: join(directory, 'stderr.log') };
  const runtimePath = join(directory, 'runtime.json');
  const intentPath = join(directory, 'control-intent.json');
  const ownerPath = join(directory, '.owner.json');
  const coordinate = fn => {
    const coordinator = dependencies.coordinator ?? createMachineCoordinator({ projectRoot, projectId: config.projectId }, { ...((dependencies.coordinationDirectory ?? dependencies.directory) ? { directory: dependencies.coordinationDirectory ?? dependencies.directory } : {}) });
    try { return fn(coordinator); } finally { if (!dependencies.coordinator) coordinator.close?.(); }
  };
  const checkPort = dependencies.probePort ?? probePort;
  const ownerContent = JSON.stringify({ schemaVersion: 1, projectId: config.projectId, projectRoot, label }) + '\n';
  function retainedOwner() {
    if (!safeFile(ownerPath, false, MAX_MANIFEST)) return false;
    if (readSafe(ownerPath) !== ownerContent) throw new Error('Service directory ownership does not match this project');
    return true;
  }
  function loaded() {
    try {
      const output = String(launchctl(['print', target]));
      const pid = output.match(/^\s*pid = (\d+)\s*$/m);
      const exit = output.match(/^\s*last exit code = (-?\d+)\s*$/m);
      return { loaded: true, running: /^\s*state = running\s*$/m.test(output), pid: pid ? Number(pid[1]) : null, lastExitCode: exit ? Number(exit[1]) : null };
    } catch (error) {
      if (missingJob(error)) return { loaded: false, running: false, pid: null, lastExitCode: null };
      throw new Error(`Cannot inspect service ${label}: ${String(error.stderr ?? error.message).trim()}`, { cause: error });
    }
  }
  function owned(required = true) {
    safeDirectory(directory);
    if (!safeFile(manifestPath, false, MAX_MANIFEST)) {
      if (required) throw new Error('Service is not installed; run service install first');
      return null;
    }
    if (!retainedOwner()) throw new Error('Service directory ownership marker is missing');
    const manifest = JSON.parse(readSafe(manifestPath));
    if (![1, 2].includes(manifest.schemaVersion) || manifest.projectRoot !== projectRoot || manifest.projectId !== config.projectId || manifest.label !== label || manifest.homeDirectory !== homeDirectory || manifest.plistPath !== plistPath || !['poll', 'webhook'].includes(manifest.mode)) throw new Error('Service manifest is not owned by this project and package');
    if (sha(readSafe(plistPath)) !== manifest.plistHash || makePlist(manifest) !== readSafe(plistPath)) throw new Error('Service plist changed outside this manager; refusing to replace or control it');
    return manifest;
  }
  function readRecord(path) {
    if(!safeFile(path,false,MAX_MANIFEST))return null;
    try{return JSON.parse(readSafe(path));}catch(error){if(error instanceof SyntaxError)return {};throw error;}
  }
  function readIntent() {
    const value=readRecord(intentPath);
    if(!value)return null;
    if(value.schemaVersion!==1||value.projectId!==config.projectId||value.label!==label||!['running','stopped'].includes(value.desired)||typeof value.token!=='string')throw new Error('Invalid service control intent');
    return value;
  }
  function saveIntent(desired) {
    const value={schemaVersion:1,projectId:config.projectId,label,desired,token:randomUUID(),at:new Date().toISOString()};
    writeAtomic(intentPath,value);return value;
  }
  function assertIntent(expected) {
    if(readIntent()?.token!==expected.token)throw Object.assign(new Error('Service control intent changed; the older operation will not start it'),{code:'SERVICE_INTENT_CHANGED'});
  }
  function plan(persisted) {
    const mode = options.mode ?? persisted?.mode ?? 'poll';
    if (!['poll', 'webhook'].includes(mode)) throw new Error('Service mode must be poll or webhook');
    const logMaxBytes = options.logMaxBytes ?? persisted?.logMaxBytes ?? DEFAULT_LOG_BYTES;
    if (!Number.isSafeInteger(logMaxBytes) || logMaxBytes < 1024 || logMaxBytes > 100 * 1024 * 1024) throw new Error('logMaxBytes must be between 1024 and 104857600');
    const current = serviceConfig(projectRoot);
    coordinate(coordinator=>{
      const overlaps=(coordinator.overlapStatus?.().overlaps??[]).filter(overlap=>overlap.active);
      if(overlaps.length)throw Object.assign(new Error('An overlapping project directory has active or unverified execution; stop its owned work before installing or starting this service'),{code:'PROJECT_ROOT_OVERLAP',details:{overlaps}});
    });
    if(current.github)coordinate(coordinator=>{
      const conflicts=(coordinator.repositoryBinding?.({repository:current.github.repository})??[]).filter(binding=>binding.projectRoot!==projectRoot);
      if(conflicts.length)throw Object.assign(new Error('GitHub repository is already assigned to another project; inspect its binding before installing or starting this service'),{code:'GITHUB_REPOSITORY_OWNED',details:{conflicts}});
    });
    const harnessRegistry = createHarnessRegistry();
    const validatedExecution = harnessRegistry.validateExecution(current.execution);
    const launch = harnessRegistry.serviceLaunch(validatedExecution, process.env);
    if (mode === 'webhook' && !current.github?.webhook) throw new Error('Webhook mode requires GitHub webhook configuration and a fixed port or explicit auto port');
    if (options.port !== undefined && mode !== 'webhook') throw new Error('A service port requires webhook mode');
    const wantedPort = options.port === 'auto' && Number.isSafeInteger(persisted?.webhookEndpoint?.port) ? persisted.webhookEndpoint.port : options.port ?? persisted?.webhookEndpoint?.port ?? current.github?.webhook?.port;
    if (mode === 'webhook' && wantedPort !== 'auto' && (!Number.isSafeInteger(wantedPort) || wantedPort < 1 || wantedPort > 65535)) throw new Error('Webhook mode requires a fixed port or explicit auto port');
    const webhookEndpoint = mode === 'webhook' ? { host: current.github.webhook.host ?? '127.0.0.1', port: wantedPort } : undefined;
    if (current.github?.app) {
      if (!current.github.app.privateKeyPath) throw new Error('Background service requires github.app.privateKeyPath; environment secrets are not persisted');
      if (!readSafe(current.github.app.privateKeyPath).trim()) throw new Error('GitHub App key file is empty');
    }
    if (mode === 'webhook') {
      if (!current.github.webhook.secretPath) throw new Error('Background service requires github.webhook.secretPath; environment secrets are not persisted');
      if (!readSafe(current.github.webhook.secretPath).trim()) throw new Error('GitHub webhook secret file is empty');
    }
    assertFeishuServiceConfig(current);
    const searchPath = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin';
    const nodeExecutable = executable(options.nodeExecutable ?? process.execPath, searchPath);
    const executionDriver = validatedExecution.driver;
    const executorExecutable = executable(launch.executable, searchPath);
    const ghExecutable = current.github && !current.github.app ? executable(current.github.executable ?? 'gh', searchPath) : null;
    const cliPath = checkedPath(realpathSync(options.cliPath ?? DEFAULT_CLI));
    safeFile(cliPath);
    safeFile(MODULE_PATH);
    const environment = { HOME: homeDirectory, PATH: [...new Set([dirname(nodeExecutable), dirname(executorExecutable), ...(ghExecutable ? [dirname(ghExecutable)] : []), ...searchPath.split(delimiter).filter(part => isAbsolute(part) && !/[\x00-\x1f\x7f]/.test(part)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter) };
    for (const [key, value] of Object.entries(launch.environment)) environment[key] = checkedPath(realpathSync(value));
    // LaunchAgents do not inherit the terminal's network settings. Persist only credential-free proxy references.
    Object.assign(environment, proxyEnvironment(process.env));
    if (process.env.JS_SUPERAGENT_HOME) environment.JS_SUPERAGENT_HOME = stateHome();
    const requiredEnvironment = launch.credentialEnvNames;
    const environmentFile = options.environmentFile ?? persisted?.environmentFile;
    if (environmentFile !== undefined) checkedPath(environmentFile);
    const result = { schemaVersion: 2, restartPolicy: 'on-failure', ...(webhookEndpoint ? { webhookEndpoint } : {}), projectId: config.projectId, projectRoot, homeDirectory, label, mode, nodeExecutable, cliPath, modulePath: MODULE_PATH, executionDriver, executorExecutable, requiredEnvironment, ghExecutable, environment, logMaxBytes, plistPath,
      ...(environmentFile === undefined ? {} : { environmentFile }) };
    if (environmentFile !== undefined) serviceEnvironment(result);
    return { ...result, plistHash: sha(makePlist(result)) };
  }
  function status() {
    const manifest = owned(false);
    const state = loaded();
    let childPid = null;
    if (manifest && state.pid && safeFile(runtimePath, false, MAX_MANIFEST)) {
      try {
        const runtime = JSON.parse(readSafe(runtimePath));
        if (runtime.pid === state.pid && Number.isSafeInteger(runtime.childPid) && runtime.childPid > 0) childPid = runtime.childPid;
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    const startup = manifest ? startupState(directory) : null;
    const ready = Boolean(state.running && startup?.state === 'ready' && startup.pid === state.pid && startup.childPid === childPid);
    return { installed: Boolean(manifest), ready, startupState: startup?.state === 'blocked' ? 'blocked' : ready ? 'ready' : state.running ? 'starting' : startup?.state === 'retrying' ? 'retrying' : 'stopped', blocked: startup?.state === 'blocked' ? { code: startup.errorCode, message: startup.message } : null, retryCount: startup?.retryCount ?? 0, webhookEndpoint: manifest?.webhookEndpoint ?? null, label, projectRoot, mode: manifest?.mode ?? options.mode ?? 'poll', plistPath, manifestPath, logs, logMaxBytes: manifest?.logMaxBytes ?? options.logMaxBytes ?? DEFAULT_LOG_BYTES,
      environmentFile: manifest?.environmentFile ?? null, ...state, childPid };
  }
  function health() {
    const state = status();
    // Stopped services need no old heartbeat or process probe, and are never auto-enabled here.
    return evaluateServiceHealth({ status: state, ...(state.running ? { runtime: readRecord(runtimePath), heartbeat: readRecord(join(directory, 'heartbeat.json')) } : {}),
      now: dependencies.now?.() ?? Date.now(), ...(dependencies.ownerState ? { ownerState: dependencies.ownerState } : {}) });
  }
  function patrol({recover=false}={}) {
    const manifest=owned(false),path=manifest?join(directory,'patrol.sqlite'):null;
    if(path)for(const file of [path,`${path}-journal`,`${path}-wal`,`${path}-shm`])safeFile(file,false,1024*1024);
    const now=dependencies.now??Date.now,ownerState=dependencies.ownerState??inspectProcessOwner;
    const observe=()=>{
      const report=health(),runtime=readRecord(runtimePath),intent=readIntent();
      const verified=report.process.wrapperState==='alive'&&['alive','dead'].includes(report.process.childState);
      const identity=verified&&runtime?.runId?sha(JSON.stringify([runtime.runId,runtime.owner,runtime.childOwner,intent?.token??null])):null;
      const blocked=!intent?'explicit-start-required':intent.desired!=='running'?'operator-stopped':!identity?'process-identity-unverified'
        :report.state!=='stalled'||!['runtime-heartbeat-expired','owned-process-exited'].includes(report.reason)?'recovery-not-applicable'
          :!report.business?.available||!report.business.machineReady||report.business.active?'last-work-state-unavailable'
            :report.business.activeIncidents||report.business.modelWaits||report.business.sources?.some(source=>['stale','degraded'].includes(source.state))?'business-needs-attention':patrolWorkBlock(projectRoot);
      return {health:report,identity,allowed:blocked===null,blocked,runtime,intent};
    };
    return patrolService({recover},{path,observe,now,recover:expected=>{
      const current=observe();
      if(current.identity!==expected.identity||!current.allowed)return {action:'inspection-required',reason:current.blocked??'service-run-changed'};
      assertIntent(expected.intent);
      // Ask the verified wrapper to stop gracefully. Never bootout a live/unknown process or send SIGKILL.
      if(ownerState(current.runtime.owner)!=='alive'||!['alive','dead'].includes(ownerState(current.runtime.childOwner)))return {action:'inspection-required',reason:'process-identity-changed'};
      const signal=dependencies.signalProcess??((pid,signal)=>process.kill(pid,signal));
      signal(current.runtime.pid,'SIGTERM');
      const deadline=Date.now()+(dependencies.patrolGraceMs??5000);
      while(ownerState(current.runtime.owner)!=='dead'||ownerState(current.runtime.childOwner)!=='dead') {
        assertIntent(expected.intent);
        if(Date.now()>=deadline)return {action:'inspection-required',reason:'graceful-stop-unconfirmed'};
        (dependencies.sleep??(ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)))(50);
      }
      assertIntent(expected.intent);
      const block=patrolWorkBlock(projectRoot);if(block)return {action:'inspection-required',reason:block};
      stopControlled();assertIntent(expected.intent);
      startControlled(expected.intent);
      return {action:'restarted',reason:'confirmed-idle-service-restarted',health:health()};
    }});
  }
  function install() {
    const existing = owned(false);
    let next = plan(existing);
    if (existing) {
      if (existing.schemaVersion !== 2) throw new Error('Legacy service installation requires explicit uninstall/reinstall; status and stop remain available');
      if (existing.restartPolicy !== 'on-failure' && (existing.modulePath !== next.modulePath || existing.cliPath !== next.cliPath)) throw new Error('Legacy restart policy belongs to a different installed package; stop, uninstall and reinstall from the intended new package before upgrading it');
      if (options.mode !== undefined && options.mode !== existing.mode || options.logMaxBytes !== undefined && options.logMaxBytes !== existing.logMaxBytes || options.nodeExecutable !== undefined && next.nodeExecutable !== existing.nodeExecutable || options.cliPath !== undefined && next.cliPath !== existing.cliPath) throw new Error('Service is already installed with different options; uninstall it before changing installation settings');
      const endpointChanged = JSON.stringify(next.webhookEndpoint) !== JSON.stringify(existing.webhookEndpoint);
      if (options.environmentFile !== undefined && options.environmentFile !== existing.environmentFile || existing.restartPolicy !== 'on-failure' || endpointChanged) {
        if (loaded().loaded) throw new Error('Stop the service before changing its installation settings');
        // Retain installed executables, proxy values and service identity.
        const updated = { ...existing, restartPolicy: 'on-failure', ...(options.environmentFile === undefined ? {} : { environmentFile: options.environmentFile }), ...(next.webhookEndpoint ? { webhookEndpoint: next.webhookEndpoint } : {}) };
        serviceEnvironment(updated);
        if (updated.webhookEndpoint) updated.webhookEndpoint = reserveEndpoint(updated.webhookEndpoint);
        updated.plistHash = sha(makePlist(updated));
        launchctl(['disable', target]);
        const oldPlist = readSafe(plistPath), temporary = `${plistPath}.${randomUUID()}.tmp`;
        try {
          owned();
          if (makePlist(updated) !== oldPlist) { writeExclusive(temporary, makePlist(updated)); renameSync(temporary, plistPath); }
          writeAtomic(manifestPath, updated);
        } catch (error) {
          // Best-effort restoration keeps the prior manager's ownership checks usable.
          if (readSafe(plistPath) !== oldPlist) { writeExclusive(temporary, oldPlist); renameSync(temporary, plistPath); }
          if (updated.webhookEndpoint && JSON.stringify(updated.webhookEndpoint) !== JSON.stringify(existing.webhookEndpoint)) coordinate(c => c.releasePort({ ...updated.webhookEndpoint, maintenanceToken: dependencies.maintenanceToken }));
          throw error;
        } finally { if (stat(temporary)) unlinkSync(temporary); }
        if (existing.webhookEndpoint && JSON.stringify(updated.webhookEndpoint) !== JSON.stringify(existing.webhookEndpoint)) coordinate(c => c.releasePort({ ...existing.webhookEndpoint, maintenanceToken: dependencies.maintenanceToken }));
      }
      return status();
    }
    safeDirectory(dirname(plistPath));
    if (stat(plistPath)) throw new Error('Refusing to overwrite an unowned LaunchAgent');
    if (loaded().loaded) throw new Error('Refusing to replace an unowned loaded service');
    const retained = retainedOwner();
    for (const file of [join(directory, '.gitignore'), runtimePath, intentPath, join(directory,'patrol.sqlite'), join(directory, 'startup.json'), join(directory, 'heartbeat.json'), ...Object.values(logs).flatMap(path => [path, `${path}.1`])]) {
      if (stat(file) && !retained) throw new Error(`Refusing to reuse an unowned service file: ${file}`);
      safeFile(file, false);
      if (Object.values(logs).some(path => file === path || file === `${path}.1`) && (stat(file)?.size ?? 0) > next.logMaxBytes) throw new Error('Retained logs exceed the requested size limit; archive them before lowering logMaxBytes');
    }
    if (retained && readSafe(join(directory, '.gitignore')) !== '*\n') throw new Error('Service ignore file was changed outside this manager');
    safeDirectory(dirname(plistPath), true);
    safeDirectory(directory, true);
    if (!retained) {
      writeExclusive(ownerPath, ownerContent);
      writeExclusive(join(directory, '.gitignore'), '*\n');
    }
    // A newly installed job remains disabled until the explicit start command, including at the next login.
    launchctl(['disable', target]);
    if (next.webhookEndpoint) next = { ...next, webhookEndpoint: reserveEndpoint(next.webhookEndpoint) };
    next.plistHash = sha(makePlist(next));
    try {
      writeExclusive(plistPath, makePlist(next));
      try { writeExclusive(manifestPath, JSON.stringify(next, null, 2) + '\n'); }
      catch (error) { unlinkSync(plistPath); throw error; }
    } catch (error) { if (next.webhookEndpoint) coordinate(c => c.releasePort({ ...next.webhookEndpoint, maintenanceToken: dependencies.maintenanceToken })); throw error; }
    saveIntent('stopped');return status();
  }
  function reserveEndpoint(endpoint) {
    return coordinate(c => {
      c.register();
      const maintenance = dependencies.maintenanceToken ? { token: dependencies.maintenanceToken } : c.acquireMaintenance();
      try {
        for (let attempt = 0; attempt < (endpoint.port === 'auto' ? 16 : 1); attempt++) {
          const port = checkPort({ host: endpoint.host, port: endpoint.port === 'auto' ? 0 : endpoint.port });
          const candidate = { host: endpoint.host, port };
          const availability = c.portStatus(candidate);
          if (!availability.available) {
            if (endpoint.port === 'auto') continue;
            throw Object.assign(new Error(`Webhook endpoint ${candidate.host}:${port} is reserved by another project; inspect projects list`), { code: 'PORT_CONFLICT' });
          }
          try { c.reservePort({ ...candidate, maintenanceToken: maintenance.token }); return candidate; }
          catch (error) { if (endpoint.port !== 'auto' || !['PORT_CONFLICT', 'WEBHOOK_PORT_OWNED'].includes(error.code)) throw error; }
        }
        throw Object.assign(new Error('No unreserved Webhook port could be selected; choose an explicit available port'), { code: 'PORT_CONFLICT' });
      } finally { if (!dependencies.maintenanceToken) c.releaseLease(maintenance); }
    });
  }
  function startControlled(intent) {
    const manifest = owned();
    if (manifest.schemaVersion !== 2) throw new Error('Legacy service installation requires explicit uninstall/reinstall before start');
    if (manifest.restartPolicy !== 'on-failure') throw new Error('Legacy service restart policy requires service install while stopped before start');
    try {
      // Revalidate references on each start, while retaining the installed mode and executables.
      safeFile(manifest.modulePath);
      const current = createServiceManager({ ...options, environmentFile: manifest.environmentFile, mode: manifest.mode, port: manifest.webhookEndpoint?.port, nodeExecutable: manifest.nodeExecutable, cliPath: manifest.cliPath, logMaxBytes: manifest.logMaxBytes }, dependencies).validate();
      if (current.executionDriver !== manifest.executionDriver || current.executorExecutable !== manifest.executorExecutable || JSON.stringify(current.requiredEnvironment) !== JSON.stringify(manifest.requiredEnvironment) || current.ghExecutable !== manifest.ghExecutable) throw new Error('Configured executable changed; uninstall and reinstall the service before starting it');
      if (current.webhookEndpoint?.host !== manifest.webhookEndpoint?.host) throw new Error('Configured Webhook host changed; run service install while stopped before starting it');
      serviceEnvironment(manifest);
      if (loaded().running) return status();
      if (manifest.webhookEndpoint) reserveEndpoint(manifest.webhookEndpoint);
    } catch (error) { blockStartup(directory, error.code ?? 'SERVICE_CONFIGURATION'); throw error; }
    assertIntent(intent);
    saveStartup(directory, { state: 'starting', ready: false, pid: null, childPid: null, retryCount: 0, errorCode: null, message: null, nextRetryAt: null });
    launchctl(['enable', target]);
    try {
      assertIntent(intent);
      if (!loaded().loaded) {assertIntent(intent);launchctl(['bootstrap', `gui/${uid}`, plistPath]);}
      else if (!loaded().running) {assertIntent(intent);launchctl(['kickstart', target]);}
      assertIntent(intent);
    } catch(error) {if(readIntent()?.desired==='stopped')stopControlled();throw error;}
    return status();
  }
  function start() {owned();return startControlled(saveIntent('running'));}
  function stopControlled() {
    owned();
    launchctl(['disable', target]);
    if (loaded().loaded) {
      try { launchctl(['bootout', target]); } catch (error) { if (!missingJob(error)) throw error; }
      const deadline = Date.now() + (dependencies.stopTimeoutMs ?? 15_000);
      while (loaded().loaded) {
        if (Date.now() >= deadline) throw new Error('Service stop is still pending; retry status before starting or uninstalling it');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    if (startupState(directory)?.state !== 'blocked') saveStartup(directory, { state: 'stopped', ready: false });
    return status();
  }
  function stop() {owned();saveIntent('stopped');return stopControlled();}
  function restart() {owned();const intent=saveIntent('stopped');stopControlled();assertIntent(intent);return startControlled(saveIntent('running'));}
  function uninstall() {
    if (!owned(false)) {
      if (stat(plistPath) || loaded().loaded) throw new Error('Refusing to remove an unowned service');
      return status();
    }
    stop();
    // Only the generated plist and manifest are removed; bounded logs remain for diagnosis.
    const manifest = owned();
    unlinkSync(plistPath);
    unlinkSync(manifestPath);
    if (manifest.webhookEndpoint) coordinate(c => c.releasePort({ ...manifest.webhookEndpoint, maintenanceToken: dependencies.maintenanceToken }));
    return status();
  }
  return { install, start, stop, restart, status, health, patrol, uninstall, validate: plan };
}

/** Relocation-only helper. The caller holds the project maintenance lock and archives local service files. */
export function retireRelocatedService({ projectRoot, fromRoot }, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Background service relocation currently supports macOS launchd only');
  const root = checkedPath(realpathSync(projectRoot)), originalRoot = checkedPath(resolve(fromRoot));
  if (root === originalRoot) throw new Error('Relocation must identify a different original directory');
  const config = readProjectConfig(root), directory = join(projectStateDirectory(root), 'service'), manifestPath = join(directory, 'manifest.json');
  if (!safeFile(manifestPath, false, MAX_MANIFEST)) return { installed: false, retired: false };
  const manifest = JSON.parse(readSafe(manifestPath)), label = `com.js-superagent.project.${sha(`${originalRoot}\0${config.projectId}`).slice(0, 20)}`;
  const owner = JSON.stringify({ schemaVersion: 1, projectId: config.projectId, projectRoot: originalRoot, label }) + '\n';
  if (readSafe(join(directory, '.owner.json')) !== owner || ![1, 2].includes(manifest.schemaVersion) || manifest.projectRoot !== originalRoot || manifest.projectId !== config.projectId || manifest.label !== label || !['poll', 'webhook'].includes(manifest.mode)) throw new Error('Relocation service identity does not match the original project');
  checkedPath(manifest.homeDirectory);
  const plistPath = join(manifest.homeDirectory, 'Library/LaunchAgents', `${label}.plist`);
  if (manifest.plistPath !== plistPath) throw new Error('Relocation service plist does not belong to the original project');
  const uid = dependencies.uid ?? process.getuid(), launchctl = dependencies.launchctl ?? defaultLaunchctl, target = `gui/${uid}/${label}`;
  const loaded = () => {
    try { launchctl(['print', target]); return true; }
    catch (error) { if (missingJob(error)) return false; throw new Error('Cannot inspect the original project service', { cause: error }); }
  };
  if (!safeFile(plistPath, false, MAX_MANIFEST)) {
    if (loaded()) throw new Error('Original service is loaded without its verifiable plist; refuse automatic relocation');
    return { installed: true, retired: true, alreadyRetired: true, manifest };
  }
  if (safeFile(plistPath).uid !== process.getuid() || sha(readSafe(plistPath)) !== manifest.plistHash || makePlist(manifest) !== readSafe(plistPath)) throw new Error('Original service plist ownership or content changed; refuse automatic relocation');
  launchctl(['disable', target]);
  if (loaded()) {
    try { launchctl(['bootout', target]); } catch (error) { if (!missingJob(error)) throw error; }
    const deadline = Date.now() + (dependencies.stopTimeoutMs ?? 15_000);
    while (loaded()) {
      if (Date.now() >= deadline) throw new Error('Original service stop is still pending; relocation must wait');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  // Check again after launchctl; never unlink a replacement written by somebody else.
  if (sha(readSafe(plistPath)) !== manifest.plistHash || makePlist(manifest) !== readSafe(plistPath)) throw new Error('Original service plist changed during retirement');
  unlinkSync(plistPath);
  return { installed: true, retired: true, alreadyRetired: false, manifest };
}

function boundedLog(path, maxBytes) {
  safeFile(path, false, maxBytes);
  safeFile(`${path}.1`, false, maxBytes);
  return bytes => {
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const size = safeFile(path, false, maxBytes)?.size ?? 0;
    if (size + chunk.length > maxBytes && size) {
      safeFile(`${path}.1`, false, maxBytes);
      renameSync(path, `${path}.1`);
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, chunk.length > maxBytes ? chunk.subarray(-maxBytes) : chunk); }
    finally { closeSync(fd); }
  };
}
async function runService(projectRoot) {
  const root = realpathSync(projectRoot);
  const directory = join(projectStateDirectory(root), 'service');
  const manifest = JSON.parse(readSafe(join(directory, 'manifest.json')));
  const previous = startupState(directory);
  if (previous?.state === 'blocked') { process.exitCode = 0; return; }
  const manager = createServiceManager({ projectRoot: root, homeDirectory: manifest.homeDirectory, environmentFile: manifest.environmentFile, mode: manifest.mode, port: manifest.webhookEndpoint?.port, nodeExecutable: manifest.nodeExecutable, cliPath: manifest.cliPath, logMaxBytes: manifest.logMaxBytes });
  // validate() checks credentials and executables without writing or calling launchctl.
  if (manifest.schemaVersion !== 2 || manifest.restartPolicy !== 'on-failure') throw new Error('Legacy service installation requires service install while stopped');
  const current = manager.validate();
  if (current.executionDriver !== manifest.executionDriver || current.executorExecutable !== manifest.executorExecutable || JSON.stringify(current.requiredEnvironment) !== JSON.stringify(manifest.requiredEnvironment) || current.ghExecutable !== manifest.ghExecutable) throw new Error('Configured executable changed; uninstall and reinstall the service');
  if (current.webhookEndpoint?.host !== manifest.webhookEndpoint?.host) throw new Error('Configured Webhook host changed; run service install while stopped');
  if (current.label !== manifest.label || current.plistPath !== manifest.plistPath || current.modulePath !== manifest.modulePath || sha(readSafe(manifest.plistPath)) !== manifest.plistHash || makePlist(manifest) !== readSafe(manifest.plistPath)) throw new Error('Service installation ownership check failed');
  const environment = serviceEnvironment(manifest);
  if (manifest.webhookEndpoint) probePort(manifest.webhookEndpoint);
  const retryCount = previous?.retryCount ?? 0;
  if (retryCount >= MAX_START_RETRIES) { blockStartup(directory, 'SERVICE_RETRY_LIMIT', retryCount); process.exitCode = 0; return; }
  if (previous?.nextRetryAt) {
    const delay = Date.parse(previous.nextRetryAt) - Date.now();
    if (delay > 0) await new Promise(resolveWait => setTimeout(resolveWait, Math.min(delay, 300_000)));
  }
  const stdout = boundedLog(join(directory, 'stdout.log'), manifest.logMaxBytes);
  const stderr = boundedLog(join(directory, 'stderr.log'), manifest.logMaxBytes);
  const args = [manifest.cliPath, '--project', root, ...(manifest.mode === 'webhook' ? ['--webhook-port', String(manifest.webhookEndpoint.port), 'github', 'listen'] : ['serve'])];
  const runId = randomUUID();
  const child = spawn(manifest.nodeExecutable, args, { cwd: root, env: { ...environment, JS_SUPERAGENT_SERVICE_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: false });
  const runtimePath = join(directory, 'runtime.json'), startedAt = Date.now();
  safeFile(runtimePath, false, MAX_MANIFEST);
  const owner = captureProcessIdentity(process.pid), childOwner = child.pid ? captureProcessIdentity(child.pid) : null;
  writeAtomic(runtimePath, { healthProtocol: 1, runId, pid: process.pid, childPid: child.pid, owner: owner ?? null, childOwner: childOwner ?? null, startedAt: new Date(startedAt).toISOString() });
  // The previous run's heartbeat must not look like an absent first heartbeat for this run.
  const heartbeatPath = join(directory, 'heartbeat.json'); if (safeFile(heartbeatPath, false, MAX_MANIFEST)) unlinkSync(heartbeatPath);
  saveStartup(directory, { state: 'starting', ready: false, pid: process.pid, childPid: child.pid ?? null, retryCount, errorCode: null, message: null, nextRetryAt: null });
  let intentionalStop = false, startupError, heartbeatSequence = 0;
  const terminate = () => { intentionalStop = true; child.kill('SIGTERM'); };
  const interrupt = () => { intentionalStop = true; child.kill('SIGINT'); };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.on('message', message => {
    const heartbeat = acceptServiceHeartbeat(message, { runId, sequence: heartbeatSequence, pid: process.pid, childPid: child.pid });
    if (heartbeat) { heartbeatSequence = heartbeat.sequence; writeAtomic(heartbeatPath, heartbeat); }
    if (message?.type === 'js-superagent:ready') saveStartup(directory, { state: 'ready', ready: true, errorCode: null, message: null });
    if (message?.type === 'js-superagent:startup-error') {
      // The CLI sends this only from its exception path. Do not persist arbitrary error text.
      startupError = typeof message.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(message.code) ? message.code : 'SERVICE_STARTUP';
    }
  });
  child.stdout.on('data', stdout);
  child.stderr.on('data', stderr);
  const outcome = await new Promise(resolveExit => {
    child.once('error', () => resolveExit({ code: 1, error: 'SERVICE_SPAWN' }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  process.off('SIGTERM', terminate);
  process.off('SIGINT', interrupt);
  if (intentionalStop || outcome.code === 0 && !startupError) {
    saveStartup(directory, { state: 'stopped', ready: false, nextRetryAt: null }); process.exitCode = 0; return;
  }
  const transient = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'GITHUB_RATE_LIMITED', 'GITHUB_TRANSIENT', 'MACHINE_REGISTRY_INITIALIZING']);
  const attempts = (Date.now() - startedAt >= 300_000 ? 0 : retryCount) + 1;
  if (startupError && !transient.has(startupError) || attempts >= MAX_START_RETRIES || outcome.error) {
    blockStartup(directory, startupError ?? outcome.error ?? 'SERVICE_RETRY_LIMIT', attempts); process.exitCode = 0; return;
  }
  saveStartup(directory, { state: 'retrying', ready: false, retryCount: attempts, errorCode: startupError ?? 'SERVICE_CHILD_EXIT', message: 'Service exited unexpectedly; bounded retry is scheduled.', nextRetryAt: new Date(Date.now() + Math.min(300_000, 5000 * 2 ** (attempts - 1))).toISOString() });
  process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH && process.argv[2] === 'run') {
  runService(process.argv[3]).catch(error => {
    const message = `js-superagent service: ${error.message}\n`;
    try {
      const directory = join(projectStateDirectory(realpathSync(process.argv[3])), 'service');
      const manifest = JSON.parse(readSafe(join(directory, 'manifest.json')));
      const limit = manifest.logMaxBytes;
      if (Number.isSafeInteger(limit) && limit >= 1024 && limit <= 100 * 1024 * 1024) boundedLog(join(directory, 'stderr.log'), limit)(message);
      blockStartup(directory, typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code) ? error.code : 'SERVICE_CONFIGURATION');
    } catch { /* Never follow redirected log paths when reporting an installation error. */ }
    process.stderr.write(message);
    // SuccessfulExit=false means a persistent configuration failure is not restarted.
    process.exitCode = 0;
  });
}

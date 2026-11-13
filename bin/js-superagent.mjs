#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProjectAgent, createHarnessRegistry } from '../src/index.mjs';
import { initializeProjectConfig, readProjectConfig, validateProjectOptions, mergeProjectConfig } from '../src/config.mjs';
import { createMachineCoordinator } from '../src/machine-coordination.mjs';
import { inspectProjectIdentity } from '../src/project-identity.mjs';
import { MACHINE_DEPENDENCIES } from '../src/runtime/machine-guard.mjs';
import { checkProjectSetup } from '../src/setup.mjs';
import { feishuSdkAvailable } from '../src/channels/feishu.mjs';
import { startServiceHeartbeat } from '../src/service-health.mjs';
import { assertStateMigrated, projectStateDirectory } from '../src/state-paths.mjs';

// Test preload modules may inject isolated stores. No CLI/environment escape hatch.
const machineDependencies = globalThis[MACHINE_DEPENDENCIES];

const help = `js-superagent --project <directory> <command>

  --version, -v          Print the installed package version without initializing a project
  --help, -h             Show this help

  init                   Initialize project-local configuration and SQLite state
  upgrade                Back up and upgrade stopped project state to schema 15
  doctor                 Inspect installation (no model call)
  setup check            Unified read-only project setup report; --check-connections probes metadata/account reads
  diagnostics events [file]  Read event routing and delivery facts; optional JSON filters
  diagnostics event <id>     Read one event diagnosis
  diagnostics replies [file] Read outgoing reply status and failure reasons
  control list           Read background control receipts
  control show <id>      Read one background control receipt
  control request <file> Queue an explicit idempotent control request from JSON
  service health         Inspect heartbeat freshness and business health without starting work
  service patrol         Check once; print only a new actionable change or recovery result
    --recover            Opt in to bounded, verified idle-service recovery; never start a manually stopped service
  projects list          List this user's registered local projects without starting them
  machine status         Inspect local execution capacity and active/waiting slots
  machine limits set --max-active-executions <n>  Set an explicit per-user execution ceiling
  machine limits clear   Remove the optional execution ceiling
  project inspect        Inspect local identity and maintenance state without writing
  project reinitialize --as-new --plan|--apply  Archive local state and create a new instance
  project relocate --from <old-path> --plan|--apply  Relocate the original instance while stopped
    --rollback           Inspect/apply rollback of an interrupted relocation
  project migrate-state --plan|--apply  Move old <project>/.js-superagent state to the per-user state directory
  harness list           List installed adapter capabilities without opening project state
  harness doctor <file>  Validate executor JSON; --check-executable also probes CLI metadata
  submit <text>          Queue a local authorized task
  request <text>         Ask the configured coordinator to classify a request
  management             List subscriptions and unavailable decisions with revisions
  unsubscribe <thread> <revision>  Remove all subscriptions to a discussion
  dismiss <decision> <revision>    Dismiss an unavailable decision
  job message|reply|resume <ticket> <job> <file>  Send {text,requestId} to the same child
  coordinate <text>      Queue a project coordination message; /stop <id> <reason> explicitly allows cancellation
  coordination retry <id>  Requeue a failed coordination event without executing it
  coordination status    Inspect coordination messages and action receipts without executing them
  details <id>           Read stage, policy application, native wait and delivery facts
  trace <id> [file]      Read a paginated task timeline (optional JSON cursor/limit)
  session inspect <id>   Inspect native session, pinned settings and history
  session replace <id> <file>  Replace session using reviewed JSON identity/reason
  prompts status        Inspect prompt revisions, assembly and default differences
  prompts set <file> <revision>  Save team sections and prompt overrides
  materials status      Inspect source grants and versioned capabilities
  materials set <file> <revision>  Configure authorized project materials while stopped
  materials snapshot <file>  Capture {sourceId,view?,actor?} as an immutable host snapshot
  materials prepare <ticket> <file>  Request {materialId,provisionId,reason}
  materials prepare-status|prepare-retry <ticket>  Inspect or retry workspace preparation
  materials apply-preview|apply|apply-recover <ticket> <file>  Preview/apply/recover an explicit local write
  materials apply-status <ticket> <operation>  Read the durable local application receipt
  recovery status       Inspect bounded automatic recovery settings
  recovery set <file> <revision>  Save trusted recovery settings
  incidents list        Inspect persisted business incidents
  incidents ack <id> <revision>  Acknowledge the current incident revision
  reevaluate <trigger>  Return a saved trigger to coordination
  request-status <id>   Ask the Worker for current task status
  coordinator status     Inspect coordinator settings and revision history
  coordinator set <file> <revision>  Save trusted JSON settings with revision check
  status                 List tickets
  show <id>              Read a ticket, inputs and reports
  reply <id> <text>      Queue follow-up input (does not change scope)
  answer <id> <file>     Answer the open structured question with {answers, attentionId?}
  retry <id>             Retry failed/interrupted/cancelled work after inspection
  cancel <id>            Request cooperative cancellation
  pause                  Pause new work and replies; continue receiving events
  resume                 Resume processing after a business pause
  health                 Inspect runtime activity, native model waits and source incidents
  panel                  Open a local management server (prints private setup URL)
  repository status      Inspect optional repository-wide GitHub intake
  repository set <file> <revision>  Configure repository event streams
  jobs status            Inspect trusted managed-job settings
  jobs set <file> <revision>  Configure trusted commands and child agents
  job list <ticket>      Inspect tasks and preview leases owned by a ticket
  job preview|renew <ticket> <job> [ttl-ms]  Open or renew a trusted local preview
  job close|cancel <ticket> <job>  Close a preview or cancel an owned task
  adoption plan <ticket> <job>  Inspect child changes against the parent snapshot
  adoption apply <ticket> <job> <digest>  Apply exactly the reviewed adoption plan
  adoption list <ticket>  Inspect saved child adoption and recovery journals
  adoption recover <ticket> <adoption> rollback|finish  Reconcile interrupted adoption
  scheduler status       Inspect Worker capacity and active slots
  scheduler set <file> <revision>  Configure isolated concurrency
  executor status        Inspect optional v2 executor settings
  executor set <file> <revision>  Select a registered Harness using trusted JSON settings
  delivery status        Inspect trusted verification/delivery settings
  delivery set <file> <revision>  Save trusted JSON settings while stopped
  review status [ticket]  Inspect PR review actions without executing them
  review request <ticket> <file>  Queue a scoped ready/reviewer/thread action from JSON
  review run <request>   Reconcile and execute one previously queued review action
  native-preview renew|close <ticket> <lease> <job> [ttl-ms]  Control an owned DSH preview
  verify <id>            Run the configured host verification profile
  deliver <id>           Deliver an authorized result using configured policy
  run                    Execute at most one queued turn with the configured Harness
  serve                  Keep processing turns until SIGINT/SIGTERM
  config                 Read persisted project configuration
  config set             Update configuration while project execution is idle
  workspace <id>         Inspect the ticket workspace and changed file paths
  github sync            Pull configured Issues/comments and deliver queued replies (no model call)
  github status          Inspect GitHub tracking, object failures and pending replies
  github link <id> <pr>   Link a PR and its current head to a local ticket
  github unlink <pr>     Stop following a linked PR
  github bot-review status  Inspect bot review rounds and remaining budgets
  github bot-review set <pr> <actor> <file>  Set explicit remaining budget with revision/reason
  github bot-review associate <pr> <actor> <file>  Associate original events with a review run
  github listen          Receive signed webhooks and keep processing work in the foreground
  github webhook-status  Inspect local webhook queue and delivery records
  github binding status  Inspect this repository's local project ownership
  github binding release --plan|--apply [--repository owner/repo]  Release settled local ownership
  service install        Install a macOS login background service (does not start it)
  service start          Start the installed background service
  service stop           Stop it and disable automatic start until service start
  service restart        Restart the installed background service
  service status         Inspect background process, mode and log paths
  service uninstall      Stop and remove the owned service; keep project work

Background service options (service install only):
  --mode <poll|webhook>   poll (default): local tasks + GitHub polling; webhook: also receive HTTP
  --log-max-bytes <n>     Rotate each service log at this limit (default: 5242880)
  --env-file <path>       Private credential file for service install; never copied into the plist
  --port <auto|1..65535>  Select a stable Webhook service port without changing shared config

Execution options (init/config set persist; run/serve/github listen override one invocation):
  --driver codex-app-server         Codex app-server override; use executor set for full Harness settings
  --codex-path <path>     Codex executable (default: codex on PATH)
  --model <name>          Override the configured Codex model
  --timeout-ms <ms>       Positive integer timeout for each turn
  --kill-grace-ms <ms>    Termination grace period (1..30000)
Workspace options (init/config set):
  --workspace <mode>     in-place (compatible default), auto, worktree, or copy
  --base-ref <ref>       Base Git revision for newly created worktrees
  --exclude <path>       Exclude a relative copy path (repeatable; no globs)
GitHub options (init/config set):
  --github-repo <owner/repo>  GitHub.com repository to listen to
  --github-actor <login>     Allowed human sender (repeatable; required)
  --github-issue <number>    Restrict intake to selected Issues (repeatable)
  --github-command <text>   Explicit new-task command (default: /js-superagent)
  --github-agent-login <login>  Dedicated user account; receive @mentions via notifications
  --github-account-disable  Remove dedicated account mode (config set only)
  --gh-path <path>           GitHub CLI executable using its existing login
  --github-poll-ms <ms>      Poll interval for serve (minimum: 1000)
  --github-check-app <slug>  Trust CI checks from this GitHub App (repeatable)
  --github-status-context <name>  Trust this commit status context (repeatable)
  --github-status-actor <login>   Trust this status creator (repeatable; paired with context)
  --github-ci-disable       Clear CI subscriptions (config set only)
  --github-disable          Remove GitHub configuration (config set only)
GitHub App options (init/config set; replace the complete App configuration):
  --github-app-id <id>       Numeric GitHub App ID
  --github-installation-id <id>  Installation authorized for this repository
  --github-private-key-env <name>  Read the PEM key from this environment variable
  --github-private-key-path <path>  Or read the PEM key from this file
  --github-app-pr-comments <true|false>  Allow App PR comment delivery explicitly
  --github-app-pr-reviews <true|false>  Allow App ready/reviewer/thread actions explicitly
  --github-app-disable      Remove App authentication and return to native gh (config set only)
Webhook options (init/config set; replace the complete Webhook configuration):
  --webhook-secret-env <name>  Read the signing secret from this environment variable
  --webhook-secret-path <path>  Or read the signing secret from this file
  --webhook-host <host>      Bind host (default: 127.0.0.1)
  --webhook-port <port>      Bind port (default: 8787; 0 selects an available port); github listen may override this invocation only
  --webhook-path <path>      POST path (default: /github/webhook)
  --webhook-max-bytes <n>    Raw request limit (default: 1048576; maximum: 26214400)
  --webhook-disable          Remove Webhook configuration (config set only)
CI options replace the complete CI policy; omitted CI options keep it unchanged.
Use init --workspace auto to isolate Git tasks in worktrees and ordinary directories in copies.
Use doctor --driver codex-app-server to check the executable and existing login without a model call.
Use harness doctor settings.json for static checks, or add --check-executable for metadata checks.
Codex uses its existing local login. SIGINT/SIGTERM waits for active work to stop.
Node.js >=22.13 required. No Git, GitHub, or DSH required.
`;
let runtime;
let removeSignals = () => {};
let shutdown;
let webhookServer;
let managementServer;
let stopServiceHeartbeat = () => {};
let webhookPortOverride;
function notifyService(message) {
  if (process.connected && typeof process.send === 'function') {
    try { process.send(message, () => {}); } catch { /* The wrapper may already be stopping. */ }
  }
}

function probeCodex(executable) {
  const supported = process.platform !== 'win32';
  const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true };
  const version = spawnSync(executable, ['--version'], options);
  const available = version.status === 0 && !version.error;
  if (!available) return { supported, available: false, loggedIn: false };
  const login = spawnSync(executable, ['login', 'status'], options);
  // Authentication output can contain account details. Return only status, never its text.
  return { supported, available: true, loggedIn: login.status === 0 && !login.error };
}

async function execute(command) {
  let signalReceived;
  let notifyStopped;
  const stopped = new Promise(resolve => { notifyStopped = resolve; });
  const onSignal = signal => {
    if (signalReceived) return;
    signalReceived = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    stopServiceHeartbeat();
    // Fence runtime ingress immediately; an open management request must not delay source cancellation.
    shutdown = (async () => {
      const results = await Promise.allSettled([runtime.stop(), webhookServer?.close(), managementServer?.close()]);
      const failed = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failed.length) throw new AggregateError(failed, 'Service shutdown did not complete');
    })();
    // Always attach rejection handling immediately, including during a one-turn run.
    shutdown.then(notifyStopped, error => {
      console.error(`js-superagent: ${error.message}`);
      process.exitCode = 1;
      notifyStopped();
    });
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  removeSignals = () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
  if (command === 'run') {
    const result = await runtime.runNext();
    if (!signalReceived && result?.status === 'failed') process.exitCode = 1;
    return result;
  }
  if (command === 'sync') return runtime.syncGitHub();
  if (command === 'listen' && !runtime.getConfigV2().github?.webhook) throw new Error('Configure github.webhook before starting the listener');
  if (command === 'listen' || command === 'serve') {
    await runtime.prepareExecution();
    if (signalReceived) { await stopped; return { running: false, signal: signalReceived }; }
  }
  if (command === 'listen') {
    const webhook = runtime.getConfigV2().github?.webhook;
    if (!webhook) throw new Error('Configure github.webhook before starting the listener');
    const { listenGitHubWebhook } = await import('../src/channels/github-webhook.mjs');
    webhookServer = await listenGitHubWebhook(runtime, { host: webhook.host, port: webhookPortOverride ?? webhook.port, path: webhook.path, maxBodyBytes: webhook.maxBodyBytes });
    if (signalReceived) { await webhookServer.close(); await stopped; return { running: false, signal: signalReceived }; }
  }
  if (command === 'panel') {
    const { createManagementServer } = await import('../src/management.mjs');
    managementServer = await createManagementServer(runtime);
    console.log(JSON.stringify({ managementUrl: managementServer.bootstrapUrl }));
    await stopped; return { running: false, signal: signalReceived };
  }
  runtime.start();
  stopServiceHeartbeat = startServiceHeartbeat(runtime);
  notifyService({ type: 'js-superagent:ready' });
  console.log(JSON.stringify({ projectRoot: runtime.projectRoot, projectId: runtime.projectId, running: true, driver: runtime.getConfigV2().execution?.driver ?? 'codex-app-server', ...(webhookServer ? { webhookUrl: webhookServer.url } : {}) }));
  try { await stopped; } finally { stopServiceHeartbeat(); }
  return { running: false, signal: signalReceived, lastError: runtime.status().lastError };
}

try {
  const { values, positionals } = parseArgs({
    options: {
      project: { type: 'string', short: 'p' }, help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'check-executable': { type: 'boolean' },
      driver: { type: 'string' }, 'codex-path': { type: 'string' },
      model: { type: 'string' }, 'timeout-ms': { type: 'string' },
      'kill-grace-ms': { type: 'string' }, workspace: { type: 'string' },
      'base-ref': { type: 'string' }, exclude: { type: 'string', multiple: true },
      'github-repo': { type: 'string' }, 'github-actor': { type: 'string', multiple: true },
      'github-issue': { type: 'string', multiple: true }, 'github-command': { type: 'string' },
      'github-agent-login': { type: 'string' }, 'github-account-disable': { type: 'boolean' },
      'gh-path': { type: 'string' }, 'github-poll-ms': { type: 'string' }, 'github-disable': { type: 'boolean' },
      'github-check-app': { type: 'string', multiple: true }, 'github-status-context': { type: 'string', multiple: true },
      'github-status-actor': { type: 'string', multiple: true }, 'github-ci-disable': { type: 'boolean' },
      'github-app-id': { type: 'string' }, 'github-installation-id': { type: 'string' },
      'github-private-key-env': { type: 'string' }, 'github-private-key-path': { type: 'string' }, 'github-app-disable': { type: 'boolean' },
      'github-app-pr-comments': { type: 'string' }, 'github-app-pr-reviews': { type: 'string' },
      'webhook-secret-env': { type: 'string' }, 'webhook-secret-path': { type: 'string' },
      'webhook-host': { type: 'string' }, 'webhook-port': { type: 'string' }, 'webhook-path': { type: 'string' },
      'webhook-max-bytes': { type: 'string' }, 'webhook-disable': { type: 'boolean' },
      mode: { type: 'string' }, 'log-max-bytes': { type: 'string' }, 'env-file': { type: 'string' }, port: { type: 'string' },
      'max-active-executions': { type: 'string' }, 'as-new': { type: 'boolean' }, from: { type: 'string' },
      plan: { type: 'boolean' }, apply: { type: 'boolean' }, rollback: { type: 'boolean' }, recover: { type: 'boolean' }, repository: { type: 'string' }, 'check-connections': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.version) {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(version);
  } else if (values.help || positionals.length === 0) {
    console.log(help);
  } else {
    const [command, ...args] = positionals;
    const arity = { management:0, unsubscribe:2, dismiss:2, init: 0, upgrade: 0, doctor: 0, submit: 1, status: 0, show: 1, reply: 2, answer: 2, retry: 1, cancel: 1, run: 0, serve: 0, workspace: 1, request: 1, coordinate: 1, details: 1, pause: 0, resume: 0, health: 0, panel: 0, verify: 1, deliver: 1, reevaluate: 1, 'request-status': 1 };
    const configSet = command === 'config' && args.length === 1 && args[0] === 'set';
    const configShow = command === 'config' && args.length === 0;
    const githubAction = command === 'github' && ((args.length === 1 && ['sync', 'status', 'listen', 'webhook-status'].includes(args[0])) ||
      (args[0] === 'link' && args.length === 3) || (args[0] === 'unlink' && args.length === 2) ||
      (args[0] === 'binding' && args.length === 2 && ['status', 'release'].includes(args[1])) ||
      (args[0] === 'bot-review' && (args[1] === 'status' && args.length === 2 || ['set','associate'].includes(args[1]) && args.length === 5)));
    const reviewAction = command === 'review' && (args[0] === 'status' && [1,2].includes(args.length) || args[0] === 'request' && args.length === 3 || args[0] === 'run' && args.length === 2);
    const nativePreviewAction = command === 'native-preview' && (args[0] === 'close' && args.length === 4 || args[0] === 'renew' && [4,5].includes(args.length));
    const deliveryAction = ['delivery','scheduler','executor','jobs','repository','prompts','recovery'].includes(command) && ((args.length === 1 && args[0] === 'status') || (args.length === 3 && args[0] === 'set'));
    const materialAction = command === 'materials' && (args[0] === 'status' && args.length === 1 || args[0] === 'set' && args.length === 3 || args[0] === 'snapshot' && args.length === 2 || ['prepare-status','prepare-retry'].includes(args[0]) && args.length === 2 || ['prepare','apply-preview','apply','apply-recover','apply-status'].includes(args[0]) && args.length === 3);
    const traceAction = command === 'trace' && [1, 2].includes(args.length);
    const sessionAction = command === 'session' && (args[0] === 'inspect' && args.length === 2 || args[0] === 'replace' && args.length === 3);
    const incidentAction = command === 'incidents' && (args[0] === 'list' && args.length === 1 || args[0] === 'ack' && args.length === 3);
    const jobAction = command === 'job' && (args[0] === 'list' && args.length === 2 || ['close','cancel'].includes(args[0]) && args.length === 3 || ['preview','renew'].includes(args[0]) && [3,4].includes(args.length) || ['message','reply','resume'].includes(args[0]) && args.length===4);
    const adoptionAction = command === 'adoption' && (args[0] === 'list' && args.length === 2 || args[0] === 'plan' && args.length === 3 || ['apply','recover'].includes(args[0]) && args.length === 4);
    const coordinatorAction = command === 'coordinator' && ((args.length === 1 && args[0] === 'status') || (args.length === 3 && args[0] === 'set'));
    const coordinationAction = command === 'coordination' && (args.length === 1 && args[0] === 'status' || args.length === 2 && args[0] === 'retry');
    const setupAction = command === 'setup' && args.length === 1 && args[0] === 'check';
    const diagnosticAction = command === 'diagnostics' && (['events','replies'].includes(args[0]) && [1,2].includes(args.length) || args[0] === 'event' && args.length === 2);
    const controlAction = command === 'control' && (args[0] === 'list' && args.length === 1 || ['show','request'].includes(args[0]) && args.length === 2);
    const serviceAction = command === 'service' && args.length === 1 && ['install', 'start', 'stop', 'restart', 'status', 'health', 'patrol', 'uninstall'].includes(args[0]);
    const harnessAction = command === 'harness' && (args[0] === 'list' && args.length === 1 || args[0] === 'doctor' && args.length === 2);
    const machineAction = command === 'machine' && (args.length === 1 && args[0] === 'status' || args.length === 2 && args[0] === 'limits' && ['set', 'clear'].includes(args[1]));
    const projectsAction = command === 'projects' && args.length === 1 && args[0] === 'list';
    const projectAction = command === 'project' && args.length === 1 && ['inspect', 'reinitialize', 'relocate', 'migrate-state'].includes(args[0]);
    const maintenanceAction = projectAction && args[0] !== 'inspect';
    const bindingRelease = githubAction && args[0] === 'binding' && args[1] === 'release';
    if (!materialAction && !diagnosticAction && !setupAction && !controlAction && !machineAction && !projectsAction && !projectAction && !reviewAction && !nativePreviewAction && !configSet && !configShow && !githubAction && !serviceAction && !coordinatorAction && !coordinationAction && !deliveryAction && !traceAction && !sessionAction && !incidentAction && !jobAction && !adoptionAction && !harnessAction && (!(command in arity) || args.length !== arity[command])) throw new Error('Invalid command or arguments. Use --help; quote task text.');
    if (values.plan !== undefined || values.apply !== undefined) {
      if (!(maintenanceAction || bindingRelease) || Boolean(values.plan) === Boolean(values.apply)) throw new Error('Use exactly one of --plan or --apply with project maintenance or github binding release.');
    } else if (maintenanceAction || bindingRelease) throw new Error('Choose --plan to inspect or --apply to perform this operation.');
    if (values['as-new'] !== undefined && !(projectAction && args[0] === 'reinitialize') || projectAction && args[0] === 'reinitialize' && !values['as-new']) throw new Error('project reinitialize requires explicit --as-new.');
    if (values.from !== undefined && !(projectAction && args[0] === 'relocate') || projectAction && args[0] === 'relocate' && !values.from) throw new Error('project relocate requires --from <old-path>.');
    if (values.rollback !== undefined && !(projectAction && args[0] === 'relocate')) throw new Error('--rollback requires project relocate.');
    if (values.repository !== undefined && !bindingRelease) throw new Error('--repository requires github binding release.');
    if (values.recover !== undefined && !(serviceAction && args[0] === 'patrol')) throw new Error('--recover requires service patrol.');
    if (values['max-active-executions'] !== undefined && !(machineAction && args[0] === 'limits' && args[1] === 'set') || machineAction && args[0] === 'limits' && args[1] === 'set' && values['max-active-executions'] === undefined) throw new Error('machine limits set requires --max-active-executions <n>.');
    if (values['check-connections'] !== undefined && !setupAction) throw new Error('--check-connections requires setup check.');
    if (values['check-executable'] !== undefined && !(harnessAction && args[0] === 'doctor')) throw new Error('--check-executable requires harness doctor <file>.');
    const integerArgument = (value, name, minimum = 0) => {
      if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`${name} must be an integer at least ${minimum}`);
      return Number(value);
    };
    if ((deliveryAction || coordinatorAction) && args[0] === 'set' || incidentAction && args[0] === 'ack') integerArgument(args[2], 'Revision');
    if (nativePreviewAction && args.length === 5) integerArgument(args[4], 'Preview lifetime', 1);
    if (githubAction && args[0] === 'bot-review' && args[1] !== 'status') { integerArgument(args[2], 'PR number', 1); integerArgument(args[3], 'Bot actor ID', 1); }
    if (jobAction && ['preview','renew'].includes(args[0]) && args.length === 4) integerArgument(args[3], 'Preview lifetime', 1);
    if (adoptionAction && args[0] === 'apply' && !/^[a-f\d]{64}$/.test(args[3])) throw new Error('Adoption requires the SHA-256 digest of the reviewed plan');
    if (adoptionAction && args[0] === 'recover' && !['rollback','finish'].includes(args[3])) throw new Error('Adoption recovery mode must be rollback or finish');
    if ((values.mode !== undefined || values['log-max-bytes'] !== undefined || values['env-file'] !== undefined || values.port !== undefined) && !(serviceAction && args[0] === 'install')) throw new Error('--mode, --log-max-bytes, --env-file and --port require service install.');
    if (values.mode !== undefined && !['poll', 'webhook'].includes(values.mode)) throw new Error('--mode must be poll or webhook.');
    const execution = command === 'run' || command === 'serve' || (command === 'github' && args[0] === 'listen');
    const configuring = command === 'init' || configSet;
    const executionKeys = ['driver', 'codex-path', 'model', 'timeout-ms', 'kill-grace-ms'];
    if (!execution && !configuring && command !== 'doctor' && executionKeys.some(key => values[key] !== undefined)) {
      throw new Error('Execution options require init, config set, run/serve, github listen, or doctor --driver codex-app-server.');
    }
    if (!configuring && ['workspace', 'base-ref', 'exclude'].some(key => values[key] !== undefined)) throw new Error('Workspace options require init or config set.');
    const ciKeys = ['github-check-app', 'github-status-context', 'github-status-actor'];
    const appKeys = ['github-app-id', 'github-installation-id', 'github-private-key-env', 'github-private-key-path', 'github-app-pr-comments', 'github-app-pr-reviews'];
    const webhookKeys = ['webhook-secret-env', 'webhook-secret-path', 'webhook-host', 'webhook-port', 'webhook-path', 'webhook-max-bytes'];
    const githubKeys = ['github-agent-login', 'github-account-disable', 'github-repo', 'github-actor', 'github-issue', 'github-command', 'gh-path', 'github-poll-ms', ...ciKeys, 'github-ci-disable', ...appKeys, 'github-app-disable', ...webhookKeys, 'webhook-disable'];
    if (!configuring && githubKeys.some(key => values[key] !== undefined && !(command === 'github' && args[0] === 'listen' && key === 'webhook-port'))) throw new Error('GitHub options require init or config set; github listen accepts an invocation-only --webhook-port.');
    if (values['github-disable'] !== undefined && !configSet) throw new Error('--github-disable requires config set.');
    if (values['github-disable'] && githubKeys.some(key => values[key] !== undefined)) throw new Error('--github-disable cannot be combined with GitHub settings.');
    if (values['github-ci-disable'] !== undefined && !configSet) throw new Error('--github-ci-disable requires config set.');
    if (values['github-ci-disable'] && ciKeys.some(key => values[key] !== undefined)) throw new Error('--github-ci-disable cannot be combined with CI settings.');
    for (const [flag, keys] of [['github-account-disable', ['github-agent-login']], ['github-app-disable', appKeys], ['webhook-disable', webhookKeys]]) {
      if (values[flag] !== undefined && !configSet) throw new Error(`--${flag} requires config set.`);
      if (values[flag] && keys.some(key => values[key] !== undefined)) throw new Error(`--${flag} cannot be combined with its settings.`);
    }
    if (command === 'doctor' && ['model', 'timeout-ms', 'kill-grace-ms'].some(key => values[key] !== undefined)) throw new Error('Model and timeout options require init, config set, run/serve, or github listen.');
    if (command === 'doctor' && values['codex-path'] !== undefined && values.driver !== 'codex-app-server') throw new Error('Use --driver codex-app-server with --codex-path for doctor.');
    const numeric = key => {
      if (values[key] === undefined) return undefined;
      if (!/^\d+$/.test(values[key])) throw new Error(`--${key} must be a positive integer`);
      return Number(values[key]);
    };
    if (command === 'github' && args[0] === 'listen' && values['webhook-port'] !== undefined) {
      webhookPortOverride = integerArgument(values['webhook-port'], 'Webhook port');
      if (webhookPortOverride > 65535) throw new Error('Webhook port must be between 0 and 65535');
    }
    const executionPatch = {
      ...(values.driver === undefined ? {} : { driver: values.driver }),
      ...(values['codex-path'] === undefined ? {} : { executable: values['codex-path'].includes('/') ? resolve(values['codex-path']) : values['codex-path'] }),
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: numeric('timeout-ms') }),
      ...(values['kill-grace-ms'] === undefined ? {} : { killGraceMs: numeric('kill-grace-ms') }),
    };
    const workspacePatch = {
      ...(values.workspace === undefined ? {} : { mode: values.workspace }),
      ...(values['base-ref'] === undefined ? {} : { baseRef: values['base-ref'] }),
      ...(values.exclude === undefined ? {} : { exclude: values.exclude }),
    };
    const ciPatch = {
      ...(values['github-check-app'] === undefined ? {} : { checkApps: values['github-check-app'] }),
      ...(values['github-status-context'] === undefined ? {} : { statusContexts: values['github-status-context'] }),
      ...(values['github-status-actor'] === undefined ? {} : { statusActors: values['github-status-actor'] }),
    };
    const appPatch = {
      ...(values['github-app-pr-reviews'] === undefined ? {} : { pullRequestReviews: (() => {
        if (!['true','false'].includes(values['github-app-pr-reviews'])) throw new Error('--github-app-pr-reviews must be true or false');
        return values['github-app-pr-reviews'] === 'true';
      })() }),
      ...(values['github-app-id'] === undefined ? {} : { appId: values['github-app-id'] }),
      ...(values['github-installation-id'] === undefined ? {} : { installationId: numeric('github-installation-id') }),
      ...(values['github-private-key-env'] === undefined ? {} : { privateKeyEnv: values['github-private-key-env'] }),
      ...(values['github-private-key-path'] === undefined ? {} : { privateKeyPath: values['github-private-key-path'] }),
      ...(values['github-app-pr-comments'] === undefined ? {} : { pullRequestComments: (() => {
        if (!['true','false'].includes(values['github-app-pr-comments'])) throw new Error('--github-app-pr-comments must be true or false');
        return values['github-app-pr-comments'] === 'true';
      })() }),
    };
    const webhookPatch = {
      ...(values['webhook-secret-env'] === undefined ? {} : { secretEnv: values['webhook-secret-env'] }),
      ...(values['webhook-secret-path'] === undefined ? {} : { secretPath: values['webhook-secret-path'] }),
      ...(values['webhook-host'] === undefined ? {} : { host: values['webhook-host'] }),
      ...(values['webhook-port'] === undefined || webhookPortOverride !== undefined ? {} : { port: numeric('webhook-port') }),
      ...(values['webhook-path'] === undefined ? {} : { path: values['webhook-path'] }),
      ...(values['webhook-max-bytes'] === undefined ? {} : { maxBodyBytes: numeric('webhook-max-bytes') }),
    };
    const githubPatch = {
      ...(values['github-account-disable'] ? { account: null } : values['github-agent-login'] === undefined ? {} : { account: { login: values['github-agent-login'] } }),
      ...(values['github-repo'] === undefined ? {} : { repository: values['github-repo'] }),
      ...(values['github-actor'] === undefined ? {} : { allowedActors: values['github-actor'] }),
      ...(values['github-issue'] === undefined ? {} : { issues: values['github-issue'].map(value => {
        if (!/^\d+$/.test(value)) throw new Error('--github-issue must be a positive integer');
        return Number(value);
      }) }),
      ...(values['github-command'] === undefined ? {} : { command: values['github-command'] }),
      ...(values['gh-path'] === undefined ? {} : { executable: values['gh-path'].includes('/') ? resolve(values['gh-path']) : values['gh-path'] }),
      ...(values['github-poll-ms'] === undefined ? {} : { pollIntervalMs: numeric('github-poll-ms') }),
      ...(values['github-ci-disable'] ? { ci: null } : Object.keys(ciPatch).length ? { ci: ciPatch } : {}),
      ...(values['github-app-disable'] ? { app: null } : Object.keys(appPatch).length ? { app: appPatch } : {}),
      ...(values['webhook-disable'] ? { webhook: null } : Object.keys(webhookPatch).length ? { webhook: webhookPatch } : {}),
    };
    let pullRequestNumber;
    if (githubAction && ['link', 'unlink'].includes(args[0])) {
      const input = args.at(-1);
      pullRequestNumber = Number(input);
      if (!/^\d+$/.test(input) || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1 || pullRequestNumber > 2_147_483_647) throw new Error('PR number must be an integer between 1 and 2147483647');
    }
    const patch = validateProjectOptions({
      ...(Object.keys(executionPatch).length ? { execution: { driver: 'codex-app-server', ...executionPatch } } : {}),
      ...(Object.keys(workspacePatch).length ? { workspace: workspacePatch } : {}),
      ...(values['github-disable'] ? { github: null } : Object.keys(githubPatch).length ? { github: githubPatch } : {}),
    });
    if (configSet && !Object.keys(patch).length) throw new Error('config set requires at least one configuration option.');
    const projectRoot = resolve(values.project ?? process.cwd());
    const dir = projectStateDirectory(projectRoot);
    if (machineAction || projectsAction) {
      const machine = createMachineCoordinator({}, machineDependencies);
      try {
        const result = projectsAction ? machine.listProjects() : args[0] === 'status' ? machine.status() : machine.setLimits({ maxActiveExecutions: args[1] === 'clear' ? null : integerArgument(values['max-active-executions'], 'Execution ceiling', 1) });
        console.log(JSON.stringify(result, null, 2));
      } finally { machine.close(); }
    } else if (projectAction) {
      const { inspectProject, reinitializeProject, relocateProject, migrateProjectState } = await import('../src/project-maintenance.mjs');
      const result = args[0] === 'migrate-state' ? migrateProjectState({ projectRoot, apply: values.apply === true }) : args[0] === 'inspect' ? inspectProject(projectRoot, machineDependencies) : args[0] === 'reinitialize' ? await reinitializeProject({ projectRoot, apply: values.apply === true }, machineDependencies) : await relocateProject({ projectRoot, fromRoot: resolve(values.from), apply: values.apply === true, mode: values.rollback ? 'rollback' : 'resume' }, machineDependencies);
      console.log(JSON.stringify(result, null, 2));
      if (result.blockers?.length) process.exitCode = 1;
    } else if (harnessAction) {
      const registry = createHarnessRegistry();
      const result = args[0] === 'list' ? registry.list() : await registry.probeExecution(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), { checkExecutable: values['check-executable'] === true });
      console.log(JSON.stringify(result, null, 2));
      if (result.ok === false) process.exitCode = 1;
    } else if (setupAction) {
      const result = await checkProjectSetup({ projectRoot, checkConnections: values['check-connections'] === true }, machineDependencies);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'blocked') process.exitCode = 1;
    } else if (serviceAction) {
      const { createServiceManager } = await import('../src/service.mjs');
      const manager = createServiceManager({ projectRoot,
        ...(values.mode === undefined ? {} : { mode: values.mode }),
        ...(values['log-max-bytes'] === undefined ? {} : { logMaxBytes: numeric('log-max-bytes') }),
        ...(values['env-file'] === undefined ? {} : { environmentFile: resolve(values['env-file']) }),
        ...(values.port === undefined ? {} : { port: values.port === 'auto' ? 'auto' : integerArgument(values.port, 'Service port', 1) }),
      }, machineDependencies ? { ...machineDependencies.serviceDependencies, coordinationDirectory: machineDependencies.directory } : undefined);
      if(args[0]==='patrol') {const result=manager.patrol({recover:values.recover===true});if(result.notify)console.log(JSON.stringify(result,null,2));}
      else console.log(JSON.stringify(manager[args[0]](), null, 2));
    } else if (configShow) {
      console.log(JSON.stringify(readProjectConfig(projectRoot), null, 2));
    } else if (command === 'doctor') {
      const configPath = join(dir, 'config.json');
      const config = existsSync(configPath) ? readProjectConfig(projectRoot) : null;
      const initialized = !!config && existsSync(join(dir, 'state.sqlite'));
      const effective = config ? mergeProjectConfig(config, patch) : undefined;
      const codex = values.driver === 'codex-app-server' ? probeCodex(effective?.execution?.executable ?? patch.execution?.executable ?? 'codex') : undefined;
      const git = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
      const machine = createMachineCoordinator(config ? { projectRoot, projectId: config.projectId } : {}, machineDependencies);
      let machineFacts;
      try {
        machine.assertWritable();
        const bindings = config?.github?.repository ? machine.repositoryBinding({ repository: config.github.repository }) : [];
        machineFacts = { identity: config ? inspectProjectIdentity(projectRoot, config.projectId) : null, machine: machine.status(), repositoryBindings: bindings, conflicts: bindings.filter(binding => binding.projectRoot !== realpathSync(projectRoot)), directoryOverlap: config ? machine.overlapStatus() : null };
      } catch(error) {
        machineFacts = { identity: config ? inspectProjectIdentity(projectRoot, config.projectId) : null, conflicts: [], coordinationError: { code: error.code ?? 'MACHINE_INSPECTION_FAILED', message: error.message } };
      } finally { machine.close(); }
      console.log(JSON.stringify({ projectRoot, node: process.version, initialized, execution: 'Registered Harness', dshRequired: false,
        harnessIsolation: { codex: { sessions: 'project-bound', loginAndGlobalSettings: 'shared-user' }, dsh: { sessionsAndHome: 'project-session' } },
        sharedResources: { coordinationScope: 'same-machine-and-os-user', executables: 'may-be-shared', modelProviderQuota: 'shared-by-provider-account', managedCommandPorts: 'not-reserved-by-runtime', githubAppWebhook: 'requires-repository-routing-or-separate-apps', overlappingRoots: 'exclusive-execution', externalPaths: 'not-a-filesystem-sandbox' },
        config, effectiveConfig: effective ?? null, feishu: config?.feishu ? { configured: true, enabled: config.feishu.enabled !== false, appId: config.feishu.appId, chats: config.feishu.chats.map(chat => chat.chatId), secret: config.feishu.appSecretPath ? 'path' : 'env', sdkAvailable: feishuSdkAvailable() } : { configured: false, sdkAvailable: feishuSdkAvailable() }, ...machineFacts, workspaceSupport: { copy: true, worktree: git.status === 0 && !git.error }, ...(codex ? { codex } : {}) }, null, 2));
      if (!initialized || machineFacts.coordinationError || machineFacts.conflicts.length || machineFacts.directoryOverlap?.overlaps.some(overlap => overlap.active) || machineFacts.identity?.matches === false || (codex && (!codex.supported || !codex.available || !codex.loggedIn))) process.exitCode = 1;
    } else {
      assertStateMigrated(projectRoot);
      if (command !== 'init' && (!existsSync(join(dir, 'config.json')) || !existsSync(join(dir, 'state.sqlite')))) {
        throw new Error('Project is not initialized. Run init first.');
      }
      if (command === 'init') initializeProjectConfig(projectRoot, patch);
      const invocationExecution = execution && patch.execution ? mergeProjectConfig(readProjectConfig(projectRoot), { execution: patch.execution }).execution : undefined;
      runtime = createProjectAgent({ projectRoot, ...(invocationExecution ? { execution: invocationExecution } : {}), ...(machineDependencies ? { [MACHINE_DEPENDENCIES]: machineDependencies } : {}) }).init();
      let result;
      switch (command) {
        case 'diagnostics': result = args[0] === 'event' ? runtime.eventDiagnostic(args[1]) : runtime[args[0] === 'events' ? 'eventDiagnostics' : 'replyDiagnostics'](args[1] ? JSON.parse(readFileSync(resolve(args[1]),'utf8')) : {}); break;
        case 'control': result = args[0] === 'list' ? runtime.listControls() : args[0] === 'show' ? runtime.controlStatus(args[1]) : await runtime.requestControl(JSON.parse(readFileSync(resolve(args[1]), 'utf8'))); break;
        case 'upgrade': result = runtime.upgradeRuntime(); break;
        case 'init': result = { projectRoot: runtime.projectRoot, projectId: runtime.projectId }; break;
        case 'submit': result = runtime.submit({ text: args[0] }); break;
        case 'status': result = runtime.list(); break;
        case 'show': result = runtime.get(args[0]); break;
        case 'trace': result = runtime.ticketTrace(args[0], args[1] ? JSON.parse(readFileSync(resolve(args[1]), 'utf8')) : undefined); break;
        case 'session': result = args[0] === 'inspect' ? runtime.sessionStatus(args[1]) : await runtime.replaceSession(args[1], JSON.parse(readFileSync(resolve(args[2]), 'utf8'))); break;
        case 'prompts': result = args[0] === 'status' ? runtime.promptStatus() : runtime.configurePrompts(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision:Number(args[2]),origin:'cli'}); break;
        case 'materials': {
          const input = index => JSON.parse(readFileSync(resolve(args[index]), 'utf8'));
          if (args[0] === 'status') result = {capabilities:runtime.materialCapabilities(),settings:runtime.getMaterialSettings()};
          else if (args[0] === 'set') result = runtime.configureMaterials(input(1), {expectedRevision:Number(args[2])});
          else if (args[0] === 'snapshot') result = runtime.createMaterialSnapshot(input(1));
          else if (args[0] === 'prepare-status') result = runtime.workspacePreparationStatus(args[1]);
          else if (args[0] === 'prepare-retry') result = runtime.retryWorkspacePreparation(args[1]);
          else if (args[0] === 'apply-status') result = runtime.materialApplicationStatus(args[1], args[2]);
          else result = await runtime[{'prepare':'requestWorkspacePreparation','apply-preview':'previewMaterialApplication','apply':'applyMaterialChanges','apply-recover':'recoverMaterialApplication'}[args[0]]](args[1], input(2));
          break;
        }
        case 'recovery': result = args[0] === 'status' ? runtime.getRecoverySettings() : runtime.configureRecovery(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision:Number(args[2])}); break;
        case 'incidents': result = args[0] === 'list' ? runtime.getIncidents() : runtime.acknowledgeIncident(args[1], {expectedRevision:Number(args[2])}); break;
        case 'reevaluate': result = runtime.reevaluate(args[0]); break;
        case 'request-status': result = runtime.requestStatus(args[0]); break;
        case 'job': result = args[0] === 'list' ? runtime.listJobs(args[1]) : await runtime.jobControl(args[1], args[2], {action:args[0],...(['message','reply','resume'].includes(args[0]) ? JSON.parse(readFileSync(resolve(args[3]),'utf8')) : args[3] === undefined ? {} : {ttlMs:Number(args[3])})}); break;
        case 'adoption': result = args[0] === 'list' ? runtime.listChildAdoptions(args[1]) : args[0] === 'plan' ? runtime.planChildAdoption(args[1],args[2]) : args[0] === 'recover' ? await runtime.recoverChildAdoption(args[1],args[2],{mode:args[3]}) : await runtime.adoptChild(args[1],args[2],{expectedPlanDigest:args[3]}); break;
        case 'jobs': result = args[0] === 'status' ? runtime.getJobsSettings() : runtime.configureJobs(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision: Number(args[2])}); break;
        case 'repository': result = args[0] === 'status' ? runtime.getRepositorySourceSettings() : runtime.configureRepositorySource(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision: Number(args[2])}); break;
        case 'scheduler': result = args[0] === 'status' ? runtime.schedulerStatus() : runtime.configureScheduler(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision: Number(args[2])}); break;
        case 'executor': result = args[0] === 'status' ? runtime.executorStatus() : runtime.configureExecutor(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision: Number(args[2])}); break;
        case 'delivery': result = args[0] === 'status' ? runtime.getDeliverySettings() : runtime.configureDelivery(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision: Number(args[2])}); break;
        case 'review': result = args[0] === 'status' ? runtime.reviewActionStatus(args[1]) : args[0] === 'request' ? runtime.requestPRReview(args[1], JSON.parse(readFileSync(resolve(args[2]), 'utf8'))) : await runtime.runPRReview(args[1]); break;
        case 'native-preview': result = await runtime.controlNativePreview(args[1], {leaseId:args[2],jobId:args[3],action:args[0],...(args[4]===undefined?{}:{ttlMs:Number(args[4])})}); break;
        case 'verify': result = await runtime.verifyTicket(args[0]); break;
        case 'deliver': result = await runtime.deliverTicket(args[0]); break;
        case 'details': result = runtime.getDetailed(args[0]); break;
        case 'request': result = runtime.request({ text: args[0] }); break;
        case 'management': result=runtime.managementStatus(); break;
        case 'unsubscribe': result=runtime.unsubscribeThread(args[0],{expectedRevision:args[1]}); break;
        case 'dismiss': result=runtime.dismissDecision(args[0],{expectedRevision:args[1]}); break;
        case 'coordinate': result = runtime.coordinate({ text: args[0] }); break;
        case 'coordination': result = args[0] === 'retry' ? runtime.retryCoordination(args[1]) : runtime.coordinationStatus(); break;
        case 'coordinator': result = args[0] === 'status' ? runtime.coordinatorStatus() : runtime.configureCoordinator(JSON.parse(readFileSync(resolve(args[1]), 'utf8')), {expectedRevision: Number(args[2])}); break;
        case 'reply': result = runtime.reply(args[0], args[1]); break;
        case 'answer': result = runtime.answer(args[0], JSON.parse(readFileSync(resolve(args[1]), 'utf8'))); break;
        case 'retry': result = runtime.retry(args[0]); break;
        case 'cancel': result = runtime.cancel(args[0]); break;
        case 'pause': result = runtime.pause(); break;
        case 'resume': result = runtime.resume(); break;
        case 'health': result = {...runtime.status(),business:runtime.businessHealth()}; break;
        case 'config': result = runtime.configureV2(patch); break;
        case 'workspace': result = runtime.inspectWorkspace(args[0]); break;
        case 'github':
          if (args[0] === 'binding') result = args[1] === 'status' ? runtime.githubBindingStatus() : runtime.releaseGitHubBinding({ apply: values.apply === true, ...(values.repository ? { repository: values.repository } : {}) });
          else if (args[0] === 'bot-review') result = args[1] === 'status' ? runtime.botReviewStatus() : args[1] === 'set' ? runtime.setBotReviewBudget(Number(args[2]),args[3],JSON.parse(readFileSync(resolve(args[4]),'utf8'))) : runtime.associateBotReviewRun(Number(args[2]),args[3],JSON.parse(readFileSync(resolve(args[4]),'utf8')));
          else if (args[0] === 'sync') result = await execute('sync');
          else if (args[0] === 'listen') result = await execute('listen');
          else if (args[0] === 'webhook-status') result = runtime.githubWebhookStatus();
          else if (args[0] === 'link') result = await runtime.linkGitHubPullRequest(args[1], { number: pullRequestNumber });
          else if (args[0] === 'unlink') result = await runtime.unlinkGitHubPullRequest(pullRequestNumber);
          else result = runtime.githubStatus();
          break;
        case 'run': case 'serve': case 'panel': result = await execute(command); break;
      }
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  notifyService({ type: 'js-superagent:startup-error', code: error.code });
  console.error(`js-superagent: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { await shutdown; }
  catch { /* Reported by the signal handler. */ }
  finally {
    removeSignals();
    stopServiceHeartbeat();
    if (runtime) {
      await webhookServer?.close();
      await managementServer?.close();
      await runtime.stop();
      runtime.close();
    }
  }
}

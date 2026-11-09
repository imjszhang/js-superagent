import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessRegistry, createProjectAgent } from './helpers/runtime-fixture.mjs';
import { recoveryEvidence } from '../src/runtime/recovery.mjs';
import { createTurnAssessor } from '../src/runtime/turn-assessor.mjs';

const forbidden = ['codex-app-server', 'dsh-sdk', 'cursor-agent', '.codex(', '.dsh(', '.cursor(', "startsWith('dsh", 'dshHostCallId'];
const neutralFiles = [
  'src/index.mjs',
  'src/service.mjs',
  'src/setup.mjs',
  'src/management.mjs',
  'src/ui/app.js',
  'src/harness/registry.mjs',
  'src/runtime/execution-observation.mjs',
  'src/runtime/turn-assessor.mjs',
  'src/runtime/assessment.mjs',
  'src/runtime/jobs.mjs',
  'src/runtime/recovery.mjs',
  'src/runtime/host-tool-recovery.mjs',
  'src/runtime/continuation-assessment.mjs',
  'src/runtime/native-handoff.mjs',
  'src/drivers/native-recovery.mjs',
];

function contractAdapter() {
  let opened, finish = () => {}, sent, child;
  const stopChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  };
  return {
    id: 'contract-harness', version: '1', roles: ['worker', 'coordinator'], supervised: true,
    validate(options) {
      if (Object.keys(options).some(key => key !== 'executable')) throw new Error('Unknown contract option');
      return options;
    },
    serviceLaunch(execution, processEnv = {}) {
      return { executable: execution.executable ?? 'contract-bin', environment: processEnv.CONTRACT_HOME ? { CONTRACT_HOME: processEnv.CONTRACT_HOME } : {}, credentialEnvNames: ['CONTRACT_API_KEY'] };
    },
    coordinatorExecution(execution) {
      const { enableAgentTools, enableManagedJobs, requiredCapabilities, ...settings } = execution;
      return settings;
    },
    validateLease(record) {
      if (record?.version !== 1 || record.driver !== 'contract-harness' || record.session?.driver !== 'contract-harness' || !Array.isArray(record.jobIds) || !record.jobIds.length) throw new Error('Invalid contract lease');
      return structuredClone(record);
    },
    createAssessor() { return { async assess() { return { kind: 'ignore', reason: 'Contract harness inspected the candidate', rules: [] }; } }; },
    createDriver() {
      return {
        reportVersion: 2,
        capabilities: { reportVersion: 2, realtimeInput: true, sessionResume: true, nativeBackgroundOwnership: true },
        async sendInput(message) {
          sent = message;
          return { accepted: true, read: false, inputId: message.inputId, sessionId: 'contract-session' };
        },
        async inspectRecovery(input) {
          return { version: 1, kind: 'interrupted', safeToResume: true, toolsSettled: true, session: input.session,
            checkpoint: { runId: input.runId, eventSequence: 2 }, code: 'HISTORY_VERIFIED', outcome: 'adopt-pending',
            adoption: { sourceRunId: input.runId, sessionId: input.session.id, eventSequence: 2,
              pending: [{ inputId: 'input-1', messageId: 'message-1', nativeDigest: 'a'.repeat(64), sourceRunId: input.runId }] } };
        },
        async run(input) {
          input.checkpoint({ driver: 'contract-harness', id: 'contract-session' });
          child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
          input.registerProcess(child.pid);
          let settleClosed = () => {};
          const closed = new Promise(resolve => { settleClosed = resolve; });
          const accepted = await input.nativeHandoff.hold({
            version: 1, id: 'contract-lease', driver: 'contract-harness', nativeVersion: '1',
            ticketId: input.ticket.id, assignmentId: input.assignmentId, originRunId: input.runId,
            session: { driver: 'contract-harness', id: 'contract-session' }, cwd: input.projectRoot,
            configDigest: 'b'.repeat(64), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            guardianPids: [child.pid], jobIds: ['job-1'],
            reportBoundary: { state: 'waiting', assistantSequence: 1, terminalSequence: 2, question: 'Continue?' },
          }, { resume: async () => ({ text: '{"version":2,"state":"ready","summary":"resumed"}' }), close: async () => { await stopChild(); settleClosed(); }, snapshot: () => ({}), closed });
          if (accepted !== true) throw new Error('Host rejected the contract lease');
          opened({ held: true });
          await new Promise(resolve => { finish = resolve; });
          return { version: 2, state: 'waiting', summary: 'Contract harness is waiting.', attention: { question: 'Continue?' } };
        },
      };
    },
    ready: () => new Promise(resolve => { opened = resolve; }),
    received: () => sent,
    release: () => finish(),
    stopChild,
  };
}

test('runtime files do not name the built-in harnesses', () => {
  for (const file of neutralFiles) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const name of forbidden) assert.equal(text.includes(name), false, `${file} mentions ${name}`);
  }
});

test('built-in launch plans and coordinator settings come from the adapter', async () => {
  const registry = createHarnessRegistry();
  assert.equal(registry.describeExecution({ driver: 'codex-app-server' }).supervised, true);
  assert.equal(registry.supervised('codex-app-server'), true);
  const codex = registry.serviceLaunch({ driver: 'codex-app-server' }, { CODEX_HOME: '/tmp/codex-home' });
  assert.equal(codex.executable, 'codex');
  assert.equal(codex.environment.CODEX_HOME, '/tmp/codex-home');
  assert.deepEqual(codex.credentialEnvNames, []);
  const dsh = { driver: 'dsh-sdk', model: 'fixture', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://example.invalid', apiKeyEnv: 'CONTRACT_DSH_KEY' } };
  const launched = registry.serviceLaunch(dsh, { CONTRACT_DSH_KEY: 'secret-value', CODEX_HOME: '/tmp/codex-home' });
  assert.equal(launched.executable, 'dsh');
  assert.deepEqual(launched.environment, {});
  assert.deepEqual(launched.credentialEnvNames, ['CONTRACT_DSH_KEY']);
  assert.equal(JSON.stringify(launched).includes('secret-value'), false);
  assert.equal(registry.loginProbe(dsh, { execFileSync() { throw new Error('DSH has no login probe'); } }), null);
  const coordinator = registry.coordinatorExecution({ ...dsh, permission: 'workspace-write', enableAgentTools: true, enableManagedJobs: true });
  assert.equal(coordinator.permission, 'read-only');
  assert.equal(coordinator.enableAgentTools, undefined);
  assert.equal(coordinator.enableManagedJobs, undefined);
  assert.equal(registry.coordinatorExecution({ driver: 'codex-app-server', enableManagedJobs: true, permission: 'workspace-write' }).permission, undefined);
  const session = { driver: 'contract-harness', id: 'contract-session' };
  const driver = createHarnessRegistry({ adapters: [contractAdapter()] }).createDriver({ driver: 'contract-harness' });
  const evidence = recoveryEvidence(await driver.inspectRecovery({ session, runId: 'run-1' }), { session, runId: 'run-1', kind: 'interrupted' });
  assert.equal(evidence.outcome, 'adopt-pending');
  assert.equal(evidence.session.driver, 'contract-harness');
});

test('a registered harness can execute, accept follow-up input, and hold its own lease', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-contract-'));
  const adapter = contractAdapter();
  const registry = createHarnessRegistry({ adapters: [adapter] });
  const agent = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init();
  t.after(async () => { adapter.release(); await adapter.stopChild(); await agent.stop(); agent.close(); rmSync(root, { recursive: true, force: true }); });
  const plan = registry.serviceLaunch({ driver: 'contract-harness' }, { CONTRACT_HOME: '/tmp/contract-home', CONTRACT_API_KEY: 'secret-value' });
  assert.equal(plan.environment.CONTRACT_HOME, '/tmp/contract-home');
  assert.deepEqual(plan.credentialEnvNames, ['CONTRACT_API_KEY']);
  assert.equal(JSON.stringify(plan).includes('secret-value'), false);
  assert.equal(registry.describeExecution({ driver: 'contract-harness' }).supervised, true);
  assert.equal(registry.coordinatorExecution({ driver: 'contract-harness', enableAgentTools: true }).enableAgentTools, undefined);
  agent.configureExecutor({ driver: 'contract-harness' }, { expectedRevision: 0 });
  const ticket = agent.submit({ text: 'Exercise the contract harness' });
  const running = agent.runNext();
  await adapter.ready();
  assert.equal(agent.getDetailed(ticket.id).nativeHandoffs[0].status, 'holding');
  agent.reply(ticket.id, 'Follow-up for the same contract session');
  const deadline = Date.now() + 2000;
  while (!adapter.received() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(adapter.received().text.includes('Follow-up'), true);
  adapter.release();
  await running;
  const view = agent.get(ticket.id);
  assert.equal(view.reports.at(-1).summary, 'Contract harness is waiting.');
  assert.equal(view.status, 'queued');
  assert.equal(agent.getSession(ticket.id).driver, 'contract-harness');
});

test('a third adapter uses the shared assessor, launch and login hooks', async () => {
  const seen = [];
  const adapter = {
    id: 'third-harness', version: '1', label: 'Third', roles: ['worker', 'coordinator'], supervised: true,
    settingsFields: ['workspaceMode'], preserveOnSave: ['tokenEnv'],
    validate(options) {
      if (Object.keys(options).some(key => key !== 'workspaceMode')) throw new Error('Unknown third option');
      return options;
    },
    serviceLaunch() { return { executable: 'third', environment: {}, credentialEnvNames: ['THIRD_TOKEN'] }; },
    loginProbe() { return { id: 'third-login', status: 'passed', message: 'Third login is present.' }; },
    createDriver() { return { reportVersion: 2, async run() { return { version: 2, state: 'ready', summary: 'third' }; } }; },
    assessor: { create: () => createTurnAssessor({ config: { timeoutMs: 1000 }, assessmentPrompt: () => 'third-assess',
      runTurn: async turn => { seen.push(turn.kind); return turn.kind === 'assessment' ? { kind: 'ignore', reason: 'noted', rules: [] } : { kind: 'reply', summary: 'noted', question: null, base: null }; } }) },
  };
  const registry = createHarnessRegistry({ adapters: [adapter] });
  const listed = registry.list().find(item => item.id === 'third-harness');
  assert.equal(listed.label, 'Third');
  assert.deepEqual(listed.settingsFields, ['workspaceMode']);
  assert.deepEqual(listed.preserveOnSave, ['tokenEnv']);
  assert.equal(listed.roles.includes('coordinator'), true);
  assert.deepEqual(registry.serviceLaunch({ driver: 'third-harness' }).credentialEnvNames, ['THIRD_TOKEN']);
  assert.equal(registry.loginProbe({ driver: 'third-harness' }).status, 'passed');
  const assessor = registry.createAssessor({ driver: 'third-harness' });
  await assessor.inspectContinuation({ projectRoot: '/tmp', runId: 'third-run', facts: { scope: 'scope' }, registerProcess() {}, checkpoint() {} });
  assert.deepEqual(seen, ['continuation']);
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent, createHarnessRegistry } from './helpers/runtime-fixture.mjs';
import { createBuiltinAssessors } from '../src/coordinator.mjs';
import { Store } from '../src/store.mjs';

function fixture({ version = '1', onRun = () => {}, driverName = 'fixture' } = {}) {
  return { id: 'fixture', version, roles: ['worker', 'child'], capabilities: { sessionResume: true },
    validate(options) {
      if (Object.keys(options).some(key => key !== 'label')) throw new Error('Unknown fixture option');
      if (options.label !== undefined && typeof options.label !== 'string') throw new Error('Invalid fixture label');
      return options;
    },
    createDriver(options) { return { reportVersion: 2, capabilities: { reportVersion: 2, sessionResume: true }, async run(input) {
      onRun(input, options);
      input.checkpoint({ driver: driverName, id: input.session?.id ?? 'fixture-session' });
      return { version: 2, state: 'waiting', summary: options.label ?? 'Reply to continue.', attention: { question: 'Continue?' } };
    } }; },
  };
}

test('registry instances isolate extensions, reject builtin overrides and enforce required capabilities', () => {
  const a = createHarnessRegistry(), b = createHarnessRegistry();
  const unregister = a.register(fixture());
  assert.equal(a.list().some(item => item.id === 'fixture'), true);
  assert.equal(b.list().some(item => item.id === 'fixture'), false);
  assert.throws(() => a.register({ ...fixture(), id: 'codex' }), /already registered/);
  assert.throws(() => a.createDriver({ driver: 'fixture', requiredCapabilities: ['agentTools'] }), /required capability/);
  assert.throws(() => a.createDriver({ driver: 'fixture', requiredCapabilities: ['imaginary'] }), /Unknown required/);
  assert.throws(() => a.createDriver({ driver: 'fixture', adapterVersion: '2' }), /version changed/);
  assert.throws(() => a.createDriver({ driver: 'fixture', model: 'not-configured' }), /Unknown fixture/);
  assert.throws(() => a.createAssessor({ driver: 'fixture' }), /does not support role/);
  assert.throws(() => a.createDriver({ driver: 'codex', enableAgentTools: true }), /removed/);
  unregister(); assert.throws(() => a.createDriver({ driver: 'fixture' }), /Unknown executor/);
});

test('static probe starts no work and coordinator keeps a separate role contract', async () => {
  let runs = 0;
  const registry = createHarnessRegistry({ adapters: [fixture({ onRun: () => runs++ })], assessors: createBuiltinAssessors() });
  const result = await registry.probeExecution({ driver: 'fixture' });
  assert.equal(result.ok, true); assert.equal(runs, 0);
  assert.equal(result.capabilities.sessionResume, true);
  assert.equal(registry.list().find(item => item.id === 'codex-app-server').capabilities.agentTools, true);
  assert.equal(registry.describeExecution({ driver: 'codex-app-server' }).capabilities.agentTools, false);
  assert.equal(typeof registry.createAssessor({ driver: 'codex-app-server' }).assess, 'function');
  assert.throws(() => registry.validateExecution({ driver: 'codex-app-server', requiredCapabilities: ['agentTools'] }, { role: 'coordinator' }), /Worker capability/);
  assert.throws(() => registry.validateExecution({ driver: 'codex-app-server' }, { role: 'untrusted' }), /Unknown Harness role/);
});

test('registered Harness executes a local ticket, pins version and workspace, and resumes after reopening', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-harness-'));
  const registry = createHarnessRegistry();
  const seen = [];
  const unregister = registry.register(fixture({ onRun: input => seen.push(input.session ?? null) }));
  let agent = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init();
  t.after(async () => { await agent.stop(); agent.close(); rmSync(root, { recursive: true, force: true }); });
  const settings = agent.configureExecutor({ driver: 'fixture', label: 'Ready for feedback' }, { expectedRevision: 0 });
  assert.equal(settings.execution.adapterVersion, '1');
  assert.throws(() => agent.getConfig(), /getConfigV2/);
  const store = new Store(join(stateDir(root), 'state.sqlite'));
  assert.equal(Number(store.db.prepare('PRAGMA user_version').get().user_version), 9); store.close();
  const ticket = agent.submit({ text: 'Inspect the local fixture' });
  await agent.runNext();
  const binding = agent.sessionStatus(ticket.id).harnessBinding;
  assert.equal(binding.adapter.id, 'fixture'); assert.equal(binding.adapter.version, '1');
  assert.equal(binding.workspaceRoot, realpathSync(root)); assert.equal(binding.session.id, 'fixture-session');
  agent.close(); agent = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init();
  agent.reply(ticket.id, 'Continue with the same facts'); await agent.runNext();
  assert.deepEqual(seen, [null, { driver: 'fixture', id: 'fixture-session' }]);
  assert.deepEqual(agent.sessionStatus(ticket.id).harnessBinding, binding);
  unregister(); registry.register(fixture({ version: '2' }));
  agent.reply(ticket.id, 'Do not silently migrate');
  await assert.rejects(agent.runNext(), /version changed/);
  assert.equal(seen.length, 2);
});

test('a new Harness cannot checkpoint another adapter identity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-harness-id-'));
  const registry = createHarnessRegistry({ adapters: [fixture({ driverName: 'codex' })] });
  const agent = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init();
  t.after(async () => { await agent.stop(); agent.close(); rmSync(root, { recursive: true, force: true }); });
  agent.configureExecutor({ driver: 'fixture' }, { expectedRevision: 0 });
  const ticket = agent.submit({ text: 'Inspect fixture' }); await agent.runNext();
  assert.equal(agent.getSession(ticket.id), null);
  assert.equal(agent.get(ticket.id).status, 'failed');
  assert.match(agent.get(ticket.id).reports.at(-1).summary, /different Harness/);
});

test('package manifests do not depend on js-agent-runtime', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(manifest[field]?.['js-agent-runtime'], undefined);
});

test('advanced executor does not break later workspace or GitHub configuration with multiple workers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-harness-config-'));
  const agent = createProjectAgent({ projectRoot: root }).init();
  t.after(async () => { await agent.stop(); agent.close(); rmSync(root, { recursive: true, force: true }); });
  agent.configureV2({ workspace: { mode: 'copy' } });
  agent.configureScheduler({ maxWorkers: 2 }, { expectedRevision: 0 });
  agent.configureExecutor({ driver: 'dsh-sdk', model: 'fixture', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://example.invalid/anthropic', apiKeyEnv: 'FIXTURE_DSH_KEY' } }, { expectedRevision: 0 });
  assert.equal(agent.configureV2({ workspace: { exclude: ['generated'] } }).execution.driver, 'dsh-sdk');
  const config = agent.configureV2({ github: { repository: 'example/fixture', allowedActors: ['operator'] } });
  assert.equal(config.execution.driver, 'dsh-sdk');
  assert.equal(config.github.repository, 'example/fixture');
  assert.deepEqual(config.workspace.exclude, ['generated']);
  assert.throws(() => agent.configureV2({ workspace: { mode: 'in-place' } }), /isolated workspaces/);
});

test('coordinator settings pin adapter versions through the same registry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-harness-assessor-'));
  const registry = createHarnessRegistry({ assessors: createBuiltinAssessors() });
  const adapter = version => ({ id: 'fixture-assessor', version, roles: ['coordinator'], validate: value => value,
    createAssessor: () => ({ async assess() { return { kind: 'ignore', reason: 'Fixture inspected', rules: [] }; } }) });
  const unregister = registry.register(adapter('1'));
  const agent = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init();
  t.after(async () => { await agent.stop(); agent.close(); rmSync(root, { recursive: true, force: true }); });
  agent.configureCoordinator({ assessor: { driver: 'codex-app-server' } }, { expectedRevision: 0 });
  assert.equal(agent.coordinatorStatus().settings.assessor.adapterVersion, '1');
  agent.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 1 });
  const saved = agent.coordinatorStatus().settings.assessor;
  assert.deepEqual(saved, { driver: 'fixture-assessor', adapterVersion: '1' });
  unregister(); registry.register(adapter('2'));
  assert.throws(() => registry.createAssessor(saved), /version changed/);
  agent.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 2 });
  assert.equal(agent.coordinatorStatus().settings.assessor.adapterVersion, '2');
});

test('public default registry includes builtin coordinator factories', () => {
  const registry = createHarnessRegistry();
  assert.equal(typeof registry.createAssessor({ driver: 'codex-app-server' }).assess, 'function');
  assert.equal(registry.list().find(item => item.id === 'dsh-sdk').roles.includes('coordinator'), true);
});

test('invalid or stale Harness settings never migrate an otherwise legacy database', async t => {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-harness-stale-'));
  const registry = createHarnessRegistry({ adapters: [fixture(), { id: 'fixture-assessor', version: '1', roles: ['coordinator'], validate: value => value, createAssessor: () => ({ async assess() {} }) }] });
  const agent = createProjectAgent({ projectRoot: root, harnessRegistry: registry }).init();
  const store = new Store(join(stateDir(root), 'state.sqlite'));
  t.after(async () => { store.close(); await agent.stop(); agent.close(); rmSync(root, { recursive: true, force: true }); });
  const schema = () => Number(store.db.prepare('PRAGMA user_version').get().user_version);
  assert.equal(schema(), 2);
  assert.throws(() => agent.configureExecutor({ driver: 'fixture' }, { expectedRevision: 1 }), /revision conflict/);
  assert.equal(schema(), 2);
  const jobs = { profiles: { inspect: { kind: 'agent', version: '1', instruction: 'Inspect only', paths: ['.'] } }, paths: ['.'], childExecution: { driver: 'fixture' } };
  assert.throws(() => agent.configureJobs(jobs, { expectedRevision: 1 }), /revision conflict/);
  assert.equal(schema(), 2);
  assert.throws(() => agent.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: 1 }), /revision conflict/);
  assert.equal(schema(), 2);
  assert.throws(() => agent.configureCoordinator({ assessor: { driver: 'fixture-assessor' }, policy: { mode: 'invalid' } }, { expectedRevision: 0 }), /mode/);
  assert.equal(schema(), 2);
  assert.throws(() => agent.configureCoordinator({ assessor: null, policy: { mode: 'auto' } }, { expectedRevision: 0 }), /configured assessor/);
  assert.equal(schema(), 2);
  assert.throws(() => agent.configureCoordinator({ assessor: 0 }, { expectedRevision: 0 }), /plain object/);
  assert.equal(schema(), 2);
});

test('registry exposes the built-in adapters and rejects removed execution contracts', () => {
  const registry=createHarnessRegistry();
  const listed = registry.list();
  assert.deepEqual(listed.map(entry=>entry.id),['codex-app-server','dsh-sdk','cursor-agent']);
  assert.equal(listed[0].label, 'Codex');
  assert.equal(listed[1].label, 'DSH');
  assert.equal(listed[2].label, 'Cursor');
  assert.deepEqual(listed[1].preserveOnSave, ['executable', 'backend', 'permission', 'contextMode']);
  for(const driver of ['codex','dsh-headless']) assert.throws(()=>registry.createDriver({driver}),/removed.*migrate/);
  registry.register({id:'old-extension',version:'1',roles:['worker'],validate:value=>value,createDriver:()=>({async run(){return {status:'completed',summary:'old'};}})});
  assert.throws(()=>registry.createDriver({driver:'old-extension'}),/reportVersion 2/);
});

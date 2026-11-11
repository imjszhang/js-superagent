import { execFile } from 'node:child_process';
import { driverCapabilities } from '../runtime/reports.mjs';
import { createBuiltinAssessors } from '../coordinator.mjs';
import { BUILTIN_ADAPTERS, RETIRED_DRIVERS } from './builtin.mjs';

const ID = /^[a-z][a-z\d-]{0,63}$/;
const ROLES = ['worker', 'child', 'coordinator'];
const CAPABILITIES = ['structuredProgress', 'sessionResume', 'realtimeInput', 'inputAcknowledgements', 'backgroundTasks', 'subagents', 'agentTools', 'nativeBackgroundOwnership'];
const VERSIONED_CAPABILITIES = ['boundedMaterialReadsVersion', 'workspacePreparationVersion'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
}
function synchronous(value, label) {
  if (value && typeof value.then === 'function') throw new Error(`${label} must be synchronous and start no external work`);
  return value;
}
/** Trusted factories/validators must be pure until Driver.run/Assessor.assess is called.
 * A registry belongs to its caller; there is no module-global registration state.
 */
export function createHarnessRegistry({ adapters = [], assessors = createBuiltinAssessors() } = {}) {
  if (!Array.isArray(adapters)) throw new Error('Harness adapters must be an array');
  object(assessors, 'Harness assessors');
  const entries = new Map(), builtinIds = new Set([...BUILTIN_ADAPTERS.map(adapter => adapter.id), ...Object.keys(RETIRED_DRIVERS)]);
  const registry = {
    register(adapter) { return add(adapter, false); },
    list() { return [...entries.values()].map(entry => ({ id: entry.id, version: entry.version, roles: [...entry.roles], capabilities: { ...entry.capabilities },
      ...(entry.label ? { label: entry.label } : {}), settingsFields: [...(entry.settingsFields ?? [])], preserveOnSave: [...(entry.preserveOnSave ?? [])] })); },
    validateExecution(execution, { role = 'worker' } = {}) {
      object(execution, 'Harness execution');
      const { driver, adapterVersion, requiredCapabilities, ...options } = execution;
      const entry = select(driver, role);
      if (adapterVersion !== undefined && adapterVersion !== entry.version) throw new Error(`Harness ${driver} adapter version changed; explicitly replace the execution target`);
      if (requiredCapabilities !== undefined && (!Array.isArray(requiredCapabilities) || requiredCapabilities.some(key => !CAPABILITIES.includes(key) && !VERSIONED_CAPABILITIES.includes(key)))) throw new Error('Unknown required Harness capability');
      const validate = role === 'coordinator' ? entry.assessor?.validate ?? entry.validate : entry.validate;
      const validated = synchronous(validate(structuredClone(options), { role }), 'Harness validation') ?? options;
      object(validated, 'Normalized Harness options');
      if (Object.hasOwn(validated, 'driver') && (role !== 'coordinator' || validated.driver !== driver)) throw new Error('Harness validator cannot change execution identity');
      const { driver: validatedDriver, ...normalized } = validated;
      object(normalized, 'Normalized Harness options');
      if (Object.keys(normalized).some(key => ['driver', 'adapterVersion', 'requiredCapabilities'].includes(key))) throw new Error('Harness validator cannot change execution identity');
      const result = { driver, ...structuredClone(normalized), ...(adapterVersion === undefined ? {} : { adapterVersion }),
        ...(requiredCapabilities === undefined ? {} : { requiredCapabilities: [...new Set(requiredCapabilities)] }) };
      // Factory construction is part of static validation; it must never start a model.
      if (role !== 'coordinator') checkDriver(entry, result, role);
      else if (requiredCapabilities?.length) throw new Error('Worker capability requirements cannot be applied to an Assessor');
      return result;
    },
    createDriver(execution, { role = 'worker' } = {}) {
      if (role === 'coordinator') throw new Error('Use createAssessor for the coordinator role');
      const normalized = registry.validateExecution(execution, { role });
      return checkDriver(select(normalized.driver, role), normalized, role);
    },
    createAssessor(execution) {
      const normalized = registry.validateExecution(execution, { role: 'coordinator' }), entry = select(normalized.driver, 'coordinator');
      const { driver, adapterVersion, requiredCapabilities, ...options } = normalized;
      const assessor = synchronous((entry.assessor?.create ?? entry.createAssessor)(options), 'Assessor factory');
      if (!assessor || typeof assessor.assess !== 'function') throw new Error('Harness Assessor must implement assess');
      return assessor;
    },
    describeExecution(execution, { role = 'worker' } = {}) {
      const normalized = registry.validateExecution(execution, { role }), entry = select(normalized.driver, role);
      return { adapter: { id: entry.id, version: entry.version }, role, supervised: entry.supervised === true, execution: normalized,
        capabilities: role === 'coordinator' ? {} : driverCapabilities(checkDriver(entry, normalized, role)) };
    },
    supervised(driver) { return entries.get(driver)?.supervised === true; },
    serviceLaunch(execution, processEnv = {}) {
      const normalized = registry.validateExecution(execution), entry = select(normalized.driver, 'worker');
      if (typeof entry.serviceLaunch !== 'function') throw new Error('Harness does not declare a service launch plan');
      const plan = synchronous(entry.serviceLaunch(normalized, processEnv), 'Service launch plan');
      object(plan, 'Service launch plan');
      if (typeof plan.executable !== 'string' || !plan.executable.trim() || plan.executable.includes('\0')) throw new Error('Harness service launch requires an executable');
      object(plan.environment ?? {}, 'Service launch environment');
      const environment = plan.environment ?? {};
      if (Object.entries(environment).some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string' || !value || value.includes('\0'))) throw new Error('Invalid service launch environment');
      if (!Array.isArray(plan.credentialEnvNames) || plan.credentialEnvNames.some(name => !ENV_NAME.test(name ?? ''))) throw new Error('Invalid harness credential environment');
      return { executable: plan.executable, environment: { ...environment }, credentialEnvNames: [...plan.credentialEnvNames] };
    },
    loginProbe(execution, context = {}) {
      const normalized = registry.validateExecution(execution), entry = select(normalized.driver, 'worker');
      if (typeof entry.loginProbe !== 'function') return null;
      return entry.loginProbe(normalized, context);
    },
    coordinatorExecution(execution) {
      object(execution, 'Harness execution');
      const entry = typeof execution.driver === 'string' ? entries.get(execution.driver) : undefined;
      if (typeof entry?.coordinatorExecution !== 'function') return execution;
      const result = synchronous(entry.coordinatorExecution(structuredClone(execution)), 'Coordinator execution');
      object(result, 'Coordinator execution');
      if (result.driver !== undefined && result.driver !== execution.driver) throw new Error('Coordinator execution cannot change harness identity');
      return result;
    },
    validateLease(record) {
      const driver = record?.session?.driver ?? record?.driver;
      const entry = typeof driver === 'string' ? entries.get(driver) : undefined;
      if (typeof entry?.validateLease !== 'function') throw new Error('Invalid native handoff ownership record');
      const validated = synchronous(entry.validateLease(record), 'Lease validation');
      if (!validated || validated.driver !== driver && validated.session?.driver !== driver) throw new Error('Invalid native handoff ownership record');
      return validated;
    },
    async probeExecution(execution, { role = 'worker', checkExecutable = false, timeoutMs = 3000 } = {}) {
      if (typeof checkExecutable !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid Harness probe options');
      const description = registry.describeExecution(execution, { role }), entry = select(execution.driver, role);
      const checks = [{ name: 'configuration', status: 'passed', message: 'Registered adapter configuration and declared capabilities are valid.' }];
      if (checkExecutable) {
        if (entry.probe) checks.push(...await entry.probe(description.execution, { role, timeoutMs }));
        else {
          // No credential values or arbitrary environment overrides are supplied to metadata calls.
          const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
          const executable = description.execution.executable ?? entry.defaultExecutable;
          if (!executable) checks.push({ name: 'executable', status: 'unknown', message: 'This extension supplies no executable metadata probe.' });
          else {
            const verdict = await new Promise(resolve => execFile(executable, ['--version'], { env, timeout: timeoutMs, maxBuffer: 16_384, windowsHide: true }, error => resolve(!error)));
            checks.push({ name: 'executable', status: verdict ? 'passed' : 'failed', message: verdict ? 'Version command exited successfully; provider and model access remain unverified.' : 'Version command failed or timed out; no model run was requested.' });
          }
        }
      }
      return { ok: checks.every(check => check.status === 'passed' || check.status === 'skipped'), adapter: description.adapter, role, capabilities: description.capabilities, checks };
    },
  };
  function select(id, role) {
    if (!ROLES.includes(role)) throw new Error('Unknown Harness role');
    if (Object.hasOwn(RETIRED_DRIVERS, id)) throw new Error(`Legacy executor ${id} was removed; preview and explicitly migrate to ${RETIRED_DRIVERS[id]}`);
    const entry = entries.get(id);
    if (!entry) throw new Error(`Unknown executor / Harness: ${id}`);
    if (!entry.roles.includes(role)) throw new Error(`Harness ${id} does not support role ${role}`);
    return entry;
  }
  function checkDriver(entry, execution, role) {
    const { driver, adapterVersion, requiredCapabilities = [], ...options } = execution;
    const instance = synchronous(entry.createDriver(options, { role }), 'Harness factory');
    if (!instance || typeof instance.run !== 'function' || instance.reportVersion !== 2) throw new Error('Harness Driver must implement run with reportVersion 2; migrate legacy Driver results');
    const effective = driverCapabilities(instance);
    for (const capability of requiredCapabilities) if (effective[capability] !== (VERSIONED_CAPABILITIES.includes(capability) ? 1 : true)) throw new Error(`Harness ${entry.id} does not provide required capability ${capability}`);
    if (options.enableManagedJobs === true && (!effective.backgroundTasks || !effective.subagents)) throw new Error('Selected Harness does not provide managed job tools');
    if (options.enableAgentTools === true && !effective.agentTools) throw new Error('Selected Harness does not provide business tools');
    return instance;
  }
  function add(adapter, builtin) {
    object(adapter, 'Harness adapter');
    if (!ID.test(adapter.id ?? '') || typeof adapter.version !== 'string' || !adapter.version.trim() || adapter.version.length > 100) throw new Error('Harness adapter requires a stable id and version');
    if (entries.has(adapter.id) || !builtin && builtinIds.has(adapter.id)) throw new Error(`Harness adapter already registered: ${adapter.id}`);
    if (!Array.isArray(adapter.roles) || !adapter.roles.length || adapter.roles.some(role => !ROLES.includes(role)) || typeof adapter.validate !== 'function') throw new Error('Harness adapter requires roles and a validator');
    if (adapter.roles.some(role => role !== 'coordinator') && typeof adapter.createDriver !== 'function') throw new Error('Harness adapter requires createDriver');
    if (adapter.roles.includes('coordinator') && typeof (adapter.assessor?.create ?? adapter.createAssessor) !== 'function') throw new Error('Harness coordinator requires createAssessor');
    const entry = Object.freeze({ ...adapter, roles: Object.freeze([...new Set(adapter.roles)]), capabilities: Object.freeze({ ...(adapter.capabilities ?? {}) }) });
    entries.set(entry.id, entry);
    return () => { if (builtin) throw new Error('Built-in Harness adapters cannot be removed'); if (entries.get(entry.id) === entry) entries.delete(entry.id); };
  }
  for (const adapter of BUILTIN_ADAPTERS) {
    const assessor = assessors[adapter.id], entry = { ...adapter, roles: adapter.roles.filter(role => role !== 'coordinator' || assessor) };
    delete entry.assessor;
    add({ ...entry, ...(assessor ? { assessor } : {}) }, true);
  }
  for (const adapter of adapters) registry.register(adapter);
  return Object.freeze(registry);
}

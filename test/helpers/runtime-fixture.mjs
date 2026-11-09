// Business-flow tests use registered adapters. Compatibility with terse historical
// fixture inputs is test-only; the published runtime accepts only the v2 contract.
export * from '../../src/index.mjs';
import { createProjectAgent as createRuntime, createHarnessRegistry } from '../../src/index.mjs';
import { MACHINE_DEPENDENCIES } from '../../src/runtime/machine-guard.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
// Child processes spawned by a test inherit the same registry root, so they coordinate with their parent.
const inheritedRoot = process.env.JS_SUPERAGENT_TEST_MACHINE_ROOT;
const machineRoot = inheritedRoot || mkdtempSync(join(tmpdir(), 'js-superagent-fixture-machine-'));
if (!inheritedRoot) {
  process.env.JS_SUPERAGENT_TEST_MACHINE_ROOT = machineRoot;
  process.once('exit', () => rmSync(machineRoot, { recursive: true, force: true }));
}

export function isolatedMachineDirectory(projectRoot) {
  return join(machineRoot, createHash('sha256').update(resolve(projectRoot)).digest('hex'));
}

export function createProjectAgent({ driver, assessor, harnessRegistry, ...options } = {}) {
  options[MACHINE_DEPENDENCIES] ??= { directory: isolatedMachineDirectory(options.projectRoot) };
  if (!driver && !assessor) return createRuntime({ ...options, harnessRegistry });
  const registry = harnessRegistry ?? createHarnessRegistry();
  if (driver) registry.register({ id: 'fixture', version: '1', roles: ['worker', 'child'], validate: value => value,
    createDriver: () => ({ ...driver, reportVersion: 2, capabilities: { ...driver.capabilities, reportVersion: 2 },
      async run(input) {
        const result = await driver.run(input);
        if (result?.version === 2) return result;
        if (!['completed', 'waiting'].includes(result?.status)) throw new Error('Invalid test fixture report');
        return { version: 2, state: result.status === 'completed' ? 'ready' : 'waiting', summary: result.summary,
          artifacts: result.artifacts, attention: result.status === 'waiting' ? { question: result.summary } : null };
      } }) });
  if (assessor) registry.register({ id: 'fixture-assessor', version: '1', roles: ['coordinator'], validate: value => value, createAssessor: () => assessor });
  // Configuration tests retain their target settings; execution itself is a test
  // double supplied through the same registry interface, never a runtime bypass.
  const fixtureRegistry = { ...registry,
    createDriver(execution, options = {}) {
      const role = options.role ?? 'worker';
      if (role === 'child' && execution?.driver && execution.driver !== 'fixture') return registry.createDriver(execution, options);
      return registry.createDriver(driver ? { driver: 'fixture' } : execution, options);
    },
    createAssessor(execution) { return registry.createAssessor(assessor ? { driver: 'fixture-assessor' } : execution); },
    describeExecution(execution, role) {
      const description = registry.describeExecution(execution, role);
      return driver && role?.role !== 'coordinator'
        ? { ...description, adapter: { id: 'fixture', version: '1' }, capabilities: registry.describeExecution({ driver: 'fixture' }).capabilities }
        : description;
    },
  };
  return createRuntime({ ...options, harnessRegistry: fixtureRegistry,
    execution: options.execution ?? (driver ? { driver: 'fixture' } : undefined) });
}

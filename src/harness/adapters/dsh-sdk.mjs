import { createDshSdkDriver, executeDshTurn, validateDshOptions, probeDsh } from '../../drivers/dsh.mjs';
import { validateNativeHandoff } from '../../drivers/dsh-lease.mjs';
import { jsonAssessmentPrompt, parseAssessmentReport } from '../../runtime/assessment.mjs';
import { createTurnAssessor } from '../../runtime/turn-assessor.mjs';

function stripCoordinatorTools(execution) {
  const { enableAgentTools, enableManagedJobs, requiredCapabilities, permission, ...settings } = execution;
  return settings;
}
export const dshAssessmentPrompt = jsonAssessmentPrompt;
function boundedText(result, message) {
  if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > 128 * 1024) throw new Error(message);
  return result.text;
}
async function runTurn(config, turn) {
  const continuation = turn.kind === 'continuation';
  const result = await executeDshTurn(continuation ? config : { ...config, timeoutMs: turn.timeoutMs }, {
    ...turn.input, role: 'coordinator', prompt: turn.prompt, ...(continuation ? {} : { session: turn.session, runId: turn.runId, checkpoint: turn.checkpoint }),
  });
  if (continuation) {
    try { return JSON.parse(result.text); } catch { throw new Error('Invalid DSH continuation decision'); }
  }
  if (turn.kind === 'event') {
    try { return JSON.parse(boundedText(result, 'DSH coordination result exceeded its report bound')); }
    catch (error) { if (error.message === 'DSH coordination result exceeded its report bound') throw error; throw new Error('DSH coordinator returned an invalid work-event report'); }
  }
  return parseAssessmentReport(result.text, 'DSH');
}
/** A DSH classifier has no native tools; scoped reads are performed by the host. */
export function createDshAssessor(options = {}) {
  const { driver = 'dsh-sdk', ...settings } = options;
  if (driver !== 'dsh-sdk') throw new Error('DSH coordination requires the SDK session adapter');
  const validated = validateDshOptions(settings, { role: 'coordinator', driver });
  const config = { driver, ...validated };
  return createTurnAssessor({ config, assessmentPrompt: dshAssessmentPrompt, runTurn: turn => runTurn(validated, turn) });
}
export const dshSdkAdapter = {
  id: 'dsh-sdk', version: '1', label: 'DSH', roles: ['worker', 'child', 'coordinator'],
  capabilities: { reportVersion: 2, sessionResume: true, boundedContextVersion: 1, structuredProgress: true, realtimeInput: true, inputAcknowledgements: true, backgroundTasks: true, subagents: true, agentTools: true },
  supervised: true, defaultExecutable: 'dsh', settingsFields: ['backend', 'permission', 'contextMode'],
  preserveOnSave: ['executable', 'backend', 'permission', 'contextMode'],
  serviceLaunch(execution) {
    return { executable: execution.executable ?? 'dsh', environment: {}, credentialEnvNames: [execution.backend.apiKeyEnv] };
  },
  coordinatorExecution(execution) { return { ...stripCoordinatorTools(execution), permission: 'read-only' }; },
  validateLease: validateNativeHandoff,
  async probe(execution, { timeoutMs }) {
    const { driver, adapterVersion, requiredCapabilities, ...options } = execution;
    try { const value = await probeDsh(options, { timeoutMs }); return [{ name: 'executable', status: 'passed', message: `Compatible DSH ${value.version}; provider and model access remain unverified.` }]; }
    catch { return [{ name: 'executable', status: 'failed', message: 'DSH version is incompatible, unavailable, or its metadata command timed out; no model run was requested.' }]; }
  },
  validate(options, { role }) { return validateDshOptions(options, { role, driver: 'dsh-sdk' }); },
  createDriver: createDshSdkDriver,
  assessor: {
    validate(settings) { return validateDshOptions(settings, { role: 'coordinator', driver: 'dsh-sdk' }); },
    create: createDshAssessor,
  },
};

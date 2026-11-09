import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCursorAgentDriver, cursorEnvironment, executeCursorTurn, probeCursor, validateCursorOptions } from '../../drivers/cursor-agent.mjs';
import { jsonAssessmentPrompt } from '../../runtime/assessment.mjs';
import { createTurnAssessor } from '../../runtime/turn-assessor.mjs';
import { projectStateDirectory } from '../../state-paths.mjs';
export { createCursorAgentDriver, validateCursorOptions };

function stripCoordinatorTools(execution) {
  const { enableAgentTools, enableManagedJobs, requiredCapabilities, permission, ...settings } = execution;
  return settings;
}
function assessmentContext(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || projectRoot.includes('\0')) throw new Error('projectRoot must be non-empty text');
  const directory = join(projectStateDirectory(resolve(projectRoot)), 'assessment-context');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
function parsedResult(result, label) {
  let value;
  try { value = JSON.parse(result.text); } catch { throw new Error(`Cursor coordinator returned an invalid ${label}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Cursor coordinator returned an invalid ${label}`);
  return value;
}
async function runTurn(options, turn) {
  const continuation = turn.kind === 'continuation';
  const result = await executeCursorTurn(continuation ? options : { ...options, timeoutMs: Math.max(1000, turn.timeoutMs) }, {
    ...turn.input, role: 'coordinator', prompt: turn.prompt, projectRoot: assessmentContext(turn.input.projectRoot), sourceProjectRoot: turn.input.projectRoot,
    ...(continuation ? {} : { session: turn.session, runId: turn.runId, checkpoint: turn.checkpoint }),
    registerProcess: turn.registerProcess ?? turn.input.registerProcess,
  });
  return parsedResult(result, continuation ? 'continuation decision' : turn.kind === 'event' ? 'work-event report' : 'JSON report');
}
/** A read-only Cursor classifier runs in an empty context directory; scoped reads are performed by the host. */
export function createCursorAssessor(options = {}) {
  const { driver = 'cursor-agent', ...settings } = options;
  if (driver !== 'cursor-agent') throw new Error('Cursor coordination requires the cursor-agent adapter');
  const validated = validateCursorOptions(settings, { role: 'coordinator' });
  return createTurnAssessor({ config: { driver, ...validated }, assessmentPrompt: jsonAssessmentPrompt, runTurn: turn => runTurn(validated, turn) });
}
export const cursorAgentAdapter = {
  id: 'cursor-agent', version: '1', label: 'Cursor', roles: ['worker', 'child', 'coordinator'],
  capabilities: { reportVersion: 2, sessionResume: true, boundedContextVersion: 1 },
  supervised: true, defaultExecutable: 'cursor-agent', settingsFields: ['permission', 'apiKeyEnv'], preserveOnSave: ['executable', 'permission', 'apiKeyEnv'],
  serviceLaunch(execution) {
    return { executable: execution.executable ?? 'cursor-agent', environment: {}, credentialEnvNames: execution.apiKeyEnv ? [execution.apiKeyEnv] : [] };
  },
  loginProbe(execution, context = {}) {
    const run = context.execFileSync;
    if (typeof run !== 'function') return { id: 'cursor-login', status: 'unchecked', message: 'Cursor login was not probed.' };
    const home = mkdtempSync(join(tmpdir(), 'js-superagent-cursor-login-'));
    try {
      const settings = { encoding: 'utf8', timeout: context.timeoutMs ?? 5000, maxBuffer: 65536, env: cursorEnvironment(execution, home), stdio: ['ignore', 'pipe', 'pipe'] };
      // `status` reports only a stored login and stays unauthenticated for API keys; `models` exits non-zero on a rejected key.
      if (execution.apiKeyEnv) {
        run(execution.executable ?? 'cursor-agent', ['models'], settings);
        return { id: 'cursor-login', status: 'passed', message: 'Cursor accepts the configured API key.' };
      }
      mkdirSync(join(home, 'Library'), { mode: 0o700 }); symlinkSync(join(homedir(), 'Library', 'Keychains'), join(home, 'Library', 'Keychains'));
      if (JSON.parse(run(execution.executable ?? 'cursor-agent', ['status', '--format', 'json'], settings))?.isAuthenticated !== true) throw new Error('unauthenticated');
      return { id: 'cursor-login', status: 'passed', message: 'Cursor uses the personal login; that account\'s user rules and skills apply to every run.', nextAction: 'Set apiKeyEnv to a dedicated Cursor account key to keep personal rules out of Workers.' };
    } catch {
      return { id: 'cursor-login', status: 'blocked', message: 'Cursor login was not confirmed.', nextAction: 'Provide the dedicated Cursor API key through apiKeyEnv, or sign in with the selected executable; do not paste credentials into this report.' };
    } finally { rmSync(home, { recursive: true, force: true }); }
  },
  coordinatorExecution(execution) { return { ...stripCoordinatorTools(execution), permission: 'read-only' }; },
  async probe(execution, { timeoutMs }) {
    const { driver, adapterVersion, requiredCapabilities, ...options } = execution;
    try { const value = await probeCursor(options, { timeoutMs }); return [{ name: 'executable', status: 'passed', message: `Compatible Cursor CLI ${value.version}; account and model access remain unverified.` }]; }
    catch { return [{ name: 'executable', status: 'failed', message: 'Cursor CLI version is incompatible, unavailable, or its metadata command timed out; no model run was requested.' }]; }
  },
  validate(options, { role }) { return validateCursorOptions(options, { role }); },
  createDriver: createCursorAgentDriver,
  assessor: {
    validate(settings) { return validateCursorOptions(settings, { role: 'coordinator' }); },
    create: createCursorAssessor,
  },
};

import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z\d._:-]{1,160}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Capture before execution. A later profile edit cannot explain an older job. */
export function commandExecutionBinding(job, profile, workspace) {
  return { version: 1, jobId: job.id, jobToken: job.token, parent: structuredClone(job.parent),
    profileId: job.profileId, profileVersion: job.profileVersion, profileDigest: job.profileDigest,
    executionProfileDigest: digest(profile), commandDigest: digest([profile.command, profile.args, profile.cwd]),
    workspaceProvisionId: workspace.provisionId, ticketId: workspace.ticketId };
}

/** Inspect durable host evidence only. Process disappearance and stdout are not results. */
export function inspectManagedJobRecovery(job, { ticketId, assignmentIds, workspace, ownerExited = () => false } = {}) {
  const inspect = reason => ({ version: 1, jobId: job?.id ?? null, outcome: 'inspection', reason });
  if (!job || job.version !== 1 || !ID.test(job.id ?? '') || job.parent?.ticketId !== ticketId ||
      !assignmentIds?.includes(job.parent.assignmentId) || !ID.test(job.parent.runId ?? '')) return inspect('job-parent-binding-mismatch');
  if (job.status !== 'interrupted') return inspect(['pending', 'running'].includes(job.status) ? 'job-still-active' : 'job-not-interrupted');
  if (![job.owner, ...(job.guardians ?? []), ...(job.guardian ? [job.guardian] : [])].every(ownerExited)) return inspect('job-owner-not-settled');
  if (job.previewLease?.status === 'active') return inspect('job-preview-not-settled');
  if (job.kind !== 'command') return inspect('child-job-terminal-proof-unavailable');
  const binding = job.executionBinding, result = job.execution;
  if (!binding) return inspect('job-execution-binding-unavailable');
  if (binding.version !== 1 || binding.jobId !== job.id || binding.jobToken !== job.token || !same(binding.parent, job.parent) ||
      binding.profileId !== job.profileId || binding.profileVersion !== job.profileVersion || binding.profileDigest !== job.profileDigest ||
      !HASH.test(binding.profileDigest ?? '') || !HASH.test(binding.executionProfileDigest ?? '') || !HASH.test(binding.commandDigest ?? '') ||
      binding.workspaceProvisionId !== workspace?.provisionId || binding.ticketId !== workspace?.ticketId) return inspect('job-execution-binding-mismatch');
  if (!result || !['passed', 'failed', 'cancelled', 'timed-out'].includes(result.status) || !Number.isFinite(Date.parse(result.endedAt))) return inspect('job-terminal-result-unavailable');
  if (result.version !== 1 || result.id !== `job-${job.id}` || result.kind !== 'prepare' || result.profileId !== binding.profileId ||
      result.profileVersion !== binding.profileVersion || result.profileDigest !== binding.executionProfileDigest ||
      digest([result.command, result.args, result.cwd]) !== binding.commandDigest || result.workspaceProvisionId !== binding.workspaceProvisionId ||
      result.ticketId !== binding.ticketId) return inspect('job-terminal-result-binding-mismatch');
  const owners = [...(job.guardians ?? []), ...(job.guardian ? [job.guardian] : [])];
  if (!Number.isSafeInteger(result.pid) || !owners.some(owner => owner.pid === result.pid) ||
      result.childPid !== undefined && (!Number.isSafeInteger(result.childPid) || !owners.some(owner => owner.pid === result.childPid))) return inspect('job-result-process-binding-mismatch');
  if (!Object.hasOwn(result, 'exitCode') || result.exitCode !== null && !Number.isInteger(result.exitCode) ||
      !Object.hasOwn(result, 'exitSignal') || result.exitSignal !== null && typeof result.exitSignal !== 'string' ||
      !Object.hasOwn(result, 'supervisorExitCode') || result.supervisorExitCode !== null && !Number.isInteger(result.supervisorExitCode) ||
      result.exitCode === null && result.exitSignal === null ||
      result.status === 'passed' && (result.exitCode !== 0 || result.exitSignal !== null || result.supervisorExitCode !== 0 || result.error)) return inspect('job-terminal-exit-unverified');
  return { version: 1, jobId: job.id, outcome: 'settled', status: result.status === 'passed' ? 'completed' : result.status,
    endedAt: result.endedAt, result: structuredClone(result), evidence: { source: 'managed-job.execution', resultDigest: digest(result),
      executionProfileDigest: binding.executionProfileDigest, jobToken: job.token } };
}

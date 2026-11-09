import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeVerificationProfile } from '../src/verification.mjs';
import { commandExecutionBinding, inspectManagedJobRecovery } from '../src/runtime/job-recovery.mjs';

test('W17 interrupted command jobs reconcile only durable bound terminal evidence', () => {
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const workspace = { provisionId: 'workspace-1', ticketId: 'ticket-1' };
  const profile = normalizeVerificationProfile({ id: 'check', version: '1', kind: 'prepare', command: 'node', args: ['check.mjs'],
    environment: 'host', allowHostExecution: true, timeoutMs: 1000 });
  const job = { version: 1, id: 'job-1', token: 'token-1', kind: 'command', status: 'interrupted',
    parent: { ticketId: 'ticket-1', assignmentId: 'assignment-1', runId: 'run-1' }, profileId: 'check', profileVersion: '1', profileDigest: digest({ ...profile, kind: 'command' }),
    owner: { pid: 100, host: 'fixture' }, guardians: [{ pid: 101, host: 'fixture' }, { pid: 102, host: 'fixture' }] };
  job.executionBinding = commandExecutionBinding(job, profile, workspace);
  job.execution = { version: 1, id: 'job-job-1', kind: 'prepare', profileId: 'check', profileVersion: '1', profileDigest: digest(profile),
    workspaceProvisionId: workspace.provisionId, ticketId: workspace.ticketId, command: profile.command, args: profile.args, cwd: profile.cwd,
    status: 'passed', pid: 101, childPid: 102, exitCode: 0, exitSignal: null, supervisorExitCode: 0, endedAt: '2026-11-02T10:00:00Z' };
  const context = { ticketId: 'ticket-1', assignmentIds: ['assignment-1'], workspace, ownerExited: () => true };
  const rows = [
    ['completed', () => {}, 'completed'],
    ['failed', j => { j.execution.status = 'failed'; j.execution.exitCode = 2; }, 'failed'],
    ['timed-out', j => { j.execution.status = 'timed-out'; j.execution.exitCode = null; j.execution.exitSignal = 'SIGTERM'; }, 'timed-out'],
    ['no terminal', j => { j.execution.status = 'running'; }, 'job-terminal-result-unavailable'],
    ['legacy binding missing', j => { delete j.executionBinding; }, 'job-execution-binding-unavailable'],
    ['wrong parent', j => { j.parent.runId = 'another-run'; }, 'job-execution-binding-mismatch'],
    ['changed profile', j => { j.profileDigest = '0'.repeat(64); }, 'job-execution-binding-mismatch'],
    ['wrong result', j => { j.execution.id = 'job-other'; }, 'job-terminal-result-binding-mismatch'],
    ['changed command', j => { j.execution.args = ['other.mjs']; }, 'job-terminal-result-binding-mismatch'],
    ['unknown exit', j => { j.execution.exitCode = null; }, 'job-terminal-exit-unverified'],
    ['lost supervisor result', j => { j.execution.status = 'failed'; j.execution.exitCode = null; j.execution.error = 'Supervisor result unavailable'; }, 'job-terminal-exit-unverified'],
    ['child report only', j => { j.kind = 'agent'; j.report = { state: 'ready' }; }, 'child-job-terminal-proof-unavailable'],
  ];
  for (const [name, mutate, expected] of rows) {
    const input = structuredClone(job); mutate(input); const before = structuredClone(input);
    const result = inspectManagedJobRecovery(input, context);
    assert.equal(result.status ?? result.reason, expected, name); assert.deepEqual(input, before, 'Inspection must not mutate the journal');
  }
  assert.equal(inspectManagedJobRecovery(job, { ...context, ownerExited: () => false }).reason, 'job-owner-not-settled');
  assert.equal(inspectManagedJobRecovery(job, { ...context, workspace: { ...workspace, provisionId: 'other' } }).reason, 'job-execution-binding-mismatch');
});

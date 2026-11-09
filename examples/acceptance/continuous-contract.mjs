import assert from 'node:assert/strict';
export const CONTINUOUS_POLL_MS = 30_000;
export const CONTINUOUS_INTAKE_MS = 2 * CONTINUOUS_POLL_MS + 5000;
export const CONTINUOUS_EXTENSION_MS = 300_000;
export function assertContinuousObservation({ pollIntervalMs, actualMs, successfulSyncs, longWorkerMs, longWorkerSyncs }) {
  assert.equal(pollIntervalMs, CONTINUOUS_POLL_MS, 'Continuous acceptance must use the production 30-second polling interval');
  assert.ok(actualMs >= 1_800_000, 'Observe at least 30 real wall-clock minutes');
  assert.ok(successfulSyncs >= 60, 'Observe at least 60 distinct successful synchronizations');
  assert.ok(longWorkerMs > 180_000, 'Observe a real Worker for more than 180 seconds');
  assert.ok(longWorkerSyncs >= 4, 'Observe at least four successful synchronizations while the real Worker is held');
}
export function assertServiceProcessOwnership({ manifest, project, installed, status, runtime, wrapperCommand, childCommand, childParentPid }) {
  const modulePath = `${installed}/src/service.mjs`, cliPath = `${installed}/bin/js-superagent.mjs`;
  assert.equal(manifest.projectRoot, project); assert.equal(manifest.modulePath, modulePath); assert.equal(manifest.cliPath, cliPath); assert.equal(manifest.mode, 'poll');
  assert.equal(status.projectRoot, project); assert.equal(status.label, manifest.label); assert.equal(status.running, true);
  assert.ok(Number.isSafeInteger(status.pid) && status.pid > 1); assert.ok(Number.isSafeInteger(status.childPid) && status.childPid > 1);
  assert.equal(runtime.pid, status.pid); assert.equal(runtime.childPid, status.childPid); assert.equal(childParentPid, status.pid);
  // Never include the actual unrelated process command in an assertion error.
  if (wrapperCommand !== `${manifest.nodeExecutable} ${modulePath} run ${project}` || childCommand !== `${manifest.nodeExecutable} ${cliPath} --project ${project} serve --codex-path ${manifest.codexExecutable}`) throw new Error('Temporary service process identity does not match its frozen package and fixture');
  return { label: manifest.label, projectRoot: project, modulePath, cliPath, wrapperPid: status.pid, childPid: status.childPid };
}
export function continuousDuplicateEvidence({ repository, comments, triggers, domain, ticket, notifications }) {
  const originIds = new Set([domain.origin?.triggerId, ...(domain.origin?.triggerIds ?? [])].filter(Boolean));
  const sources = comments.map(comment => {
    const triggerId = `github:${repository}:comment:${comment.id}`;
    const matching = triggers.filter(trigger => trigger.source === 'github' && (trigger.id === triggerId || trigger.url === comment.url || trigger.text.includes(comment.marker)));
    const messageCount = ticket.messages.filter(message => message.triggerId === triggerId || message.text.includes(comment.marker)).length;
    const inputCount = domain.inputs.filter(input => input.kind === 'trigger' && input.triggerId === triggerId).length;
    const originCount = originIds.has(triggerId) ? 1 : 0;
    return { commentId: comment.id, triggerId, matchingTriggerIds: matching.map(trigger => trigger.id), messageCount, inputCount, originCount };
  });
  const runCounts = new Map(); for (const report of ticket.reports) runCounts.set(report.runId, (runCounts.get(report.runId) ?? 0) + 1);
  const receiptCounts = new Map();
  for (const receipt of notifications) {
    const runId = receipt.text.match(/(?:^|\n)Run: ([a-f0-9-]+)/)?.[1] ?? (receipt.kind === 'acknowledgement' ? domain.origin?.triggerId : receipt.text);
    const key = JSON.stringify([receipt.ticketId, receipt.kind, receipt.channel.source, receipt.channel.thread, runId]);
    const item = receiptCounts.get(key) ?? { kind: receipt.kind, runId, notificationIds: [] }; item.notificationIds.push(receipt.id); receiptCounts.set(key, item);
  }
  const duplicateSources = sources.reduce((count, source) => count + Math.max(0, source.matchingTriggerIds.length - 1) + Math.max(0, source.messageCount - 1) + Math.max(0, source.inputCount + source.originCount - 1), 0);
  const duplicateReportIds = [...runCounts.values()].reduce((count, n) => count + Math.max(0, n - 1), 0), businessReceipts = [...receiptCounts.values()];
  const duplicateBusinessReceipts = businessReceipts.reduce((count, item) => count + Math.max(0, item.notificationIds.length - 1), 0);
  return { sources, reportRuns: [...runCounts].map(([runId, count]) => ({ runId, count })), businessReceipts, duplicateSources, duplicateReportIds, duplicateBusinessReceipts,
    effectiveDuplicateCount: duplicateSources + duplicateReportIds + duplicateBusinessReceipts };
}
export function assertContinuousDeduplication(result) {
  for (const item of result.sources) { assert.equal(item.matchingTriggerIds.length, 1); assert.equal(item.matchingTriggerIds[0], item.triggerId); assert.equal(item.messageCount, 1); assert.equal(item.inputCount + item.originCount, 1); }
  assert.equal(result.effectiveDuplicateCount, 0, 'Repeated source inputs, run reports or business receipts were observed');
}

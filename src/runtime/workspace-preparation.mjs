import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const preparationPending = meta => ['queued', 'preparing', 'blocked'].includes(meta?.workspacePreparation?.status);

/** A durable host operation. It does not create a Ticket, Mandate or Assignment. */
export function requestWorkspacePreparation({ meta, materialId, provisionId, reason, now = new Date().toISOString() }) {
  if (typeof materialId !== 'string' || !materialId || typeof reason !== 'string' || !reason.trim() || reason.length > 4000) fail('PREPARATION_ARGUMENTS', 'Material reference and preparation reason are required');
  if (!meta.materialBinding?.allowPreparation || !meta.materialBinding.sources.some(source => source.id === materialId)) fail('PREPARATION_DENIED', 'The ticket has no grant to prepare this material');
  if (meta.workspace?.provisionId !== provisionId) fail('PREPARATION_STALE', 'Workspace preparation refers to a superseded workspace');
  const previous = meta.workspacePreparation;
  if (previous && previous.previousProvisionId === provisionId) {
    if (previous.materialId !== materialId) fail('PREPARATION_CONFLICT', 'Another material preparation already owns this workspace generation');
    return structuredClone(previous);
  }
  const id = `materials-${digest([meta.id, provisionId, materialId]).slice(0, 32)}`;
  return { version: 1, id, ticketId: meta.id, materialId, previousProvisionId: provisionId,
    previousSessionId: meta.driverSession?.id ?? null, bindingDigest: digest(meta.materialBinding),
    sourceRunId: meta.runId, status: 'queued', reason, createdAt: now, updatedAt: now };
}

export function preparationReport(meta, report) {
  if (!preparationPending(meta) || ['failed', 'blocked'].includes(report.state)) return report;
  return { version: 2, sourceVersion: 2, state: 'waiting', summary: 'The host is preparing the requested execution workspace. The current turn is complete; no business result has been delivered.', artifacts: [], attention: null };
}

export function validatePreparationOwner(meta) {
  const operation = meta.workspacePreparation;
  if (!operation || !['queued', 'preparing'].includes(operation.status)) return false;
  if (operation.bindingDigest !== digest(meta.materialBinding) || operation.previousProvisionId !== meta.workspace?.provisionId ||
      operation.previousSessionId !== (meta.driverSession?.id ?? null)) fail('PREPARATION_STALE', 'Material or session binding changed while preparation was pending');
  return true;
}

export function activatePreparedWorkspace(meta, workspace, now = new Date().toISOString()) {
  validatePreparationOwner(meta);
  const operation = meta.workspacePreparation;
  (meta.sessionHistory ??= []).push({ id: operation.id, at: now, kind: 'material-preparation', reason: operation.reason,
    previous: meta.driverSession ?? null, workspace: meta.workspace, execution: meta.executionConfig ?? null, harnessBinding: meta.harnessBinding ?? null,
    previousEvidence: {nativeFacts:meta.nativeFacts??null,delivery:meta.delivery??null,deliveryAttempt:meta.deliveryAttempt??null,recovery:meta.recovery??null} });
  for (const key of ['driverSession', 'agentToolsVersion', 'contextVersion', 'harnessBinding', 'preparation', 'verification', 'uiEvidence',
    'recoveredNative', 'inputAdoption', 'failure', 'executionObservation', 'nativeFacts', 'delivery', 'deliveryAttempt']) delete meta[key];
  // Retain the consumed repair budget and deadline as history; a directory
  // transition must never be disguised as a fresh failure/recovery allowance.
  if (meta.recovery?.status === 'resuming') meta.recovery = { ...meta.recovery, status: 'superseded', reason: 'material-preparation', updatedAt: now };
  meta.workspace = workspace;
  meta.workspacePreparation = { ...operation, status: 'ready', workspace, updatedAt: now };
  meta.executionPinOrigin = 'material-preparation'; meta.interrupted = false;
  return meta;
}

import { createHash } from 'node:crypto';

const ID = /^[A-Za-z\d_-]{1,120}$/;
const SHA = /^[a-f\d]{40}$/;
const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;
const nonempty = value => typeof value === 'string' && !!value.trim() && value.length <= 512 && !value.includes('\0');
const branch = value => nonempty(value) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
  !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.includes('//') &&
  !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
const inspect = reason => ({ version: 1, status: 'inspection', reason });

/** Host supplies authoritative facts; neither source text nor a model chooses a replacement branch. */
export function inspectContinuationPreconditions({ closedPulls = [], workspaceInspection, pendingInputIds = [],
  pendingOperationIds = [], activeJobIds = [], activeOwnerIds = [] } = {}) {
  for (const values of [closedPulls, pendingInputIds, pendingOperationIds, activeJobIds, activeOwnerIds]) {
    if (!Array.isArray(values)) throw new Error('Continuation inspection requires bounded fact lists');
    if (values.length > 1000) throw new Error('Continuation inspection exceeds fact limits');
  }
  if (activeOwnerIds.length) return inspect('previous-owner-active');
  if (pendingInputIds.length) return inspect('previous-input-outcome-unknown');
  if (pendingOperationIds.length) return inspect('previous-operation-outcome-unknown');
  if (activeJobIds.length) return inspect('previous-jobs-unsettled');
  const sources = new Map();
  for (const pull of closedPulls) {
    if (!REPOSITORY.test(pull?.repository ?? '') || !Number.isSafeInteger(pull.number) || pull.number < 1 ||
        pull.state !== 'closed' || typeof pull.merged !== 'boolean' || !SHA.test(pull.headSha ?? '')) return inspect('closed-source-unverified');
    const key = `${pull.repository.toLowerCase()}#${pull.number}`;
    const previous = sources.get(key);
    if (previous && (previous.headSha !== pull.headSha || previous.merged !== pull.merged)) return inspect('closed-source-observation-conflict');
    sources.set(key, { repository: pull.repository.toLowerCase(), number: pull.number, state: 'closed', merged: pull.merged, headSha: pull.headSha });
  }
  if (!sources.size) return inspect('closed-source-unavailable');
  if (sources.size !== 1) return inspect('closed-target-ambiguous');
  if (workspaceInspection?.status !== 'ready') return inspect(workspaceInspection?.reason ?? 'previous-workspace-unverified');
  if (workspaceInspection.version !== 1 || !SHA.test(workspaceInspection.headSha ?? '') ||
      !/^[a-f\d-]{36}$/.test(workspaceInspection.provisionId ?? '') || !Number.isSafeInteger(workspaceInspection.generation) ||
      workspaceInspection.generation < 0 || workspaceInspection.generation >= 1_000_000) return inspect('previous-workspace-unverified');
  return { version: 1, status: 'ready', reason: null, source: [...sources.values()][0],
    previousProvisionId: workspaceInspection.provisionId, previousHeadSha: workspaceInspection.headSha,
    generation: workspaceInspection.generation + 1 };
}

/** Immutable intent saved before provisioning; the host archives prior run/session evidence separately. */
export function createContinuationRecord({ ticketId, triggerIds, source, previousWorkspace, previousSession = null,
  target, generation = (previousWorkspace?.generation ?? 0) + 1, at = new Date().toISOString() }) {
  if (!ID.test(ticketId ?? '') || previousWorkspace?.ticketId !== ticketId || previousWorkspace.state !== 'ready' ||
      previousWorkspace.mode !== 'worktree' || !/^[a-f\d-]{36}$/.test(previousWorkspace.provisionId ?? '') ||
      !Number.isSafeInteger(generation) || generation !== (previousWorkspace.generation ?? 0) + 1 || generation > 1_000_000) throw new Error('Invalid continuation predecessor');
  if (!Array.isArray(triggerIds) || !triggerIds.length || triggerIds.length > 100 || triggerIds.some(value => !nonempty(value))) throw new Error('Continuation requires the original input identities');
  if (!REPOSITORY.test(source?.repository ?? '') || !Number.isSafeInteger(source.number) || source.number < 1 ||
      source.state !== 'closed' || typeof source.merged !== 'boolean' || !SHA.test(source.headSha ?? '')) throw new Error('Continuation requires a verified closed source');
  if (!target || target.repository !== source.repository.toLowerCase() || !SHA.test(target.baseCommit ?? '') ||
      !branch(target.base) || !['target-branch', 'previous-head'].includes(target.strategy) ||
      source.merged && target.strategy !== 'target-branch' || target.strategy === 'previous-head' && target.baseCommit !== source.headSha) throw new Error('Continuation requires an explicit verified target');
  if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid continuation time');
  const identity = { ticketId, generation, triggerIds: [...new Set(triggerIds)],
    source: { repository: source.repository.toLowerCase(), number: source.number, state: 'closed', merged: source.merged, headSha: source.headSha },
    target: { repository: target.repository, base: target.base, baseCommit: target.baseCommit, strategy: target.strategy },
    previousProvisionId: previousWorkspace.provisionId };
  const id = `continuation-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
  return { version: 1, id, ...identity, status: 'preparing', createdAt: new Date(at).toISOString(),
    previousWorkspace: structuredClone(previousWorkspace), previousSession: structuredClone(previousSession) };
}

export function completeContinuationRecord(record, workspace) {
  if (record?.version !== 1 || record.status !== 'preparing' || !ID.test(record.id ?? '') || workspace?.state !== 'ready' ||
      workspace.ticketId !== record.ticketId || workspace.generation !== record.generation ||
      workspace.previousProvisionId !== record.previousProvisionId || workspace.continuationId !== record.id ||
      workspace.baseCommit !== record.target?.baseCommit || workspace.path === record.previousWorkspace?.path ||
      workspace.provisionId === record.previousProvisionId) throw new Error('Prepared continuation does not match its saved intent');
  return { ...structuredClone(record), status: 'ready', workspace: structuredClone(workspace) };
}

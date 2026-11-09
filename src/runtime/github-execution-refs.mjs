const positive = value => Number.isSafeInteger(value) && value > 0;
const identity = value => typeof value === 'string' && value.length > 0;

/** Only a committed host continuation can retire the original discussion as an execution dependency. */
export function hasVerifiedContinuation(meta) {
  const workspace = meta?.workspace, continuation = meta?.continuation;
  return !!(workspace?.state === 'ready' && positive(workspace.generation) && workspace.ticketId === meta.id &&
    identity(workspace.provisionId) && identity(workspace.continuationId) && identity(workspace.path) &&
    continuation?.version === 1 && continuation.status === 'ready' && continuation.ticketId === meta.id &&
    continuation.generation === workspace.generation && continuation.id === workspace.continuationId &&
    continuation.workspace?.ticketId === meta.id && continuation.workspace.generation === workspace.generation &&
    continuation.workspace.provisionId === workspace.provisionId && continuation.workspace.path === workspace.path);
}

/** Read/notification history is broader than the remote objects needed to execute this generation.
 * Pending GitHub inputs remain strong dependencies, including inputs from an old discussion.
 * Outbox sends validate their own destination separately and must not use this filtered list.
 */
export function githubExecutionRefs({ meta, domain, bindings = [], pendingTriggers = [] }) {
  const refs = new Map();
  const add = (kind, value) => {
    const number = Number(value);
    if (['pull', 'issue'].includes(kind) && positive(number)) refs.set(`${kind}:${number}`, { kind, number });
  };
  const channel = value => {
    if (value?.source !== 'github') return;
    if (value.address?.pullNumber !== undefined) add('pull', value.address.pullNumber);
    else add('issue', value.address?.issueNumber);
  };
  const continued = hasVerifiedContinuation(meta);
  if (!continued) {
    add('issue', meta?.github?.issueNumber);
    add('pull', meta?.githubPull?.pullNumber);
    for (const value of domain?.channels ?? []) channel(value);
  }
  for (const binding of bindings) {
    if (binding.ticketId === meta?.id && (!continued || (binding.generation ?? 0) === meta.workspace.generation)) add('pull', binding.number);
  }
  for (const trigger of pendingTriggers) {
    if (trigger?.source !== 'github') continue;
    channel(trigger.channel);
    if (trigger.meta?.pullEvent) add('pull', trigger.meta.pullEvent.pullNumber);
    else if (trigger.meta?.pullRequest) add('pull', trigger.meta.pullRequest.number);
    else add('issue', trigger.meta?.issueNumber);
  }
  return [...refs.values()];
}

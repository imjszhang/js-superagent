import { createHash } from 'node:crypto';
import { followupOwners, reached } from '../../dist/core/index.js';
import { normalizeGitHubActorTrigger } from '../policy.mjs';
import { pullReplyChannel } from './github-review-delivery.mjs';

const positive = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
const repositoryName = value => typeof value === 'string' && /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/.test(value) && !['.', '..'].includes(value.split('/')[1]);
function fail(reason) {
  throw Object.assign(new Error(`Coordinator answer refused: ${reason}`), { code: 'COORDINATOR_ANSWER_REJECTED', reason });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

/** Fingerprint the exact source facts and destination, independent of object key order. */
export function answerFingerprint(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger) || typeof trigger.id !== 'string' || !trigger.id) fail('invalid-trigger');
  return createHash('sha256').update(JSON.stringify(canonical(trigger))).digest('hex');
}

/** Capture only trusted, still-held sibling inputs before the answer's transaction closes its target. */
export function coordinatorAnswerScope({ store, candidate, triggerId }) {
  const thread = store.threads.get(candidate.thread.key), evaluation = thread?.evaluating, tickets = store.tickets.list();
  if (evaluation?.id !== candidate.evalId || !evaluation.triggerIds.includes(triggerId) ||
      JSON.stringify(evaluation.triggerIds) !== JSON.stringify(candidate.triggers.map(trigger => trigger.id))) fail('invalid-answer-snapshot');
  const siblings = candidate.triggers.filter(trigger => trigger.id !== triggerId).map(trigger => {
    const current = store.triggers.get(trigger.id);
    if (!current || answerFingerprint(current) !== answerFingerprint(trigger)) fail('invalid-answer-snapshot');
    const disposition = store.triggers.disposition(trigger.id);
    return { id: trigger.id, fingerprint: answerFingerprint(current), decisionId: disposition?.decisionId ?? null,
      reachedTicketIds: [...new Set([...(disposition?.fanout ?? []), ...(disposition?.context ?? []),
        ...tickets.filter(ticket => ticket.origin?.triggerIds?.includes(trigger.id) ||
          ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)).map(ticket => ticket.id)])] };
  });
  const ids = new Set(siblings.map(item => item.id));
  return { version: 1, siblings, subscriptions: [...thread.subscriptions], existingTicketIds: tickets
    .filter(ticket => ticket.origin?.triggerIds?.some(id => ids.has(id))).map(ticket => ticket.id) };
}

function queuedSiblingProof(store, trigger, queuedAnswer) {
  const saved = queuedAnswer && store.getMeta(`coordinator-answer:${trigger.id}`), scope = saved?.queuedScope;
  if (!saved || JSON.stringify(canonical(saved)) !== JSON.stringify(canonical(queuedAnswer)) ||
      saved.fingerprint !== answerFingerprint(trigger) || saved.trigger?.id !== trigger.id || scope?.version !== 1 ||
      !Array.isArray(scope.siblings) || !Array.isArray(scope.existingTicketIds) || !Array.isArray(scope.subscriptions)) return;
  const closed = store.decisions.byThread(`github:${trigger.threads[0].id}`).some(decision => decision.kind === 'ignore' &&
    decision.triggerIds.length === 1 && decision.triggerIds[0] === trigger.id &&
    decision.audit?.coordinatorAnswer?.triggerId === trigger.id && decision.audit.coordinatorAnswer.replyId === saved.replyId &&
    decision.audit?.triggerDecision?.sourceEvalId === saved.evalId);
  if (!closed) return;
  const siblings = new Map();
  for (const item of scope.siblings) {
    const current = store.triggers.get(item.id);
    if (item.id === trigger.id || siblings.has(item.id) || !current || answerFingerprint(current) !== item.fingerprint || !Array.isArray(item.reachedTicketIds)) return;
    siblings.set(item.id, item);
  }
  return { siblings, existingTicketIds: new Set(scope.existingTicketIds), subscriptions: new Set(scope.subscriptions) };
}

function laterSiblingSubscription(store, trigger, ticket, proof) {
  if (!proof || proof.subscriptions.has(ticket.id) || ticket.origin?.triggerId === trigger.id ||
      ticket.origin?.triggerIds?.includes(trigger.id) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)) return false;
  const thread = store.threads.get(`github:${trigger.threads[0].id}`);
  if (thread?.subscriptions.includes(ticket.id) !== true || thread.context?.includes(ticket.id)) return false;
  const ids = ticket.origin?.triggerIds;
  const decision = store.decisions.get(ticket.decisionId);
  if (!proof.existingTicketIds.has(ticket.id) && ids?.length && ids.every(id => proof.siblings.has(id)) && ids.includes(ticket.origin.triggerId) &&
      decision?.kind === 'accept' && decision.ticketId === ticket.id && JSON.stringify(decision.triggerIds) === JSON.stringify(ids)) return true;
  // An older task needs a new, explicit domain route of a sibling; a later bind alone supplies no proof.
  return [...proof.siblings.values()].some(sibling => {
    if (sibling.reachedTicketIds.includes(ticket.id) || !ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === sibling.id && !input.context)) return false;
    const disposition = store.triggers.disposition(sibling.id);
    if (!disposition?.fanout.includes(ticket.id) || disposition.context?.includes(ticket.id) ||
        disposition.handbacks?.some(item => item.ticketId === ticket.id) || !disposition.decisionId || disposition.decisionId === sibling.decisionId) return false;
    const routed = store.decisions.get(disposition.decisionId);
    return ['ignore', 'unavailable'].includes(routed?.kind) && routed.triggerIds.includes(sibling.id) &&
      routed.reason.some(reason => reason.code === 'routed' && reason.values?.ticket === ticket.id &&
        (reason.triggerId === undefined ? routed.triggerIds.length === 1 : reason.triggerId === sibling.id));
  });
}

export function checkAnswerDestination(trigger, repository, owningTicketId) {
  const channel = trigger.channel, meta = trigger.meta ?? {}, event = meta.pullEvent, pull = meta.pullRequest;
  const address = channel?.address;
  if (!repositoryName(repository) || meta.repository !== repository || event && event.repository !== repository || pull && pull.repository !== repository) fail('outside-repository');
  if (channel?.source !== 'github' || !address || address.repository !== repository) fail('invalid-channel');
  const isPull = address.pullNumber !== undefined;
  let expected;
  if (isPull) {
    const number = Number(address.pullNumber), source = event ?? pull;
    if (!positive(address.pullNumber) || !source || !/^[a-f\d]{40}$/.test(address.headSha ?? '') ||
        Number(source.pullNumber ?? source.number) !== number || source.headSha !== address.headSha ||
        event && (event.pullNumber !== number || event.headSha !== address.headSha) ||
        pull && (pull.number !== number || pull.headSha !== address.headSha) ||
        meta.issueNumber !== undefined && Number(meta.issueNumber) !== number ||
        meta.pullNumber !== undefined && Number(meta.pullNumber) !== number) fail('invalid-channel');
    if (event?.kind === 'review_comment' && (!positive(event.reviewRootId) || !positive(event.reviewCommentId))) fail('invalid-channel');
    expected = pullReplyChannel(source);
  } else {
    if (event || pull || !positive(address.issueNumber) || Number(address.issueNumber) !== Number(meta.issueNumber)) fail('invalid-channel');
    expected = { source: 'github', thread: `${repository}#${Number(address.issueNumber)}`, address: { repository, issueNumber: String(Number(address.issueNumber)) } };
  }
  // Compare the entire original route, including review ancestry; no extra destination fields.
  const normalized = { ...channel, address: { ...address } };
  for (const key of ['issueNumber', 'pullNumber', 'reviewRootId', 'reviewCommentId']) if (normalized.address[key] !== undefined) normalized.address[key] = String(normalized.address[key]);
  if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(expected)) || !Array.isArray(trigger.threads) || trigger.threads.length !== 1 ||
      trigger.threads[0]?.source !== 'github' || !(trigger.threads[0]?.id === expected.thread ||
        isPull && owningTicketId && trigger.threads[0]?.id === `${expected.thread}:${owningTicketId}`)) fail('invalid-channel');
}

export function checkAnswerRevision(store, trigger, ticketId) {
  for (const [field, prefix] of [['githubComment', 'github:comment-version:'], ['githubBody', 'github:body-version:']]) {
    const version = trigger.meta?.[field];
    const baseId = version?.baseId ?? trigger.id.replace(/:v:[a-f\d]{24}$/, '');
    const current = store.getMeta(`${prefix}${baseId}`);
    if (version && (!current || current.eventId !== trigger.id || current.digest !== version.digest || current.actorId !== version.actorId || current.location !== version.location) ||
        !version && current && current.eventId !== trigger.id) fail('source-revision-retired');
    if (field === 'githubBody' && version && version.initialAuthorVerified !== true) fail('body-author-unverified');
  }
  // A handback or unread replacement retires the input for that ticket only.
  // The current source stays assessable until its own comment or body revision changes.
  if (!ticketId) return;
  for (const prefix of ['input:retired:', 'github:retired:']) {
    if (store.getMeta(`${prefix}${ticketId}:${trigger.id}`)) fail('source-revision-retired');
  }
}

/** Host-only, read-only gate. Call both before queuing and immediately before a new channel write. */
export function assertCoordinatorAnswer({ store, policy, trigger, repository, queuedAnswer }) {
  if (policy?.paused) fail('paused');
  const fingerprint = answerFingerprint(trigger), current = store.triggers.get(trigger.id);
  if (!current) fail('trigger-missing');
  if (answerFingerprint(current) !== fingerprint) fail('trigger-changed');
  if (current.source !== 'github' || current.actor?.source !== 'github') fail('unsupported-source');
  const normalized = normalizeGitHubActorTrigger(policy, current);
  if (!normalized.human || normalized.meta.githubActor.nativeType !== 'User' ||
      !positive(current.meta?.actorId ?? current.meta?.pullEvent?.actor?.id)) fail('not-human');
  if (current.meta?.contextOnly) fail('context-only');
  checkAnswerDestination(current, repository);
  checkAnswerRevision(store, current);
  const disposition = store.triggers.disposition(current.id), tickets = store.tickets.list();
  const proof = queuedSiblingProof(store, current, queuedAnswer);
  if ((disposition?.fanout?.length ?? 0) || (disposition?.context?.length ?? 0) || followupOwners(current, store).length ||
      tickets.some(ticket => reached(ticket, current, key => store.threads.get(key)) && !laterSiblingSubscription(store, current, ticket, proof))) fail('ticket-owned');
  const thread = store.threads.get(`github:${current.threads[0].id}`);
  const gate = policy?.gate?.(normalized, thread, tickets.filter(ticket => thread?.subscriptions?.includes(ticket.id)));
  if (!gate?.admissible || gate.strength !== 'explicit') fail('not-explicit');
  return { trigger: current, fingerprint, gate };
}

import { normalizeGitHubActorTrigger } from '../policy.mjs';
import { answerFingerprint, checkAnswerDestination, checkAnswerRevision } from './coordinator-answers.mjs';

const fail = reason => { throw Object.assign(new Error(`Worker answer refused: ${reason}`), { code: 'WORKER_ANSWER_REJECTED', reason }); };
export const workerAnswerKey = (ticketId, triggerId) => `worker-answer:${ticketId}:${triggerId}`;

/** An answer is a use of an actually delivered request, never of a subscription or a model-selected address. */
export function assertWorkerAnswer({ store, policy, repository, ticketId, trigger, execution, queuedAnswer }) {
  if (policy?.paused) fail('paused');
  const domain = store.tickets.get(ticketId), current = trigger && store.triggers.get(trigger.id);
  if (!domain || domain.ended?.by === 'human' || !policy.revalidate(domain.mandate)) fail('mandate-revoked');
  if (!current || answerFingerprint(current) !== answerFingerprint(trigger)) fail('trigger-changed');
  const disposition = store.triggers.disposition(current.id);
  const origin = domain.origin?.triggerId === current.id || domain.origin?.triggerIds?.includes(current.id);
  const input = domain.inputs.find(item => item.kind === 'trigger' && item.triggerId === current.id && !item.context) ??
    (origin ? { id: `origin:${current.id}`, kind: 'trigger', triggerId: current.id } : undefined);
  if (!input || current.meta?.contextOnly || disposition?.context?.includes(domain.id)) fail('not-owned-input');
  if (disposition?.handbacks?.some(item => item.ticketId === domain.id)) fail('input-handed-back');
  checkAnswerRevision(store, current, domain.id);
  let normalized = current;
  if (current.source === 'github') {
    normalized = normalizeGitHubActorTrigger(policy, current);
    if (current.actor?.source !== 'github' || !normalized.human || normalized.meta.githubActor.nativeType !== 'User' ||
        !/^[1-9]\d*$/.test(String(current.meta?.actorId ?? current.meta?.pullEvent?.actor?.id ?? ''))) fail('not-human');
    checkAnswerDestination(current, repository, domain.id);
    if (current.channel.address.pullNumber) {
      const binding = store.getMeta(`github:pull:${repository}#${Number(current.channel.address.pullNumber)}`);
      const publicId = store.getMeta(`public:${domain.id}`) ?? domain.id;
      if (!binding || binding.ticketId !== publicId) fail('pull-request-association-removed');
      if (binding.blockedReason === 'head-changed' || !new Set([binding.headSha, ...(binding.headHistory ?? []),
          ...(binding.discussionHeads ?? [])]).has(current.channel.address.headSha)) fail('pull-request-version-unavailable');
    }
  } else if (current.source === 'feishu') {
    // The channel address came from the verified Feishu event; the model only names the trigger.
    if (!current.human || current.actor?.source !== 'feishu' || current.channel?.source !== 'feishu' ||
        current.channel.address?.chatId !== current.meta?.chatId || current.channel.address?.tenantKey !== current.meta?.tenantKey) fail('not-human');
  } else if (current.source !== 'local' || !current.human || current.actor?.source !== 'local' || current.actor?.id !== 'operator' ||
      current.channel?.source !== 'local') fail('unsupported-source');
  const thread = store.threads.get(`${current.source}:${current.threads[0]?.id}`);
  const gate = policy.gate(normalized, thread, store.tickets.list().filter(ticket => thread?.subscriptions.includes(ticket.id)));
  if (!gate?.admissible || gate.strength !== 'explicit') fail('source-no-longer-authorized');
  if (execution) {
    const assignment = domain.assignments.find(item => item.id === execution.assignmentId);
    if (execution.ticketId !== domain.id || !assignment || assignment.state === 'ended' || domain.ended ||
        !(origin || execution.inputs.includes(input.id) || input.readAt && domain.assignments.some(item => item.id === input.deliveredTo) ||
          store.getMeta(`live-input:${execution.runId}:${input.id}`)?.status === 'read')) fail('input-not-delivered-to-run');
  }
  if (queuedAnswer) {
    const saved = store.getMeta(workerAnswerKey(domain.id, current.id));
    if (!saved || JSON.stringify(saved) !== JSON.stringify(queuedAnswer) || saved.ticketId !== domain.id || saved.inputId !== input.id ||
        saved.fingerprint !== answerFingerprint(current) || !domain.assignments.some(item => item.id === saved.assignmentId)) fail('answer-provenance-changed');
  }
  return { trigger: current, input, fingerprint: answerFingerprint(current) };
}

import { versionGitHubComment, commentCorrection } from './github-comment-version.mjs';
import { normalizeGitHubActorTrigger } from './policy.mjs';
import { githubMention } from './github-mention.mjs';
/** GitHub is an untrusted input source. Authority comes only from local configuration. */
export function githubAuthority(config, repository, actor, issueNumber) {
  return !!config && config.repository === repository && config.allowedActors.includes(actor) &&
    (!config.issues || config.issues.includes(issueNumber));
}

/** Pure admission result; a supplied ticket means the caller verified its subscription/binding.
 * Context delivery grants no new authority. Execution must still apply feedback hold/head checks. */
export function evaluateGitHubFeedback(config, input, { policy, thread, tickets = [], ticket, contextOnly = false, scopeAllowed = true } = {}) {
  const trigger = normalizeGitHubActorTrigger(policy, input);
  const meta = trigger?.meta ?? {}, event = meta.pullEvent;
  const repository = meta.repository ?? event?.repository;
  const issueNumber = meta.issueNumber;
  const ciAllowed = event?.kind === 'check_run' ? !!config?.ci?.checkApps?.includes(event.ci?.app)
    : event?.kind === 'commit_status' ? !!config?.ci?.statusContexts?.includes(event.ci?.name) && !!config?.ci?.statusActors?.includes(event.actor?.login) : true;
  const inScope = scopeAllowed && trigger?.source === 'github' && trigger.actor?.source === 'github' && !!config &&
    ciAllowed && repository === config.repository && (event || meta.pullRequest || issueNumber === undefined || !config.issues || config.issues.includes(issueNumber));
  const legacyAllowed = inScope && trigger.human && config.allowedActors.includes(trigger.actor.id);
  const admission = !inScope ? { admissible: false, reason: 'outside-configured-scope' }
    : policy ? policy.gate(trigger, thread, tickets)
      : legacyAllowed && !!trigger.addressed ? { admissible: true, strength: 'explicit', basis: { via: 'listed', sender: trigger.actor.id } }
        : { admissible: false, reason: 'actor-not-authorized' };
  const mandateValid = !!ticket && (!policy || policy.revalidate(ticket.mandate));
  const contextAllowed = !!(inScope && ticket && !ticket.ended && mandateValid);
  const canContinue = contextAllowed && !contextOnly && !policy?.paused && (event?.ci || legacyAllowed || admission.admissible);
  const canResume = !!(inScope && ticket?.ended && ticket.ended.by !== 'human' && mandateValid &&
    trigger.human && admission.admissible && !contextOnly && !policy?.paused);
  return { trigger, admission, candidateAllowed: admission.admissible, contextAllowed, canContinue, canResume,
    reason: !inScope ? 'outside-configured-scope' : ticket && !mandateValid ? 'mandate-revoked'
      : contextAllowed ? 'subscribed-context' : canResume ? 'authorized-human-followup' : admission.reason ?? 'candidate-admitted' };
}

export function normalizeGitHubEvent(event) {
  if (!event || !['issue', 'comment'].includes(event.kind) || typeof event.repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(event.repository) ||
      !Number.isSafeInteger(event.issueNumber) || event.issueNumber < 1 ||
      !/^\d+$/.test(String(event.issueId)) ||
      !['open', 'closed'].includes(event.issueState) || typeof event.text !== 'string' ||
      Buffer.byteLength(event.text) > 256 * 1024 ||
      typeof event.actor?.login !== 'string' || !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(event.actor.login) ||
      !/^\d+$/.test(String(event.actor.id)) || typeof event.actor.type !== 'string' ||
      !Number.isFinite(Date.parse(event.createdAt))) throw new Error('Invalid GitHub event');
  const repository = event.repository.toLowerCase();
  const prefix = `github:${repository}:${event.kind}:`;
  if (typeof event.id !== 'string' || !event.id.startsWith(prefix) || !/^\d+(?::v:[a-f0-9]{24})?$/.test(event.id.slice(prefix.length))) throw new Error('Invalid GitHub event identity');
  if (event.kind === 'issue' && event.id !== `${prefix}${event.issueId}`) throw new Error('GitHub issue identity mismatch');
  const thread = `${repository}#${event.issueNumber}`;
  const url = `https://github.com/${repository}/issues/${event.issueNumber}`;
  const { bodyVersion: _untrustedBodyVersion, ...raw } = event;
  return versionGitHubComment({ ...raw, repository, issueId: String(event.issueId), actor: { ...event.actor, login: event.actor.login.toLowerCase(), id: String(event.actor.id) },
    title: typeof event.title === 'string' ? event.title.slice(0, 256) : '', thread,
    createdAt: new Date(event.createdAt).toISOString(), url: event.kind === 'issue' ? url : `${url}#issuecomment-${event.id.slice(prefix.length).split(':')[0]}` });
}

export function githubRequest(text, command = '/js-superagent', { mentionIdentity } = {}) {
  const trimmed = text.trim();
  if (trimmed.startsWith(command)) {
    const rest = trimmed.slice(command.length);
    if (/^\s/.test(rest) && rest.trim()) return rest.trim();
  }
  return githubMention(text, mentionIdentity) ? text : null;
}

export function githubTrigger(event, text = event.text) {
  return {
    id: event.id, source: 'github', threads: [{ source: 'github', id: event.thread }],
    actor: { source: 'github', id: event.actor.login }, human: event.actor.type === 'User', addressed: 'direct',
    at: event.updatedAt ?? event.createdAt, text: commentCorrection(event, text), url: event.url,
    channel: { source: 'github', thread: event.thread, address: { repository: event.repository, issueNumber: String(event.issueNumber) } },
    meta: { repository: event.repository, issueNumber: event.issueNumber, actor: event.actor.login, actorId: event.actor.id, actorType: event.actor.type, ...(event.bodyVersion ? {githubBody:event.bodyVersion} : {}), ...(event.commentVersion ? { githubComment: event.commentVersion, supersedes: event.supersedes ?? null } : {}) },
  };
}

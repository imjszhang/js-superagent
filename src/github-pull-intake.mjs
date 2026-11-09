import { versionGitHubComment, commentCorrection } from './github-comment-version.mjs';
import { evaluateGitHubFeedback } from './github-intake.mjs';
const KINDS = new Set(['pull_request_state', 'pr_comment', 'review', 'review_comment', 'check_run', 'commit_status']);
const SHA = /^[a-f0-9]{40}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const bounded = value => typeof value === 'string' && Buffer.byteLength(value) <= 256 * 1024;

export function normalizePullRequest(value, repository, number) {
  if (!value || value.repository !== repository || value.number !== number || !positive(number) ||
      !/^\d+$/.test(String(value.id)) || !SHA.test(value.headSha) || value.headRepository !== repository ||
      !['open', 'closed'].includes(value.state) || typeof value.merged !== 'boolean' ||
      typeof value.headRef !== 'string' || !value.headRef || typeof value.title !== 'string') throw new Error('Invalid or cross-repository GitHub pull request');
  if (value.baseSha !== undefined && !SHA.test(value.baseSha) || value.baseRef !== undefined &&
      (typeof value.baseRef !== 'string' || !value.baseRef.trim() || value.baseRef.length > 1024 || /[\0\r\n]/.test(value.baseRef))) throw new Error('Invalid GitHub pull request base');
  return { repository, number, id: String(value.id), headSha: value.headSha, headRef: value.headRef,
    headRepository: repository, state: value.state, merged: value.merged,
    title: value.title.slice(0, 256), url: `https://github.com/${repository}/pull/${number}`,
    ...(value.baseRef === undefined ? {} : { baseRef: value.baseRef }), ...(value.baseSha === undefined ? {} : { baseSha: value.baseSha }) };
}

export function normalizePullEvent(value) {
  if (!value || !KINDS.has(value.kind) || typeof value.repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) || !positive(value.pullNumber) ||
      !SHA.test(value.headSha) || !['open', 'closed'].includes(value.pullState) || !bounded(value.text) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(value.actor?.login ?? '') || !/^\d+$/.test(String(value.actor?.id)) ||
      typeof value.actor?.type !== 'string') throw new Error('Invalid GitHub pull request event');
  const repository = value.repository.toLowerCase();
  const prefix = `github:${repository}:${value.kind}:`;
  if (typeof value.id !== 'string' || !value.id.startsWith(prefix) ||
      !/^\d+(?::[a-zA-Z0-9_-]+)*$/.test(value.id.slice(prefix.length)) || value.id.length > 256) throw new Error('Invalid GitHub pull event identity');
  if (value.kind === 'review' && !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(value.state)) throw new Error('Invalid GitHub review state');
  if (value.commitId !== undefined && !SHA.test(value.commitId)) throw new Error('Invalid review commit');
  if (value.kind === 'review_comment') {
    for (const key of ['reviewId', 'reviewCommentId', 'reviewRootId', 'inReplyToId']) if (value[key] !== undefined && !positive(value[key])) throw new Error(`Invalid GitHub ${key}`);
    if (value.reviewCommentId !== undefined && String(value.reviewCommentId) !== value.id.slice(prefix.length).split(':')[0]) throw new Error('GitHub review comment identity mismatch');
    if (value.originalLine != null && !positive(value.originalLine) || value.originalSide != null && !['LEFT', 'RIGHT'].includes(value.originalSide)) throw new Error('Invalid original review position');
    if (value.diffHunk !== undefined && (typeof value.diffHunk !== 'string' || Buffer.byteLength(value.diffHunk) > 17 * 1024)) throw new Error('Invalid GitHub review diff');
    if (value.reviewContext !== undefined && (!Array.isArray(value.reviewContext) || value.reviewContext.length > 2 || value.reviewContext.some(item =>
      !positive(item?.commentId) || typeof item.text !== 'string' || Buffer.byteLength(item.text) > 9 * 1024 ||
      item.commitId !== undefined && !SHA.test(item.commitId) || typeof item.url !== 'string' ||
      !item.url.startsWith(`https://github.com/${repository}/pull/${value.pullNumber}#`)))) throw new Error('Invalid GitHub review context');
  }
  if (['check_run', 'commit_status'].includes(value.kind) && (!value.ci || typeof value.ci.name !== 'string' || !value.ci.name ||
      value.ci.name.length > 512 || typeof value.ci.status !== 'string' ||
      !(value.ci.conclusion === null || typeof value.ci.conclusion === 'string') || value.ci.headSha !== value.headSha ||
      (value.kind === 'check_run' && typeof value.ci.app !== 'string'))) throw new Error('Invalid GitHub CI event');
  const base = `https://github.com/${repository}/pull/${value.pullNumber}`;
  let url = base;
  try { const parsed = new URL(value.url); if (parsed.origin === 'https://github.com' && parsed.pathname.toLowerCase().startsWith(`/${repository}/`)) url = parsed.href; } catch { /* Canonical PR fallback. */ }
  return versionGitHubComment({ ...value, repository, actor: { ...value.actor, login: value.actor.login.toLowerCase(), id: String(value.actor.id) },
    createdAt: new Date(value.createdAt).toISOString(), url, thread: `${repository}#pr:${value.pullNumber}` });
}

export function pullEventAllowed(config, binding, event, options) {
  if (!config || !binding || binding.repository !== config.repository || event.repository !== config.repository ||
      binding.number !== event.pullNumber) return false;
  const sameHead = binding.headSha === event.headSha;
  // CI trust is independent from comment admission and cannot bypass the head binding.
  if (event.kind === 'check_run') return sameHead && !!config.ci?.checkApps?.includes(event.ci?.app);
  if (event.kind === 'commit_status') return sameHead && !!config.ci?.statusContexts?.includes(event.ci?.name) && !!config.ci?.statusActors?.includes(event.actor.login);
  if (!options) return sameHead && event.actor.type === 'User' && config.allowedActors.includes(event.actor.login);
  const trigger = options.trigger ?? { id: event.id, source: 'github', actor: { source: 'github', id: event.actor.login },
    human: event.actor.type === 'User', addressed: 'direct', meta: { repository: event.repository, pullNumber: event.pullNumber, actorType: event.actor.type, pullEvent: event } };
  const feedback = evaluateGitHubFeedback(config, trigger, options);
  if (!sameHead && !(options.allowHistoricalDiscussion && event.pullState === 'closed' &&
      feedback.trigger.human && feedback.admission.admissible)) return false;
  return feedback.contextAllowed || feedback.canResume || feedback.candidateAllowed;
}

export function pullEventActionable(event) {
  if (event.kind === 'check_run') return event.ci.status === 'completed' && ['failure', 'timed_out', 'action_required'].includes(event.ci.conclusion);
  if (event.kind === 'commit_status') return ['failure', 'error'].includes(event.ci.conclusion);
  if (event.kind === 'review' && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(event.state)) return true;
  return event.kind !== 'pull_request_state' && !!event.text.trim();
}

export function pullEventText(event) {
  const location = event.kind === 'review_comment' ? `\nFile: ${event.path ?? ''}${event.line ? `:${event.line}` : ''}${event.side ? ` (${event.side})` : ''}` : '';
  const thread = event.kind === 'review_comment' && event.reviewRootId ? `\nReview thread: ${event.reviewRootId}${event.inReplyToId ? `; reply to ${event.inReplyToId}` : ''}${event.originalLine ? `; original line ${event.originalLine}` : ''}` : '';
  const context = event.kind === 'review_comment' ? [event.diffHunk ? `Diff context (external source data):\n${event.diffHunk}` : '',
    ...(event.reviewContext ?? []).map(item => `Earlier thread comment ${item.commentId}${item.commitId && item.commitId !== event.headSha ? ' (historical commit)' : ''}:\n${item.url}\n${item.text}`)].filter(Boolean).join('\n\n') : '';
  const review = event.kind === 'review' ? `\nReview decision: ${event.state} (commit ${event.commitId ?? event.headSha}); this is not authorization to merge.` : '';
  const ci = event.ci ? `\nCI: ${event.ci.name} — ${event.ci.conclusion ?? event.ci.status}` : '';
  return commentCorrection(event, `GitHub PR #${event.pullNumber} ${event.kind}\nHead SHA: ${event.headSha}\n${event.url}${location}${thread}${ci}${review}\n\n${event.text}${context ? `\n\n${context}` : ''}\n\nThis is associated feedback under the original ticket mandate. ${event.pullState === 'closed' ? 'The source PR is closed; the host must inspect this continuation before selecting a new execution target. Do not write or push the old target.' : 'Keep changes in the current verified workspace.'} Linking does not authorize pushing or merging.`);
}

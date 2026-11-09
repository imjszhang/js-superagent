import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function webhookError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
export function readWebhookSecret(config) {
  try {
    let secret;
    if (config.secretEnv) secret = process.env[config.secretEnv];
    else {
      const fd = openSync(config.secretPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) throw new Error('Invalid secret file');
        secret = readFileSync(fd);
      } finally { closeSync(fd); }
    }
    if (!secret || Buffer.byteLength(secret) < 1 || Buffer.byteLength(secret) > 64 * 1024) throw new Error('Missing secret');
    return secret;
  } catch { throw webhookError(503, 'Webhook secret is unavailable'); }
}
export function webhookConfigurationKey(config) {
  return createHash('sha256').update(JSON.stringify(config ?? null)).digest('hex');
}
const positive = value => Number.isSafeInteger(value) && value > 0;
/** A signed delivery is a reconciliation hint, never authority to run its body. */
export function webhookRoute({ event, payload }, config, pulls, repositorySettings = {}) {
  if (event === 'ping') return { accepted: false, reason: 'ping' };
  const installationId = payload.installation?.id;
  if (config.app && installationId !== config.app.installationId) return { accepted: false, reason: 'installation-not-configured' };
  if (['installation', 'installation_repositories'].includes(event)) {
    if (!config.app) return { accepted: false, reason: 'installation-not-configured' };
    if (!['deleted', 'suspend', 'unsuspend', 'added', 'removed', 'created', 'new_permissions_accepted'].includes(payload.action)) return { accepted: false, reason: 'unsupported-action' };
    return { accepted: true, repository: config.repository, installationId, selector: { kind: 'installation' } };
  }
  if (typeof payload.repository?.full_name !== 'string' || payload.repository.full_name.toLowerCase() !== config.repository) return { accepted: false, reason: 'repository-not-configured' };
  const context = { repository: config.repository, ...(positive(installationId) ? { installationId } : {}) };
  const issue = number => positive(number) && (!config.issues || config.issues.includes(number));
  const pull = number => positive(number) && pulls.some(binding => binding.repository === config.repository && binding.number === number);
  const onHead = head => typeof head === 'string' && pulls.some(binding => binding.repository === config.repository && binding.headSha === head);
  const mentions = repositorySettings.enabled === true && repositorySettings.streams?.mentions === true;
  let selector;
  if (mentions && event === 'issues' && ['opened','edited','reopened'].includes(payload.action) && !payload.issue?.pull_request && issue(payload.issue?.number)) selector = {kind:'issue',number:payload.issue.number,mention:true};
  else if (mentions && event === 'issue_comment' && ['created','edited'].includes(payload.action) && positive(payload.comment?.id) &&
    (payload.issue?.pull_request ? positive(payload.issue?.number)&&!pull(payload.issue.number) : issue(payload.issue?.number))) selector = {kind:payload.issue.pull_request?'pull':'issue',number:payload.issue.number,commentId:payload.comment.id,mention:true};
  else if (mentions && event === 'pull_request' && ['opened','edited','reopened'].includes(payload.action) && positive(payload.pull_request?.number) && !pull(payload.pull_request.number)) selector = {kind:'pull',number:payload.pull_request.number,mention:true};
  else if (mentions && event === 'pull_request_review' && ['submitted','edited'].includes(payload.action) && positive(payload.pull_request?.number) && !pull(payload.pull_request.number) && positive(payload.review?.id)) selector = {kind:'pull',number:payload.pull_request.number,reviewId:payload.review.id,mention:true};
  else if (event === 'issues' && ['opened', 'reopened', 'closed'].includes(payload.action) && !payload.issue?.pull_request && issue(payload.issue?.number)) selector = { kind: 'issue', number: payload.issue.number };
  else if (event === 'issue_comment' && ['created', 'edited'].includes(payload.action)) {
    if (payload.issue?.pull_request ? pull(payload.issue?.number) : issue(payload.issue?.number)) selector = { kind: payload.issue.pull_request ? 'pull' : 'issue', number: payload.issue.number };
  } else if (event === 'pull_request' && ['opened', 'synchronize', 'reopened', 'closed', 'edited'].includes(payload.action) && pull(payload.pull_request?.number)) selector = { kind: 'pull', number: payload.pull_request.number };
  else if (event === 'pull_request_review' && ['submitted', 'dismissed'].includes(payload.action) && pull(payload.pull_request?.number)) selector = { kind: 'pull', number: payload.pull_request.number };
  else if (event === 'pull_request_review_comment' && ['created', 'edited'].includes(payload.action) && pull(payload.pull_request?.number)) selector = { kind: 'pull', number: payload.pull_request.number };
  else if (event === 'pull_request_review_comment' && ['created', 'edited'].includes(payload.action) &&
    repositorySettings.enabled === true && repositorySettings.streams?.reviewComments === true && positive(payload.pull_request?.number) && positive(payload.comment?.id)) {
    // The signed body is a locator only. Polling must fetch and validate this
    // exact comment and same-repository PR before it can reach admission.
    selector = { kind: 'pull', number: payload.pull_request.number, reviewCommentId: payload.comment.id };
  }
  else if (mentions && event === 'pull_request_review_comment' && ['created','edited'].includes(payload.action) && positive(payload.pull_request?.number) && positive(payload.comment?.id)) selector = {kind:'pull',number:payload.pull_request.number,reviewCommentId:payload.comment.id,mention:true};
  else if (event === 'check_run' && ['created', 'completed', 'rerequested', 'requested_action', 'in_progress'].includes(payload.action) &&
    config.ci?.checkApps?.includes(payload.check_run?.app?.slug) && onHead(payload.check_run?.head_sha)) selector = { kind: 'head', headSha: payload.check_run.head_sha };
  else if (event === 'status' && config.ci?.statusContexts?.includes(payload.context) &&
    typeof payload.sender?.login === 'string' && config.ci?.statusActors?.includes(payload.sender.login.toLowerCase()) && onHead(payload.sha)) selector = { kind: 'head', headSha: payload.sha };
  return selector ? { accepted: true, ...context, selector } : { accepted: false, ...context, reason: 'event-outside-listened-scope' };
}

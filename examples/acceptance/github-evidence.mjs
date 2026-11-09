import assert from 'node:assert/strict';

/** A check must belong to the actual fixture workflow run at the exact tested head. */
export function assertActionsEvidence({ repository, headSha, conclusion, check, runs }) {
  assert.equal(check.head_sha, headSha); assert.equal(check.status, 'completed'); assert.equal(check.conclusion, conclusion);
  assert.equal(check.name, 'diagnostic-contract'); assert.equal(check.app?.slug, 'github-actions');
  assert.ok(Number.isSafeInteger(check.id) && check.id > 0); assert.ok(Number.isSafeInteger(check.app.id) && check.app.id > 0);
  assert.ok(Number.isSafeInteger(check.check_suite?.id) && check.check_suite.id > 0);
  const matches = runs.filter(run => run.check_suite_id === check.check_suite.id && run.head_sha === headSha && run.event === 'push' &&
    run.path === '.github/workflows/acceptance.yml' && run.repository?.full_name?.toLowerCase() === repository && run.head_repository?.full_name?.toLowerCase() === repository);
  assert.equal(matches.length, 1, 'Expected exactly one matching real fixture Actions workflow run');
  const run = matches[0]; assert.ok(Number.isSafeInteger(run.id) && run.id > 0); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, conclusion);
  return { checkId: check.id, checkSuiteId: check.check_suite.id, runId: run.id, headSha, conclusion, app: check.app.slug, appId: String(check.app.id), checkUrl: check.html_url, runUrl: run.html_url };
}
export function readStoredTrigger(runtime, id) {
  let offset = 0, version, encoded = '';
  do {
    const page = runtime.readContextRecord('triggers', id, { offset, limit: 32_000, ...(version ? { version } : {}) });
    assert.ok(page, `Expected persisted GitHub trigger ${id}`); version ??= page.version;
    assert.equal(page.version, version); assert.equal(page.offset, offset); encoded += page.text;
    assert.ok(encoded.length <= 1024 * 1024, 'Stored acceptance trigger exceeded its bound'); offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(encoded);
}
export function assertPullFailureInTicket({ repository, pullNumber, ticketId, domain, binding, trigger, action }) {
  const remoteId = `github:${repository}:check_run:${action.checkId}:${action.headSha}:completed:failure`;
  const triggerId = `${remoteId}:pr:${pullNumber}`;
  assert.equal(action.conclusion, 'failure'); assert.equal(binding.repository, repository); assert.equal(binding.number, pullNumber);
  assert.equal(binding.ticketId, ticketId); assert.equal(binding.headSha, action.headSha); assert.equal(binding.own, true);
  const ci = binding.ci.find(item => item.id === triggerId);
  assert.ok(ci, 'Actual failed check must be persisted in the current PR binding');
  assert.equal(ci.headSha, action.headSha); assert.equal(ci.name, 'diagnostic-contract'); assert.equal(ci.app, 'github-actions');
  assert.equal(ci.status, 'completed'); assert.equal(ci.conclusion, 'failure');
  assert.equal(trigger.id, triggerId); assert.equal(trigger.source, 'github'); assert.equal(trigger.actor?.id, 'github-actions'); assert.equal(trigger.human, false);
  const event = trigger.meta?.pullEvent;
  assert.equal(event?.remoteEventId, remoteId); assert.equal(event.id, triggerId); assert.equal(event.kind, 'check_run');
  assert.equal(event.repository, repository); assert.equal(event.pullNumber, pullNumber); assert.equal(event.headSha, action.headSha);
  assert.equal(event.actor.login, 'github-actions'); assert.equal(event.actor.id, action.appId); assert.equal(event.actor.type, 'Bot');
  assert.equal(event.ci.app, 'github-actions'); assert.equal(event.ci.status, 'completed'); assert.equal(event.ci.conclusion, 'failure');
  assert.ok(domain.inputs.some(input => input.triggerId === triggerId), 'The real check trigger must belong to the original ticket');
  return { triggerId, ticketId, pullNumber, ...action };
}
export function assertDefaultFailureInTicket({ repository, domain, trigger, action }) {
  const triggerId = `github:${repository}:branch_check:${action.checkId}:failure`;
  assert.equal(action.conclusion, 'failure'); assert.equal(domain.origin?.triggerId, triggerId); assert.equal(domain.mandate.strength, 'inferred');
  assert.equal(trigger.id, triggerId); assert.equal(trigger.source, 'github'); assert.equal(trigger.actor?.id, 'github-actions[bot]'); assert.equal(trigger.human, false);
  assert.equal(trigger.meta?.repository, repository); assert.equal(trigger.meta.defaultBranch, 'main'); assert.equal(trigger.meta.headSha, action.headSha);
  assert.equal(trigger.meta.actorId, action.appId); assert.equal(trigger.meta.actorType, 'Bot');
  assert.equal(trigger.meta.ci.app, 'github-actions'); assert.equal(trigger.meta.ci.name, 'diagnostic-contract');
  assert.equal(trigger.meta.ci.status, 'completed'); assert.equal(trigger.meta.ci.conclusion, 'failure');
  return { triggerId, ...action };
}
export function assertAppReceipt({ notification, comments, projectId, identity }) {
  const marker = `<!-- js-superagent:${projectId}:${notification.id} -->`, matches = comments.filter(comment => comment.body.includes(marker));
  assert.equal(notification.status, 'sent', 'App notification must actually be sent'); assert.equal(matches.length, 1, 'Expected exactly one durable App receipt');
  const comment = matches[0]; assert.equal(comment.user.login.toLowerCase(), identity.login.toLowerCase());
  assert.equal(String(comment.user.id), String(identity.id)); assert.equal(comment.user.type, 'Bot');
  assert.equal(comment.html_url, notification.delivery?.url);
  return { id: notification.id, kind: notification.kind, status: notification.status, url: comment.html_url, actor: comment.user.login, actorId: String(comment.user.id), type: comment.user.type };
}
export function assertOwnedDraftPull({ pull, repository, actor, headSha }) {
  assert.equal(pull.state, 'open'); assert.equal(pull.draft, true); assert.equal(pull.merged, false);
  assert.equal(pull.user.login.toLowerCase(), actor); assert.equal(pull.head.repo.full_name.toLowerCase(), repository);
  assert.equal(pull.base.repo.full_name.toLowerCase(), repository); assert.equal(pull.base.ref, 'main'); assert.equal(pull.head.sha, headSha);
}
/** Do not report pass until every requested cleanup finishes. All cleanup attempts run. */
export async function finalizeAcceptance({ evidence, checksPassed, cleanup, save }) {
  const errors = [];
  for (const step of cleanup) {
    try { await step.run(); }
    catch (error) { errors.push({ step: step.name, error: String(error.message ?? error) }); }
  }
  if (errors.length) evidence.cleanupErrors = errors;
  evidence.status = checksPassed && !errors.length ? 'passed' : 'failed'; evidence.completedAt = new Date().toISOString(); save();
  return errors.length ? new Error(`Acceptance cleanup failed: ${errors.map(item => item.step).join(', ')}`) : null;
}
/** Record the owned target before a remote ref update, so a lost response can be reconciled. */
export function updateOwnedMain({ api, prefix, expected, content, message, intent, save }) {
  assert.equal(api('GET', `${prefix}/git/ref/heads/main`).object.sha, expected, 'Acceptance main changed outside this run');
  const previous = api('GET', `${prefix}/git/commits/${expected}`);
  const tree = api('POST', `${prefix}/git/trees`, { base_tree: previous.tree.sha, tree: [{ path: intent.path, mode: '100644', type: 'blob', content }] });
  const commit = api('POST', `${prefix}/git/commits`, { message, tree: tree.sha, parents: [expected] });
  Object.assign(intent, { expected, sha: commit.sha, state: 'prepared' }); save();
  try { api('PATCH', `${prefix}/git/refs/heads/main`, { sha: commit.sha, force: false }); }
  catch (error) { if (api('GET', `${prefix}/git/ref/heads/main`).object.sha !== commit.sha) throw error; intent.responseReconciled = true; }
  assert.equal(api('GET', `${prefix}/git/ref/heads/main`).object.sha, commit.sha, 'Owned main update must be observed');
  intent.state = 'observed'; save(); return commit.sha;
}

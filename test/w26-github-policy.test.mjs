import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimePolicy, normalizeGitHubActorTrigger } from '../src/policy.mjs';
import { evaluateGitHubFeedback } from '../src/github-intake.mjs';
import { normalizePullRequest, pullEventAllowed } from '../src/github-pull-intake.mjs';

const repo = 'owner/project', head = 'a'.repeat(40), other = 'b'.repeat(40);
const config = { repository: repo, allowedActors: ['operator', 'reviewer'], ci: { checkApps: ['trusted-ci'], statusContexts: ['build'], statusActors: ['ci-user'] } };
const settings = mode => ({ mode, rules: [{ id: 'fix', enabled: true, instruction: 'Handle authorized review feedback' }],
  sourceRows: [{ id: 'github', source: 'github', scope: { repository: repo }, actors: ['operator', 'reviewer'], bots: ['reviewer', 'automation[bot]'], admission: { unlistedAddressed: true } }] });
const trigger = (id = 'operator', type = 'User') => ({ id: 'trigger', source: 'github', actor: { source: 'github', id }, human: type === 'User',
  addressed: 'direct', meta: { repository: repo, issueNumber: 1, actorType: type } });
const policy = (mode = 'auto', options = {}) => createRuntimePolicy({ config: settings(mode),
  explicitGate: value => config.allowedActors.includes(value.actor.id) && value.human
    ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'legacy-denied' },
  revalidateExplicit: () => true, ...options });
const ticket = ended => ({ id: 'ticket', ...(ended ? { ended } : {}), mandate: { actor: { source: 'github', id: 'operator' }, strength: 'explicit', basis: { scope: { repository: repo } } } });
const event = (actor = 'operator', type = 'User') => ({ id: 'github:owner/project:pr_comment:1', kind: 'pr_comment', repository: repo, pullNumber: 2, headSha: head,
  pullState: 'open', actor: { login: actor, type, id: '1' }, text: 'Follow up' });
const binding = { repository: repo, number: 2, headSha: head };

test('W26 configured User bots cannot reach explicit gates or human follow-up admission', () => {
  for (const mode of ['off', 'observe', 'auto']) {
    let calls = 0;
    const p = policy(mode, { explicitGate: () => { calls++; return { admissible: true, strength: 'explicit' }; } });
    const normalized = normalizeGitHubActorTrigger(p, trigger('reviewer'));
    assert.equal(normalized.human, false);
    assert.equal(normalized.meta.githubActor.nativeType, 'User');
    assert.equal(normalized.meta.githubActor.configuredBot, true);
    const outcome = p.gate(trigger('reviewer'), { subscriptions: ['ticket'] }, [ticket()]);
    assert.equal(calls, 0);
    assert.equal(outcome.admissible, mode !== 'off');
    if (outcome.admissible) assert.equal(outcome.strength, 'inferred');
    assert.equal(p.revalidate({ ...ticket().mandate, actor: { source: 'github', id: 'reviewer' } }), false);
  }
  assert.equal(policy().gate(trigger('operator')).strength, 'explicit');
  assert.equal(normalizeGitHubActorTrigger(policy(), { ...trigger('operator'), human: false }).human, false);
  assert.equal(normalizeGitHubActorTrigger(policy(), { ...trigger('automation[bot]'), human: true }).human, false);
  assert.equal(normalizeGitHubActorTrigger(policy(), trigger('operator', 'Bot')).human, false);
});

test('W26 context delivery, inferred candidates and human resume remain distinct', () => {
  const p = policy('off');
  const context = evaluateGitHubFeedback(config, trigger('automation[bot]', 'Bot'), { policy: p, ticket: ticket() });
  assert.equal(context.candidateAllowed, false); assert.equal(context.contextAllowed, true); assert.equal(context.canResume, false);
  assert.equal(evaluateGitHubFeedback(config, trigger('reviewer'), { policy: policy(), ticket: ticket({ by: 'worker' }) }).canResume, false);
  assert.equal(evaluateGitHubFeedback(config, trigger(), { policy: p, ticket: ticket({ by: 'worker' }) }).canResume, true);
  assert.equal(evaluateGitHubFeedback(config, trigger(), { policy: p, ticket: ticket({ by: 'human' }) }).canResume, false);
  assert.equal(evaluateGitHubFeedback(config, trigger(), { policy: p, ticket: ticket(), contextOnly: true }).canContinue, false);
  assert.equal(evaluateGitHubFeedback(config, trigger(), { policy: policy('auto', { paused: true }), ticket: ticket() }).canContinue, false);
  assert.equal(evaluateGitHubFeedback(config, trigger(), { policy: policy('auto', { revalidateExplicit: () => false }), ticket: ticket() }).contextAllowed, false);
  assert.equal(evaluateGitHubFeedback(config, trigger(), { policy: p, ticket: ticket(), scopeAllowed: false }).contextAllowed, false);
  assert.equal(evaluateGitHubFeedback({ ...config, issues: [99] }, trigger(), { policy: p, ticket: ticket() }).candidateAllowed, false);
  for (const mode of ['off', 'observe', 'auto']) {
    const value = evaluateGitHubFeedback(config, trigger('outsider'), { policy: policy(mode) });
    assert.equal(value.candidateAllowed, mode !== 'off');
    if (value.candidateAllowed) assert.equal(value.admission.strength, 'inferred');
  }
});

test('W26 PR admission supports policy bots without changing default or CI trust', () => {
  assert.equal(pullEventAllowed(config, binding, event('automation[bot]', 'Bot')), false);
  assert.equal(pullEventAllowed(config, binding, event('operator')), true);
  assert.equal(pullEventAllowed(config, binding, event('automation[bot]', 'Bot'), { policy: policy() }), true);
  assert.equal(pullEventAllowed(config, binding, event('automation[bot]', 'Bot'), { policy: policy('off') }), false);
  assert.equal(pullEventAllowed(config, binding, event('automation[bot]', 'Bot'), { policy: policy('off'), ticket: ticket() }), true);
  const ci = { ...event('automation[bot]', 'Bot'), kind: 'check_run', ci: { app: 'untrusted', name: 'build' } };
  assert.equal(pullEventAllowed(config, binding, ci, { policy: policy(), ticket: ticket() }), false);
  assert.equal(pullEventAllowed(config, binding, { ...ci, ci: { ...ci.ci, app: 'trusted-ci' } }, { policy: policy('off') }), true);
  assert.equal(pullEventAllowed(config, binding, { ...ci, headSha: other, ci: { ...ci.ci, app: 'trusted-ci' } }, { allowHistoricalDiscussion: true, policy: policy() }), false);
});

test('W26 historical PR discussion accepts only policy-authorized humans and never changes target', () => {
  const historical = { ...event(), headSha: other, pullState: 'closed' };
  assert.equal(pullEventAllowed(config, binding, historical, { policy: policy() }), false);
  assert.equal(pullEventAllowed(config, binding, historical, { policy: policy(), allowHistoricalDiscussion: true }), true);
  assert.equal(pullEventAllowed(config, binding, { ...historical, pullState: 'open' }, { policy: policy(), allowHistoricalDiscussion: true }), false);
  assert.equal(pullEventAllowed(config, binding, { ...historical, actor: event('reviewer').actor }, { policy: policy(), allowHistoricalDiscussion: true }), false);
  assert.equal(binding.headSha, head);
});

test('W26 pull normalization retains verified optional base facts and rejects malformed facts', () => {
  const raw = { repository: repo, number: 2, id: 10, headSha: head, headRef: 'feature', headRepository: repo, state: 'closed', merged: true, title: 'Task', baseRef: 'main', baseSha: other };
  const value = normalizePullRequest(raw, repo, 2);
  assert.equal(value.baseRef, 'main'); assert.equal(value.baseSha, other);
  for (const patch of [{ baseRef: '' }, { baseRef: 'main\nnext' }, { baseSha: 'short' }]) assert.throws(() => normalizePullRequest({ ...raw, ...patch }, repo, 2));
});

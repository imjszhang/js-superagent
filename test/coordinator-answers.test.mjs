import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createRuntimePolicy } from '../src/policy.mjs';
import { githubTrigger, normalizeGitHubEvent } from '../src/github-intake.mjs';
import { normalizePullEvent } from '../src/github-pull-intake.mjs';
import { observeGitHubComment } from '../src/github-comment-version.mjs';
import { pullReplyChannel } from '../src/runtime/github-review-delivery.mjs';
import { assertCoordinatorAnswer, answerFingerprint, checkAnswerRevision } from '../src/runtime/coordinator-answers.mjs';

const repository = 'fixture/answers', head = 'a'.repeat(40), at = '2026-11-03T01:00:00.000Z';
const actor = { login: 'alice', id: '10', type: 'User' };
function fixture(t, { pull = false, review = false, versioned = true } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let event, trigger;
  if (pull) {
    event = normalizePullEvent({ id: `github:${repository}:${review ? 'review_comment' : 'pr_comment'}:100`, kind: review ? 'review_comment' : 'pr_comment',
      repository, pullNumber: 7, headSha: head, pullState: 'open', text: 'Explain the retry behavior', actor, createdAt: at,
      ...(versioned ? { updatedAt: at } : {}), ...(review ? { reviewCommentId: 100, reviewRootId: 90 } : {}) });
    trigger = { id: event.id, source: 'github', actor: { source: 'github', id: actor.login }, human: true, addressed: 'direct',
      text: event.text, at, threads: [{ source: 'github', id: event.thread }], channel: pullReplyChannel(event),
      meta: { repository, actorType: 'User', pullEvent: event, ...(event.commentVersion ? { githubComment: event.commentVersion } : {}) } };
  } else {
    event = normalizeGitHubEvent({ id: `github:${repository}:comment:100`, kind: 'comment', repository, issueNumber: 7, issueId: '70', issueState: 'open',
      text: '/js-superagent Explain the retry behavior', actor, createdAt: at, ...(versioned ? { updatedAt: at } : {}) });
    trigger = githubTrigger(event);
  }
  observeGitHubComment(store, event, at); store.triggers.save(trigger);
  const config = { mode: 'observe', rules: [{ id: 'help', enabled: true, instruction: 'Answer questions' }], sourceRows: [
    { id: 'repo', source: 'github', scope: { repository }, actors: ['alice'], bots: [], admission: { listedUnaddressed: true } },
  ] };
  const policy = createRuntimePolicy({ config });
  const run = (value = trigger, options = {}) => assertCoordinatorAnswer({ store, policy, trigger: value, repository, ...options });
  const update = change => { const next = structuredClone(trigger); change(next); store.triggers.save(next); return next; };
  return { store, trigger, event, config, policy, run, update };
}
const refused = (call, reason) => assert.throws(call, error => error.code === 'COORDINATOR_ANSWER_REJECTED' && error.reason === reason);

test('an explicit human Issue question can be answered without a work item or punctuation heuristic', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.trigger.id, f.trigger.id); assert.equal(result.gate.strength, 'explicit');
  assert.equal(result.fingerprint, answerFingerprint(f.trigger)); assert.equal(f.store.tickets.list().length, 0);
});

test('fingerprints ignore key ordering and cover changed text, actor and destinations', t => {
  const f = fixture(t), reordered = Object.fromEntries(Object.entries(f.trigger).reverse());
  reordered.meta = Object.fromEntries(Object.entries(reordered.meta).reverse());
  assert.equal(answerFingerprint(reordered), answerFingerprint(f.trigger));
  for (const change of [v => { v.text += ' edited'; }, v => { v.actor.id = 'bob'; }, v => { v.channel.address.issueNumber = '8'; }]) {
    const value = structuredClone(f.trigger); change(value);
    assert.notEqual(answerFingerprint(value), answerFingerprint(f.trigger)); refused(() => f.run(value), 'trigger-changed');
  }
});

test('current policy revocation, pause and inferred admission cannot authorize an answer', t => {
  const f = fixture(t); refused(() => f.run(f.trigger, { policy: { ...f.policy, paused: true } }), 'paused');
  const config = structuredClone(f.config); config.sourceRows[0].actors = [];
  refused(() => f.run(f.trigger, { policy: createRuntimePolicy({ config }) }), 'not-explicit');
  const unaddressed = f.update(value => { delete value.addressed; });
  assert.equal(f.policy.gate(unaddressed).strength, 'inferred'); refused(() => f.run(unaddressed), 'not-explicit');
});

test('native and configured bots cannot impersonate a human source', t => {
  const f = fixture(t), config = structuredClone(f.config); config.sourceRows[0].bots = ['alice'];
  refused(() => f.run(f.trigger, { policy: createRuntimePolicy({ config }) }), 'not-human');
  for (const change of [v => { v.human = false; }, v => { v.meta.actorType = 'Bot'; }, v => { delete v.meta.actorType; }, v => { delete v.meta.actorId; }]) {
    const value = f.update(change); refused(() => f.run(value), 'not-human');
  }
});

test('source-only context and forged Issue routes are rejected', t => {
  const f = fixture(t);
  refused(() => f.run(f.update(v => { v.meta.contextOnly = true; })), 'context-only');
  for (const change of [v => { v.channel.address.issueNumber = '8'; }, v => { v.channel.thread = `${repository}#8`; },
    v => { v.channel.address.pullNumber = '7'; }, v => { v.channel.address.reviewRootId = '90'; }, v => { v.threads[0].id += ':ticket'; }]) {
    refused(() => f.run(f.update(change)), 'invalid-channel');
  }
  refused(() => f.run(f.update(v => { v.meta.repository = 'other/repo'; })), 'outside-repository');
});

test('PR discussion and review replies remain bound to their original head and review ancestry', t => {
  for (const review of [false, true]) {
    const f = fixture(t, { pull: true, review }); assert.equal(f.run().trigger.channel.address.headSha, head);
    refused(() => f.run(f.update(v => { v.channel.address.headSha = 'b'.repeat(40); })), 'invalid-channel');
    refused(() => f.run(f.update(v => { v.channel.address.pullNumber = '8'; })), 'invalid-channel');
    refused(() => f.run(f.update(v => { v.channel.address.reviewRootId = '91'; })), 'invalid-channel');
    if (review) refused(() => f.run(f.update(v => { v.channel.address.reviewCommentId = '101'; })), 'invalid-channel');
  }
});

test('new PR source records are supported without creating an owning binding', t => {
  const f = fixture(t, { pull: true });
  const value = f.update(v => { v.meta.actorId = actor.id; v.meta.pullRequest = { repository, number: 7, headSha: head }; delete v.meta.pullEvent; });
  assert.equal(f.run(value).trigger.id, value.id); assert.equal(f.store.getMeta(`github:pull:${repository}#7`), undefined);
});

test('superseded comments, body versions and unverified body editors cannot be answered', t => {
  const f = fixture(t), key = `github:comment-version:${f.event.commentVersion.baseId}`;
  const saved = f.store.getMeta(key); f.store.setMeta(key, { ...saved, eventId: 'replacement' });
  refused(() => f.run(), 'source-revision-retired'); f.store.setMeta(key, saved);
  const body = f.update(v => { delete v.meta.githubComment; v.meta.githubBody = { baseId: `github:${repository}:issue:70`, digest: 'body-digest', actorId: actor.id, location: 7, initialAuthorVerified: true }; });
  const bodyKey = `github:body-version:${body.meta.githubBody.baseId}`;
  f.store.setMeta(bodyKey, { ...body.meta.githubBody, eventId: body.id }); assert.ok(f.run(body));
  const edited = structuredClone(body); edited.meta.githubBody.initialAuthorVerified = false; f.store.triggers.save(edited);
  refused(() => f.run(edited), 'body-author-unverified');
  f.store.triggers.save(body); f.store.setMeta(bodyKey, { ...body.meta.githubBody, eventId: 'replacement' });
  refused(() => f.run(body), 'source-revision-retired');
});

test('a legacy comment cannot bypass a later observed revision, while one ticket handback leaves the source answerable', t => {
  const f = fixture(t, { versioned: false }); assert.ok(f.run());
  f.store.setMeta(`github:comment-version:${f.trigger.id}`, { eventId: `${f.trigger.id}:v:new` });
  refused(() => f.run(), 'source-revision-retired'); f.store.deleteMeta(`github:comment-version:${f.trigger.id}`);
  f.store.setMeta(`input:retired:ended-ticket:${f.trigger.id}`, { reason: 'beyond this ticket', at, eventId: f.trigger.id });
  assert.ok(f.run());
  assert.throws(() => checkAnswerRevision(f.store, f.trigger, 'ended-ticket'), error => error.reason === 'source-revision-retired');
});

test('owners, context followers and historical recipients retain their response boundary', t => {
  for (const mode of ['owner', 'context', 'input', 'origin', 'fanout', 'ended']) {
    const f = fixture(t), ticket = { id: 'ticket', origin: { triggerId: mode === 'origin' ? f.trigger.id : 'previous' }, inputs: [], undelivered: [], assignments: [] };
    if (mode === 'input') ticket.inputs.push({ id: 'input', kind: 'trigger', triggerId: f.trigger.id });
    if (mode === 'ended') ticket.ended = { by: 'human', outcome: 'stopped', at };
    f.store.tickets.save(ticket);
    if (['owner', 'context', 'ended'].includes(mode)) f.store.threads.save({ key: `github:${f.trigger.threads[0].id}`, ref: f.trigger.threads[0], subscriptions: [ticket.id], context: mode === 'context' ? [ticket.id] : [], pending: [], correlated: [], meta: {}, createdAt: at });
    if (mode === 'fanout') f.store.triggers.saveDisposition(f.trigger.id, { fanout: [ticket.id], requeued: true, at });
    refused(() => f.run(), 'ticket-owned');
  }
});

test('a missing source or altered stored record rejects stale assessment output', t => {
  const f = fixture(t); refused(() => f.run({ ...f.trigger, id: 'missing' }), 'trigger-missing');
  f.update(v => { v.text = 'Corrected question'; }); refused(() => f.run(), 'trigger-changed');
});

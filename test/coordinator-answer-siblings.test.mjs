import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../dist/core/index.js';
import { createRuntimePolicy } from '../src/policy.mjs';
import { githubTrigger, normalizeGitHubEvent } from '../src/github-intake.mjs';
import { assertCoordinatorAnswer, answerFingerprint, coordinatorAnswerScope } from '../src/runtime/coordinator-answers.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';

const repository = 'fixture/answer-siblings', at = '2026-11-03T01:00:00.000Z';
const event = (id, text, issueNumber = 7) => ({ id: `github:${repository}:comment:${id}`, kind: 'comment', repository,
  issueNumber, issueId: String(issueNumber), issueState: 'open', text: `/js-superagent ${text}`,
  actor: { login: 'alice', id: '10', type: 'User' }, createdAt: at });
const accept = { kind: 'accept', title: 'Implement retries', scope: 'The requested retry change', reason: 'Implementation requested', rules: [] };

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const policy = createRuntimePolicy({ config: { mode: 'auto', rules: [], sourceRows: [
    { id: 'repo', source: 'github', scope: { repository }, actors: ['alice'], bots: [], admission: { listedUnaddressed: true } },
  ] } });
  const engine = new Engine({ repo: store, policy: () => policy, scope: policy, now: () => at,
    assessor: { request() {} }, executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status() {}, withdraw() {} } });
  const question = githubTrigger(normalizeGitHubEvent(event('100', 'Explain retries [QUESTION]')));
  const sibling = githubTrigger(normalizeGitHubEvent(event('101', 'Implement retries [WORK]')));
  const check = queuedAnswer => assertCoordinatorAnswer({ store, policy, trigger: question, repository, queuedAnswer });
  function queue() {
    engine.receive(question); engine.receive(sibling); engine.evaluateDue();
    const candidate = engine.candidate(question.id);
    check();
    const reply = engine.reply({ purpose: 'answer', triggerId: question.id, text: 'Retries handle transient failures.' });
    const record = { trigger: question, fingerprint: answerFingerprint(question), replyId: reply.id,
      evalId: candidate.evalId, policyVersion: policy.version, at,
      queuedScope: coordinatorAnswerScope({ store, candidate, triggerId: question.id }) };
    store.setMeta(`coordinator-answer:${question.id}`, record);
    engine.decideTrigger(question.id, { kind: 'ignore', evalId: candidate.evalId, reason: 'Answered',
      audit: { coordinatorAnswer: { triggerId: question.id, replyId: reply.id } } });
    return record;
  }
  function acceptSibling() {
    engine.evaluateDue();
    return store.tickets.get(engine.decide(sibling.id, { ...accept, evalId: engine.candidate(sibling.id).evalId }).ticketId);
  }
  return { store, policy, engine, question, sibling, queue, check, acceptSibling };
}
const refused = call => assert.throws(call, error => error.reason === 'ticket-owned');

test('queued proof permits only a later sibling subscription, while first-time answers stay refused', t => {
  const f = fixture(t), queued = f.queue(), ticket = f.acceptSibling();
  assert.equal(ticket.inputs.some(input => input.triggerId === f.question.id), false);
  // Same timestamp throughout: the exception uses persisted identity and decisions, never wall-clock ordering.
  assert.equal(ticket.createdAt, queued.at);
  assert.equal(f.check(queued).trigger.id, f.question.id);
  refused(() => f.check());
});

test('legacy or forged queued proof cannot authorize a new reply', t => {
  const f = fixture(t), queued = f.queue(); f.acceptSibling();
  refused(() => f.check({ ...queued, queuedScope: { ...queued.queuedScope, existingTicketIds: ['forged'] } }));
  const legacy = { ...queued }; delete legacy.queuedScope;
  f.store.setMeta(`coordinator-answer:${f.question.id}`, legacy); refused(() => f.check(legacy));
  f.store.setMeta(`coordinator-answer:${f.question.id}`, queued);
  const decision = f.store.decisions.get(f.store.triggers.disposition(f.question.id).decisionId);
  f.store.decisions.save({ ...decision, audit: {} }); refused(() => f.check(queued));
});

for (const change of ['input', 'fanout', 'context', 'origin', 'decision', 'sibling-changed', 'existed-at-queue']) {
  test(`queued sibling proof keeps ${change} ownership or provenance refusals`, t => {
    const f = fixture(t), queued = f.queue(), ticket = f.acceptSibling();
    if (change === 'input') {
      ticket.inputs.push({ id: 'taken-up', kind: 'trigger', triggerId: f.question.id, at }); f.store.tickets.save(ticket);
    } else if (change === 'fanout') f.store.triggers.saveDisposition(f.question.id, { ...f.store.triggers.disposition(f.question.id), fanout: [ticket.id] });
    else if (change === 'context') {
      const thread = f.store.threads.get(`github:${repository}#7`); thread.context = [ticket.id]; f.store.threads.save(thread);
    } else if (change === 'origin') {
      ticket.origin.triggerIds.push(f.question.id); f.store.tickets.save(ticket);
    } else if (change === 'decision') {
      const decision = f.store.decisions.get(ticket.decisionId); decision.triggerIds = [f.question.id]; f.store.decisions.save(decision);
    } else if (change === 'sibling-changed') f.store.triggers.save({ ...f.sibling, text: 'A different implementation request' });
    else {
      queued.queuedScope.existingTicketIds.push(ticket.id); f.store.setMeta(`coordinator-answer:${f.question.id}`, queued);
    }
    refused(() => f.check(queued));
  });
}

test('an older unrelated task bound later cannot use the sibling exception', t => {
  const f = fixture(t), unrelated = githubTrigger(normalizeGitHubEvent(event('90', 'Other implementation', 8)));
  f.engine.receive(unrelated); f.engine.evaluateDue();
  const ticketId = f.engine.decide(unrelated.id, accept).ticketId;
  const queued = f.queue(); f.acceptSibling();
  f.engine.bindThread(ticketId, f.question.threads[0], true);
  refused(() => f.check(queued));
});

for (const mutation of [null, 'missing-route', 'wrong-route-trigger', 'already-reached', 'target-taken-up', 'context']) {
  test(`a sibling newly attached to an older task ${mutation ? `still rejects ${mutation}` : 'preserves the independent queued answer'}`, t => {
    const f = fixture(t), origin = githubTrigger(normalizeGitHubEvent(event('90', 'Other implementation', 8)));
    f.engine.receive(origin); f.engine.evaluateDue();
    const ticketId = f.engine.decide(origin.id, accept).ticketId;
    const queued = f.queue(); f.engine.evaluateDue(); f.engine.attach(ticketId, f.sibling.id);
    if (mutation === 'missing-route' || mutation === 'wrong-route-trigger') {
      const disposition = f.store.triggers.disposition(f.sibling.id), routed = f.store.decisions.get(disposition.decisionId);
      routed.reason = mutation === 'missing-route' ? [] : [{ code: 'routed', triggerId: 'other', values: { ticket: ticketId } }];
      f.store.decisions.save(routed);
    } else if (mutation === 'already-reached') {
      queued.queuedScope.siblings[0].reachedTicketIds.push(ticketId); f.store.setMeta(`coordinator-answer:${f.question.id}`, queued);
    } else if (mutation === 'target-taken-up') f.engine.deliverSubscribed(f.question.id, [ticketId]);
    else if (mutation === 'context') {
      const thread = f.store.threads.get(`github:${repository}#7`); thread.context = [ticketId]; f.store.threads.save(thread);
    }
    if (mutation) refused(() => f.check(queued));
    else { assert.equal(f.check(queued).trigger.id, f.question.id); refused(() => f.check()); }
  });
}

for (const mode of ['accept', 'attach']) test(`a delayed queued answer survives sibling ${mode} and restart, without entering that worker`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'answer-sibling-runtime-'));
  writeFileSync(join(root, 'README.md'), 'Fixture project\n');
  let runtime, allowDelivery = false, posts = 0, existingTicketId;
  const comments = [], user = { id: 20, login: 'helper', type: 'User' }, runs = [];
  const channel = createGitHubChannel({ repository, allowedActors: ['alice'], issues: [1, 7] }, { async request(path, options) {
    if (path === `/repos/${repository}`) return { id: 55, full_name: repository, has_issues: true, permissions: { push: true } };
    if (path === '/user') return user;
    if (/\/issues\/(?:1|7)\/comments(?:\?|$)/.test(path)) {
      if (!allowDelivery) throw new Error('Fixture transport temporarily unavailable');
      if (options.method !== 'POST') return comments;
      const comment = { id: ++posts, body: options.body.body, user, html_url: `https://github.com/${repository}/issues/7#issuecomment-${posts}` };
      comments.push(comment); return comment;
    }
    throw new Error(`Unexpected request ${path}`);
  } });
  channel.poll = async () => ({ version: 1, repository, repositoryVerified: true, events: [],
    objects: [1, 7].map(number => ({ kind: 'issue', number, status: 'ok' })), errors: [], discovery: { complete: true } });
  const open = () => createProjectAgent({ projectRoot: root, workspace: 'copy', github: { repository, allowedActors: ['alice'], issues: [1, 7] }, githubChannel: channel,
    driver: { async run(input) { runs.push(input.ticket.id); return { version: 2, state: 'waiting', summary: 'Waiting for follow-up', attention: null, artifacts: [] }; } },
    assessor: { async assess({ candidate }) {
      const question = candidate.triggers.find(trigger => trigger.text.includes('[QUESTION]'));
      return question ? { kind: 'answer', triggerId: question.id, answer: 'Retries handle transient failures.', reason: 'Question answered', rules: [] }
        : existingTicketId ? { kind: 'attach', ticketId: existingTicketId, triggerId: candidate.triggers[0].id, reason: 'Continue the referenced work', rules: [] } : accept;
    } },
  }).init();
  const state = fn => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return fn(store); } finally { store.close(); } };
  t.after(async () => { await runtime?.stop(); runtime?.close(); rmSync(root, { recursive: true, force: true }); });
  runtime = open();
  runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: runtime.coordinatorStatus().settings.revision });
  if (mode === 'attach') {
    runtime.receiveGitHubEvent(event('90', 'Implement the parser [ROOT]', 1)); await runtime.runNext();
    existingTicketId = runtime.getDomainTicket(runtime.list()[0].id).id;
  }
  const question = event('100', 'Explain retries [QUESTION]'), sibling = event('101', mode === 'attach' ? 'Continue #1 [WORK]' : 'Implement retries [WORK]');
  runtime.receiveGitHubEvent(question); runtime.receiveGitHubEvent(sibling);
  await runtime.runNext();
  const queued = runtime.notifications().find(message => message.kind === 'reply' && !message.ticketId);
  assert.equal(queued.status, 'pending'); assert.equal(posts, 0);
  await runtime.runNext();
  assert.equal(runtime.list().length, 1);
  const ticket = runtime.getDomainTicket(runtime.list()[0].id);
  if (mode === 'accept') assert.deepEqual(ticket.origin.triggerIds, [sibling.id]);
  else assert.equal(ticket.inputs.some(input => input.triggerId === sibling.id), true);
  assert.equal(ticket.inputs.some(input => input.triggerId === question.id), false);
  assert.equal(runtime.notifications().find(message => message.id === queued.id).status, 'pending');
  await runtime.stop(); runtime.close(); runtime = open();
  allowDelivery = true;
  state(store => store.db.prepare('UPDATE effects SET due = 0 WHERE kind = ?').run('coordinator-answer'));
  await runtime.runNext(); await runtime.runNext();
  assert.equal(runtime.notifications().find(message => message.id === queued.id).status, 'sent');
  assert.equal(comments.filter(comment => comment.body.includes('Retries handle transient failures.')).length, 1);
  assert.equal(runs.length, mode === 'accept' ? 1 : 2);
});

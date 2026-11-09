import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { Store } from '../src/store.mjs';

const repository = 'fixture/candidate-routing', issues = [1, 2, 7], user = { id: 20, login: 'helper', type: 'User' };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const answer = trigger => ({ kind: 'answer', triggerId: trigger.id, answer: `Answer for ${trigger.text}`, reason: 'Answer only this original question.', rules: [] });
const unavailable = () => ({ kind: 'unavailable', reason: 'No eligible existing target was found.', rules: [] });
const attach = ticketId => ({ kind: 'attach', ticketId, note: 'This is the same explicitly referenced parser task.', reason: 'Continue the referenced authorized work.', rules: [] });
const accept = () => ({ kind: 'accept', title: 'Parser implementation', scope: 'Implement the requested parser change.', reason: 'The remaining input explicitly requests implementation.', rules: [] });

function fixture(t, { assess } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-routing-runtime-'));
  writeFileSync(join(root, 'parser.txt'), 'original parser fixture');
  const comments = new Map(issues.map(number => [number, []])), runtimes = new Set(), runs = [], assessments = [];
  let sequence = 100, posts = 0, runtime, assessor = assess ?? (() => unavailable());
  const native = createGitHubChannel({ repository, allowedActors: ['alice', 'carl'], issues }, { async request(path, options) {
    if (path === `/repos/${repository}`) return { id: 55, full_name: repository, has_issues: true, permissions: { push: true } };
    if (path === '/user') return user;
    const match = /\/issues\/(\d+)\/comments(?:\?|$)/.exec(path);
    if (match) {
      const number = Number(match[1]), rows = comments.get(number); assert.ok(rows, 'Only configured discussions are used');
      if (options.method !== 'POST') return rows;
      const id = 1000 + ++posts, comment = { id, body: options.body.body, user, html_url: `https://github.com/${repository}/issues/${number}#issuecomment-${id}` };
      rows.push(comment); return comment;
    }
    throw new Error(`Unexpected fixture request ${path}`);
  } });
  const channel = { ...native, async poll() { return { version: 1, repository, repositoryVerified: true, events: [],
    objects: issues.map(number => ({ kind: 'issue', number, status: 'ok' })), errors: [], discovery: { complete: true } }; } };
  const open = () => {
    runtime = createProjectAgent({ projectRoot: root, workspace: 'copy', github: { repository, allowedActors: ['alice', 'carl'], issues, pollIntervalMs: 86400000 }, githubChannel: channel,
      driver: { async run(input) {
        runs.push({ ticketId: input.ticket.id, session: input.session && structuredClone(input.session), projectRoot: input.projectRoot });
        input.checkpoint(input.session ?? { driver: 'fixture', id: `native-${input.ticket.id}` });
        return { version: 2, state: 'waiting', summary: 'The existing task is ready for its next input.', attention: null, artifacts: [] };
      } },
      assessor: { async assess(input) { assessments.push(structuredClone(input.candidate)); return assessor(input, runtime); } },
    }).init();
    runtimes.add(runtime); return runtime;
  };
  open();
  t.after(async () => { for (const item of runtimes) { await item.stop(); item.close(); } rmSync(root, { recursive: true, force: true }); });
  const state = fn => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return fn(store); } finally { store.close(); } };
  const event = (text, { issueNumber = 7, actor = { login: 'alice', id: 10, type: 'User' }, ...extra } = {}) => ({ kind: 'comment',
    id: `github:${repository}:comment:${++sequence}`, repository, issueNumber, issueId: issueNumber, issueState: 'open', title: `Discussion ${issueNumber}`,
    actor, text: `/js-superagent ${text}`, createdAt: new Date(Date.now() + sequence).toISOString(), ...extra });
  return { root, runs, assessments, comments, state, event, get runtime() { return runtime; }, get posts() { return posts; },
    setAssessor(value) { assessor = value; },
    enable() { runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: runtime.coordinatorStatus().settings.revision }); },
    async first() {
      const received = runtime.receiveGitHubEvent(event('Implement the parser fix [ROOT]', { issueNumber: 1 }));
      await runtime.runNext(); assert.ok(received.ticketId); assert.equal(runtime.get(received.ticketId).status, 'waiting'); return runtime.get(received.ticketId);
    },
    answers() { return runtime.notifications().filter(message => message.kind === 'reply' && message.ticketId === undefined); },
    async settle(predicate, turns = 8) { for (let turn = 0; turn < turns && !predicate(); turn++) await runtime.runNext(); assert.ok(predicate(), 'Expected bounded fixture progress'); },
    async reopen() { await runtime.stop(); runtime.close(); runtimes.delete(runtime); return open(); },
  };
}

for (const reference of [`https://github.com/${repository}/issues/1`, '#1', `${repository}#1`]) {
  test(`explicit cross-discussion reference ${reference} reuses the ticket, native session and workspace`, async t => {
    const f = fixture(t), old = await f.first(), domainId = f.runtime.getDomainTicket(old.id).id;
    const session = f.runtime.getSession(old.id), workspace = f.runtime.getWorkspace(old.id), before = f.runs.length;
    f.setAssessor(({ candidate }) => {
      assert.ok(candidate.tickets.some(ticket => ticket.id === domainId), 'The linked task must be offered as a target');
      return attach(domainId);
    }); f.enable();
    const followup = f.event(`Continue the same parser work in ${reference} [FOLLOW]`, { issueNumber: 2 });
    f.runtime.receiveGitHubEvent(followup); await f.settle(() => f.runs.length > before);
    assert.equal(f.runtime.list().length, 1); assert.equal(f.runs.at(-1).ticketId, old.id);
    assert.deepEqual(f.runtime.getSession(old.id), session); assert.deepEqual(f.runs.at(-1).session, session);
    assert.equal(f.runtime.getWorkspace(old.id).path, workspace.path); assert.equal(f.runs.at(-1).projectRoot, workspace.path);
    assert.ok(f.runtime.getDomainTicket(old.id).inputs.some(input => input.triggerId === followup.id));
  });
}

for (const reference of ['https://github.com/another/repo/issues/1', 'another/repo#1', '#999']) {
  test(`unresolvable reference ${reference} does not expose an unrelated existing ticket`, async t => {
    const f = fixture(t), old = await f.first(), domainId = f.runtime.getDomainTicket(old.id).id, before = f.runs.length;
    f.setAssessor(() => unavailable()); f.enable();
    const followup = f.event(`Continue the task in ${reference} [UNKNOWN]`, { issueNumber: 2 });
    f.runtime.receiveGitHubEvent(followup); await f.runtime.runNext();
    assert.equal(f.assessments.length, 1); assert.equal(f.assessments[0].tickets.some(ticket => ticket.id === domainId), false);
    assert.equal(f.runtime.list().length, 1); assert.equal(f.runs.length, before);
    assert.equal(f.runtime.getDomainTicket(old.id).inputs.some(input => input.triggerId === followup.id), false);
  });
}

for (const mutation of ['stopped', 'revoked']) test(`cross-discussion target ${mutation} during assessment cannot receive the stale attach`, { timeout: 10000 }, async t => {
  const f = fixture(t), old = await f.first(), domainId = f.runtime.getDomainTicket(old.id).id, entered = deferred(), release = deferred(), before = f.runs.length;
  t.after(() => release.resolve());
  f.setAssessor(async ({ candidate }) => { entered.resolve(candidate); await release.promise; return attach(domainId); }); f.enable();
  const followup = f.event(`Continue https://github.com/${repository}/issues/1 [RACE]`, { issueNumber: 2, actor: { login: 'carl', id: 12, type: 'User' } });
  f.runtime.receiveGitHubEvent(followup); const work = f.runtime.runNext();
  try {
    const candidate = await entered.promise; assert.ok(candidate.tickets.some(ticket => ticket.id === domainId));
    if (mutation === 'stopped') f.runtime.cancel(old.id);
    else f.runtime.configureCoordinator({ policy: { mode: 'off', sourceRows: [{ id: 'github', source: 'github', scope: { repository }, actors: ['carl'], bots: [] }] } },
      { expectedRevision: f.runtime.coordinatorStatus().settings.revision });
  } finally { release.resolve(); await work; }
  assert.equal(f.runtime.list().length, 1); assert.equal(f.runs.length, before);
  assert.equal(f.runtime.getDomainTicket(old.id).inputs.some(input => input.triggerId === followup.id), false);
});

test('two batched authorized questions are answered individually once, including non-first selection and reopen/replay', async t => {
  const f = fixture(t, { assess: ({ candidate }) => answer(candidate.triggers.at(-1)) }); f.enable();
  const first = f.event('Question [ONE]?'), second = f.event('Question [TWO]?');
  f.runtime.receiveGitHubEvent(first); f.runtime.receiveGitHubEvent(second);
  await f.settle(() => f.answers().filter(message => message.status === 'sent').length === 2);
  assert.equal(f.assessments[0].triggers.length, 2); assert.match(f.answers()[0].text, /\[TWO\]/);
  assert.equal(f.runs.length, 0); assert.equal(f.runtime.list().length, 0); assert.equal(f.posts, 2);
  const answeredIds = f.state(store => store.listMeta('coordinator-answer:').map(row => row.value.trigger.id));
  assert.deepEqual(answeredIds.sort(), [first.id, second.id].sort());
  await f.reopen();
  assert.equal(f.runtime.receiveGitHubEvent(first).status, 'duplicate'); assert.equal(f.runtime.receiveGitHubEvent(second).status, 'duplicate');
  f.runtime.reevaluate(first.id); f.runtime.reevaluate(second.id);
  await f.runtime.runNext(); await f.runtime.runNext();
  assert.equal(f.answers().length, 2); assert.equal(f.posts, 2); assert.equal(f.runs.length, 0);
});

test('answering one item in a mixed batch leaves the implementation request for a separate acceptance', async t => {
  const f = fixture(t, { assess: ({ candidate }) => {
    const question = candidate.triggers.find(trigger => trigger.text.includes('[QUESTION]'));
    return question ? answer(question) : accept();
  } }); f.enable();
  const implementation = f.event('Implement the parser fix [WORK]'), question = f.event('What is the parser purpose [QUESTION]?');
  f.runtime.receiveGitHubEvent(implementation); f.runtime.receiveGitHubEvent(question);
  await f.settle(() => f.runtime.list().length === 1 && f.answers().some(message => message.status === 'sent'));
  assert.equal(f.assessments[0].triggers.length, 2); assert.equal(f.answers().length, 1);
  assert.ok(f.assessments.some(candidate => candidate.triggers.length === 1 && candidate.triggers[0].id === implementation.id));
  const ticket = f.runtime.list()[0], domain = f.runtime.getDomainTicket(ticket.id);
  assert.deepEqual(domain.origin.triggerIds, [implementation.id]);
  assert.equal(domain.inputs.some(input => input.triggerId === question.id), false);
  assert.equal(f.runs.length, 1);
});

test('an unauthorized neighboring question cannot consume or authorize the two admitted answers', async t => {
  const f = fixture(t, { assess: ({ candidate }) => answer(candidate.triggers.at(-1)) }); f.enable();
  const denied = f.event('Question [DENIED]?', { actor: { login: 'stranger', id: 30, type: 'User' } });
  for (const input of [f.event('Question [ONE]?'), denied, f.event('Question [TWO]?')]) f.runtime.receiveGitHubEvent(input);
  await f.settle(() => f.answers().filter(message => message.status === 'sent').length === 2);
  assert.equal(f.assessments.some(candidate => candidate.triggers.some(trigger => trigger.id === denied.id)), false);
  assert.equal(f.answers().some(message => message.text.includes('[DENIED]')), false);
  assert.equal(f.runs.length, 0); assert.equal(f.runtime.list().length, 0);
});

test('an unavailable first item leaves the second batched question available for one answer', async t => {
  const f = fixture(t, { assess: ({ candidate }) => {
    const blocked = candidate.triggers.find(trigger => trigger.text.includes('[UNAVAILABLE]'));
    return blocked ? { ...unavailable(), triggerId: blocked.id } : answer(candidate.triggers[0]);
  } }); f.enable();
  const blocked = f.event('Question [UNAVAILABLE]?'), good = f.event('Question [GOOD]?');
  f.runtime.receiveGitHubEvent(blocked); f.runtime.receiveGitHubEvent(good);
  await f.settle(() => f.answers().some(message => message.status === 'sent' && message.text.includes('[GOOD]')));
  assert.deepEqual(f.assessments.map(candidate => candidate.triggers.map(trigger => trigger.id)), [[blocked.id, good.id], [good.id]]);
  const decisions = f.state(store => store.decisions.byThread(`github:${repository}#7`));
  assert.deepEqual(decisions.find(decision => decision.kind === 'unavailable')?.triggerIds, [blocked.id]);
  assert.deepEqual(decisions.find(decision => decision.audit?.coordinatorAnswer)?.triggerIds, [good.id]);
  assert.equal(f.answers().length, 1); assert.equal(f.posts, 1);
  assert.equal(f.runs.length, 0); assert.equal(f.runtime.list().length, 0);
});

test('a replaced coordinator owner cannot apply its old answer or settle the held candidate', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { assess: async ({ candidate }) => {
    entered.resolve(candidate); await release.promise; return answer(candidate.triggers.at(-1));
  } }); f.enable(); t.after(() => release.resolve());
  const input = f.event('Question [OWNER]?'); f.runtime.receiveGitHubEvent(input);
  const work = f.runtime.runNext(); let replacement;
  try {
    const candidate = await entered.promise;
    const before = f.state(store => ({ evaluation: store.threads.get(candidate.thread.key).evaluating,
      disposition: store.triggers.disposition(input.id), assessment: store.getMeta(`assessment:${candidate.evalId}`) }));
    replacement = f.state(store => {
      const owner = { ...store.getMeta('coordinator:owner'), token: 'replacement-owner-token' };
      store.setMeta('coordinator:owner', owner); return owner;
    });
    release.resolve(); await work;
    f.state(store => {
      assert.deepEqual(store.getMeta('coordinator:owner'), replacement);
      assert.deepEqual(store.threads.get(candidate.thread.key).evaluating, before.evaluation);
      assert.deepEqual(store.triggers.disposition(input.id), before.disposition);
      assert.deepEqual(store.getMeta(`assessment:${candidate.evalId}`), before.assessment);
      assert.deepEqual(store.decisions.byThread(candidate.thread.key), []);
      assert.deepEqual(store.listMeta('coordinator-answer:'), []);
    });
    assert.equal(f.answers().length, 0); assert.equal(f.posts, 0);
    assert.equal(f.runs.length, 0); assert.equal(f.runtime.list().length, 0);
  } finally {
    release.resolve(); await work;
    if (replacement) f.state(store => { if (store.getMeta('coordinator:owner')?.token === replacement.token) store.deleteMeta('coordinator:owner'); });
  }
});

test('a comment superseded during batched assessment does not consume the other question', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); let firstAssessment = true;
  const f = fixture(t, { assess: async ({ candidate }) => {
    if (firstAssessment) { firstAssessment = false; entered.resolve(candidate); await release.promise; return answer(candidate.triggers.find(trigger => trigger.text.includes('[OLD]'))); }
    return answer(candidate.triggers.find(trigger => trigger.text.includes('[GOOD]')) ?? candidate.triggers.at(-1));
  } }); f.enable(); t.after(() => release.resolve());
  const obsolete = f.event('Question [OLD]?'), good = f.event('Question [GOOD]?');
  obsolete.updatedAt = obsolete.createdAt;
  f.runtime.receiveGitHubEvent(obsolete); f.runtime.receiveGitHubEvent(good);
  const work = f.runtime.runNext();
  try {
    const candidate = await entered.promise; assert.equal(candidate.triggers.length, 2);
    const replacement = { ...obsolete, text: '/js-superagent Corrected question [NEW]?', updatedAt: new Date(Date.parse(obsolete.createdAt) + 2000).toISOString() };
    assert.notEqual(f.runtime.receiveGitHubEvent(replacement).reason, 'legacy-comment-baseline');
  } finally { release.resolve(); await work; }
  await f.settle(() => f.answers().some(message => message.status === 'sent' && message.text.includes('[GOOD]')));
  assert.equal(f.answers().some(message => message.text.includes('[OLD]')), false);
  assert.equal(f.answers().filter(message => message.text.includes('[GOOD]')).length, 1);
  assert.equal(f.runs.length, 0); assert.equal(f.runtime.list().length, 0);
});

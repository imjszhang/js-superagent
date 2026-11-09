import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createGitHubChannel } from '../src/channels/github.mjs';
import { Store } from '../src/store.mjs';
import { versionGitHubComment } from '../src/github-comment-version.mjs';
import { normalizePullEvent } from '../src/github-pull-intake.mjs';
import { buildWorkerContext } from '../src/runtime/worker-context.mjs';
import { pullReplyChannel } from '../src/runtime/github-review-delivery.mjs';

const repository = 'fixture/worker-answers', issues = [1, 2, 3], user = { id: 20, login: 'helper', type: 'User' };
const idle = () => ({ version: 2, state: 'waiting', summary: 'The original implementation remains in progress.', attention: null, artifacts: [] });
const answerText = 'ANSWER: the parser preserves the original newline.';

/** Real runtime/outbox/channel, with an in-memory remote transport and isolated project state. */
function fixture(t, { beforeSend, loseAnswerResponse = false, bounded = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-answers-'));
  writeFileSync(join(root, 'parser.txt'), 'original parser');
  const comments = new Map([...issues, 9].map(number => [number, []])), reviewComments = [], runtimes = new Set(), runs = [];
  let sequence = 100, posts = 0, runtime, target, respond = idle;
  const native = createGitHubChannel({ repository, allowedActors: ['alice', 'carl'], issues }, { async request(path, options) {
    if (path === `/repos/${repository}`) return { id: 55, full_name: repository, has_issues: true, permissions: { push: true } };
    if (path === '/user') return user;
    if (path === `/repos/${repository}/pulls/9`) return { id: 9000, number: 9, title: 'Existing parser change', user,
      head: { sha: 'a'.repeat(40), ref: 'fix', repo: { full_name: repository } }, base: { ref: 'main', repo: { full_name: repository } },
      state: 'open', merged: false, html_url: `https://github.com/${repository}/pull/9` };
    if (path.startsWith(`/repos/${repository}/pulls/9/comments?`)) return reviewComments;
    const ancestor = /\/pulls\/comments\/(900|901)$/.exec(path);
    if (ancestor) return { id: Number(ancestor[1]), ...(ancestor[1] === '901' ? { in_reply_to_id: 900 } : {}),
      pull_request_url: `https://api.github.com/repos/${repository}/pulls/9`, html_url: `https://github.com/${repository}/pull/9#discussion_r${ancestor[1]}` };
    if (path === `/repos/${repository}/pulls/9/comments/900/replies` && options.method === 'POST') {
      const id = 1000 + ++posts, comment = { id, body: options.body.body, user, in_reply_to_id: 900,
        html_url: `https://github.com/${repository}/pull/9#discussion_r${id}` };
      reviewComments.push(comment); return comment;
    }
    const match = /\/issues\/(\d+)\/comments(?:\?|$)/.exec(path);
    if (match) {
      const number = Number(match[1]), rows = comments.get(number); assert.ok(rows, 'Only configured discussions are used');
      if (options.method !== 'POST') return rows;
      const id = 1000 + ++posts, comment = { id, body: options.body.body, user, html_url: `https://github.com/${repository}/${number === 9 ? 'pull' : 'issues'}/${number}#issuecomment-${id}` };
      rows.push(comment);
      if (loseAnswerResponse && comment.body.includes(answerText)) throw Error('Remote accepted the answer but its response was lost');
      return comment;
    }
    throw new Error(`Unexpected fixture request ${path}`);
  } });
  const channel = { ...native,
    async poll({ contextPullRequests = [], trackedPullRequests = [] } = {}) { return { version: 1, repository, repositoryVerified: true, events: [],
      objects: [...issues.map(number => ({ kind: 'issue', number, status: 'ok' })), ...[...new Set([...contextPullRequests, ...trackedPullRequests.map(pull => pull.number)])].map(number => ({ kind: 'pull', number, status: 'ok' }))],
      errors: [], discovery: { complete: true } }; },
    async deliver(message, context) {
      return native.deliver(message, { ...context, authorizeSend: async destination => {
        if (message.text.includes(answerText)) await beforeSend?.(runtime, message);
        return context.authorizeSend(destination);
      } });
    },
  };
  const open = () => {
    runtime = createProjectAgent({ projectRoot: root, workspace: 'copy',
      github: { repository, allowedActors: ['alice', 'carl'], issues, pollIntervalMs: 86400000 }, githubChannel: channel,
      driver: { capabilities: { structuredProgress: true, ...(bounded ? { boundedContextVersion: 1, agentTools: true } : {}) }, async run(input) {
        runs.push(input); input.checkpoint(input.session ?? { driver: 'fixture', id: `native-${input.ticket.id}` });
        if (bounded) {
          input.contextDelivered({ records: buildWorkerContext(input).messages.filter(card => !card.truncated).map(({ resource, id, version }) => ({ resource, id, version })) });
          // Cross-discussion attachments are scoped trigger records, not necessarily initial message cards.
          for (const [index, record] of input.agentTools.contextResources().filter(row => row.resource === 'triggers' && Buffer.byteLength(JSON.stringify(row.value)) < 2048).entries())
            input.agentTools.call({ sessionId: `native-${input.ticket.id}`, turnId: 'turn', callId: `read-source-${index}`, name: 'js_superagent_read',
              arguments: { resource: record.resource, id: record.id, limit: 8192 } });
        }
        return respond(input, runtime);
      } },
      assessor: { async assess() { return { kind: 'attach', ticketId: target,
        note: 'Answer this explicitly linked question using the existing work.', reason: 'The question explicitly references the original task.', rules: [] }; } },
    }).init();
    runtimes.add(runtime); return runtime;
  };
  open();
  t.after(async () => { for (const item of runtimes) { await item.stop(); item.close(); } rmSync(root, { recursive: true, force: true }); });
  const state = fn => { const store = new Store(join(stateDir(root), 'state.sqlite')); try { return fn(store); } finally { store.close(); } };
  const event = (text, { issueNumber = 2, actor = { login: 'alice', id: 10, type: 'User' }, ...extra } = {}) => {
    const value = { kind: 'comment', id: `github:${repository}:comment:${++sequence}`, repository,
      issueNumber, issueId: issueNumber, issueState: 'open', title: `Discussion ${issueNumber}`,
      actor, text: `/js-superagent ${text}`, createdAt: new Date(Date.now() + sequence).toISOString(), ...extra };
    return { ...value, id: versionGitHubComment(value).id };
  };
  return { root, runs, comments, reviewComments, state, event, get runtime() { return runtime; }, get posts() { return posts; },
    respond(value) { respond = value; },
    answers() { return runtime.notifications().filter(message => message.kind === 'reply' && message.text.includes(answerText)); },
    due() { state(store => store.db.prepare("UPDATE effects SET due=0 WHERE kind IN ('reply','coordinator-answer','worker-answer')").run()); },
    async first(issueNumber = 1) {
      const received = runtime.receiveGitHubEvent(event('Implement the parser fix [ROOT]', { issueNumber }));
      await runtime.runNext(); assert.ok(received.ticketId); assert.equal(runtime.get(received.ticketId).status, 'waiting');
      return runtime.get(received.ticketId);
    },
    attachTo(ticket) {
      target = runtime.getDomainTicket(ticket.id).id;
      runtime.configureCoordinator({ assessor: { driver: 'fixture-assessor' } }, { expectedRevision: runtime.coordinatorStatus().settings.revision });
    },
    async follow(ticket, supplied) {
      this.attachTo(ticket); const question = supplied ?? event('For #1, does the parser preserve newlines [QUESTION]?');
      const before = runs.length; question.source === 'github' ? runtime.receive(question) : runtime.receiveGitHubEvent(question);
      for (let count = 0; count < 8 && runs.length === before; count++) await runtime.runNext();
      assert.ok(runs.length > before, `The already assigned Worker received the question: ${JSON.stringify(state(store => store.listMeta('assessment:')))}`); return question;
    },
    async reopen() { await runtime.stop(); runtime.close(); runtimes.delete(runtime); return open(); },
  };
}

for (const reportState of ['waiting', 'ready']) test(`an existing Worker ${reportState} answer returns to the exact original question discussion`, async t => {
  const f = fixture(t), original = await f.first(), session = f.runtime.getSession(original.id), question = f.event('For #1, does the parser preserve newlines [QUESTION]?');
  f.respond(() => ({ ...idle(), state: reportState, summary: answerText, answers: question.id }));
  await f.follow(original, question);
  const replies = f.answers().filter(message => Number(message.channel.address.issueNumber) === 2);
  assert.equal(replies.length, 1); assert.equal(replies[0].status, 'sent'); assert.equal(replies[0].text, answerText);
  assert.equal(f.runtime.list().length, 1); assert.deepEqual(f.runtime.getSession(original.id), session);
  assert.equal(f.runtime.get(original.id).status, reportState === 'waiting' ? 'waiting' : 'completed');
  assert.equal(f.runtime.receiveGitHubEvent(question).status, 'duplicate');
  await f.runtime.flushNotifications(); assert.equal(f.comments.get(2).filter(comment => comment.body.includes(answerText)).length, 1);
});

test('the actually assigned Issue origin is an answerable source even though it is not a follow-up input', async t => {
  const f = fixture(t, { bounded: true });
  f.respond(input => ({ ...idle(), summary: answerText, answers: input.domainTicket.origin.triggerId }));
  const original = await f.first();
  assert.equal(f.runtime.getDomainTicket(original.id).inputs.length, 0);
  assert.equal(f.answers().length, 1); assert.equal(f.answers()[0].channel.address.issueNumber, '1');
  assert.equal(f.answers()[0].status, 'sent'); assert.equal(f.runtime.get(original.id).status, 'waiting');
});

test('the local operator origin uses the same answer report without selecting an external destination', async t => {
  const root = mkdtempSync(join(tmpdir(), 'worker-local-answer-'));
  const runtime = createProjectAgent({ projectRoot: root, driver: { async run(input) {
    input.checkpoint({ driver: 'fixture', id: 'local-answer-session' });
    return { ...idle(), summary: answerText, answers: input.domainTicket.origin.triggerId };
  } } }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const original = runtime.submit({ text: 'Explain whether the parser preserves a newline.' }); await runtime.runNext();
  const replies = runtime.notifications().filter(message => message.kind === 'reply');
  assert.equal(replies.length, 1); assert.equal(replies[0].status, 'sent'); assert.equal(replies[0].channel.source, 'local');
  assert.equal(replies[0].text, answerText); assert.equal(runtime.get(original.id).status, 'waiting');
});

test('progress may answer a question once without finishing the task or replacing its first queued answer', async t => {
  const f = fixture(t), original = await f.first(), question = f.event('For #1, does the parser preserve newlines [QUESTION]?');
  f.respond(input => {
    input.progress({ ...idle(), state: 'progress', summary: answerText, answers: question.id });
    input.progress({ ...idle(), state: 'progress', summary: `${answerText} A later restatement.`, answers: question.id });
    return idle();
  });
  await f.follow(original, question);
  assert.equal(f.runtime.get(original.id).status, 'waiting'); assert.equal(f.answers().length, 1);
  assert.equal(f.answers()[0].text, answerText); assert.equal(f.answers()[0].status, 'sent');
  assert.equal(f.runtime.getDomainTicket(original.id).answers?.includes(question.id) ?? false, false);
  assert.equal(f.comments.get(2).length, 1);
});

test('a later turn can answer an earlier consumed question without redirecting to the latest input', async t => {
  const f = fixture(t), original = await f.first(), question = await f.follow(original);
  assert.equal(f.answers().length, 0);
  f.respond(() => ({ ...idle(), summary: answerText, answers: question.id }));
  f.runtime.receiveGitHubEvent(f.event('Use the supplied example to finish answering the earlier question', { issueNumber: 1 }));
  await f.runtime.runNext();
  assert.equal(f.answers().length, 1); assert.equal(f.answers()[0].channel.address.issueNumber, '2');
  assert.equal(f.answers()[0].status, 'sent'); assert.equal(f.runtime.get(original.id).status, 'waiting');
});

test('an unknown remote answer outcome reconciles after restart without a second post, even after authorization is revoked', async t => {
  const f = fixture(t, { loseAnswerResponse: true }), original = await f.first(), question = f.event('For #1, does the parser preserve newlines [QUESTION]?');
  f.respond(() => ({ ...idle(), summary: answerText, answers: question.id })); await f.follow(original, question);
  assert.equal(f.answers().length, 1); assert.equal(f.answers()[0].status, 'pending'); assert.equal(f.comments.get(2).length, 1);
  await f.reopen();
  f.runtime.configureCoordinator({ policy: { mode: 'off', sourceRows: [{ id: 'github', source: 'github', scope: { repository }, actors: ['carl'], bots: ['alice'] }] } },
    { expectedRevision: f.runtime.coordinatorStatus().settings.revision });
  f.due(); await f.runtime.flushNotifications();
  assert.equal(f.answers()[0].status, 'sent'); assert.equal(f.comments.get(2).length, 1);
  assert.equal(f.runtime.receiveGitHubEvent(question).status, 'duplicate');
});

for (const invalidation of ['revocation', 'source-revocation', 'revision', 'cancellation', 'handback']) test(`an unsent Worker answer is withdrawn after source ${invalidation}`, async t => {
  let f, original, question;
  f = fixture(t, { beforeSend(runtime) {
    if (invalidation === 'revocation') runtime.configureCoordinator({ policy: { mode: 'off', sourceRows: [{ id: 'github', source: 'github', scope: { repository }, actors: ['carl'], bots: ['alice'] }] } },
      { expectedRevision: runtime.coordinatorStatus().settings.revision });
    if (invalidation === 'source-revocation') runtime.configureCoordinator({ policy: { mode: 'off', sourceRows: [{ id: 'github', source: 'github', scope: { repository }, actors: ['alice'], bots: ['carl'] }] } },
      { expectedRevision: runtime.coordinatorStatus().settings.revision });
    if (invalidation === 'cancellation') runtime.cancel(original.id);
    if (invalidation === 'handback') runtime.handback(original.id, question.id, 'This question was returned to coordination');
    if (invalidation === 'revision') f.state(store => {
      const trigger = store.triggers.get(question.id), version = trigger.meta.githubComment;
      assert.ok(version); store.setMeta(`github:comment-version:${version.baseId}`, { ...version, eventId: 'newer-revision' });
    });
  } });
  original = await f.first(); question = f.event('For #1, does the parser preserve newlines [QUESTION]?', { updatedAt: new Date().toISOString(),
    ...(invalidation === 'source-revocation' ? { actor: { login: 'carl', id: 12, type: 'User' } } : {}) });
  f.respond(() => ({ ...idle(), summary: answerText, answers: question.id })); await f.follow(original, question);
  assert.equal(f.comments.get(2).length, 0); assert.equal(f.answers().length, 1); assert.equal(f.answers()[0].status, 'dropped');
});

test('an input belonging to another ticket cannot be used as an answer destination', async t => {
  const f = fixture(t), original = await f.first(), other = await f.first(3);
  const otherTrigger = f.runtime.getDomainTicket(other.id).origin.triggerId;
  f.respond(() => ({ ...idle(), summary: answerText, answers: otherTrigger }));
  await f.follow(original);
  assert.equal(f.answers().length, 0); assert.equal(f.comments.get(3).some(comment => comment.body.includes(answerText)), false);
});

test('a context-only subscription does not grant permission to answer a watched discussion', async t => {
  const f = fixture(t), original = await f.first();
  f.runtime.followForContext(original.id, { source: 'github', id: `${repository}#2` });
  const question = f.event('Could someone explain the newline behavior [CONTEXT]?');
  const received = f.runtime.receiveGitHubEvent(question);
  assert.ok(['received', 'ignored'].includes(received.status));
  const ownerQuestion = f.event('Continue implementing the parser [OWNER]', { issueNumber: 1 });
  f.respond(() => ({ ...idle(), summary: answerText, answers: question.id }));
  f.runtime.receiveGitHubEvent(ownerQuestion); await f.runtime.runNext();
  assert.equal(f.answers().length, 0); assert.equal(f.comments.get(2).some(comment => comment.body.includes(answerText)), false);
});

for (const truncated of [false, true]) test(`a bounded-context Worker may answer only a fully supplied question (${truncated ? 'truncated' : 'complete'})`, async t => {
  const f = fixture(t, { bounded: true }), original = await f.first();
  const question = f.event(`For #1, does the parser preserve newlines [QUESTION]?${truncated ? ' extra context'.repeat(400) : ''}`);
  let refused = false;
  f.respond(input => {
    try { input.progress({ ...idle(), state: 'progress', summary: answerText, answers: question.id }); }
    catch (error) { assert.match(error.message, /input|read|context/i); refused = true; }
    return idle();
  });
  await f.follow(original, question);
  assert.equal(refused, truncated, JSON.stringify(buildWorkerContext(f.runs.at(-1)))); assert.equal(f.answers().length, truncated ? 0 : 1);
  assert.equal(f.comments.get(2).length, truncated ? 0 : 1);
});

for (const inline of [false, true]) test(`a bound Worker answer preserves the original PR ${inline ? 'review thread' : 'conversation'} through its isolated input thread`, async t => {
  const f = fixture(t), original = await f.first(), head = 'a'.repeat(40);
  const pull = { repository, number: 9, id: '9000', headSha: head, headRef: 'fix', headRepository: repository,
    state: 'open', merged: false, title: 'Existing parser change', url: `https://github.com/${repository}/pull/9` };
  const event = normalizePullEvent({ id: `github:${repository}:${inline ? 'review_comment' : 'pr_comment'}:901`,
    repository, pullNumber: 9, kind: inline ? 'review_comment' : 'pr_comment', headSha: head, pullState: 'open', pullRequest: pull,
    actor: { login: 'alice', id: 10, type: 'User' }, createdAt: new Date().toISOString(), text: 'For #1, does the parser preserve newlines [QUESTION]?',
    ...(inline ? { reviewCommentId: 901, reviewRootId: 900, inReplyToId: 900, commitId: head, path: 'parser.txt', line: 1 } : {}) });
  await f.runtime.linkGitHubPullRequest(original.id, { number: 9 });
  f.respond(() => ({ ...idle(), summary: answerText, answers: event.id }));
  f.runtime.receiveGitHubEvent(event); await f.runtime.syncGitHub({ flush: false }); await f.runtime.runNext();
  await f.runtime.syncGitHub({ flush: false }); f.due(); await f.runtime.flushNotifications();
  assert.equal(f.runtime.githubStatus().trackedPullRequests.length, 1); assert.equal(f.runtime.list().length, 1);
  assert.equal(f.answers().length, 1); assert.equal(f.answers()[0].status, 'sent');
  assert.deepEqual(f.answers()[0].channel, pullReplyChannel(event)); assert.equal(f.runtime.get(original.id).status, 'waiting');
  assert.deepEqual(f.state(store => store.triggers.get(event.id).threads), [{ source: 'github', id: `${repository}#pr:9:${f.runtime.getDomainTicket(original.id).id}` }]);
  assert.equal(f.reviewComments.length, inline ? 1 : 0); assert.equal(f.comments.get(9).length, inline ? 0 : 1);
  assert.equal(f.runtime.receiveGitHubEvent(event).status, 'duplicate'); await f.runtime.flushNotifications();
  assert.equal(f.reviewComments.length + f.comments.get(9).length, 1);
});

test('unlinking a PR prevents a later Issue turn from queuing an answer to its previously read question', async t => {
  const f = fixture(t), original = await f.first(), head = 'a'.repeat(40);
  const pull = { repository, number: 9, id: '9000', headSha: head, headRef: 'fix', headRepository: repository,
    state: 'open', merged: false, title: 'Existing parser change', url: `https://github.com/${repository}/pull/9` };
  const question = normalizePullEvent({ id: `github:${repository}:pr_comment:901`, repository, pullNumber: 9,
    kind: 'pr_comment', headSha: head, pullState: 'open', pullRequest: pull, actor: { login: 'alice', id: 10, type: 'User' },
    createdAt: new Date().toISOString(), text: 'Does the parser preserve the newline [PREVIOUSLY_READ]?' });
  await f.runtime.linkGitHubPullRequest(original.id, { number: 9 });
  f.runtime.receiveGitHubEvent(question); await f.runtime.syncGitHub({ flush: false }); await f.runtime.runNext();
  const delivered = f.runtime.getDomainTicket(original.id).inputs.find(input => input.triggerId === question.id);
  assert.ok(delivered?.readAt); assert.ok(delivered.deliveredTo); assert.equal(f.answers().length, 0);
  assert.equal(f.runtime.unlinkGitHubPullRequest(9), true);
  assert.equal(f.runtime.githubStatus().trackedPullRequests.length, 0);
  // Unlink intentionally does not rewrite the fact that the old input was already read.
  assert.ok(f.runtime.getDomainTicket(original.id).inputs.find(input => input.triggerId === question.id)?.readAt);
  let refusal;
  f.respond(input => {
    try { input.progress({ ...idle(), state: 'progress', summary: answerText, answers: question.id }); }
    catch (error) { refusal = error.reason; }
    return idle();
  });
  const before = f.runs.length;
  f.runtime.receiveGitHubEvent(f.event('Continue the parser discussion here [NEW_ISSUE_INPUT]', { issueNumber: 1 }));
  await f.runtime.runNext(); await f.runtime.flushNotifications();
  assert.equal(f.runs.length, before + 1); assert.equal(refusal, 'pull-request-association-removed');
  assert.equal(f.answers().length, 0); assert.equal(f.comments.get(9).some(comment => comment.body.includes(answerText)), false);
  assert.equal(f.runtime.get(original.id).status, 'waiting');
});

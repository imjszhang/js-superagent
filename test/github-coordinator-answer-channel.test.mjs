import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubChannel } from '../src/channels/github.mjs';

const repository = 'owner/repo', prefix = `/repos/${repository}`, head = 'a'.repeat(40);
const user = { id: 42, login: 'helper', type: 'User' };
const options = { repository, allowedActors: ['owner'], issues: [1] };
const message = (pull = true, inline = false) => ({ id: 'answer-1', kind: 'reply', text: 'The check tests the parser contract.',
  channel: { source: 'github', thread: `${repository}#${pull ? 'pr:7' : '1'}`,
    address: { repository, ...(pull ? { pullNumber: '7', headSha: head } : { issueNumber: '1' }),
      ...(inline ? { reviewRootId: '31', reviewCommentId: '32' } : {}) } } });
const context = (value, authorizeSend = async () => {}) => ({ projectId: 'project-1', authorizeSend,
  coordinatorAnswer: { triggerId: `github:${repository}:${value.channel.address.pullNumber ? 'pr_comment' : 'comment'}:11`, channel: structuredClone(value.channel) } });
function fixture({ lostResponse = false, author = user } = {}) {
  const calls = [], comments = [], inlineComments = []; let posts = 0;
  const comment = (id, text, inline, pull) => ({ id, user: author, body: text,
    html_url: `https://github.com/${repository}/${pull ? 'pull/7' : 'issues/1'}#${inline ? 'discussion_r' : 'issuecomment-'}${id}`,
    ...(inline ? { in_reply_to_id: 31 } : {}) });
  const channel = createGitHubChannel(options, { async request(endpoint, init) {
    calls.push({ endpoint, method: init.method });
    if (endpoint === '/user') return user;
    if (/\/issues\/(1|7)\/comments\?/.test(endpoint)) return comments;
    if (endpoint.includes('/pulls/7/comments?')) return inlineComments;
    if (/\/pulls\/comments\/(31|32)$/.test(endpoint)) {
      const id = Number(endpoint.split('/').at(-1));
      return { id, pull_request_url: `https://api.github.com${prefix}/pulls/7`,
        html_url: `https://github.com/${repository}/pull/7#discussion_r${id}`, ...(id === 32 ? { in_reply_to_id: 31 } : {}) };
    }
    if (init.method === 'POST') {
      posts++;
      const inline = endpoint.endsWith('/replies'), pull = endpoint.includes('/7/');
      const posted = comment(70 + posts, init.body.body, inline, pull);
      (inline ? inlineComments : comments).push(posted);
      if (lostResponse) throw new Error('response lost after acceptance');
      return posted;
    }
    throw new Error(`Unexpected request ${endpoint}`);
  } });
  return { channel, calls, comments, inlineComments, get posts() { return posts; } };
}

test('source-bound coordinator answers can reply to a PR without a ticket/head ownership binding', async () => {
  const f = fixture(), value = message(), destinations = [];
  const receipt = await f.channel.deliver(value, context(value, destination => { destinations.push(destination); }));
  assert.deepEqual(receipt, { id: '71', url: `https://github.com/${repository}/pull/7#issuecomment-71` });
  assert.deepEqual(destinations, [{ kind: 'conversation' }]);
  assert.equal(f.posts, 1); assert.doesNotMatch(f.comments[0].body, /Ticket:/);
  assert.match(f.comments[0].body, new RegExp(head));
});

test('coordinator answer proof never widens delivery kind, ticket, address, scope or SHA', async () => {
  const f = fixture(), value = message(), valid = context(value);
  await assert.rejects(f.channel.deliver(value, { projectId: valid.projectId, authorizeSend: valid.authorizeSend }), /authorized ticket\/head/);
  await assert.rejects(f.channel.deliver({ ...value, coordinatorAnswer: valid.coordinatorAnswer }, { projectId: valid.projectId, authorizeSend: valid.authorizeSend }), /authorized ticket\/head/);
  for (const [changed, settings] of [
    [{ ...value, ticketId: 'ticket-1' }, valid],
    [{ ...value, kind: 'notice' }, valid],
    [value, { ...valid, authorizeSend: undefined }],
    [value, { ...valid, coordinatorAnswer: { ...valid.coordinatorAnswer, triggerId: '' } }],
    [value, { ...valid, coordinatorAnswer: { ...valid.coordinatorAnswer, channel: { ...value.channel, thread: `${repository}#pr:8` } } }],
    [value, { ...valid, coordinatorAnswer: { ...valid.coordinatorAnswer, channel: { ...value.channel, address: { ...value.channel.address, headSha: 'b'.repeat(40) } } } }],
  ]) await assert.rejects(f.channel.deliver(changed, settings), /matching source proof/);
  for (const channel of [
    { ...value.channel, source: 'local' },
    { ...value.channel, address: { ...value.channel.address, repository: 'other/repo' } },
    { ...value.channel, address: { ...value.channel.address, headSha: 'main' } },
  ]) { const changed = { ...value, channel }; await assert.rejects(f.channel.deliver(changed, context(changed)), /configured channel|40-character/); }
  assert.equal(f.calls.length, 0);
});

test('Issue coordinator answers validate their source proof and retain the Issue allowlist', async () => {
  const f = fixture(), value = message(false), valid = context(value);
  await assert.rejects(f.channel.deliver(value, { ...valid, coordinatorAnswer: { ...valid.coordinatorAnswer, channel: message().channel } }), /matching source proof/);
  const outside = { ...value, channel: { ...value.channel, thread: `${repository}#2`, address: { repository, issueNumber: '2' } } };
  await assert.rejects(f.channel.deliver(outside, context(outside)), /configured channel/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.channel.deliver(value, valid), { id: '71', url: `https://github.com/${repository}/issues/1#issuecomment-71` });
});

for (const inline of [false, true]) test(`unknown ${inline ? 'inline' : 'conversation'} answer is reconciled before revoked send authorization without reposting`, async () => {
  const f = fixture({ lostResponse: true }), value = message(true, inline); let authorized = 0;
  await assert.rejects(f.channel.deliver(value, context(value, () => { authorized++; })), /response lost/);
  const receipt = await f.channel.deliver(value, context(value, () => { authorized++; throw new Error('authority revoked'); }));
  assert.equal(receipt.id, '71'); assert.equal(f.posts, 1); assert.equal(authorized, 1);
  if (inline) {
    assert.deepEqual(receipt.destination, { kind: 'review-thread', reviewRootId: '31' });
    assert.equal(f.calls.some(call => call.endpoint === `${prefix}/pulls/7/comments/31/replies` && call.method === 'POST'), true);
  }
});

test('revoked answer authorization refuses a new write and a foreign marker cannot satisfy reconciliation', async () => {
  const f = fixture(), value = message();
  f.comments.push({ id: 60, user: { id: 99, login: 'outsider', type: 'User' }, body: '<!-- js-superagent:project-1:answer-1 -->',
    html_url: `https://github.com/${repository}/pull/7#issuecomment-60` });
  await assert.rejects(f.channel.deliver(value, context(value, () => { throw new Error('authority revoked'); })), /authority revoked/);
  assert.equal(f.posts, 0);
});

test('coordinator answers retain the remote delivery author identity check', async () => {
  const f = fixture({ author: { id: 99, login: 'outsider', type: 'User' } }), value = message();
  await assert.rejects(f.channel.deliver(value, context(value)), /unexpected author/);
});

import { createFindingReplyTransport } from './github-review-finding.mjs';
const SHA = /^[a-f0-9]{40}$/;
const NODE = /^[A-Za-z0-9_=-]{1,200}$/;
export const REVIEW_QUERIES = Object.freeze({
  findThread: 'query($id:ID!,$after:String){node(id:$id){... on PullRequest{id number headRefOid repository{nameWithOwner} reviewThreads(first:100,after:$after){nodes{id isResolved comments(first:100){nodes{databaseId} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}',
  thread: 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved pullRequest{number headRefOid repository{nameWithOwner}} comments(first:100){nodes{databaseId} pageInfo{hasNextPage}}}}}',
  ready: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
  resolve: 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}',
});
const integer = value => { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid review PR identity'); return value; };
function pullOf(raw, repository, number) {
  if (raw?.number !== number || raw.base?.repo?.full_name?.toLowerCase() !== repository || raw.head?.repo?.full_name?.toLowerCase() !== repository ||
      !SHA.test(raw.head?.sha ?? '') || !NODE.test(raw.node_id ?? '') || !['open','closed'].includes(raw.state) || typeof raw.draft !== 'boolean') throw new Error('Review target is not an accessible same-repository PR');
  return { repository, number, id: raw.node_id, headSha: raw.head.sha, state: raw.state, merged: !!raw.merged_at, isDraft: raw.draft,
    author: raw.user?.login?.toLowerCase() ?? null };
}
export function graphData(result) {
  if (result?.errors?.length || !result?.data) throw new Error('GitHub review GraphQL operation failed');
  return result.data;
}
/** Fixed operations only. App transport calls this with its private authenticated
 * HTTP callback; no arbitrary GraphQL query or cross-repository node is accepted. */
export async function scopedReviewGraphql({ repository, request, operation, number, headSha, threadId, commentId, signal, beforeWrite, allowWrite = false }) {
  integer(number);
  const prefix = `/repos/${repository}`;
  const pull = pullOf(await request(`${prefix}/pulls/${number}`, { method: 'GET', signal }), repository, number);
  if (headSha !== undefined && (pull.headSha !== headSha || pull.state !== 'open' || pull.merged)) throw new Error('PR head changed before review mutation');
  const graphql = (query, id) => request('/graphql', { method: 'POST', body: { query, variables: { id } }, signal }).then(graphData);
  if (operation === 'findThread') {
    integer(commentId); let after = null, incomplete = false;
    for (let page = 0; page < 20; page++) {
      const data = graphData(await request('/graphql', { method: 'POST', body: { query: REVIEW_QUERIES.findThread, variables: { id: pull.id, after } }, signal }));
      const node = data.node, threads = node?.reviewThreads;
      if (node?.id !== pull.id || node.number !== number || node.headRefOid !== pull.headSha || node.repository?.nameWithOwner?.toLowerCase() !== repository ||
          !Array.isArray(threads?.nodes) || typeof threads.pageInfo?.hasNextPage !== 'boolean') throw new Error('PR review thread listing is incomplete or changed');
      for (const thread of threads.nodes) {
        if (!NODE.test(thread.id ?? '') || typeof thread.isResolved !== 'boolean' || !Array.isArray(thread.comments?.nodes) || typeof thread.comments.pageInfo?.hasNextPage !== 'boolean') throw new Error('Invalid review thread listing');
        const commentIds = thread.comments.nodes.map(node => integer(node.databaseId));
        if (commentIds.includes(commentId)) return { id: thread.id, isResolved: thread.isResolved, commentIds };
        incomplete ||= thread.comments.pageInfo.hasNextPage;
      }
      if (!threads.pageInfo.hasNextPage) throw new Error(incomplete ? 'Original comment is outside the bounded thread snapshot' : 'Original review comment has no accessible thread');
      if (typeof threads.pageInfo.endCursor !== 'string' || !threads.pageInfo.endCursor || threads.pageInfo.endCursor === after) throw new Error('Invalid review thread cursor');
      after = threads.pageInfo.endCursor;
    }
    throw new Error('Review thread mapping exceeds reconciliation bound');
  }
  if (operation === 'ready') {
    if (!allowWrite || !SHA.test(headSha ?? '')) throw new Error('GitHub App PR review writes are not enabled');
    await beforeWrite?.(); signal?.throwIfAborted();
    return graphql(REVIEW_QUERIES.ready, pull.id);
  }
  if (!['thread','resolve'].includes(operation) || !NODE.test(threadId ?? '')) throw new Error('Unsupported review operation');
  const data = await graphql(REVIEW_QUERIES.thread, threadId), thread = data.node;
  if (thread?.id !== threadId || thread.pullRequest?.number !== number || thread.pullRequest?.repository?.nameWithOwner?.toLowerCase() !== repository ||
      thread.pullRequest.headRefOid !== pull.headSha || typeof thread.isResolved !== 'boolean' || thread.comments?.pageInfo?.hasNextPage !== false || !Array.isArray(thread.comments?.nodes)) throw new Error('Review thread identity or comment scope is incomplete');
  if (operation === 'thread') return { id: thread.id, isResolved: thread.isResolved, commentIds: thread.comments.nodes.map(node => integer(node.databaseId)) };
  if (!allowWrite || !SHA.test(headSha ?? '')) throw new Error('GitHub App PR review writes are not enabled');
  await beforeWrite?.(); signal?.throwIfAborted();
  return graphql(REVIEW_QUERIES.resolve, thread.id);
}

export function createGitHubReviewTransport({ repository, request, graphql, allowWrite = true }) {
  const prefix = `/repos/${repository}`, findings=createFindingReplyTransport({repository,request,allowWrite});
  const graph = (operation, args) => graphql ? graphql(operation, args) : scopedReviewGraphql({ repository, request, operation, ...args, allowWrite: true });
  async function reviews(number, signal) {
    const values = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await request(`${prefix}/pulls/${number}/reviews?per_page=100&page=${page}`, { method: 'GET', signal });
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Invalid PR review list');
      for (const review of batch) {
        if (typeof review.user?.login !== 'string' || !SHA.test(review.commit_id ?? '') || !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(review.state)) throw new Error('Invalid submitted review');
        values.push({ id: integer(review.id), login: review.user.login.toLowerCase(), state: review.state, commitSha: review.commit_id });
      }
      if (batch.length < 100) return values;
    }
    throw new Error('Review history exceeds reconciliation bound');
  }
  return {
    findingReplySnapshot:findings.findingReplySnapshot,
    async reviewRecipientIdentity(login,{signal}={}) {
      if(typeof login!=='string'||!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(login))throw new Error('Invalid reviewer login');
      const raw=typeof request.reviewerIdentity==='function'?await request.reviewerIdentity(login,{signal}):await request(`/users/${encodeURIComponent(login)}`,{method:'GET',signal});
      if(raw?.login?.toLowerCase()!==login.toLowerCase()||!Number.isSafeInteger(raw.id)||raw.id<1||!['User','Bot'].includes(raw.type))throw new Error('Reviewer identity could not be verified');
      return {id:String(raw.id),login:raw.login.toLowerCase(),type:raw.type};
    },
    async reviewSnapshot(number, { threadId, commentId, signal } = {}) {
      integer(number);
      const pull = pullOf(await request(`${prefix}/pulls/${number}`, { method: 'GET', signal }), repository, number);
      const recipients = await request(`${prefix}/pulls/${number}/requested_reviewers?per_page=100`, { method: 'GET', signal });
      if (!Array.isArray(recipients?.users) || !Array.isArray(recipients?.teams) || recipients.users.length >= 100 || recipients.teams.length >= 100) throw new Error('Invalid or incomplete requested reviewer list');
      return { ...pull, requestedReviewers: recipients.users.map(user => { if (typeof user.login !== 'string') throw new Error('Invalid reviewer'); return user.login.toLowerCase(); }),
        requestedTeams: recipients.teams.map(team => { if (typeof team.slug !== 'string') throw new Error('Invalid reviewer team'); return team.slug.toLowerCase(); }), reviews: await reviews(number, signal),
        ...(threadId ? { thread: await graph('thread', { number, threadId, signal }) } : commentId ? { thread: await graph('findThread', { number, commentId, signal }) } : {}) };
    },
    async applyReviewAction(intent, { signal, beforeWrite, expectedAuthorId } = {}) {
      let writing = false;
      const guardWrite = async () => { await beforeWrite?.(); signal?.throwIfAborted(); writing = true; };
      try {
      if (!allowWrite) throw new Error('GitHub App pullRequestReviews write permission is not configured');
      if (intent.repository !== repository) throw new Error('Review action repository mismatch');
      const number = integer(intent.pullNumber), pull = pullOf(await request(`${prefix}/pulls/${number}`, { method: 'GET', signal }), repository, number);
      if (pull.state !== 'open' || pull.merged || pull.headSha !== intent.headSha) throw new Error('PR target changed before review action');
      if(intent.evidence?.commentDigest)await findings.verifyFinding(intent,signal);
      if (intent.kind === 'replyFinding') return await findings.replyFinding(intent,{signal,beforeWrite:guardWrite,expectedAuthorId});
      if (intent.kind === 'requestReviewers') { await guardWrite(); return await request(`${prefix}/pulls/${number}/requested_reviewers`, { method: 'POST', body: { reviewers: intent.reviewers, team_reviewers: intent.teams }, signal }); }
      if (intent.kind === 'ready') return await graph('ready', { number, headSha: intent.headSha, signal, beforeWrite: guardWrite });
      if (intent.kind === 'resolveThread') return await graph('resolve', { number, threadId: intent.threadId, headSha: intent.headSha, signal, beforeWrite: guardWrite });
      throw new Error('Unsupported PR review action');
      } catch (error) { error.reviewWriteSent = writing; throw error; }
    },
  };
}

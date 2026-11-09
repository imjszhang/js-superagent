import { versionGitHubComment } from '../github-comment-version.mjs';
import { createGitHubAccountRequest } from './github-account.mjs';
import { createGitHubAppRequest } from './github-app.mjs';
import { githubRequest } from '../github-intake.mjs';
import { githubMention, verifiedGitHubMentionIdentity, versionGitHubMentionBody } from '../github-mention.mjs';
import { isGitHubReceipt, ghRequest, githubReviewCommentEvent } from './github.mjs';
import { classifyGitHubError, githubIdentityError, githubRepositoryFailure } from './github-errors.mjs';
import { normalizePullRequest } from '../github-pull-intake.mjs';
import { webhookConfigurationKey } from '../github-webhook-inbox.mjs';
import { summarizeGitHubCi, observeGitHubCi } from '../runtime/github-ci-observation.mjs';
import { pullReplyChannel } from '../runtime/github-review-delivery.mjs';

const SHA = /^[a-f\d]{40}$/i;
function positive(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`); return value; }
function text(value, name, max = 256 * 1024) { if (typeof value !== 'string' || Buffer.byteLength(value) > max) throw new Error(`Invalid ${name}`); return value; }
function timestamp(value) { const number = Date.parse(value); if (!Number.isFinite(number)) throw new Error('Invalid GitHub source timestamp'); return number; }
function author(value) {
  if (!value || !/^[a-z\d-]+(?:\[bot\])?$/i.test(value.login ?? '') || !['User', 'Bot', 'Organization'].includes(value.type)) throw new Error('Invalid GitHub source author');
  return { login: value.login.toLowerCase(), id: String(positive(value.id, 'author ID')), type: value.type };
}
function checkCancelled(signal) { if (signal?.aborted) throw new Error('GitHub repository polling cancelled'); }
function nativeRequest(executable, repository) {
  const prefix = `/repos/${repository}`;
  const request = (endpoint, options = {}) => {
    if (typeof endpoint !== 'string' || !endpoint.startsWith(`${prefix}/`) && endpoint !== prefix || /[\0\r\n\\#]/.test(endpoint)) throw new Error('GitHub source request outside configured repository');
    return ghRequest(executable, endpoint, { ...options, method: 'GET' });
  };
  request.identity = () => ghRequest(executable, '/user', { method: 'GET' });
  return request;
}

/** Read-only repository streams. Existing GitHub channel owns authenticated result delivery. */
export function createGitHubRepositorySource(options, { request: injectedRequest, streams: selectedStreams, observe = false, now = () => Date.now(), maxPages = 20,
  isTrackedPullRequest = () => false, isTrackedIssue = () => false, mentionEpoch = 0, mentionStartedAt, pollMentions = true } = {}) {
  const repository = options?.repository?.toLowerCase();
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/.test(repository ?? '') || ['.', '..'].includes(repository.split('/')[1])) throw new Error('GitHub repository source requires owner/repository');
  if (!Array.isArray(options.allowedActors) || !options.allowedActors.length || options.allowedActors.some(actor => !/^[a-z\d-]{1,39}$/i.test(actor))) throw new Error('GitHub repository source requires allowedActors');
  const allowedActors = options.allowedActors.map(actor => actor.toLowerCase()), command = options.command ?? '/js-superagent';
  if (!/^\/[a-z][a-z\d_-]{0,63}$/i.test(command)) throw new Error('Invalid GitHub command');
  const streams = { pulls: true, issues: false, comments: false, reviewComments: false, mentions: false, defaultBranchCI: false, ...selectedStreams };
  if (Object.keys(streams).some(key => !['pulls', 'issues', 'comments', 'reviewComments', 'mentions', 'defaultBranchCI'].includes(key)) || Object.values(streams).some(value => typeof value !== 'boolean')) throw new Error('Invalid GitHub repository stream settings');
  if(!Number.isSafeInteger(mentionEpoch)||mentionEpoch<0)throw new Error('Invalid GitHub mention activation epoch');
  if(mentionStartedAt!==undefined&&!Number.isFinite(Date.parse(mentionStartedAt)))throw new Error('Invalid GitHub mention activation timestamp');
  if (typeof observe !== 'boolean' || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid GitHub repository observation settings');
  if (typeof isTrackedPullRequest !== 'function' || typeof isTrackedIssue !== 'function') throw new Error('GitHub tracked-resource callbacks must be functions');
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 86_400_000) throw new Error('GitHub source pollIntervalMs must be 1000 to 86400000');
  if (streams.defaultBranchCI && !options.ci?.checkApps?.length && !options.ci?.statusContexts?.length) throw new Error('Default branch CI requires explicit checkApps or status contexts');
  const transport = injectedRequest ?? (options.app ? createGitHubAppRequest({ repository, app: options.app, ci: options.ci }) : options.account ? createGitHubAccountRequest(options) : nativeRequest(options.executable ?? 'gh', repository));
  if (typeof transport !== 'function') throw new Error('GitHub source request must be a function');
  let mentionIdentity;
  const verifyMentionIdentity = async signal => { mentionIdentity = undefined; mentionIdentity = await verifiedGitHubMentionIdentity(transport, {app:!!options.app,signal}); return structuredClone(mentionIdentity); };
  const prefix = `/repos/${repository}`, id = `github-repository:${repository.replace('/', ':')}`;
  const read = async (endpoint, signal) => { checkCancelled(signal); const value = await transport(endpoint, { method: 'GET', signal }); checkCancelled(signal); return value; };
  async function pages(endpoint, signal, field, since) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const value = await read(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, signal);
      const batch = field ? value?.[field] : value;
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Invalid GitHub source pagination');
      items.push(...batch);
      if (batch.length < 100 || since !== undefined && batch.every(item => Number.isFinite(Date.parse(item?.updated_at ?? item?.created_at)) && Date.parse(item.updated_at ?? item.created_at) < since)) return items;
    }
    throw new Error('GitHub source pagination limit reached; narrow streams or increase maxPages');
  }
  async function pullMetadata(number, signal) {
    const raw = await read(`${prefix}/pulls/${positive(number, 'pull number')}`, signal);
    if (raw?.number !== number || raw.base?.repo?.full_name?.toLowerCase() !== repository) throw githubIdentityError('GitHub returned a different pull request');
    if (raw.head?.repo?.full_name?.toLowerCase() !== repository) return null; // Fork execution is explicitly outside this adapter.
    return { ...normalizePullRequest({ repository, number, id: raw.id, headSha: String(raw.head.sha).toLowerCase(), headRef: raw.head.ref, headRepository: repository,
      state: raw.state, merged: raw.merged, title: raw.title, url: raw.html_url }, repository, number),
      ...(typeof raw.base.ref === 'string' && raw.base.ref ? { baseRef: raw.base.ref } : {}),
      ...(SHA.test(raw.base.sha ?? '') ? { baseSha: raw.base.sha.toLowerCase() } : {}) };
  }
  function reviewEvent(raw,pull,observedAt) {
    const reviewId=positive(raw.id,'review ID');
    if(!['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(raw.state))throw new Error('Invalid GitHub review state');
    return {id:`github:${repository}:review:${reviewId}`,kind:'review',repository,number:pull.number,pullNumber:pull.number,reviewId,
      createdAt:raw.submitted_at??raw.updated_at??raw.created_at,at:raw.submitted_at??raw.updated_at??raw.created_at,updatedAt:raw.updated_at??raw.submitted_at??raw.created_at,observedAt,
      text:raw.body??'',title:pull.title,actor:author(raw.user),pullRequest:pull,pullState:pull.state,headSha:pull.headSha,state:raw.state,
      commitId:raw.commit_id,url:`https://github.com/${repository}/pull/${pull.number}#pullrequestreview-${reviewId}`,mentionOnly:true};
  }
  async function readMentionSelector(selector,signal) {
    if(!streams.mentions||selector?.mention!==true||!['issue','pull'].includes(selector.kind))throw new Error('GitHub mention selector is outside configured scope');
    const number=positive(selector.number,'mention object number');
    if(selector.kind==='issue'&&options.issues&&!options.issues.includes(number))throw new Error('GitHub mention issue is outside configured scope');
    // A queued hint can become bound before reconciliation. The original channel
    // then owns ordinary follow-up/cancellation and polls that bound discussion.
    if(selector.kind==='issue'?isTrackedIssue(number):isTrackedPullRequest(number))return [];
    if([selector.commentId,selector.reviewId,selector.reviewCommentId].filter(value=>value!==undefined).length>1)throw new Error('Ambiguous GitHub mention selector');
    await verifyMentionIdentity(signal);
    const observedAt=new Date(now()).toISOString();let event;
    if(selector.kind==='pull'){
      const pull=await pullMetadata(number,signal);if(!pull)return [];
      if(selector.reviewCommentId!==undefined){
        const raw=await read(`${prefix}/pulls/comments/${positive(selector.reviewCommentId,'review comment ID')}`,signal);
        if(raw?.id!==selector.reviewCommentId)throw githubIdentityError('GitHub mention comment identity mismatch');
        event={...await githubReviewCommentEvent({repository,pull,comment:raw,observedAt,readParent:id=>read(`${prefix}/pulls/comments/${id}`,signal)}),number,at:raw.updated_at??raw.created_at,title:pull.title};
      }else if(selector.reviewId!==undefined){
        const raw=await read(`${prefix}/pulls/${number}/reviews/${positive(selector.reviewId,'review ID')}`,signal);
        if(raw?.id!==selector.reviewId)throw githubIdentityError('GitHub mention review identity mismatch');
        event=reviewEvent(raw,pull,observedAt);
      }else if(selector.commentId!==undefined){
        const raw=await read(`${prefix}/issues/comments/${positive(selector.commentId,'comment ID')}`,signal);
        if(raw?.id!==selector.commentId||raw.issue_url!==`https://api.github.com${prefix}/issues/${number}`)throw githubIdentityError('GitHub mention comment parent mismatch');
        event={id:`github:${repository}:pr_comment:${raw.id}`,kind:'comment',repository,number,at:raw.updated_at??raw.created_at,updatedAt:raw.updated_at??raw.created_at,observedAt,text:raw.body??'',title:pull.title,actor:author(raw.user),pullRequest:pull};
      }else{
        const raw=await read(`${prefix}/pulls/${number}`,signal);
        if(raw?.number!==number||String(raw.id)!==pull.id)throw githubIdentityError('GitHub mention PR identity mismatch');
        event={id:`github:${repository}:new_pull:${raw.id}`,kind:'pull',repository,number,at:raw.created_at,updatedAt:raw.updated_at??raw.created_at,text:raw.body??'',title:raw.title,actor:author(raw.user),pullRequest:pull};
      }
    }else{
      if(selector.reviewId!==undefined||selector.reviewCommentId!==undefined)throw new Error('Issue cannot carry PR review selectors');
      const issue=await read(`${prefix}/issues/${number}`,signal);
      if(issue?.number!==number||issue.pull_request)throw githubIdentityError('GitHub mention issue identity mismatch');
      if(selector.commentId!==undefined){
        const raw=await read(`${prefix}/issues/comments/${positive(selector.commentId,'comment ID')}`,signal);
        if(raw?.id!==selector.commentId||raw.issue_url!==`https://api.github.com${prefix}/issues/${number}`)throw githubIdentityError('GitHub mention comment parent mismatch');
        event={id:`github:${repository}:comment:${raw.id}`,kind:'comment',repository,number,at:raw.updated_at??raw.created_at,updatedAt:raw.updated_at??raw.created_at,observedAt,text:raw.body??'',title:issue.title,actor:author(raw.user),issueState:issue.state};
      }else event={id:`github:${repository}:issue:${positive(issue.id,'issue ID')}`,kind:'issue',repository,number,at:issue.created_at,updatedAt:issue.updated_at??issue.created_at,text:issue.body??'',title:issue.title,actor:author(issue.user),issueState:issue.state};
    }
    if(mentionStartedAt&&timestamp(event.updatedAt??event.at)<=timestamp(mentionStartedAt))return [];
    event=versionGitHubMentionBody({...event,mentionOnly:true},mentionIdentity);
    return normalize(event)?[event]:[];
  }
  function normalize(event) {
    if (!event || event.repository !== repository || !['pull', 'issue', 'comment', 'review_comment', 'review', 'check', 'status', 'ci_state'].includes(event.kind)) return null;
    const at = new Date(timestamp(event.updatedAt??event.at)).toISOString();
    if (event.kind === 'ci_state') {
      if (!streams.defaultBranchCI || !observe || !SHA.test(event.headSha ?? '') || !event.ciSnapshot || !event.ciTransition) return null;
      return { id: event.id, source: 'github', threads: [{ source: 'github', id: `${repository}#branch:${event.defaultBranch}` }],
        actor: { source: 'github', id: 'github-ci' }, human: false, at, text: event.text,
        url: `https://github.com/${repository}/commit/${event.headSha}`,
        meta: { repository, repositoryEvent: true, defaultBranch: event.defaultBranch, headSha: event.headSha,
          ciSnapshot: event.ciSnapshot, ciTransition: event.ciTransition, contextOnly: true } };
    }
    if (['check', 'status'].includes(event.kind)) {
      if (!streams.defaultBranchCI || !observe || !SHA.test(event.headSha ?? '')) return null;
      if (event.kind === 'check' && !options.ci?.checkApps?.includes(event.ci.app)) return null;
      if (event.kind === 'status' && (!options.ci?.statusContexts?.includes(event.ci.name) || !options.ci?.statusActors?.includes(event.actor.login))) return null;
      const thread = `${repository}#branch:${event.defaultBranch}`;
      return { id: event.id, source: 'github', threads: [{ source: 'github', id: thread }], actor: { source: 'github', id: event.actor.login }, human: false,
        at, text: event.text, url: `https://github.com/${repository}/commit/${event.headSha}`,
        meta: { repository, repositoryEvent: true, defaultBranch: event.defaultBranch, headSha: event.headSha, ci: event.ci,
          actor: event.actor.login, actorId: event.actor.id, actorType: 'Bot' } };
    }
    const activeMentionIdentity=streams.mentions&&(!mentionStartedAt||timestamp(event.updatedAt??event.at)>timestamp(mentionStartedAt))?mentionIdentity:undefined;
    event=versionGitHubMentionBody(event,activeMentionIdentity);
    if (event.kind === 'comment' || event.kind === 'review_comment' || event.kind === 'review') event = versionGitHubComment({ ...event, kind: ['review_comment','review'].includes(event.kind) ? event.kind : event.pullRequest ? 'pr_comment' : 'comment' });
    const body = text(event.text, 'GitHub event text'); if (isGitHubReceipt(body)) return null;
    const mentioned = githubMention(body,activeMentionIdentity);
    if (event.mentionOnly && !mentioned) return null;
    const request = githubRequest(body, command, {mentionIdentity:activeMentionIdentity}), human = event.actor.type === 'User';
    // Actor facts are data. The host's current Policy decides candidate admission
    // and subscribed feedback separately; discovery must not silently override it.
    if (!request && !observe) return null;
    const number = positive(event.number, 'GitHub resource number'), pull = event.pullRequest;
    if (!pull && options.issues && !options.issues.includes(number)) return null;
    if (pull && (pull.repository !== repository || pull.headRepository !== repository || pull.number !== number)) throw new Error('Cross-repository pull event');
    const thread = pull ? `${repository}#pr:${number}` : `${repository}#${number}`;
    const pullEvent = pull && ['pr_comment','review_comment','review'].includes(event.kind) ? { ...event, pullNumber: number, headSha: pull.headSha, pullState: pull.state,
      createdAt: event.createdAt ?? event.at, url: event.url ?? `https://github.com/${repository}/pull/${number}#issuecomment-${event.remoteId}` } : undefined;
    return { id: event.id, source: 'github', threads: [{ source: 'github', id: thread }], actor: { source: 'github', id: event.actor.login }, human,
      ...(request ? { addressed: 'direct' } : {}), at, text: mentioned ? body : request ? `${pull ? 'GitHub PR' : 'GitHub Issue'} #${number}: ${event.title ?? ''}\n\n${request}` : body,
      url: event.url ?? `https://github.com/${repository}/${pull ? 'pull' : 'issues'}/${number}`,
      channel: event.kind === 'review_comment' ? pullReplyChannel(event) : { source: 'github', thread, address: { repository, ...(pull ? { pullNumber: String(number), headSha: pull.headSha } : { issueNumber: String(number) }) } },
      meta: { repository, repositoryEvent: true, issueNumber: number, ...(mentioned?{addressedVia:'mention',mentionIdentity:structuredClone(mentionIdentity)}:{}), actor: event.actor.login, actorId: event.actor.id, actorType: event.actor.type, ...(event.commentVersion ? { githubComment: event.commentVersion } : {}), ...(event.bodyVersion?{githubBody:event.bodyVersion}:{}),
        ...(event.bodyVersion && !event.bodyVersion.initialAuthorVerified ? {contextOnly:true,observationReason:'body-editor-unverified'} : {}),
        ...(pull ? { pullRequest: pull } : {}), ...(pullEvent ? { pullEvent } : {}), ...(event.issueState ? { issueState: event.issueState } : {}) } };
  }
  return { id, source: 'github', configurationKey: webhookConfigurationKey(options), pollIntervalMs, normalize,
    authentication: injectedRequest ? 'injected' : options.app ? 'app' : 'native-gh',
    async poll({ cursor, signal } = {}) {
      const cutoff = now(), current = cursor?.schemaVersion === 1 && cursor.repository === repository ? structuredClone(cursor) : { schemaVersion: 1, repository, streams: {} };
      if(streams.mentions&&current.mentionEpoch!==mentionEpoch){for(const key of Object.keys(current.streams))if(key.startsWith('mentions:'))delete current.streams[key];current.mentionEpoch=mentionEpoch;}
      const events = [], errors = [];let identityError;
      if(streams.mentions)try{await verifyMentionIdentity(signal);}catch(error){identityError=error;}
      let repo;
      const repositoryInfo = async () => {
        if (!repo) {
          const candidate = await read(prefix, signal);
          if (candidate.full_name?.toLowerCase() !== repository || typeof candidate.default_branch !== 'string') throw githubIdentityError('GitHub repository identity mismatch');
          repo = candidate;
        }
        return repo;
      };
      const scans=Object.entries(streams).filter(([name,enabled])=>enabled&&name!=='mentions').map(([name])=>[name,name]);
      if(streams.mentions && pollMentions)for(const name of ['pulls','issues','comments','reviewComments'])scans.push([`mentions:${name}`,name]);
      for (const [cursorKey, stream] of scans) {
        const mentionOnly=cursorKey.startsWith('mentions:');
        const previous = current.streams[cursorKey], collected = []; let ciObservation;
        const failures = new Map(), visited = new Set(); let complete = true;
        const errorFor = (error, object) => {
          checkCancelled(signal); const fact = classifyGitHubError(error);
          errors.push({ scope: cursorKey, error: fact.message, ...fact, ...(object ? { object } : {}), ...(githubRepositoryFailure(error) ? { repositoryFailure: true } : {}) });
        };
        try {
          if(mentionOnly&&identityError)throw identityError;
          if (!previous) { await repositoryInfo(); current.streams[cursorKey] = { since: new Date(cutoff).toISOString(),...(mentionOnly?{startedAt:new Date(cutoff).toISOString()}:{}) }; if (stream !== 'defaultBranchCI') continue; }
          const since = timestamp(previous?.since ?? new Date(cutoff).toISOString()) - 2000, sinceISO = new Date(since).toISOString();
          for (const item of previous?.retries ?? []) {
            if (!['pull', 'issue', 'comment', 'review_comment', 'check', 'status'].includes(item?.kind) || !Number.isSafeInteger(item.id) || item.id < 1 ||
                ['pull', 'issue'].includes(item.kind) && (!Number.isSafeInteger(item.number) || item.number < 1) || !Number.isSafeInteger(item.attempts) || item.attempts < 1 ||
                !Number.isFinite(Date.parse(item.nextAt)) || typeof item.error?.message !== 'string' || typeof item.error?.category !== 'string' ||
                (stream === 'defaultBranchCI' ? !['check', 'status'].includes(item.kind) || typeof item.defaultBranch !== 'string' || !item.defaultBranch ||
                  item.kind === 'status' && !SHA.test(item.headSha ?? '') || item.headSha !== undefined && !SHA.test(item.headSha)
                  : item.kind !== (stream === 'pulls' ? 'pull' : stream === 'issues' ? 'issue' : stream === 'reviewComments' ? 'review_comment' : 'comment'))) throw new Error('Invalid GitHub object retry cursor');
            failures.set(`${item.kind}:${item.id}`, item);
          }
          if (failures.size > 1000) throw new Error('GitHub object retries exceed supported limit');
          for (const item of failures.values()) if (Date.parse(item.nextAt) > cutoff) errors.push({ scope: cursorKey, ...item.error,
            error: item.error.message, object: { kind: item.kind, id: item.id, ...(item.number ? { number: item.number } : {}) }, nextAt: item.nextAt });
          const resources = new Map();
          const kind = stream === 'pulls' ? 'pull' : stream === 'issues' ? 'issue' : stream === 'reviewComments' ? 'review_comment' : 'comment';
          const retry = (identity, error) => {
            const key = `${identity.kind}:${identity.id}`, before = failures.get(key), attempts = (before?.attempts ?? 0) + 1;
            if (!before && failures.size >= 1000) { complete = false; errorFor(new Error('GitHub object retries exceed supported limit')); return; }
            failures.set(key, { ...identity, attempts, nextAt: new Date(cutoff + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 16))).toISOString(),
              error: { ...classifyGitHubError(error), ...(githubRepositoryFailure(error) ? { repositoryFailure: true } : {}) } });
            errorFor(error, identity);
          };
          const inspect = async (raw, known) => {
            let identity;
            try { identity = known ?? { kind, id: positive(raw?.id, 'GitHub object ID'), ...(['comment', 'review_comment'].includes(kind) ? {} : { number: positive(raw.number, 'GitHub object number') }) }; }
            catch (error) { complete = false; errorFor(error); return; }
            const key = `${identity.kind}:${identity.id}`;
            if (visited.has(key)) return;
            visited.add(key);
            const waiting = failures.get(key);
            if (waiting && Date.parse(waiting.nextAt) > cutoff) return;
            try {
              if (known) {
                const endpoint = identity.kind === 'review_comment' ? `${prefix}/pulls/comments/${identity.id}` : identity.kind === 'comment' ? `${prefix}/issues/comments/${identity.id}`
                  : `${prefix}/${identity.kind === 'pull' ? 'pulls' : 'issues'}/${identity.number}`;
                raw = await read(endpoint, signal);
                if (raw?.id !== identity.id || !['comment', 'review_comment'].includes(identity.kind) && raw.number !== identity.number) throw new Error('GitHub retry returned a different object');
              }
              if(mentionOnly&&previous?.startedAt&&timestamp(raw.updated_at??raw.created_at)<=timestamp(previous.startedAt)){failures.delete(key);return;}
              let event;
              if (stream === 'pulls') {
                const updated = timestamp(raw.updated_at ?? raw.created_at);
                if ((!known && updated < since) || updated > cutoff || raw.state !== 'open' || isTrackedPullRequest(raw.number)) { failures.delete(key); return; }
                const pull = await pullMetadata(raw.number, signal);
                if (pull) event = { id: `github:${repository}:new_pull:${identity.id}`, kind: 'pull', repository, number: raw.number, at: raw.created_at, updatedAt:raw.updated_at??raw.created_at,
                  text: raw.body ?? '', title: raw.title, actor: author(raw.user), pullRequest: pull };
                if(pull&&mentionOnly)for(const rawReview of await pages(`${prefix}/pulls/${raw.number}/reviews`,signal)){
                  if(rawReview.state==='PENDING')continue;const reviewedAt=timestamp(rawReview.updated_at??rawReview.submitted_at??rawReview.created_at);
                  if(reviewedAt<since||reviewedAt>cutoff||previous?.startedAt&&reviewedAt<=timestamp(previous.startedAt))continue;const review=reviewEvent(rawReview,pull,new Date(cutoff).toISOString());if(normalize(review))collected.push(review);
                }
              } else if (stream === 'issues') {
                if (raw.pull_request || raw.state !== 'open' || isTrackedIssue(raw.number) || timestamp(raw.updated_at ?? raw.created_at) > cutoff) { failures.delete(key); return; }
                event = { id: `github:${repository}:issue:${identity.id}`, kind: 'issue', repository, number: raw.number, at: raw.created_at, updatedAt:raw.updated_at??raw.created_at,
                  text: raw.body ?? '', title: raw.title, actor: author(raw.user) };
              } else if (stream === 'comments') {
                if (timestamp(raw.updated_at ?? raw.created_at) > cutoff) { failures.delete(key); return; }
                let url; try { url = new URL(raw.issue_url); } catch { throw new Error('Invalid GitHub comment parent'); }
                const match = url.pathname.match(/\/issues\/([1-9]\d*)$/);
                if (url.origin !== 'https://api.github.com' || !match || url.pathname !== `${prefix}/issues/${match[1]}`) throw new Error('GitHub comment parent is outside repository');
                const number = positive(Number(match[1]), 'GitHub comment parent number'); identity.number = number;
                if (!resources.has(number)) {
                  const issue = await read(`${prefix}/issues/${number}`, signal);
                  if (issue.number !== number) throw new Error('GitHub returned a different comment parent');
                  resources.set(number, { issue, pull: issue.pull_request ? await pullMetadata(number, signal) : undefined });
                }
                const { issue, pull } = resources.get(number);
                if (issue.pull_request && !pull || (pull ? isTrackedPullRequest(number) : isTrackedIssue(number))) { failures.delete(key); return; }
                event = { id: `github:${repository}:${pull ? 'pr_comment' : 'comment'}:${identity.id}`, kind: 'comment', repository, number,
                  at: raw.updated_at ?? raw.created_at, updatedAt: raw.updated_at ?? raw.created_at, observedAt: new Date(cutoff).toISOString(),
                  text: raw.body ?? '', title: issue.title, actor: author(raw.user), ...(pull ? { pullRequest: pull } : { issueState: issue.state }) };
              } else if (stream === 'reviewComments') {
                const updated = timestamp(raw.updated_at ?? raw.created_at);
                if ((!known && updated < since) || updated > cutoff) { failures.delete(key); return; }
                let url; try { url = new URL(raw.pull_request_url); } catch { throw new Error('Invalid GitHub review parent'); }
                const match = url.pathname.match(/\/pulls\/([1-9]\d*)$/);
                if (url.origin !== 'https://api.github.com' || !match || url.pathname !== `${prefix}/pulls/${match[1]}`) throw new Error('GitHub review parent outside repository');
                const number = positive(Number(match[1]), 'GitHub review parent number'); identity.number = number;
                if (isTrackedPullRequest(number)) { failures.delete(key); return; }
                if (!resources.has(number)) resources.set(number, await pullMetadata(number, signal));
                const pull = resources.get(number);
                if (!pull) { failures.delete(key); return; }
                const comment = await githubReviewCommentEvent({ repository, pull, comment: raw, observedAt: new Date(cutoff).toISOString(),
                  readParent: id => read(`${prefix}/pulls/comments/${id}`, signal) });
                event = { ...comment, number, at: comment.updatedAt, title: pull.title };
              }
              if(event&&mentionOnly)event.mentionOnly=true;
              if(event)event=versionGitHubMentionBody(event,streams.mentions&&(!mentionStartedAt||timestamp(event.updatedAt??event.at)>timestamp(mentionStartedAt))?mentionIdentity:undefined);
              if (event && normalize(event)) collected.push(event);
              failures.delete(key);
            } catch (error) { retry(identity, error); }
          };
          if (stream !== 'defaultBranchCI') {
            for (const item of [...failures.values()]) if (Date.parse(item.nextAt) <= cutoff) await inspect(undefined, { kind: item.kind, id: item.id, ...(item.number ? { number: item.number } : {}) });
            const endpoint = stream === 'pulls' ? `${prefix}/pulls?state=all&sort=updated&direction=desc`
              : stream === 'issues' ? `${prefix}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(sinceISO)}`
              : `${prefix}/${stream === 'reviewComments' ? 'pulls' : 'issues'}/comments?sort=updated&direction=desc&since=${encodeURIComponent(sinceISO)}`;
            for (const raw of await pages(endpoint, signal, undefined, stream === 'pulls' ? since : undefined)) await inspect(raw);
          }
          if (stream === 'defaultBranchCI') {
            const defaultBranch = (await repositoryInfo()).default_branch, ref = encodeURIComponent(defaultBranch);
            const head = await read(`${prefix}/commits/${ref}`, signal);
            if (!SHA.test(head?.sha ?? '')) throw new Error('Invalid default branch head');
            const currentHead = head.sha.toLowerCase(), statuses = new Map(), checkRecords = [], statusRecords = [];
            const inspectCi = async (raw, kind, headSha, known) => {
              let identity;
              try { identity = known ?? { kind, id: positive(raw?.id, 'GitHub CI object ID'), defaultBranch,
                ...(kind === 'status' ? { headSha } : SHA.test(raw.head_sha ?? '') ? { headSha: raw.head_sha.toLowerCase() } : {}) }; }
              catch (error) { complete = false; errorFor(error); return; }
              const key = `${kind}:${identity.id}`;
              if (visited.has(key)) return;
              visited.add(key);
              if (Date.parse(failures.get(key)?.nextAt) > cutoff) return;
              try {
                if (known) {
                  if (kind === 'check') raw = await read(`${prefix}/check-runs/${identity.id}`, signal);
                  else {
                    if (!statuses.has(identity.headSha)) statuses.set(identity.headSha, await pages(`${prefix}/commits/${identity.headSha}/statuses`, signal));
                    raw = statuses.get(identity.headSha).find(value => value?.id === identity.id);
                  }
                  if (raw?.id !== identity.id) throw new Error('GitHub CI retry returned a different or missing object');
                }
                let event;
                if (kind === 'check') {
                  if (!options.ci?.checkApps?.includes(raw.app?.slug)) { failures.delete(key); return; }
                  if (raw.head_sha?.toLowerCase() !== currentHead) { failures.delete(key); return; }
                  checkRecords.push(raw);
                  const at = raw.completed_at ?? raw.started_at ?? raw.created_at ?? new Date(cutoff).toISOString();
                  const time = timestamp(at);
                  if (time > cutoff) throw new Error('GitHub CI observation is newer than the polling boundary');
                  if (!SHA.test(raw.head_sha ?? '') || identity.headSha && identity.headSha !== raw.head_sha.toLowerCase()) throw new Error('GitHub CI retry commit mismatch');
                  const ci = { name: text(raw.name, 'check name', 512), app: raw.app.slug, status: raw.status, conclusion: raw.conclusion };
                  const baselined = previous?.ciObservation?.entries?.some(entry => entry.kind === 'check_run' && entry.id === String(raw.id) && entry.status === raw.status && entry.conclusion === raw.conclusion);
                  if (previous && !baselined && (known || time >= since) && raw.status === 'completed' && ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(raw.conclusion)) event = { kind, id: `github:${repository}:branch_check:${identity.id}:${raw.conclusion}`, repository, at, defaultBranch: identity.defaultBranch, headSha: raw.head_sha.toLowerCase(),
                    actor: { login: `${raw.app.slug}[bot]`, id: String(positive(raw.app.id, 'check App ID')), type: 'Bot' }, ci,
                    text: `Default branch ${identity.defaultBranch}: ${ci.name} ${ci.conclusion}\nHead: ${raw.head_sha}\n${text(raw.output?.summary ?? '', 'check summary', 128 * 1024)}` };
                } else {
                  const at = raw.updated_at ?? raw.created_at, time = timestamp(at), actor = author(raw.creator);
                  if (!options.ci?.statusContexts?.includes(raw.context) || !options.ci?.statusActors?.includes(actor.login) || identity.headSha !== currentHead) { failures.delete(key); return; }
                  if (time > cutoff) throw new Error('GitHub CI observation is newer than the polling boundary');
                  statusRecords.push(raw);
                  const baselined = previous?.ciObservation?.entries?.some(entry => entry.kind === 'commit_status' && entry.id === String(raw.id) && entry.conclusion === raw.state);
                  if (previous && !baselined && (known || time >= since) && ['failure', 'error'].includes(raw.state)) event = { kind, id: `github:${repository}:branch_status:${identity.id}`, repository, at, defaultBranch: identity.defaultBranch, headSha: identity.headSha, actor,
                    ci: { name: raw.context, status: raw.state, conclusion: raw.state },
                    text: `Default branch ${identity.defaultBranch}: ${raw.context} ${raw.state}\nHead: ${identity.headSha}\n${text(raw.description ?? '', 'status description', 128 * 1024)}` };
                }
                if(event&&mentionOnly)event.mentionOnly=true;
              if(event)event=versionGitHubMentionBody(event,streams.mentions?mentionIdentity:undefined);
              if (event && normalize(event)) collected.push(event);
                failures.delete(key);
              } catch (error) { retry(identity, error); }
            };
            for (const item of [...failures.values()]) if (Date.parse(item.nextAt) <= cutoff) {
              const { error, attempts, nextAt, ...identity } = item;
              await inspectCi(undefined, item.kind, item.headSha, identity);
            }
            if (options.ci?.checkApps?.length) try {
              for (const raw of await pages(`${prefix}/commits/${currentHead}/check-runs?filter=latest`, signal, 'check_runs')) await inspectCi(raw, 'check');
            } catch (error) { complete = false; errorFor(error); }
            if (options.ci?.statusContexts?.length) try {
              for (const raw of await pages(`${prefix}/commits/${currentHead}/statuses`, signal)) await inspectCi(raw, 'status', currentHead);
            } catch (error) { complete = false; errorFor(error); }
            const snapshot = summarizeGitHubCi({ repository, target: `branch:${defaultBranch}`, headSha: currentHead, config: options.ci,
              checks: checkRecords, statuses: statusRecords, complete: complete && failures.size === 0, observedAt: new Date(cutoff).toISOString() });
            const transition = observeGitHubCi(previous?.ciObservation, snapshot);
            ciObservation = transition.snapshot;
            if (previous?.ciObservation && transition.changed) collected.push({ kind: 'ci_state',
              id: `github:${repository}:branch_ci:${currentHead}:${snapshot.digest}`, repository, defaultBranch, headSha: currentHead,
              at: new Date(cutoff).toISOString(), ciSnapshot: transition.snapshot,
              ciTransition: { baseline: transition.baseline, changed: transition.changed, recovered: transition.recovered },
              text: `Default branch ${defaultBranch}: ${transition.recovered ? 'previously observed CI failures recovered' : `selected CI observations ${snapshot.state}`}\nHead: ${currentHead}\nThis describes selected observations, not all required checks.` });
          }
        } catch (error) { complete = false; errorFor(error); }
        events.push(...collected);
        if (previous || stream === 'defaultBranchCI') current.streams[cursorKey] = { ...(mentionOnly?{startedAt:previous?.startedAt??new Date(cutoff).toISOString()}:{}), since: complete ? new Date(cutoff).toISOString() : previous?.since ?? new Date(cutoff).toISOString(),
          ...(failures.size ? { retries: [...failures.values()] } : {}),
          ...(ciObservation ?? previous?.ciObservation ? { ciObservation: ciObservation ?? previous.ciObservation } : {}) };
      }
      return { events, cursor: current, errors };
    },
    async readContext({ issueNumber, pullNumber, mentionIdentity: identityRequest, mentionSelector, signal } = {}) {
      if(identityRequest){if(!streams.mentions)throw new Error('GitHub mention discovery is disabled');return verifyMentionIdentity(signal);}
      if(mentionSelector)return readMentionSelector(mentionSelector,signal);
      if (pullNumber !== undefined) return pullMetadata(pullNumber, signal);
      return read(`${prefix}/issues/${positive(issueNumber, 'issue number')}`, signal);
    },
  };
}

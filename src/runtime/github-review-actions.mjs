import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID = /^[A-Za-z0-9._:/-]{1,512}$/;
const SHA = /^[a-f0-9]{40}$/;
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const TEAM = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const PREFIX = 'github:review-action:';
function names(value, pattern) {
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !pattern.test(item))) throw new Error('Invalid review recipients');
  return [...new Set(value.map(item => item.toLowerCase()))].sort();
}
export function normalizeReviewSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['ready','requestReviewers','resolveThreads','reviewers','teams'].includes(key))) throw new Error('Invalid PR review settings');
  for (const key of ['ready','requestReviewers','resolveThreads']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Invalid PR review switch');
  return { ready: value.ready ?? false, requestReviewers: value.requestReviewers ?? false, resolveThreads: value.resolveThreads ?? false,
    reviewers: names(value.reviewers ?? [], LOGIN), teams: names(value.teams ?? [], TEAM) };
}
function intentOf(value) {
  if (!value || !['ready','requestReviewers','resolveThread','finding'].includes(value.kind) || !ID.test(value.ticketId ?? '') || !ID.test(value.provisionId ?? '') ||
      !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(value.repository ?? '') ||
      !Number.isSafeInteger(value.pullNumber) || value.pullNumber < 1 || !SHA.test(value.headSha ?? '') ||
      !Number.isSafeInteger(value.generation ?? 0) || (value.generation ?? 0) < 0) throw new Error('Invalid bound PR review intent');
  const intent = { kind: value.kind, ticketId: value.ticketId, provisionId: value.provisionId, generation: value.generation ?? 0,
    repository: value.repository.toLowerCase(), pullNumber: value.pullNumber, headSha: value.headSha,
    ...(value.policyVersion === undefined ? {} : { policyVersion: String(value.policyVersion).slice(0, 300) }) };
  if (value.kind === 'requestReviewers') {
    intent.reviewers = names(value.reviewers ?? [], LOGIN); intent.teams = names(value.teams ?? [], TEAM);
    if (!intent.reviewers.length && !intent.teams.length) throw new Error('Review request needs a recipient');
  }
  if (value.kind === 'resolveThread' || value.kind === 'finding') {
    if (value.threadId !== undefined && !ID.test(value.threadId) || !Number.isSafeInteger(value.commentId) || value.commentId < 1 ||
        !value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence) || JSON.stringify(value.evidence).length > 8000) throw new Error('Thread resolution needs original comment and repair evidence');
    Object.assign(intent, { ...(value.threadId === undefined ? {} : { threadId: value.threadId }), commentId: value.commentId, evidence: structuredClone(value.evidence) });
  }
  if(value.kind==='finding') {
    if(!['fixed','declined','unresolved'].includes(value.disposition)||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>4000||
        !['human','bot'].includes(value.authorKind)||!Number.isSafeInteger(value.evidence?.rootId)||value.evidence.rootId<1||
        !/^[1-9]\d*$/.test(value.evidence.actorId??'')||!/^[a-f0-9]{64}$/.test(value.evidence.commentDigest??''))throw new Error('Finding needs a bounded disposition and verified original author');
    Object.assign(intent,{disposition:value.disposition,reason:value.reason.trim(),authorKind:value.authorKind});
  }
  if(value.reviewerIdentities!==undefined)intent.reviewerIdentities=structuredClone(value.reviewerIdentities);
  return intent;
}
function permits(intent, settings) {
  const policy = normalizeReviewSettings(settings);
  if (intent.kind === 'ready') return policy.ready;
  if (intent.kind === 'resolveThread' || intent.kind === 'finding') return policy.resolveThreads;
  return policy.requestReviewers && intent.reviewers.every(name => policy.reviewers.includes(name)) && intent.teams.every(name => policy.teams.includes(name));
}
function checkSnapshot(intent, snapshot) {
  if (snapshot.repository !== intent.repository || snapshot.number !== intent.pullNumber || snapshot.headSha !== intent.headSha || snapshot.state !== 'open' || snapshot.merged) throw new Error('PR target changed; inspect this review action');
  if (['resolveThread','finding'].includes(intent.kind) && (!snapshot.thread || intent.threadId !== undefined && snapshot.thread.id !== intent.threadId || !snapshot.thread.commentIds.includes(intent.commentId))) throw new Error('Review thread does not contain the original finding');
}
function satisfied(intent, snapshot) {
  if (intent.kind === 'ready') return snapshot.isDraft === false;
  if (intent.kind === 'resolveThread' || intent.kind === 'finding') return snapshot.thread.isResolved === true;
  return intent.reviewers.every(login => snapshot.requestedReviewers.includes(login) || snapshot.reviews.some(review => review.login === login && review.commitSha === intent.headSha && review.state !== 'DISMISSED' && review.state !== 'PENDING')) &&
    intent.teams.every(team => snapshot.requestedTeams.includes(team));
}

/** Network work is outside Store transactions. The runtime owns the Effect and
 * supplies fresh authorization/readiness evidence on every attempt. */
export function createGitHubReviewActions({ store, channel, now = () => new Date().toISOString() }) {
  if (!store || !['atomic','getMeta','setMeta','listMeta'].every(key => typeof store[key] === 'function')) throw new Error('Review actions need a durable Store');
  const get = id => structuredClone(store.getMeta(PREFIX + id) ?? null);
  const save = record => store.atomic(() => { store.setMeta(PREFIX + record.id, record); return structuredClone(record); });
  return {
    enqueue(value) {
      const intent = intentOf(value), { policyVersion: _version, ...identity } = intent, id = sha(identity);
      return store.atomic(() => get(id) ?? save({ id, intent, status: 'pending', attempts: 0, createdAt: now(), updatedAt: now() }));
    },
    get,
    list(ticketId) { return store.listMeta(PREFIX).map(row => structuredClone(row.value)).filter(record => !ticketId || record.intent.ticketId === ticketId); },
    async run(id, { authorize, policy, validateReady, validateResolution, validateFinding, validateRecipients, signal } = {}) {
      let record = get(id);
      if (!record) throw new Error('PR review action not found');
      if (record.status === 'completed') return record;
      if (typeof channel?.reviewSnapshot !== 'function' || typeof channel?.applyReviewAction !== 'function') throw new Error('GitHub channel does not support review actions');
      const check = async () => {
        signal?.throwIfAborted();
        if (!permits(record.intent, typeof policy === 'function' ? policy() : policy) || typeof authorize !== 'function' || await authorize(record.intent) !== true) throw new Error('PR review action is no longer authorized');
      };
      const validate = async snapshot => {
        if (record.intent.kind === 'requestReviewers' && (typeof validateRecipients !== 'function' || await validateRecipients(record.intent,snapshot)!==true))throw new Error('Review recipient identity or bot round budget is unavailable or exhausted');
        if (record.intent.kind === 'ready' && (typeof validateReady !== 'function' || await validateReady(record.intent, snapshot) !== true)) throw new Error('Ready requires the current completed report, verification and settled inputs');
        if (record.intent.kind === 'finding' && (typeof validateFinding !== 'function' || await validateFinding(record.intent,snapshot)!==true))throw new Error('Finding disposition no longer matches the original consumed comment');
        if ((record.intent.kind === 'resolveThread'||record.intent.kind==='finding'&&record.intent.disposition==='fixed') && (typeof validateResolution !== 'function' || await validateResolution(record.intent, snapshot) !== true)) throw new Error('Resolution requires current pushed repair and verification evidence');
      };
      const complete=snapshot=>save({...record,status:'completed',observation:snapshot,updatedAt:now(),completedAt:now(),error:null});
      const uncertain=snapshot=>save({...record,status:'inspection',updatedAt:now(),error:'Remote result remains uncertain; do not repeat this action automatically',observation:snapshot});
      const claim=stage=>store.atomic(()=>{
        const current=get(id);
        if(current.status!==record.status||current.attempts!==record.attempts)return false;
        record=save({...record,stage,status:'sending',attempts:record.attempts+1,updatedAt:now(),error:null});return true;
      });
      try {
        await check();
        const snapshot = await channel.reviewSnapshot(record.intent.pullNumber, { threadId: record.resolvedThreadId ?? record.intent.threadId, commentId: record.intent.commentId, signal });
        await check(); checkSnapshot(record.intent, snapshot);
        if (record.resolvedThreadId && record.resolvedThreadId !== snapshot.thread?.id) throw new Error('Resolved thread identity changed');
        if (snapshot.thread) record.resolvedThreadId = snapshot.thread.id;
        if(record.intent.kind==='finding') {
          await validate(snapshot);
          if(record.intent.disposition==='unresolved')return complete(snapshot);
          if(record.intent.disposition==='declined') {
            if(typeof channel.findingReplySnapshot!=='function')throw new Error('GitHub channel does not support finding explanations');
            let reply=await channel.findingReplySnapshot(record.intent,{signal,expectedAuthorId:record.replyAuthorId});
            await check();
            record.replyAuthorId=reply.authorId;
            if(!reply.receipt) {
              if(record.replyReceipt || record.stage==='reply'&&['sending','inspection'].includes(record.status))return uncertain(snapshot);
              await validate(snapshot);await check();if(!claim('reply'))return get(id);
              await channel.applyReviewAction({...record.intent,kind:'replyFinding'}, {signal,expectedAuthorId:record.replyAuthorId,beforeWrite:async()=>{await check();await validate(snapshot);}});
              reply=await channel.findingReplySnapshot(record.intent,{signal,expectedAuthorId:record.replyAuthorId});await check();
              if(!reply.receipt)throw new Error('GitHub did not confirm the finding explanation');
            }
            // Commit the explanation receipt before any attempt to resolve a bot thread.
            record=save({...record,replyReceipt:reply.receipt,replyAuthorId:reply.authorId,
              ...(record.stage==='reply'?{status:'pending',stage:'resolve'}:{}),updatedAt:now()});
            if(record.intent.authorKind==='human')return complete(snapshot);
          }
        }
        if (satisfied(record.intent, snapshot)) {if(['ready','resolveThread'].includes(record.intent.kind))await validate(snapshot);return complete(snapshot);}
        if (record.status === 'sending' || record.status === 'inspection') return uncertain(snapshot);
        await validate(snapshot); await check();
        record.observation=snapshot;
        if(!claim(['finding','resolveThread'].includes(record.intent.kind)?'resolve':'action'))return get(id);
        await channel.applyReviewAction({ ...record.intent, ...(record.intent.kind==='finding'?{kind:'resolveThread'}:{}), ...(record.resolvedThreadId ? { threadId: record.resolvedThreadId } : {}) }, { signal, beforeWrite: async () => { await check(); await validate(snapshot); } });
        const observed = await channel.reviewSnapshot(record.intent.pullNumber, { threadId: record.resolvedThreadId ?? record.intent.threadId, signal });
        await check(); checkSnapshot(record.intent, observed);
        if (!satisfied(record.intent, observed)) throw new Error('GitHub did not confirm the review action');
        return complete(observed);
      } catch (error) {
        const rejected = error.reviewWriteSent === false || [400,401,403,404,405,410,422,429].includes(error.status ?? error.statusCode);
        const status=record.status==='sending'&&!rejected||record.status==='inspection'?'inspection':'failed';
        error.reviewRetryable=status==='inspection'||['EAGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error.code)||[408,429].includes(error.status??error.statusCode)||(error.status??error.statusCode)>=500||/timed? ?out|network|fetch failed|transport failed|request failed|response lost/i.test(String(error.message??''));
        store.atomic(() => {
          const current = get(id);
          if (current.status === 'completed' || current.attempts !== record.attempts) return;
          save({ ...record, status, updatedAt: now(),error: String(error.message ?? error).slice(0, 1000) });
        });
        throw error;
      }
    },
  };
}

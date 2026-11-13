import { createHash } from 'node:crypto';
import { followupOwners } from '../../dist/core/index.js';
import { normalizeGitHubActorTrigger } from '../policy.mjs';
import { AssessmentContextChanged } from './assessment-refresh.mjs';

const MAX_TRIGGERS = 20, MAX_TEXT_BYTES = 32000, MAX_REFERENCES = 20, MAX_TARGETS = 8;
const repoName = value => typeof value === 'string' && /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/.test(value) && !['.', '..'].includes(value.split('/')[1]);
const positive = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
// Ordinary long messages retain the existing bounded assessment/read path. This
// cheap prefilter grants nothing; references() still parses and checks every link.
const mayReference = text => /#[1-9]\d*|https:\/\/github\.com\/[a-z\d-]+\/[a-z\d_.-]+\/(?:issues|pull)\/[1-9]\d*/i.test(text);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
function fail(reason, triggerId) { throw Object.assign(new Error(`Candidate links refused: ${reason}`), { code: 'CANDIDATE_LINKS_REJECTED', reason, ...(triggerId ? { triggerId } : {}) }); }
const threadKey = ref => `${ref.source}:${ref.id}`;
const membership = thread => thread && { key: thread.key, ref: thread.ref, subscriptions: thread.subscriptions, context: thread.context ?? [] };
// Changing authority, identity or reply destinations is not an ordinary worker
// snapshot update. Keep the full fingerprint as well: nothing is applied from a
// stale card, even when only inputs or execution state changed.
const targetAuthority = ticket => ({ id: ticket.id, decisionId: ticket.decisionId, mandate: ticket.mandate,
  origin: ticket.origin, channels: ticket.channels, createdAt: ticket.createdAt, threads: ticket.threads });

/** Mask whole URL tokens before short references, so an invalid outer URL cannot donate an inner reference. */
function references(text, repository, budget) {
  const found = new Set();
  const add = (repo, number, kind) => {
    if (++budget.count > MAX_REFERENCES) fail('reference-budget-exceeded');
    if (repo.toLowerCase() === repository && positive(number)) {
      if (kind !== 'pull') found.add(`github:${repository}#${Number(number)}`);
      if (kind !== 'issues') found.add(`github:${repository}#pr:${Number(number)}`);
    }
  };
  let rest = text.replace(/[a-z][a-z\d+.-]*:[^\s<>"'`]*|www\.[^\s<>"'`]*/gi, (raw, offset) => {
    const token = raw.replace(/[),.;!?\]}，。；！？]+$/, '');
    const match = /^https:\/\/github\.com\/([a-z\d-]+\/[a-z\d_.-]+)\/(issues|pull)\/([1-9]\d*)\/?(?:#(?:issuecomment-|discussion_r|pullrequestreview-|issue-|discussion-)[1-9]\d*)?$/i.exec(token);
    if (match && (!offset || !/[\w/.:@%?=&+#-]/.test(text[offset - 1]))) add(match[1], match[3], match[2].toLowerCase());
    return ' '.repeat(raw.length);
  });
  rest = rest.replace(/[a-z\d_.-]+\/[a-z\d_.-]+#\d+/gi, (raw, offset) => {
    const before = rest[offset - 1], after = rest[offset + raw.length];
    const match = /^([a-z\d-]+\/[a-z\d_.-]+)#([1-9]\d*)$/i.exec(raw);
    if (match && (!before || !/[\w/.:@%?=&+#-]/.test(before)) && (!after || !/[\w/#-]/.test(after))) add(match[1], match[2]);
    return ' '.repeat(raw.length);
  });
  for (const match of rest.matchAll(/(?<![\w/.:@%?=&+#-])#([1-9]\d*)(?![\w/#-]|\.[a-z\d])/gi)) add(repository, match[1]);
  return found;
}

function revision(store, trigger) {
  if (trigger.source !== 'github') return;
  for (const [field, prefix] of [['githubComment', 'github:comment-version:'], ['githubBody', 'github:body-version:']]) {
    const version = trigger.meta?.[field], baseId = version?.baseId ?? trigger.id.replace(/:v:[a-f\d]{24}$/, '');
    const current = store.getMeta(`${prefix}${baseId}`);
    if (version && (!current || current.eventId !== trigger.id || current.digest !== version.digest || current.actorId !== version.actorId || current.location !== version.location) ||
        !version && current && current.eventId !== trigger.id || field === 'githubBody' && version && version.initialAuthorVerified !== true) fail('source-revision-retired');
  }
}

function explicit(store, policy, trigger) {
  const normalized = normalizeGitHubActorTrigger(policy, trigger), thread = store.threads.get(threadKey(trigger.threads[0]));
  const tickets = (thread?.subscriptions ?? []).map(id => store.tickets.get(id)).filter(Boolean);
  const gate = policy.gate(normalized, thread, tickets);
  return gate?.admissible && gate.strength === 'explicit';
}

function eligibleSource(store, policy, trigger, repository) {
  const normalized = normalizeGitHubActorTrigger(policy, trigger), meta = trigger.meta ?? {};
  const number = meta.pullEvent?.pullNumber ?? meta.pullRequest?.number ?? meta.issueNumber ?? meta.pullNumber;
  const pull = meta.pullEvent || meta.pullRequest || meta.pullNumber !== undefined;
  return trigger.source === 'github' && trigger.actor?.source === 'github' && normalized.human &&
    normalized.meta.githubActor.nativeType === 'User' && positive(meta.actorId ?? meta.pullEvent?.actor?.id) &&
    meta.repository === repository && (!meta.pullEvent || meta.pullEvent.repository === repository) &&
    (!meta.pullRequest || meta.pullRequest.repository === repository) && positive(number) &&
    trigger.threads.length === 1 && trigger.threads[0].source === 'github' &&
    trigger.threads[0].id === `${repository}#${pull ? 'pr:' : ''}${Number(number)}` && !meta.contextOnly && explicit(store, policy, trigger);
}

function routeable(store, policy, ticket, triggers) {
  if (!ticket || ticket.ended?.by === 'human' || !ticket.mandate || !policy.revalidate(ticket.mandate)) return false;
  return !triggers.some(trigger => store.triggers.disposition(trigger.id)?.handbacks?.some(item => item.ticketId === ticket.id));
}

function related(store, policy, ticket, thread, triggers, repository) {
  if (!routeable(store, policy, ticket, triggers) || !thread?.subscriptions?.includes(ticket.id) || thread.context?.includes(ticket.id)) return false;
  const origin = ticket.origin?.triggerId && store.triggers.get(ticket.origin.triggerId);
  if (!origin || !['local', 'github'].includes(origin.source)) return false;
  if (origin.source === 'github' && origin.meta?.repository !== repository) return false;
  const scopeRepository = ticket.mandate.basis?.scope?.repository;
  return scopeRepository === undefined || scopeRepository === repository;
}

/** Trusted, project-local enrichment. Verification never discovers replacement targets or performs I/O. */
export function createCandidateLinks({ store, policy, candidate, repository }) {
  const currentPolicy = () => typeof policy === 'function' ? policy() : policy;
  const snapshot = structuredClone(candidate), initialPolicy = currentPolicy();
  if (!snapshot?.evalId || !snapshot.thread?.key || !Array.isArray(snapshot.triggers) || !snapshot.triggers.length ||
      !Array.isArray(snapshot.tickets) || snapshot.triggers.some(trigger => !trigger?.id || !Array.isArray(trigger.threads) || !trigger.threads.length || typeof trigger.text !== 'string')) fail('invalid-candidate');
  const sources = snapshot.triggers.map(trigger => ({ trigger, fingerprint: digest(trigger), disposition: digest(store.triggers.disposition(trigger.id)),
    threads: trigger.threads.map(ref => ({ key: threadKey(ref), fingerprint: digest(membership(store.threads.get(threadKey(ref)))) })) }));
  const original = new Set(snapshot.tickets.map(ticket => ticket.id)), targets = new Map(snapshot.tickets.map(ticket => [ticket.id, {
    ticket, fingerprint: digest(ticket), origin: digest(ticket.origin?.triggerId && store.triggers.get(ticket.origin.triggerId)),
    routeable: snapshot.triggers.some(trigger => routeable(store, initialPolicy, ticket, [trigger])), original: true,
  }]));
  const linkedThreads = new Map(), links = new Map(), budget = { count: 0, triggers: 0, bytes: 0 };

  function verifySources() {
    const livePolicy = currentPolicy();
    if (!livePolicy || livePolicy.paused || livePolicy.version !== snapshot.policyVersion) fail('policy-changed-or-paused', snapshot.triggers[0].id);
    const thread = store.threads.get(snapshot.thread.key), evaluation = thread?.evaluating;
    if (!evaluation || evaluation.id !== snapshot.evalId || evaluation.policyVersion !== snapshot.policyVersion ||
        digest(evaluation.triggerIds) !== digest(snapshot.triggers.map(trigger => trigger.id))) fail('candidate-expired', snapshot.triggers.find(trigger => !evaluation?.triggerIds.includes(trigger.id))?.id ?? snapshot.triggers[0].id);
    for (const source of sources) {
      const current = store.triggers.get(source.trigger.id);
      if (!current || digest(current) !== source.fingerprint) fail('source-missing-or-changed', source.trigger.id);
      try { revision(store, current); } catch (error) { error.triggerId = current.id; throw error; }
      if (digest(store.triggers.disposition(current.id)) !== source.disposition) fail('source-disposition-changed', current.id);
      for (const thread of source.threads) if (digest(membership(store.threads.get(thread.key))) !== thread.fingerprint) fail('source-thread-changed', current.id);
      if (followupOwners(current, store).length) fail('source-owned', current.id);
    }
    return livePolicy;
  }

  verifySources();
  if (snapshot.strength === 'explicit' && repoName(repository)) for (const source of sources) {
    if (!mayReference(source.trigger.text) || !eligibleSource(store, initialPolicy, source.trigger, repository)) continue;
    budget.triggers++; budget.bytes += Buffer.byteLength(source.trigger.text);
    if (budget.triggers > MAX_TRIGGERS || budget.bytes > MAX_TEXT_BYTES) fail('text-budget-exceeded', source.trigger.id);
    let keys;
    try { keys = references(source.trigger.text, repository, budget); } catch (error) { error.triggerId = source.trigger.id; throw error; }
    for (const key of keys) {
      const thread = store.threads.get(key);
      if (!thread || thread.key !== key || thread.ref?.source !== 'github' || `github:${thread.ref.id}` !== key) continue;
      linkedThreads.set(key, { fingerprint: digest(membership(thread)), thread });
      if ((thread.subscriptions?.length ?? 0) > 100) fail('subscription-budget-exceeded', source.trigger.id);
      for (const id of thread.subscriptions ?? []) {
        if (original.has(id)) continue;
        const ticket = store.tickets.get(id);
        if (!related(store, initialPolicy, ticket, thread, [source.trigger], repository)) continue;
        if (!targets.has(id)) {
          if (links.size >= MAX_TARGETS) fail('target-budget-exceeded', source.trigger.id);
          targets.set(id, { ticket: structuredClone(ticket), fingerprint: digest(ticket), origin: digest(store.triggers.get(ticket.origin.triggerId)), routeable: true, original: false });
          links.set(id, new Map());
        }
        const byTrigger = links.get(id);
        if (!byTrigger.has(source.trigger.id)) byTrigger.set(source.trigger.id, new Set());
        byTrigger.get(source.trigger.id).add(key);
      }
    }
  }
  const enrichedCandidate = { ...snapshot, tickets: [...targets.values()].map(value => structuredClone(value.ticket)),
    ticketReferences: [...links].map(([ticketId, byTrigger]) => ({ ticketId, triggerIds: [...byTrigger.keys()], threads: [...new Set([...byTrigger.values()].flatMap(value => [...value]))] })) };

  function verifyAuthority(targetId, triggerId) {
    const livePolicy = verifySources();
    for (const [key, saved] of linkedThreads) if (digest(membership(store.threads.get(key))) !== saved.fingerprint) fail('referenced-thread-changed');
    const changes = [];
    for (const [id, saved] of targets) {
      const current = store.tickets.get(id);
      if (!current) fail('target-missing');
      const currentVersion = digest(current), changed = currentVersion !== saved.fingerprint;
      const routeableNow = snapshot.triggers.some(trigger => routeable(store, livePolicy, current, [trigger]));
      if (saved.routeable && !routeableNow) fail('target-no-longer-routeable');
      if (changed && digest(targetAuthority(current)) !== digest(targetAuthority(saved.ticket))) fail('target-authority-or-route-changed');
      const origin = current.origin?.triggerId && store.triggers.get(current.origin.triggerId);
      if (digest(origin) !== saved.origin) fail('target-source-missing-or-changed');
      if (changed) {
        if (!saved.routeable || !routeableNow) fail('target-no-longer-routeable');
        if (!origin) fail('target-source-missing-or-changed');
        if (saved.original && !sources.some(({ trigger }) => !trigger.meta?.contextOnly && explicit(store, livePolicy, trigger) && routeable(store, livePolicy, current, [trigger]) &&
          trigger.threads.some(ref => {
            const thread = store.threads.get(threadKey(ref));
            return thread?.subscriptions.includes(id) && !thread.context?.includes(id);
          }))) fail('target-no-longer-routeable');
        changes.push({ ticketId: id, previousVersion: saved.fingerprint, currentVersion, changeKind: 'ticket-snapshot' });
      }
      if (!saved.original) {
        for (const [sourceId, keys] of links.get(id)) for (const key of keys) if (!related(store, livePolicy, current, store.threads.get(key), [snapshot.triggers.find(trigger => trigger.id === sourceId)], repository)) fail('target-no-longer-routeable');
      }
    }
    if (targetId !== undefined) {
      const target = targets.get(targetId), selected = snapshot.triggers.find(trigger => trigger.id === (triggerId ?? (snapshot.triggers.length === 1 ? snapshot.triggers[0].id : undefined)));
      if (!target) fail('target-outside-candidate', triggerId);
      if (!selected || !explicit(store, livePolicy, selected) || selected.meta?.contextOnly) fail('selected-trigger-not-explicit', triggerId ?? selected?.id);
      if (!routeable(store, livePolicy, store.tickets.get(targetId), [selected])) fail('target-no-longer-routeable', selected.id);
      if (!target.original && !links.get(targetId)?.has(selected.id)) fail('target-not-referenced-by-trigger', selected.id);
    }
    return changes;
  }
  return { candidate: enrichedCandidate,
    // Internal host guard: checking hard boundaries cannot accept an assessment
    // or make its saved fingerprint current. Applying a result still uses verify.
    verifyAuthority(targetId, triggerId) { verifyAuthority(targetId, triggerId); return true; },
    verify(targetId, triggerId) {
      const changes = verifyAuthority(targetId, triggerId);
      // All hard refusals, including a different target's authority and the
      // selected attachment's gate, win over any version change in this batch.
      if (changes.length) throw Object.assign(new AssessmentContextChanged('candidate-target-snapshot'), { targetSnapshot: changes[0] });
      return true;
    },
  };
}

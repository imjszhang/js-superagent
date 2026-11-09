import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => /^\d+$/.test(String(value ?? '')) && Number(value) > 0;
const bounded = value => typeof value === 'string' && value.trim() && value.length <= 500;
export function reviewBudgetIdentity(binding, actorId) {
  if (!binding || !/^[\w.-]+\/[\w.-]+$/.test(binding.repository) || !positive(binding.id) || !positive(actorId)) throw new Error('Bot review budget requires stable PR and actor identities');
  return { repository: binding.repository, pullId: String(binding.id), pullNumber: binding.number, actorId: String(actorId) };
}
export const legacyReviewBudgetKey = binding => `bot-review:legacy:${binding.repository}:${binding.id}`;

/** One native review ID groups its submission and all inline findings. No body or time heuristics. */
export function botReviewRun(event) {
  if (positive(event.reviewId)) return `review:${event.reviewId}`;
  if (event.kind === 'review') {
    const id = event.remoteId ?? event.id?.split(':')[3];
    if (positive(id)) return `review:${id}`;
  }
  return null;
}

export class BotReviewBudget {
  constructor(store, { now = () => new Date().toISOString() } = {}) { this.store = store; this.now = now; }
  key(identity) { return `bot-review:budget:${digest([identity.repository, identity.pullId, identity.actorId])}`; }
  get(binding, actorId) {
    const identity = reviewBudgetIdentity(binding, actorId);
    return this.store.getMeta(this.key(identity)) ?? { version: 1, ...identity, revision: 0, limit: 3, rounds: [], history: [],
      historicalUnknown: !!this.store.getMeta(legacyReviewBudgetKey(binding)) };
  }
  list() { return this.store.listMeta('bot-review:budget:').map(row => row.value); }
  /** Outbound requests use the immutable account ID resolved from GitHub, never login-only state. */
  authorizeRequest(binding, actor) {
    if(!actor || !positive(actor.id) || typeof actor.login!=='string')throw new Error('Review recipient identity is unavailable');
    const record=this.get(binding,actor.id);
    const reason=record.historicalUnknown?'bot-review-history-unknown':record.rounds.length>=record.limit?'bot-review-round-limit':null;
    return {allowed:!reason,reason,used:record.rounds.length,limit:record.limit,actorId:String(actor.id)};
  }
  inspect(binding, event) {
    const record=this.get(binding,event.actor.id);
    const manual=this.store.getMeta(`bot-review:run:${digest([record.repository,record.pullId,record.actorId,event.commentVersion?.baseId??event.id.replace(/:v:[a-f\d]+$/,'')])}`);
    const runId=botReviewRun(event)??manual?.runId, existing=record.rounds.find(row=>row.runId===runId);
    const reason=record.historicalUnknown?'bot-review-history-unknown':!runId?'bot-review-run-unknown':!existing&&record.rounds.length>=record.limit?'bot-review-round-limit':null;
    return {allowed:!reason,reason,runId,number:existing?.number??null,used:record.rounds.length,limit:record.limit};
  }
  reserve(binding, event, ticketId) {
    return this.store.atomic(() => {
      const record = this.get(binding, event.actor.id), key = this.key(record);
      const manual = this.store.getMeta(`bot-review:run:${digest([record.repository, record.pullId, record.actorId, event.commentVersion?.baseId ?? event.id.replace(/:v:[a-f\d]+$/, '')])}`);
      const runId = botReviewRun(event) ?? manual?.runId;
      const existing = runId && record.rounds.find(row => row.runId === runId);
      let reason = record.historicalUnknown ? 'bot-review-history-unknown' : !runId ? 'bot-review-run-unknown'
        : !existing && record.rounds.length >= record.limit ? 'bot-review-round-limit' : null;
      const observation = { eventId: event.id, runId, ticketId, at: this.now(), reason };
      record.observations = [...(record.observations ?? []).filter(row => row.eventId !== event.id), observation].slice(-200);
      if (!reason) {
        const round = existing ?? { runId, number: record.rounds.length + 1, status: 'reserved', ticketIds: [], eventIds: [], at: this.now() };
        if (!round.eventIds.includes(event.id)) round.eventIds.push(event.id);
        if (!round.ticketIds.includes(ticketId)) round.ticketIds.push(ticketId);
        if (!existing) record.rounds.push(round);
      }
      record.revision++; record.updatedAt = this.now(); this.store.setMeta(key, record);
      return { allowed: !reason, reason, runId, number: existing?.number ?? (!reason ? record.rounds.length : null), used: record.rounds.length, limit: record.limit };
    });
  }
  initialize(binding, actorId, { remaining, reason, expectedRevision }) {
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 3 || !bounded(reason)) throw new Error('Set an explicit remaining budget of 0..3 with a reason');
    return this.store.atomic(() => {
      const record = this.get(binding, actorId);
      if (record.revision !== expectedRevision) throw new Error('Bot review budget revision conflict');
      record.history.push({ kind: record.historicalUnknown ? 'initialize-history' : 'set-remaining', remaining, reason, actor: 'local/operator', at: this.now() });
      record.historicalUnknown = false; record.limit = record.rounds.length + remaining;
      record.revision++; record.updatedAt = this.now(); this.store.setMeta(this.key(record), record); return record;
    });
  }
  associate(binding, actorId, { runId, events, reason }) {
    if (!bounded(runId) || !bounded(reason) || !Array.isArray(events) || !events.length || events.length > 100) throw new Error('A bounded explicit review-run association is required');
    const identity = reviewBudgetIdentity(binding, actorId);
    this.store.atomic(() => {
      for (const event of events) {
        if (String(event.actor.id) !== identity.actorId || event.repository !== identity.repository || event.pullNumber !== binding.number || event.ci) throw new Error('Review event identity mismatch');
        if (botReviewRun(event)) throw new Error('Native review identity cannot be overwritten');
        const key = `bot-review:run:${digest([identity.repository, identity.pullId, identity.actorId, event.commentVersion?.baseId ?? event.id.replace(/:v:[a-f\d]+$/, '')])}`;
        const previous = this.store.getMeta(key);
        if (previous && previous.runId !== `manual:${runId}`) throw new Error('A review event already belongs to another run');
        this.store.setMeta(key, { runId: `manual:${runId}`, reason, actor: 'local/operator', at: this.now() });
      }
    });
  }
  report(ticketId, { runId, summary, state, eventIds = [] }) {
    for (const record of this.list()) {
      let changed = false;
      for (const round of record.rounds) if (round.ticketIds.includes(ticketId) && round.eventIds.some(id => eventIds.includes(id))) {
        round.status = 'assessed'; round.disposition = { runId, summary: String(summary).slice(0, 2000), state,
          eventIds: round.eventIds.filter(id => eventIds.includes(id)), at: this.now() }; changed = true;
      }
      if (changed) { record.revision++; this.store.setMeta(this.key(record), record); }
    }
  }
}

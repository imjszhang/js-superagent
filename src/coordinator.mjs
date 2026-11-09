import { createHash } from 'node:crypto';
import { validatePolicyConfig } from './policy.mjs';
import { normalizeWorkRetry } from './runtime/coordination.mjs';
import { validateAssessment } from './runtime/assessment.mjs';
import { BUILTIN_ADAPTERS } from './harness/builtin.mjs';
import { validateCoordinatorConfig } from './harness/adapters/codex-app-server.mjs';
export { boundedCandidate, readContext, readContextRecord } from './context.mjs';
export { createRuntimePolicy, validatePolicyConfig, policyVersion, PolicyRegistry, policyImpact } from './policy.mjs';
export { candidateAssessmentSchema, validateAssessment } from './runtime/assessment.mjs';
export { validateCoordinatorConfig, createCodexAssessor } from './harness/adapters/codex-app-server.mjs';
export { createDshAssessor } from './harness/adapters/dsh-sdk.mjs';
export { createCursorAssessor } from './harness/adapters/cursor-agent.mjs';

/** Versioned opt-in coordination settings, separate from the legacy ProjectConfig contract. */
export class CoordinatorRegistry {
  constructor(store, { validateAssessor = validateCoordinatorConfig } = {}) { this.store = store; this.validateAssessor = validateAssessor; }
  current() {
    return this.store.getMeta('coordinator:settings') ?? { revision: 0, version: 'coordinator-disabled-v1', policy: validatePolicyConfig({}), assessor: null, workflowMode: 'candidates', at: null };
  }
  history() { return this.store.listMeta('coordinator:revision:').map(row => row.value).sort((a, b) => a.revision - b.revision); }
  update(value, { expectedRevision, onChange } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['policy', 'assessor', 'workflowMode', 'workRetry'].includes(key))) throw new Error('Coordinator settings accept policy, assessor, workflowMode and workRetry only');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision is required');
    return this.store.atomic(() => {
      const previous = this.current();
      if (previous.revision !== expectedRevision) throw new Error('Coordinator revision conflict; reload before saving');
      const policy = validatePolicyConfig(value.policy ?? previous.policy);
      const assessor = value.assessor === null ? null : value.assessor === undefined ? previous.assessor : this.validateAssessor(value.assessor);
      const workflowMode = value.workflowMode ?? previous.workflowMode ?? 'candidates';
      if (!['candidates', 'continuous'].includes(workflowMode)) throw new Error('Coordinator workflowMode must be candidates or continuous');
      if (policy.mode !== 'off' && !assessor) throw new Error('Observation requires a configured assessor');
      if (workflowMode === 'continuous' && !assessor) throw new Error('Continuous coordination requires a configured assessor');
      const workRetry = normalizeWorkRetry(value.workRetry ?? previous.workRetry);
      const version = `coordinator-v1:${createHash('sha256').update(JSON.stringify({ policy, assessor, ...(workflowMode === 'continuous' ? { workflowMode } : {}) })).digest('hex').slice(0, 24)}`;
      const next = { revision: previous.revision + 1, version, policy, assessor, workflowMode, workRetry, at: new Date().toISOString() };
      this.store.setMeta('coordinator:settings', next); this.store.setMeta(`coordinator:revision:${next.revision}`, next);
      onChange?.(previous, next);
      return next;
    });
  }
}

/** Apply under a single host transaction; stale model answers never mutate current work. */
export function applyAssessment({ engine, store, candidate, outcome, policy, onAccepted, onAnswer }) {
  outcome = validateAssessment(outcome, candidate);
  return store.atomic(() => {
    const triggerId = outcome.triggerId ?? candidate.triggers[0].id;
    const current = engine.candidate(triggerId);
    if (!current || current.evalId !== candidate.evalId || current.policyVersion !== candidate.policyVersion || policy.version !== candidate.policyVersion || policy.paused) {
      return { applied: false, reason: 'stale-or-paused-assessment' };
    }
    const normalized = policy.normalizeOutcome ? policy.normalizeOutcome(candidate, outcome) : outcome;
    if (normalized.kind === 'answer') {
      if (typeof onAnswer !== 'function') throw new Error('This host does not support coordinator answers');
      const reply = onAnswer(normalized, current);
      const decision = engine.decideTrigger(normalized.triggerId, { kind: 'ignore', reason: normalized.reason,
        evalId: candidate.evalId, audit: { coordinatorAnswer: { triggerId: normalized.triggerId, replyId: reply.id } } });
      return { applied: true, kind: 'answer', decision, reply };
    }
    if (normalized.kind === 'attach') {
      if (candidate.strength !== 'explicit' || !candidate.tickets.some(ticket => ticket.id === normalized.ticketId)) throw new Error('Invalid routing target');
      if (!policy.revalidate(store.tickets.get(normalized.ticketId).mandate)) throw new Error('Routing target mandate is no longer authorized');
      const ticket = engine.attach(normalized.ticketId, normalized.triggerId, normalized.note ?? normalized.reason);
      return { applied: true, kind: 'attach', ticket, triggerId: normalized.triggerId };
    }
    if (['ignore','unavailable'].includes(normalized.kind)) {
      const decision = engine.decideTrigger(normalized.triggerId ?? candidate.triggers[0].id, { ...normalized, evalId:candidate.evalId });
      return { applied:true, kind:decision.kind, decision };
    }
    const decision = engine.decide(candidate.triggers[0].id, { ...normalized, evalId: candidate.evalId });
    if (decision.kind === 'accept') onAccepted?.(store.tickets.get(decision.ticketId), decision, candidate);
    return { applied: true, kind: decision.kind, decision };
  });
}

/** Injected into the registry so role adapters do not depend on the domain runtime. */
export function createBuiltinAssessors() {
  return Object.fromEntries(BUILTIN_ADAPTERS.flatMap(adapter => adapter.assessor ? [[adapter.id, adapter.assessor]] : []));
}

import { randomUUID } from 'node:crypto';
import { boundedCandidate } from '../context.mjs';
import { candidateReferences, runBoundedAssessment } from '../context-requests.mjs';
import { workEventPrompt, workEventTurnSchema, runBoundedWorkEvent } from './coordination.mjs';
import { continuationSchema, continuationPrompt, validateContinuationDecision } from './continuation-assessment.mjs';
import { candidateAssessmentSchema, validateAssessment } from './assessment.mjs';

/** One read-only assessor over a single-turn runner. Prompt wording stays with the caller. */
export function createTurnAssessor({ config, runTurn, assessmentPrompt }) {
  return {
    config: structuredClone(config),
    async inspectContinuation(input) {
      const value = await runTurn({ kind: 'continuation', prompt: continuationPrompt(input.facts), schema: continuationSchema,
        session: input.session, runId: input.runId, timeoutMs: config.timeoutMs, checkpoint: input.checkpoint, registerProcess: input.registerProcess, input });
      return validateContinuationDecision(value, input.facts.source);
    },
    async handleEvent(input = {}) {
      const runId = input.runId ?? `coordination-${randomUUID()}`;
      if (!/^[a-zA-Z0-9_-]{1,110}$/.test(runId)) throw new Error('Invalid coordination runId');
      let session = input.session;
      return runBoundedWorkEvent(input, { timeoutMs: Math.min(config.timeoutMs, input.timeoutMs ?? config.timeoutMs),
        maxReads: config.contextLimits?.maxReads ?? 3, maxBytes: config.contextLimits?.readBytes ?? 32000,
        call: async ({ turn, facts, context, remainingMs }) => runTurn({ kind: 'event', prompt: workEventPrompt({ ...input, context, facts }, config.prompt),
          schema: workEventTurnSchema, session, runId: turn ? `${runId}-read-${turn}` : runId, timeoutMs: remainingMs,
          checkpoint: value => { session = value; input.checkpoint?.(value); }, registerProcess: input.registerProcess, input }),
      });
    },
    async assess(input = {}) {
      const runId = input.runId ?? `assessment-${randomUUID()}`;
      if (!/^[a-zA-Z0-9_-]{1,110}$/.test(runId)) throw new Error('Invalid assessment runId');
      if (!input.candidate?.evalId || !input.candidate.triggers?.length) throw new Error('Assessment candidate is required');
      let session = input.session;
      return runBoundedAssessment({ candidate: input.candidate, contextReferences: input.contextReferences,
        maxReads: config.contextLimits?.maxReads ?? 3, maxBytes: config.contextLimits?.readBytes ?? 32_000,
        readContextRecord: input.readContextRecord, signal: input.signal, timeoutMs: config.timeoutMs,
        call: async ({ turn, facts, remainingMs, contextReferences }) => {
          const snapshot = boundedCandidate(input.candidate);
          snapshot.availableRecords = Object.fromEntries(Object.entries(candidateReferences(input.candidate, contextReferences)).map(([resource, ids]) => [resource, [...ids].slice(0, 100)]));
          const value = await runTurn({ kind: 'assessment', prompt: assessmentPrompt({ config, snapshot, facts, rules: input.rules, schema: candidateAssessmentSchema }),
            schema: candidateAssessmentSchema, session, runId: turn ? `${runId}-read-${turn}` : runId, timeoutMs: remainingMs,
            checkpoint: value => { session = value; input.checkpoint?.(value); }, registerProcess: input.registerProcess ?? (() => {}), input });
          return value?.kind === 'read' ? value : validateAssessment(value, input.candidate);
        },
      });
    },
  };
}

import { randomUUID } from 'node:crypto';
import { boundedCandidate } from '../context.mjs';
import { candidateReferences, runBoundedAssessment } from '../context-requests.mjs';
import { workEventPrompt, workEventTurnSchema, runBoundedWorkEvent, WorkEventOutputError } from './coordination.mjs';
import { continuationSchema, continuationPrompt, validateContinuationDecision } from './continuation-assessment.mjs';
import { candidateAssessmentSchema, validateAssessmentTurn, AssessmentFormatError, assessmentFailure } from './assessment.mjs';
import { setTimeout as delay } from 'node:timers/promises';

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
        call: async ({ turn, facts, context, remainingMs, correction, corrections }) => {
          const basePrompt = workEventPrompt({ ...input, context, facts }, config.prompt);
          const prompt = correction ? `The previous coordination output was rejected before any action was applied. Correct its output contract: ${correction}. Preserve the operator intent and supplied authority; do not change targets or request new work to bypass the rejection. Return a complete corrected result, including accurate reply wording.\n\n${basePrompt}` : basePrompt;
          try {
            return await runTurn({ kind: 'event', prompt, schema: workEventTurnSchema, session,
              runId: `${turn ? `${runId}-read-${turn}` : runId}${correction ? `-correction-${corrections}` : ''}`, timeoutMs: remainingMs,
              checkpoint: value => { session = value; input.checkpoint?.(value); }, registerProcess: input.registerProcess, input });
          } catch (error) {
            // Only the adapter's model-JSON parser emits this type. Transport,
            // host checkpoint and live authority failures must not be repaired.
            if (error instanceof AssessmentFormatError) throw new WorkEventOutputError(error.message);
            throw error;
          }
        },
      });
    },
    async assess(input = {}) {
      const runId = input.runId ?? `assessment-${randomUUID()}`;
      if (!/^[a-zA-Z0-9_-]{1,110}$/.test(runId)) throw new Error('Invalid assessment runId');
      if (!input.candidate?.evalId || !input.candidate.triggers?.length) throw new Error('Assessment candidate is required');
      let session = input.session, attempts = 0, corrections = 0, retries = 0;
      const timeoutMs = Math.min(config.timeoutMs, input.timeoutMs ?? config.timeoutMs), deadline = Date.now() + timeoutMs;
      const progress = (phase, error) => input.onAssessmentAttempt?.({ attempts, corrections, retries, phase, ...(error ? { error: assessmentFailure(error) } : {}) });
      return runBoundedAssessment({ candidate: input.candidate, contextReferences: input.contextReferences,
        maxReads: config.contextLimits?.maxReads ?? 3, maxBytes: config.contextLimits?.readBytes ?? 32_000,
        readContextRecord: input.readContextRecord, signal: input.signal, timeoutMs,
        call: async ({ turn, facts, remainingMs, contextReferences }) => {
          const snapshot = boundedCandidate(input.candidate);
          snapshot.availableRecords = Object.fromEntries(Object.entries(candidateReferences(input.candidate, contextReferences)).map(([resource, ids]) => [resource, [...ids].slice(0, 100)]));
          const basePrompt = assessmentPrompt({ config, snapshot, facts, rules: input.rules, schema: candidateAssessmentSchema });
          let correction, localAttempts = 0;
          while (true) {
            if (input.signal?.aborted) throw input.signal.reason ?? new Error('Assessment cancelled');
            const budget = Math.min(remainingMs, deadline - Date.now());
            if (budget <= 0) {
              const error = new Error('Coordinator assessment time budget exhausted');
              Object.assign(error, { code: 'assessment_timeout', failureKind: 'timeout', retryable: true, attempts, corrections, exhausted: true }); throw error;
            }
            attempts++; localAttempts++; progress('running');
            try {
              const prompt = correction ? `The previous assessment was rejected before any action was applied. Correct only its output format: ${correction.message.slice(0, 1000)}. Preserve the authorized intent and scope; do not change targets or actions to bypass authority checks. Return a complete corrected assessment.\n\n${basePrompt}` : basePrompt;
              const suffix = localAttempts > 1 ? `-attempt-${attempts}` : '';
              const value = await runTurn({ kind: 'assessment', prompt, schema: candidateAssessmentSchema, session,
                runId: `${turn ? `${runId}-read-${turn}` : runId}${suffix}`, timeoutMs: budget,
                checkpoint: value => { session = value; input.checkpoint?.(value); }, registerProcess: input.registerProcess ?? (() => {}), input });
              if (input.signal?.aborted) throw input.signal.reason ?? new Error('Assessment cancelled');
              if (Date.now() >= deadline) { const error = new Error('Coordinator assessment time budget exhausted'); Object.assign(error, { code: 'assessment_timeout', failureKind: 'timeout', retryable: true }); throw error; }
              const outcome = validateAssessmentTurn(value, input.candidate);
              progress(outcome.kind === 'read' ? 'reading' : 'completed');
              return outcome;
            } catch (error) {
              Object.assign(error, { attempts, corrections, retries });
              if (input.signal?.aborted) throw error;
              if (error instanceof AssessmentFormatError) {
                if (corrections >= 2 || Date.now() >= deadline) { error.exhausted = true; throw error; }
                corrections++; correction = error; progress('correcting', error);
                continue;
              }
              if (assessmentFailure(error).failureKind === 'transient') {
                const waitMs = 250 * (2 ** retries);
                if (retries >= 2 || deadline - Date.now() <= waitMs) { error.exhausted = true; throw error; }
                retries++; progress('retrying', error);
                await delay(waitMs, undefined, { signal: input.signal });
                continue;
              }
              throw error;
            }
          }
        },
      });
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { codexAssessmentPrompt } from '../src/harness/adapters/codex-app-server.mjs';
import { dshAssessmentPrompt } from '../src/harness/adapters/dsh-sdk.mjs';
import { continuationPrompt } from '../src/runtime/continuation-assessment.mjs';
import { workEventPrompt } from '../src/runtime/coordination.mjs';
import { createTurnAssessor } from '../src/runtime/turn-assessor.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sample = { config: { prompt: 'Stay inside the ticket.' }, snapshot: { id: 'candidate' }, facts: [{ n: 1 }], rules: ['rule-a'] };
const facts = { scope: 'scope', source: { merged: false } };
const work = { event: { kind: 'operator' }, context: {}, facts: [] };

test('assessment prompts keep the previous Codex and DSH wording', () => {
  const codex = codexAssessmentPrompt(sample), dsh = dshAssessmentPrompt(sample);
  assert.equal(hash(codex), 'ed375afd3656cadb4e008302a6763303468bbecc03ce5abfa09fb60d4962d1e3');
  assert.equal(hash(dsh), '8e373016d534e05aa1cef589396b7af84e921f7fc43b46ef30ca606b140cddde');
  assert.match(codex, /Classify only supplied facts/);
  assert.match(dsh, /Classify only the supplied facts/);
  assert.match(codex, /ignore non-work/);
  assert.match(dsh, /Return one JSON object only matching this schema/);
  assert.equal(hash(continuationPrompt(facts)), '96a17fd7f544e7757f7aa4a4e5ccda24b8a20cbeabdddfdbb114357c9108d0d9');
  assert.equal(hash(workEventPrompt(work, 'Stay inside the ticket.')), '0cdf372511ab3f04cb736dc031ceb37975012dbdb3199f17e96ad75ab466976b');
  assert.match(workEventPrompt(work), /For reply and request actions, ticketId MUST be null/);
  assert.match(workEventPrompt(work), /local-only means.*NOT been delivered to Feishu/);
  assert.match(workEventPrompt(work), /An empty actions list is invalid/);
  assert.doesNotMatch(workEventPrompt(work), /or deliver Worker results/);
});

test('every turn assessor sends the shared continuation and work-event prompts', async () => {
  const seen = [];
  const assessor = createTurnAssessor({ config: { timeoutMs: 5000, prompt: 'Stay inside the ticket.' }, assessmentPrompt: () => 'assess',
    runTurn: async turn => { seen.push(turn.prompt); return turn.kind === 'event' ? { kind: 'result', summary: 'ok', actions: [], read: null } : { kind: 'reply', summary: 'ok', question: null, base: null }; } });
  await assessor.inspectContinuation({ projectRoot: '/tmp', runId: 'prompt-run', facts, registerProcess() {}, checkpoint() {} });
  await assessor.handleEvent({ projectRoot: '/tmp', runId: 'prompt-event', event: work.event, context: {}, signal: AbortSignal.timeout(5000) });
  assert.equal(seen[0], continuationPrompt(facts));
  assert.equal(seen[1], workEventPrompt({ event: work.event, context: {}, facts: [] }, 'Stay inside the ticket.'));
});

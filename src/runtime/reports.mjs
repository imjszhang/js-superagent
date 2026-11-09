import { ticketStage, latestAssignment } from '../../dist/core/index.js';
import { normalizeDecision } from './decisions.mjs';

export const REPORT_STATES = Object.freeze(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']);
const CAPABILITIES = ['structuredProgress', 'sessionResume', 'realtimeInput', 'inputAcknowledgements', 'backgroundTasks', 'subagents', 'agentTools', 'nativeBackgroundOwnership'];
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${name} must be a plain object`);
  }
}
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function artifacts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) throw new Error('report.artifacts must be an array of strings');
  return [...value];
}

/** Explicit declarations, never guesses based on a driver name or session checkpoint. */
export function driverCapabilities(driver = {}) {
  const declared = driver.capabilities ?? {};
  object(declared, 'driver.capabilities');
  const reportVersion = declared.reportVersion ?? driver.reportVersion ?? 2;
  if (reportVersion !== 2) throw new Error('Harness adapters require reportVersion 2');
  if (driver.reportVersion !== undefined && declared.reportVersion !== undefined && driver.reportVersion !== declared.reportVersion) {
    throw new Error('Conflicting Driver report versions');
  }
  const result = { reportVersion };
  if (declared.boundedContextVersion !== undefined) {
    if (declared.boundedContextVersion !== 1) throw new Error('Unknown bounded context version');
    result.boundedContextVersion = 1;
  }
  for (const key of CAPABILITIES) {
    if (declared[key] !== undefined && typeof declared[key] !== 'boolean') throw new Error(`driver.capabilities.${key} must be boolean`);
    result[key] = declared[key] === true;
  }
  if (result.structuredProgress && reportVersion !== 2) throw new Error('Structured progress requires reportVersion 2');
  if (result.inputAcknowledgements && !result.realtimeInput) throw new Error('Input acknowledgements require realtimeInput');
  return Object.freeze(result);
}

/** Validate the single adapter report contract. */
export function normalizeDriverReport(report, { version = 2 } = {}) {
  object(report, 'Driver report');
  const summary = nonempty(report.summary, 'report.summary');
  if (version !== 2 || report.version !== 2) throw new Error('A v2 Driver must return an explicit version: 2 report');
  const allowed = new Set(['version', 'state', 'summary', 'artifacts', 'attention', 'answers']);
  if (Object.keys(report).some(key => !allowed.has(key))) throw new Error('Unknown v2 report field');
  if (!REPORT_STATES.includes(report.state)) throw new Error('Unknown v2 report state');
  let attention;
  if (report.attention === null) attention = null;
  else if (report.attention !== undefined) {
    object(report.attention, 'report.attention');
    if (Object.keys(report.attention).some(key => !['question', 'triggerId', 'decision'].includes(key))) throw new Error('Unknown attention field');
    attention = { question: nonempty(report.attention.question, 'attention.question') };
    if (report.attention.triggerId !== undefined) attention.triggerId = nonempty(report.attention.triggerId, 'attention.triggerId');
    if (report.attention.decision !== undefined && report.attention.decision !== null) attention.decision = normalizeDecision(report.attention.decision);
    if (['ready', 'dropped'].includes(report.state)) throw new Error('A terminal result cannot also ask a question');
  }
  if (report.answers !== undefined) {
    nonempty(report.answers, 'report.answers');
    if (report.answers.length > 2000 || /[\0\r\n]/.test(report.answers)) throw new Error('Invalid answer trigger ID');
    if (attention) throw new Error('An answer cannot also ask a question');
    if (Buffer.byteLength(summary) > 32_000) throw new Error('Answer summary exceeds 32000 bytes');
  }
  return { version: 2, sourceVersion: 2, state: report.state, summary, artifacts: artifacts(report.artifacts),
    ...(report.answers === undefined ? {} : { answers: report.answers }),
    ...(attention === undefined ? {} : { attention }) };
}

/** Preserve the public ticket/history status projection, independent of adapter protocol. */
export function publicTicketReport(report) {
  if (!REPORT_STATES.includes(report.state)) throw new Error('Unknown normalized report state');
  return { status: ['ready', 'dropped'].includes(report.state) ? 'completed'
    : ['blocked', 'failed'].includes(report.state) ? 'failed' : 'waiting',
  summary: report.summary, artifacts: [...(report.artifacts ?? [])] };
}

/** Tool reports and final JSON must name the same question, including its original message. */
export function sameBusinessReport(staged, parsed) {
  if (!staged || !parsed) return !staged;
  const question = value => value.question ?? value.attention?.question ?? null;
  const directed = value => value.questionForTriggerId ?? value.attention?.triggerId ?? null;
  return JSON.stringify([staged.state, question(staged), directed(staged), staged.artifacts ?? [], staged.answers ?? null])
    === JSON.stringify([parsed.state, question(parsed), directed(parsed), parsed.artifacts ?? [], parsed.answers ?? null]);
}

/** Preserve v1's pending-input behavior; v2 attention is independent from an idle waiting report. */
export function domainReport(report, { hasPendingInput = false } = {}) {
  if (!REPORT_STATES.includes(report.state)) throw new Error('Unknown normalized report state');
  const result = { state: hasPendingInput && report.state === 'ready' ? 'waiting' : report.state, summary: report.summary };
  if (report.answers !== undefined) result.answers = report.answers;
  if (report.attention !== undefined) {
    result.question = report.sourceVersion === 1 && hasPendingInput ? null : report.attention?.question ?? null;
    if (result.question && report.attention.triggerId) result.askedBy = report.attention.triggerId;
  }
  return result;
}

/** Detailed state has a separate version and does not replace get/list's legacy status field. */
export function detailedTicketView({ domain, legacy, meta = {}, capabilities, execution } = {}) {
  object(domain, 'domain ticket'); object(legacy, 'legacy ticket');
  const assignment = latestAssignment(domain);
  const detail = { version: 2, ticket: structuredClone(legacy), ...ticketStage(domain),
    outcome: domain.ended?.outcome ?? null, reportState: assignment?.report?.state ?? null,
    attention: domain.attention ? structuredClone(domain.attention) : null,
    delivery: structuredClone(meta.delivery ?? domain.delivery ?? null),
    deliveryAttempt: structuredClone(meta.deliveryAttempt ?? null),
    sessionSettings: { execution: structuredClone(meta.executionConfig ?? null), revision: meta.executionRevision ?? null, promptVersion: meta.executionPromptVersion ?? null,
      pinOrigin: meta.executionPinOrigin ?? (meta.executionConfig ? 'session-start' : null) },
    verification: structuredClone(meta.verification ?? null),
    interrupted: meta.interrupted === true,
    failure: structuredClone(meta.failure ?? null),
    recovery: structuredClone(meta.recovery ?? null),
    nativeFacts: structuredClone(meta.nativeFacts ?? null),
    nativeResultRecoveredFrom: meta.nativeResultRecoveredFrom ?? null,
    heldFeedback: (meta.heldFeedback ?? []).map(input => ({ id: input.id, at: input.at,
      reason: meta.heldFeedbackRelease?.triggerIds.includes(input.id) ? 'runtime-paused'
        : meta.messages.find(message => message.triggerId === input.id)?.feedback?.reason ?? 'inspection-required' })),
    reports: structuredClone(meta.reportsV2 ?? []) };
  if (capabilities) detail.capabilities = structuredClone(capabilities);
  if (execution) detail.execution = structuredClone(execution);
  return detail;
}

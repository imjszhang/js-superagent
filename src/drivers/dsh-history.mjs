// Read-only parser for the explicitly supported DSH releases / session format v4.
// Never repairs/truncates a native log or edits the native pending inbox.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { hostToolSettled, nativeJsonResult, recoveryInspection } from './native-recovery.mjs';
import { isSupportedDshVersion } from './dsh-versions.mjs';
import { projectStateDirectory } from '../state-paths.mjs';
import { parseDshReport } from './dsh-report.mjs';
import { normalizeDriverReport } from '../runtime/reports.mjs';

export const dshDigest = value => createHash('sha256').update(value).digest('hex');
export const dshHostCallId = (sessionId, runId, nativeCallId) => `dsh-${createHash('sha256').update(JSON.stringify([sessionId, runId, nativeCallId])).digest('hex').slice(0, 40)}`;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
function file(path, maximum = 16 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('Unsafe DSH history file');
  return readFileSync(path, 'utf8');
}
function inside(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('DSH history escaped its session');
  return path;
}
export function dshSessionHome(source, session) {
  if (session?.driver !== 'dsh-sdk' || !id(session.id)) throw new Error('Invalid DSH recovery session');
  const state = projectStateDirectory(realpathSync(source)), home = join(state, 'harness', 'dsh', session.id);
  inside(state, home);
  if (lstatSync(home).isSymbolicLink()) throw new Error('Unsafe DSH session directory');
  return home;
}
export function readDshHistory(home, sessionId, cwd) {
  const root = inside(home, join(home, 'sessions')), matches = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const folder = join(root, project.name, sessionId);
    try {
      if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) continue;
      const path = inside(home, join(folder, 'session.v4.jsonl'));
      matches.push(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (matches.length !== 1) throw new Error('DSH native history is missing or ambiguous');
  const raw = file(matches[0]);
  if (!raw.endsWith('\n')) throw new Error('DSH native history has an uncommitted tail');
  const rows = raw.trimEnd().split('\n').map(line => JSON.parse(line)), header = rows.shift();
  if (header?.type !== 'session' || header.version !== 4 || header.id !== sessionId || realpathSync(header.cwd) !== realpathSync(cwd) || header.isSeeded !== false) throw new Error('Unsupported DSH native history binding');
  const inboxes = new Map(), messages = new Map(), calls = new Set(), jobs = new Set(), toolCalls = new Map(), toolResults = new Map();
  let previous = -1, assistant, terminal;
  for (const event of rows) {
    if (!Number.isSafeInteger(event.seq) || event.seq !== previous + 1 || !event.data || typeof event.type !== 'string') throw new Error('Unsupported or incomplete DSH event history');
    previous = event.seq;
    const data = event.data;
    if (event.type === 'agent/inbox/spliced') {
      if (!['next-turn', 'next-step'].includes(data.target) || !Number.isSafeInteger(data.start) || !Array.isArray(data.inserted)) throw new Error('Unknown DSH inbox record');
      const queue = inboxes.get(data.target) ?? [];
      if (data.start < 0 || data.start > queue.length || (data.removedCount !== undefined && (!Number.isSafeInteger(data.removedCount) || data.removedCount < 0 || data.removedCount > queue.length - data.start))) throw new Error('Invalid DSH inbox mutation');
      queue.splice(data.start, data.removedCount ?? 0, ...data.inserted); inboxes.set(data.target, queue);
    }
    if (event.type === 'user/message') messages.set(data.id, event);
    if (event.type === 'tool/call') { if (typeof data.callId !== 'string' || toolCalls.has(data.callId)) throw new Error('Invalid DSH tool call'); calls.add(data.callId); toolCalls.set(data.callId, event); }
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId;
      if (typeof callId !== 'string' || !calls.has(callId) || data.message?.meta?.outcome === 'unknown') throw new Error('Unmatched DSH tool result');
      // Native synthetic recovery results do not prove the outside action settled.
      if (JSON.stringify(data).includes('TOOL_OUTCOME_UNKNOWN') || JSON.stringify(data).includes('tool_outcome_unknown')) throw new Error('Unknown DSH tool outcome');
      calls.delete(callId); toolResults.set(callId, event);
    }
    if (event.type === 'job/registered') {
      if (typeof data.jobId !== 'string' || jobs.has(data.jobId) || data.owner !== sessionId) throw new Error('Invalid DSH job registration');
      jobs.add(data.jobId);
    }
    if (event.type === 'job/settled') {
      if (!jobs.has(data.jobId) || data.owner !== sessionId || !['completed','killed','failed'].includes(data.status)) throw new Error('Unmatched DSH job settlement');
      jobs.delete(data.jobId);
    }
    if (event.type === 'assistant/message') assistant = event;
    if (event.type === 'turn/end') terminal = event;
  }
  return { sessionId, rows, messages, pending: [...inboxes.values()].flat(), calls, jobs, toolCalls, toolResults, assistant, terminal, eventSequence: previous, path: matches[0] };
}
export function inspectDshInputReceipts(history, receipts) {
  const reconciled = {}, unresolved = [];
  for (const [inputId, item] of Object.entries(receipts)) {
    const candidates = item.messageId ? [history.messages.get(item.messageId)].filter(Boolean) : [...history.messages.values()].filter(event => {
      const text = (event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      return dshDigest(text) === item.nativeDigest;
    });
    if (candidates.length > 1) throw new Error('DSH input consumption identity is ambiguous');
    const matching = candidates[0];
    if (matching && dshDigest((matching.data.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')) !== item.nativeDigest) throw new Error('DSH consumed input identity mismatch');
    if (matching) reconciled[inputId] = { ...item, state: 'read', messageId: matching.data.id, evidence: { type: 'native-user-message', driver: 'dsh-sdk', sessionId: history.sessionId,
      messageId: matching.data.id, eventSequence: matching.seq, runId: item.runId, inputId } };
    else if (item.state === 'read') throw new Error('DSH consumed receipt missing from native history');
    else {
      const pending = history.pending.filter(message => (!item.messageId || message.id === item.messageId) && dshDigest((message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')) === item.nativeDigest);
      // A send whose response disappeared cannot be proven absent merely by an older durable log.
      unresolved.push({ inputId, state: pending.length === 1 ? 'accepted' : 'unknown',
        ...(pending.length === 1 ? { messageId: pending[0].id, nativeDigest: item.nativeDigest, sourceRunId: item.runId } : {}) }); reconciled[inputId] = item;
    }
  }
  return { reconciled, unresolved };
}
export function inspectDshRecovery(options, input) {
  const reject = reason => recoveryInspection(input, reason);
  try {
    if (input.signal?.aborted || !id(input.runId)) return reject('recovery-cancelled-or-invalid');
    const home = dshSessionHome(input.sourceProjectRoot, input.session), binding = JSON.parse(file(join(home, 'binding.json'), 65536));
    if (!isSupportedDshVersion(binding.nativeVersion) || binding.adapter !== 'dsh-sdk' || binding.cwd !== realpathSync(input.projectRoot) || binding.model !== options.model || JSON.stringify(binding.backend) !== JSON.stringify(options.backend) || binding.permission !== options.permission || binding.promptDigest !== dshDigest(options.prompt ?? '') || !!binding.agentTools !== !!options.enableAgentTools || !!binding.managedJobs !== !!options.enableManagedJobs) return reject('native-history-binding-mismatch');
    const anchor = JSON.parse(file(join(home, `run-${input.runId}.json`), 65536));
    if (anchor.sessionId !== input.session.id || anchor.runId !== input.runId || anchor.nativeVersion !== binding.nativeVersion) return reject('native-run-anchor-mismatch');
    const latest = JSON.parse(file(join(home, 'latest-run.json'), 65536));
    if (latest.runId !== input.runId || latest.sessionId !== input.session.id) return reject('native-run-is-not-latest');
    const history = readDshHistory(home, input.session.id, input.projectRoot);
    const origins = [...history.messages.values()].filter(event => (!anchor.messageId || event.data.id === anchor.messageId) && dshDigest((event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')) === anchor.promptDigest);
    const origin = origins.length === 1 ? origins[0] : null;
    const start = anchor.adoption ? anchor.startSequence : origin?.seq;
    if (!Number.isSafeInteger(start) || start < -1) return reject('native-run-anchor-missing');
    if (history.calls.size || history.jobs.size) return reject('native-tools-or-jobs-unsettled');
    const anchors = [anchor];
    const anchorNames = readdirSync(home).filter(name => /^run-[A-Za-z0-9_-]+\.json$/.test(name));
    if (anchorNames.length > 2048) return reject('native-anchor-budget-exceeded');
    for (const name of anchorNames) {
      if (name === `run-${input.runId}.json`) continue;
      const value = JSON.parse(file(join(home, name), 65536));
      if (value.sessionId !== input.session.id || !id(value.runId)) return reject('native-history-binding-mismatch');
      const message = value.messageId && history.messages.get(value.messageId);
      // Resume does not replay historical events over RPC, so its pre-prompt
      // sequence may be -1. The consumed original message is the durable run
      // boundary for ordinary runs; only adoption uses a no-message boundary.
      const boundary = value.adoption ? value.startSequence : message?.seq ?? value.startSequence;
      if (Number.isSafeInteger(boundary)) anchors.push({ ...value, startSequence: boundary });
    }
    const boundaries = anchors.map(value => ({ ...value, startSequence: value === anchor ? start : value.startSequence })).sort((a, b) => a.startSequence - b.startSequence);
    for (const [callId, call] of history.toolCalls) {
      if (!call.data.name?.startsWith('js_superagent_')) continue;
      // Old read/report calls cannot affect this turn; old job starts may still own outside work.
      if (call.seq < start && call.data.name !== 'js_superagent_job_start') continue;
      const owner = boundaries.filter(value => value.startSequence < call.seq).at(-1), result = history.toolResults.get(callId);
      if (!owner || !result || result.data.message?.isError) return reject('host-tool-receipt-unverified');
      let args, value;
      try { args = JSON.parse(call.data.arguments); value = nativeJsonResult(result.data.message?.content); } catch { return reject('native-host-tool-format-unsupported'); }
      if (!hostToolSettled(input.verifyHostTool, { driver: 'dsh-sdk', runId: owner.runId, sessionId: input.session.id, turnId: owner.runId,
        nativeCallId: callId, callId: dshHostCallId(input.session.id, owner.runId, callId), name: call.data.name, arguments: args, result: value })) return reject('host-tool-receipt-unverified');
    }
    let receipts = {}; try { receipts = JSON.parse(file(join(home, 'input-receipts.json'), 1024 * 1024)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const checked = inspectDshInputReceipts(history, receipts);
    if (checked.unresolved.some(item => item.state !== 'accepted')) return reject('native-input-outcome-unknown');
    const ownedMessages = new Set(Object.values(checked.reconciled).map(item => item.messageId));
    for (const item of checked.unresolved) ownedMessages.add(item.messageId);
    if ([...history.messages.values()].some(event => event.seq > start && event.data.source?.kind === 'user' && !ownedMessages.has(event.data.id))) return reject('native-unowned-human-input');
    // Host delivery may have been interrupted before its own receipt commit.
    // Only native consumption can turn that unknown delivery into read.
    if ((input.inputs ?? []).some(item => !['read', 'queued', 'not-sent', 'rejected'].includes(item.status) && checked.reconciled[item.inputId]?.state !== 'read' && !checked.unresolved.some(pending => pending.inputId === item.inputId && pending.state === 'accepted'))) return reject('native-input-unresolved');
    const result = { version: 1, kind: 'interrupted', safeToResume: true, toolsSettled: true, session: input.session,
      checkpoint: { runId: input.runId, eventSequence: history.eventSequence }, code: 'HISTORY_VERIFIED', outcome: 'resume',
      readInputIds: Object.entries(checked.reconciled).filter(([key,item]) => item.state === 'read' && (item.runId === input.runId || anchor.adoption?.pending?.some(pending => pending.inputId === key))).map(([key]) => key),
      ...(Array.isArray(anchor.contextRecords) ? { contextRecords: anchor.contextRecords } : {}) };
    if (history.pending.length) {
      const pending = checked.unresolved;
      if (pending.length !== history.pending.length || new Set(pending.map(item => item.messageId)).size !== pending.length ||
          pending.some(item => !(input.inputs ?? []).some(allowed => allowed.inputId === item.inputId && !['rejected', 'not-sent'].includes(allowed.status)))) return reject('native-pending-input-not-authorized');
      // Both supported releases restore the inbox without a public no-input wake API.
      // Returning an adoption proof here would lead resume/wait to report idle
      // and shutdown to cancel this queue. Keep the native files untouched.
      const inspection = reject('native-pending-wakeup-unsupported');
      return inspection && { ...inspection, nativeVersion: binding.nativeVersion, pendingInputs: { sourceRunId: input.runId,
        sessionId: input.session.id, eventSequence: history.eventSequence,
        pending: pending.map(({ inputId, messageId, nativeDigest, sourceRunId }) => ({ inputId, messageId, nativeDigest, sourceRunId })) } };
    }
    if (checked.unresolved.length) return reject('native-input-unresolved');
    const end = history.terminal, answer = history.assistant;
    const requiredSequence = Math.max(start, ...Object.values(checked.reconciled).filter(item => item.runId === input.runId || anchor.adoption?.pending?.some(pending => pending.inputId === item.evidence?.inputId)).map(item => item.evidence?.eventSequence ?? -1));
    if (end?.seq > requiredSequence && end.data.reason?.kind === 'completed' && answer?.seq > requiredSequence && answer.seq < end.seq && answer.data.turn === end.data.turn && !answer.data.interrupted) {
      const content = answer.data.message?.content ?? [];
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      // A durable, settled completed turn can still lack its business result.
      // Preserve the distinction from unreadable history and continue the same
      // session under the host's bounded repair policy; never replay its tools.
      const repair = finalReportFailure => {
        if (content.some(block => block.type === 'tool-call') || history.rows.some(event => event.seq > answer.seq && ['tool/result', 'job/settled'].includes(event.type))) return reject('native-result-predates-tool-completion');
        return { ...result, finalReportFailure };
      };
      if (!text.trim()) return repair('missing-final-report');
      let report;
      try { report = parseDshReport(text); normalizeDriverReport(report, { version: 2 }); }
      catch { return repair('invalid-final-report'); }
      return { ...result, outcome: 'completed', report };
    }
    if (end?.seq > start && !(end.data.reason?.kind === 'error' && ['RATE_LIMIT','SERVER','TIMEOUT'].includes(end.data.reason.error?.code))) return reject('native-terminal-does-not-allow-resume');
    return result;
  } catch { return reject('native-history-unavailable'); }
}

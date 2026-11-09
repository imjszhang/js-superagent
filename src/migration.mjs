import { hostname } from 'node:os';
import { key, threadKey } from '../dist/core/index.js';

const STATUSES = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);
const REPORT_STATUSES = new Set(['completed', 'waiting', 'failed', 'interrupted']);
function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid legacy ${name}`);
}
function time(value, name) {
  string(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid legacy ${name}`);
}
function validate(record, projectId) {
  if (!record || typeof record !== 'object') throw new Error('Invalid legacy ticket');
  for (const name of ['id', 'projectId', 'text', 'scope']) string(record[name], name);
  if (record.projectId !== projectId) throw new Error(`Legacy ticket ${record.id} belongs to a different project`);
  if (!STATUSES.has(record.status)) throw new Error(`Unknown legacy status: ${record.status}`);
  if (typeof record.cancelRequested !== 'boolean') throw new Error('Invalid legacy cancelRequested');
  time(record.createdAt, 'createdAt'); time(record.updatedAt, 'updatedAt');
  if (record.runId !== null) string(record.runId, 'runId');
  if (!Array.isArray(record.messages) || !record.messages.length) throw new Error('Invalid legacy messages');
  for (const message of record.messages) {
    if (!message || typeof message !== 'object') throw new Error('Invalid legacy message');
    string(message.text, 'message.text'); time(message.at, 'message.at');
  }
  if (!Array.isArray(record.reports)) throw new Error('Invalid legacy reports');
  for (const report of record.reports) {
    if (!report || !REPORT_STATUSES.has(report.status)) throw new Error('Invalid legacy report.status');
    // v1 could persist an empty summary when a driver threw Error(''); retain it verbatim.
    if (typeof report.summary !== 'string') throw new Error('Invalid legacy report.summary');
    string(report.runId, 'report.runId'); time(report.at, 'report.at');
    if (report.artifacts !== undefined && (!Array.isArray(report.artifacts) || report.artifacts.some(item => typeof item !== 'string'))) {
      throw new Error('Invalid legacy report.artifacts');
    }
  }
  if (record.status === 'running') {
    const owner = record.owner;
    if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      throw new Error(`Cannot migrate running legacy ticket ${record.id}: execution owner cannot be verified`);
    }
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return record.cancelRequested ? 'cancelled' : 'interrupted';
      throw new Error(`Cannot migrate running legacy ticket ${record.id}: execution owner cannot be verified`, { cause: error });
    }
    throw new Error(`Cannot migrate running legacy ticket ${record.id}: execution owner is still alive`);
  }
  // A persisted stop withdrew authorization even if v1 crashed before settling its status.
  return record.cancelRequested ? 'cancelled' : record.status;
}

/** Import v1 local records atomically, preserving public identities and untouched archival rows. */
export function migrateLegacy(store, effects, projectId) {
  string(projectId, 'projectId');
  return store.atomic(() => {
    if (store.getMeta('legacy-imported') === true) return;
    const records = store.legacyList();
    // Validate the entire input before producing any replacement state or effects.
    const statuses = records.map(record => validate(record, projectId));
    records.forEach((old, index) => {
      if (store.tickets.get(old.id) || store.getMeta(`ticket:${old.id}`) !== undefined) {
        throw new Error(`Legacy ticket identity collision: ${old.id}`);
      }
      const status = statuses[index];
      const actor = { source: 'local', id: 'operator' };
      const ref = { source: 'local', id: `legacy:${old.id}` };
      const thread = threadKey(ref);
      const inputs = old.messages.map((message, messageIndex) => {
        const triggerId = key('legacy-trigger', projectId, old.id, String(messageIndex));
        store.triggers.save({
          id: triggerId, source: 'local', threads: [ref], actor, human: true,
          at: message.at, text: message.text, meta: { migration: 'legacy-import', originalTicketId: old.id, messageIndex },
        });
        store.triggers.saveDisposition(triggerId, { fanout: [old.id], at: message.at });
        return { id: key('input', old.id, 'trigger', triggerId), kind: 'trigger', triggerId, at: message.at, human: true, readAt: null };
      });
      const decisionId = key('legacy-decision', projectId, old.id);
      const mandate = { strength: 'explicit', policyVersion: 'local-v1', basis: { via: 'listed', sender: 'operator' }, actor, scope: old.scope };
      const assignment = { id: key('legacy-assignment', projectId, old.id, old.runId ?? 'pending'), state: status === 'queued' ? 'pending' : 'running', createdAt: old.createdAt };
      if (status !== 'queued') assignment.startedAt = old.createdAt;
      const previous = old.reports.at(-1);
      if (status === 'waiting') assignment.report = { state: 'waiting', summary: previous?.summary ?? 'Awaiting the operator response from the legacy task.', at: old.updatedAt };
      if (status === 'failed' || status === 'interrupted') assignment.report = {
        state: 'failed', summary: status === 'interrupted'
          ? 'Legacy execution was interrupted. Inspect external effects before explicitly retrying.'
          : previous?.summary ?? 'The legacy task failed; inspect it before explicitly retrying.',
        at: old.updatedAt,
      };
      const ticket = {
        id: old.id, title: old.text, decisionId, mandate, channels: [], assignments: [assignment], inputs,
        undelivered: ['queued', 'failed', 'interrupted'].includes(status) ? inputs.map(input => input.id) : [],
        createdAt: old.createdAt, updatedAt: old.updatedAt,
        origin: { triggerId: inputs[0].triggerId, triggerIds: [inputs[0].triggerId] },
      };
      if (status === 'waiting') ticket.attention = { id: key('legacy-attention', projectId, old.id), question: assignment.report.summary };
      if (status === 'completed' || status === 'cancelled') {
        ticket.ended = { by: status === 'cancelled' ? 'human' : 'executor', outcome: status === 'cancelled' ? 'stopped' : 'completed', at: old.updatedAt, reason: 'Imported legacy terminal state' };
        assignment.state = 'ended'; assignment.endedAt = old.updatedAt; assignment.endedReason = 'legacy-import';
        if (status === 'completed') assignment.report = { state: 'ready', summary: previous?.summary ?? 'Legacy task completed.', at: old.updatedAt };
      }
      store.threads.save({ key: thread, ref, createdAt: old.createdAt, lastAt: old.messages.at(-1).at,
        subscriptions: status === 'cancelled' ? [] : [old.id], correlated: [], pending: [], meta: { migration: 'legacy-import' } });
      store.decisions.save({ id: decisionId, evalId: key('legacy-eval', projectId, old.id), threadKey: thread,
        triggerIds: [inputs[0].triggerId], policyVersion: 'local-v1', at: old.createdAt, kind: 'accept',
        reason: [{ code: 'legacyImport' }], strength: 'explicit', ticketId: old.id, mandate,
        audit: { migration: 'legacy-import', schemaVersion: 1, originalStatus: old.status, modelAssessment: false } });
      store.tickets.save(ticket);
      store.setMeta(`ticket:${old.id}`, {
        id: old.id, domainId: old.id, projectId, text: old.text, createdAt: old.createdAt, updatedAt: old.updatedAt,
        messages: old.messages, reports: old.reports, runId: old.runId,
        interrupted: status === 'interrupted', threadId: ref.id,
      });
      store.setMeta(`public:${old.id}`, old.id);
      if (status === 'queued') effects.enqueue('launch', assignment.id, { ticketId: old.id, assignmentId: assignment.id });
    });
    store.setMeta('legacy-imported', true);
  });
}

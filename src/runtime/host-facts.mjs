import { createHash } from 'node:crypto';

const PREFIX = 'host-facts:';
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function identifier(value, name, max = 160) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)) fail('HOST_FACTS_INVALID', `Invalid host facts ${name}`);
  return value;
}
function json(value, depth = 0) {
  if (depth > 8) fail('HOST_FACTS_INVALID', 'Host facts are too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 2000 && !value.includes('\0')) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(item => json(item, depth + 1));
  if (object(value) && Object.keys(value).length <= 100) return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('HOST_FACTS_INVALID', 'Invalid host facts field');
    return [key, json(value[key], depth + 1)];
  }));
  fail('HOST_FACTS_INVALID', 'Host facts must contain bounded JSON data');
}

export function normalizeHostReference(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['producer', 'taskId', 'runId', 'kind'].includes(key))) fail('HOST_FACTS_INVALID', 'Invalid host reference');
  return Object.fromEntries(['producer', 'taskId', 'runId', 'kind'].map(key => [key, identifier(value[key], key)]));
}

export function normalizeCancellation(value = {}) {
  if (!object(value) || Object.keys(value).some(key => !['source', 'reason', 'expectedDomainId', 'expectedAssignmentId', 'reference'].includes(key))) fail('HOST_FACTS_INVALID', 'Invalid cancellation provenance');
  const source = identifier(value.source ?? 'local', 'cancellation source');
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000 || value.reason.includes('\0'))) fail('HOST_FACTS_INVALID', 'Invalid cancellation reason');
  return { source, reason: value.reason ?? 'Explicit local cancellation',
    ...(value.expectedDomainId === undefined ? {} : { expectedDomainId: identifier(value.expectedDomainId, 'domainId') }),
    ...(value.expectedAssignmentId === undefined ? {} : {expectedAssignmentId:identifier(value.expectedAssignmentId,'assignmentId')}),
    ...(value.reference === undefined ? {} : { reference: json(value.reference) }) };
}

/** Host-owned query copies only. This module never creates work or interprets business state. */
export function publishHostFacts(store, input, { projectId, proof = null, now, commit = true }) {
  if (!object(input) || Object.keys(input).some(key => !['scope', 'producer', 'key', 'sourceVersion', 'observedAt', 'facts', 'ticketId', 'domainId', 'assignmentId'].includes(key))) fail('HOST_FACTS_INVALID', 'Invalid host facts record');
  const { scope } = input;
  if (!['project', 'ticket'].includes(scope)) fail('HOST_FACTS_INVALID', 'Invalid host facts scope');
  const producer = identifier(input.producer, 'producer'), key = identifier(input.key, 'key');
  const sourceVersion = identifier(input.sourceVersion, 'sourceVersion', 200);
  if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString() !== input.observedAt) fail('HOST_FACTS_INVALID', 'observedAt must be a canonical ISO timestamp');
  if (!object(input.facts)) fail('HOST_FACTS_INVALID', 'Host facts must be an object');
  const facts = json(input.facts);
  if (Buffer.byteLength(JSON.stringify(facts)) > 8192) fail('HOST_FACTS_INVALID', 'Host facts exceed 8192 bytes');
  const identity = scope === 'ticket' ? { ticketId: identifier(input.ticketId, 'ticketId'), domainId: identifier(input.domainId, 'domainId'),assignmentId:identifier(input.assignmentId,'assignmentId') } : {};
  if (scope === 'project' && (input.ticketId !== undefined || input.domainId !== undefined || input.assignmentId !== undefined)) fail('HOST_FACTS_INVALID', 'Project facts cannot claim a ticket identity');
  const id = digest([projectId, scope, producer, key, identity.ticketId ?? null, identity.domainId ?? null,identity.assignmentId??null]);
  const semanticVersion = digest({ sourceVersion, facts }), previous = store.getMeta(PREFIX + id);
  if (previous?.version === semanticVersion) return { status: 'unchanged', record: structuredClone(previous.record) };
  if (previous && input.observedAt < previous.record.observedAt) return { status: 'stale', record: structuredClone(previous.record) };
  if (previous && input.observedAt === previous.record.observedAt) fail('HOST_FACTS_CONFLICT', 'Different facts share the same observation timestamp');
  const record = { id, scope, producer, key, ...identity, sourceVersion, observedAt: input.observedAt, recordedAt: typeof now === 'function' ? now() : now, facts };
  if(commit)store.setMeta(PREFIX + id, { version: semanticVersion, proof, record });
  return { status: 'stored', record: structuredClone(record) };
}

export function hostFactRows(store, filters = {}) {
  if (!object(filters) || Object.keys(filters).some(key => !['scope', 'producer', 'ticketId'].includes(key))) fail('HOST_FACTS_INVALID', 'Invalid host facts filter');
  if (filters.scope !== undefined && !['project', 'ticket'].includes(filters.scope)) fail('HOST_FACTS_INVALID', 'Invalid host facts scope');
  for (const key of ['producer', 'ticketId']) if (filters[key] !== undefined) identifier(filters[key], key);
  return store.listMeta(PREFIX).map(row => row.value).filter(row => Object.entries(filters).every(([key, value]) => row.record[key] === value))
    .sort((a, b) => a.record.id.localeCompare(b.record.id));
}

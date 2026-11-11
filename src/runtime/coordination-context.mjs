import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowVersion = row => digest({ value: row.value, card: row.card });
const RESOURCES = ['tickets', 'threads', 'triggers', 'decisions', 'requests'];
const tables = { threads: 'domain_threads', triggers: 'domain_triggers', decisions: 'domain_decisions' };

/** Project records only. Native transcripts, execution config and credentials never enter this reader. */
export function createCoordinationReader(store, { ticketCard, allowTicket = () => true, allowSharedRecords = true, requestCards = () => [], maxReads = 3, maxBytes = 32000 } = {}) {
  let reads = 0, bytes = 0;
  const readSet = [], tickets = new Map(), requests = new Map();
  function rows(resource) {
    if (resource === 'requests') return requestCards().map(card => ({ id: card.triggerId, value: card, request: card }));
    if (resource === 'tickets') return store.listMeta('ticket:').flatMap(({ value: meta }) => {
      const domain = store.tickets.get(meta.domainId); if (!domain || !allowTicket(meta, domain)) return [];
      const value = { id: meta.id, domainId: domain.id, title: domain.title, mandate: domain.mandate, origin: domain.origin,
        inputs: domain.inputs, assignments: domain.assignments, attention: domain.attention ?? null, ended: domain.ended ?? null,
        threads: domain.threads, follows: domain.follows, failure: meta.failure ?? null,
        messages: (meta.messages ?? []).map(({ text, at, triggerId, superseded, feedback }) => ({ text, at, triggerId, superseded, feedback })) };
      return [{ id: meta.id, value, card: ticketCard(meta, domain) }];
    });
    if (!allowSharedRecords) return [];
    return store.db.prepare(`SELECT id,data FROM ${tables[resource]} ORDER BY id`).all().map(row => ({ id: row.id, value: JSON.parse(row.data) }));
  }
  function calculate(request, includeText = true) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['resource', 'recordId', 'query', 'cursor', 'offset'].includes(key)) || !RESOURCES.includes(request.resource)) throw new Error('Invalid coordination read');
    const resource = request.resource, all = rows(resource).sort((a, b) => a.id.localeCompare(b.id));
    if (request.recordId != null) {
      if (typeof request.recordId !== 'string' || request.recordId.length > 1024 || request.query != null || request.cursor != null) throw new Error('Invalid coordination record read');
      const row = all.find(row => row.id === request.recordId || resource === 'tickets' && row.value.domainId === request.recordId);
      if (!row) return { resource, id: request.recordId, version: digest(null), missing: true };
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new Error('Invalid coordination read offset');
      const full = JSON.stringify(row.value);
      return { resource, id: row.id, version: rowVersion(row), offset,
        ...(includeText ? { text: full.slice(offset, offset + 4000) } : {}),
        nextOffset: offset + 4000 < full.length ? offset + 4000 : null, length: full.length,
        ...(row.card ? { tickets: [row.card] } : {}), ...(row.request ? { requests: [row.request] } : {}) };
    }
    const query = request.query ?? '';
    if (typeof query !== 'string' || query.length > 200 || Buffer.byteLength(query) > 300 || /[\u0000-\u001f\u007f]/.test(query) || request.offset != null) throw new Error('Invalid coordination search');
    const normalized = query.trim().toLowerCase();
    const matches = all.filter(row => JSON.stringify(row.value).toLowerCase().includes(normalized));
    const version = digest(matches.map(row => [row.id, rowVersion(row)]));
    let offset = 0;
    if (request.cursor != null) {
      if (typeof request.cursor !== 'string' || request.cursor.length > 2048) throw new Error('Invalid coordination search cursor');
      let cursor; try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url')); } catch { throw new Error('Invalid coordination search cursor'); }
      if (cursor.resource !== resource || cursor.query !== normalized || cursor.version !== version || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('Context record changed; restart the search');
      offset = cursor.offset;
    }
    const selected = matches.slice(offset, offset + 10);
    return { resource, query: normalized, version, total: matches.length,
      items: selected.map(row => ({ id: row.id, version: rowVersion(row), ...(includeText ? { preview: JSON.stringify(row.value).slice(0, 350) } : {}) })),
      nextCursor: offset + 10 < matches.length ? Buffer.from(JSON.stringify({ resource, query: normalized, version, offset: offset + 10 })).toString('base64url') : null,
      ...(resource === 'tickets' ? { tickets: selected.map(row => row.card) } : {}),
      ...(resource === 'requests' ? { requests: selected.map(row => row.request) } : {}) };
  }
  return {
    read(request) {
      if (++reads > maxReads) throw new Error('Coordination read budget exhausted');
      const result = calculate(request);
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > maxBytes) throw new Error('Coordination context byte budget exhausted');
      readSet.push({ request: structuredClone(request), version: result.version });
      for (const card of result.tickets ?? []) tickets.set(card.id, card);
      for (const card of result.requests ?? []) requests.set(card.triggerId, card);
      return structuredClone(result);
    },
    verify() {
      for (const item of readSet) if (calculate(item.request, false).version !== item.version) throw new Error('Coordination context or policy changed; reassessment required');
      return true;
    },
    tickets() { return [...tickets.values()]; },
    requests() { return [...requests.values()]; },
    records() { return structuredClone(readSet); },
  };
}

import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function clip(value, limit) { return typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value; }
function ticketCard(ticket, textLimit) {
  return { id: ticket.id, title: ticket.title, scope: clip(ticket.mandate?.scope, textLimit), strength: ticket.mandate?.strength,
    stage: ticket.stage, ended: ticket.ended ?? null, attention: ticket.attention ?? null,
    latestReport: ticket.assignments?.at(-1)?.report ?? null, threads: ticket.threads, version: digest(ticket) };
}

/** A bounded view with omissions and durable references, never a replacement for source facts. */
export function boundedCandidate(candidate, { maxTriggers = 20, maxTickets = 20, textLimit = 4000 } = {}) {
  for (const [key, val] of Object.entries({ maxTriggers, maxTickets, textLimit })) if (!Number.isSafeInteger(val) || val < 1 || val > (key === 'textLimit' ? 16_000 : 100)) throw new Error(`Invalid ${key}`);
  const triggers = candidate.triggers.slice(-maxTriggers).map(trigger => ({ id: trigger.id, source: trigger.source, actor: trigger.actor,
    human: trigger.human, addressed: trigger.addressed, at: trigger.at, text: clip(trigger.text, textLimit), threads: trigger.threads,
    url: trigger.url, version: digest(trigger), textTruncated: trigger.text.length > textLimit }));
  return { evalId: candidate.evalId, policyVersion: candidate.policyVersion, strength: candidate.strength,
    thread: { key: candidate.thread.key, ref: candidate.thread.ref }, triggers,
    tickets: candidate.tickets.slice(0, maxTickets).map(ticket => ticketCard(ticket, textLimit)),
    ...(candidate.ticketReferences?.length ? { ticketReferences: candidate.ticketReferences.filter(reference => candidate.tickets.slice(0,maxTickets).some(ticket => ticket.id === reference.ticketId)) } : {}),
    coverage: { triggerCount: candidate.triggers.length, omittedTriggers: Math.max(0, candidate.triggers.length - maxTriggers),
      ticketCount: candidate.tickets.length, omittedTickets: Math.max(0, candidate.tickets.length - maxTickets),
      candidateVersion: digest(candidate), instruction: 'Do not assume omitted history is empty. Use unavailable if omitted facts prevent a decision.' } };
}

const tables = { tickets: 'domain_tickets', threads: 'domain_threads', decisions: 'domain_decisions', triggers: 'domain_triggers' };
/** Paginated read-only SDK resource. Each result identifies the full immutable/current record. */
export function readContext(store, resource, { cursor, limit = 20, textLimit = 4000, query = '', projectForSearch } = {}) {
  if (!Object.hasOwn(tables, resource)) throw new Error('Unknown context resource');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Context limit must be 1 to 100');
  if (!Number.isSafeInteger(textLimit) || textLimit < 100 || textLimit > 16_000) throw new Error('Context textLimit must be 100 to 16000');
  if (typeof query !== 'string' || query.length > 200 || Buffer.byteLength(query) > 300 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('Invalid context query');
  query = query.trim().toLowerCase();
  if (projectForSearch !== undefined && typeof projectForSearch !== 'function') throw new Error('Invalid trusted search projection');
  const queryDigest = query ? digest(query) : undefined;
  let after = '';
  if (cursor) {
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('Invalid context cursor'); }
    if (parsed?.resource !== resource || typeof parsed.after !== 'string' || parsed.after.length > 1024 || parsed.queryDigest !== queryDigest) throw new Error('Context cursor does not match resource or query');
    after = parsed.after;
  }
  const predicate = query ? ' AND instr(lower(data), ?) > 0' : '';
  let rows, total;
  if (query && projectForSearch) {
    rows = []; total = 0;
    // The authenticated management surface searches the same redacted facts it
    // may display, rather than exposing hidden values through match/no-match.
    for (const row of store.db.prepare(`SELECT id, data FROM ${tables[resource]} ORDER BY id`).iterate()) {
      if (!JSON.stringify(projectForSearch(JSON.parse(row.data))).toLowerCase().includes(query)) continue;
      total++; if (row.id > after && rows.length < limit + 1) rows.push(row);
    }
  } else {
    rows = store.db.prepare(`SELECT id, data FROM ${tables[resource]} WHERE id > ?${predicate} ORDER BY id LIMIT ?`).all(...(query ? [after, query, limit + 1] : [after, limit + 1]));
    total = store.db.prepare(`SELECT count(*) AS count FROM ${tables[resource]}${query ? ' WHERE instr(lower(data), ?) > 0' : ''}`).get(...(query ? [query] : [])).count;
  }
  const selected = rows.slice(0, limit);
  const items = selected.map(row => {
    const value = JSON.parse(row.data), encoded = JSON.stringify(value);
    return { id: row.id, resource, version: digest(value), truncated: encoded.length > textLimit,
      ...(encoded.length > textLimit ? { preview: encoded.slice(0, textLimit) } : { value }) };
  });
  return { resource, items, total, query, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ resource, after: selected.at(-1).id, ...(queryDigest ? { queryDigest } : {}) })).toString('base64url') : null };
}

export function readContextRecord(store, resource, id, { version, offset = 0, limit = 8000 } = {}) {
  if (!Object.hasOwn(tables, resource) || typeof id !== 'string') throw new Error('Unknown context record');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 100 || limit > 32_000) throw new Error('Invalid context range');
  const row = store.db.prepare(`SELECT data FROM ${tables[resource]} WHERE id = ?`).get(id);
  if (!row) return null;
  const current = digest(JSON.parse(row.data));
  if (version && version !== current) throw new Error('Context record changed; reread its current version');
  return { resource, id, version: current, offset, text: row.data.slice(offset, offset + limit),
    nextOffset: offset + limit < row.data.length ? offset + limit : null, length: row.data.length };
}

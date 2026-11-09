import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export class Later extends Error {}
const isDead = owner => {
  if (!owner || owner.host !== hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};

/** At-least-once durable queue. Handlers must reconcile external effects after crashes. */
export class Effects {
  constructor(store, { now = () => Date.now(), retryMs = 1000, maxRetryMs = 60_000 } = {}) {
    this.store = store; this.now = now; this.retryMs = retryMs; this.maxRetryMs = maxRetryMs;
  }
  enqueue(kind, key, payload) {
    if (!this.store.inTransaction) return this.store.atomic(() => this.enqueue(kind, key, payload));
    this.store.assertWritable();
    if (!kind || !key) throw new Error('Effect kind and key are required');
    this.store.db.prepare(`INSERT INTO effects(kind, key, payload, due) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload, generation = generation + 1,
      attempts = 0, error = '', due = excluded.due, cancelled = 0`).run(kind, key, JSON.stringify(payload), this.now());
  }
  pending(kind, key) {
    return !!(key === undefined
      ? this.store.db.prepare('SELECT 1 FROM effects WHERE kind = ? AND cancelled = 0 LIMIT 1').get(kind)
      : this.store.db.prepare('SELECT 1 FROM effects WHERE kind = ? AND key = ? AND cancelled = 0').get(kind, key));
  }
  list() {
    return this.store.db.prepare('SELECT * FROM effects ORDER BY seq').all().map(row => ({ ...row, payload: JSON.parse(row.payload), owner: row.owner ? JSON.parse(row.owner) : null, cancelled: !!row.cancelled }));
  }
  cancel(kind, key) {
    this.store.atomic(() => {
      this.store.db.prepare('DELETE FROM effects WHERE kind = ? AND key = ? AND token IS NULL').run(kind, key);
      this.store.db.prepare('UPDATE effects SET cancelled = 1, generation = generation + 1 WHERE kind = ? AND key = ? AND token IS NOT NULL').run(kind, key);
    });
  }
  recover() {
    return this.store.atomic(() => {
      let recovered = 0;
      for (const row of this.list()) {
        if (!row.token || !isDead(row.owner)) continue;
        if (row.cancelled) this.store.db.prepare('DELETE FROM effects WHERE seq = ? AND token = ?').run(row.seq, row.token);
        else this.store.db.prepare('UPDATE effects SET token = NULL, owner = NULL, due = ? WHERE seq = ? AND token = ?').run(this.now(), row.seq, row.token);
        recovered++;
      }
      return recovered;
    });
  }
  async runNext(handlers, { compare } = {}) {
    if (this.store.inTransaction) throw new Error('Effects cannot run inside a transaction');
    const row = this.store.atomic(() => {
      this.recover();
      const available = this.list();
      if (compare) available.sort(compare);
      const next = available.find(value => !value.token && !value.cancelled && value.due <= this.now() && Object.hasOwn(handlers, value.kind) && typeof handlers[value.kind] === 'function');
      if (!next) return null;
      next.token = randomUUID();
      const owner = { pid: process.pid, host: hostname() };
      this.store.db.prepare('UPDATE effects SET token = ?, owner = ? WHERE seq = ? AND token IS NULL').run(next.token, JSON.stringify(owner), next.seq);
      return next;
    });
    if (!row) return false;
    let failure, failed = false;
    try { await handlers[row.kind](row.payload, row.key); }
    catch (error) { failed = true; failure = error; }
    this.store.atomic(() => {
      const current = this.store.db.prepare('SELECT generation, cancelled FROM effects WHERE seq = ? AND token = ?').get(row.seq, row.token);
      if (!current) return;
      if (current.cancelled) {
        this.store.db.prepare('DELETE FROM effects WHERE seq = ? AND token = ?').run(row.seq, row.token);
      } else if (current.generation !== row.generation) {
        // A later payload owns this row; release only this attempt's claim.
        this.store.db.prepare('UPDATE effects SET token = NULL, owner = NULL WHERE seq = ? AND token = ?').run(row.seq, row.token);
      } else if (!failed) {
        this.store.db.prepare('DELETE FROM effects WHERE seq = ? AND token = ?').run(row.seq, row.token);
      } else {
        const attempts = row.attempts + (failure instanceof Later ? 0 : 1);
        const delay = failure instanceof Later ? this.retryMs : Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(row.attempts, 16));
        this.store.db.prepare('UPDATE effects SET token = NULL, owner = NULL, attempts = ?, due = ?, error = ? WHERE seq = ? AND token = ?')
          .run(attempts, this.now() + delay, String(failure?.message ?? failure).slice(0, 1000), row.seq, row.token);
      }
    });
    return true;
  }
}

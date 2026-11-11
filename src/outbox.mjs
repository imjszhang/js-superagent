import { Later } from './effects.mjs';
import { reconcilePendingReviewDestination } from './runtime/github-review-delivery.mjs';

/** Durable receipts; network delivery occurs only outside storage transactions. */
export class Outbox {
  constructor(store, effects, { deliver, authorize, onEnqueue } = {}) { this.store = store; this.effects = effects; this.delivery = deliver; this.authorize = authorize; this.onEnqueue = onEnqueue; }
  send(message) {
    this.store.atomic(() => {
      if (this.status(message.id) !== undefined) return;
      this.onEnqueue?.(message);
      this.store.db.prepare('INSERT INTO receipts(id, data, status) VALUES (?, ?, ?)').run(message.id, JSON.stringify(message), 'pending');
      this.effects.enqueue('reply', message.id, {});
    });
  }
  status(id) { return this.store.db.prepare('SELECT status FROM receipts WHERE id = ?').get(id)?.status; }
  withdraw(id) {
    this.store.atomic(() => {
      this.store.db.prepare("UPDATE receipts SET status = 'dropped' WHERE id = ? AND status = 'pending'").run(id);
      this.effects.cancel('reply', id);
      this.effects.cancel('coordinator-answer', id);
      this.effects.cancel('worker-answer', id);
    });
  }
  list() {
    return this.store.db.prepare('SELECT id, data, status FROM receipts ORDER BY rowid').all().map(row => ({ ...JSON.parse(row.data), status: row.status,
      ...(this.store.getMeta(`receipt:${row.id}`) ? { delivery: this.store.getMeta(`receipt:${row.id}`) } : {}),
      ...(this.store.getMeta(`receipt:terminal:${row.id}`) ? { terminal: this.store.getMeta(`receipt:terminal:${row.id}`) } : {}),
      ...(this.store.getMeta(`receipt:ordering:${row.id}`) ? { ordering: this.store.getMeta(`receipt:ordering:${row.id}`) } : {}) }));
  }
  conversation(message) {
    const channel = message.channel, address = channel.address ?? {};
    const ticketId = message.ticketId && (this.store.getMeta(`public:${message.ticketId}`) ?? message.ticketId);
    return JSON.stringify([ticketId ?? null, channel.source, channel.thread,
      address.reviewRootId ?? address.reviewCommentId ?? null]);
  }
  async deliver(_payload, id) {
    if (this.store.inTransaction) throw new Error('Outbox delivery cannot run inside a transaction');
    const message = this.store.atomic(() => {
      const row = this.store.db.prepare('SELECT rowid, data, status FROM receipts WHERE id = ?').get(id);
      if (row?.status !== 'pending') return undefined;
      const message = reconcilePendingReviewDestination(this.store, JSON.parse(row.data)), skipped = [];
      for (const earlier of this.store.db.prepare("SELECT id, data FROM receipts WHERE rowid < ? AND status = 'pending' ORDER BY rowid").all(row.rowid)) {
        const preceding = reconcilePendingReviewDestination(this.store, JSON.parse(earlier.data));
        if (this.conversation(preceding) !== this.conversation(message)) continue;
        const effect = this.store.db.prepare("SELECT attempts FROM effects WHERE kind IN ('reply','coordinator-answer','worker-answer') AND key = ? AND cancelled = 0").get(earlier.id);
        if ((effect?.attempts ?? 0) < 3) throw new Later('An earlier message for this ticket and discussion is waiting');
        skipped.push(earlier.id);
      }
      if (skipped.length) this.store.setMeta(`receipt:ordering:${id}`, { reason: 'earlier-delivery-failed-three-times', skipped });
      return message;
    });
    if (!message) return;
    const authorization = this.authorize?.(message);
    if (authorization?.then) await authorization;
    let delivery;
    if (message.channel.source !== 'local') {
      if (!this.delivery) throw new Later('No channel adapter installed for this source');
      delivery = await this.delivery(message);
      if (delivery?.status === 'gone' && ['deleted', 'locked'].includes(delivery.reason)) {
        this.store.atomic(() => {
          this.store.setMeta(`receipt:terminal:${id}`, { status: 'gone', reason: delivery.reason });
          this.store.db.prepare("UPDATE receipts SET status = 'dropped' WHERE id = ? AND status = 'pending'").run(id);
          this.effects.cancel('reply', id);
          this.effects.cancel('coordinator-answer', id);
          this.effects.cancel('worker-answer', id);
        });
        return;
      }
      if (!delivery || typeof delivery.id !== 'string' || typeof delivery.url !== 'string') throw new Error('Channel adapter returned an invalid delivery receipt');
    }
    this.store.atomic(() => {
      // A request already accepted by the remote service cannot be retracted locally.
      // Preserve that fact even if withdrawal raced with the network request.
      if (delivery) this.store.setMeta(`receipt:${id}`, delivery);
      this.store.db.prepare("UPDATE receipts SET status = 'sent' WHERE id = ? AND status = 'pending'").run(id);
    });
  }
}

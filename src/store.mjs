import { assertDatabaseAvailable } from './database-maintenance.mjs';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

function validateBackup(path) {
  let backup;
  try {
    backup = new DatabaseSync(path, { readOnly: true });
    const checks = backup.prepare('PRAGMA quick_check').all();
    if (!checks.length || checks.some(row => row.quick_check !== 'ok')) throw new Error('SQLite integrity check failed');
    if (Number(backup.prepare('PRAGMA user_version').get().user_version) !== 1) throw new Error('Expected schema version 1');
    backup.prepare('SELECT id, data FROM tickets LIMIT 1').all();
  } catch (error) {
    throw new Error(`Invalid v1 migration backup: ${path}`, { cause: error });
  } finally { backup?.close(); }
}
function backupLegacy(db, path) {
  const final = `${path}.v1-backup`;
  if (existsSync(final)) { validateBackup(final); return; }
  const temporary = `${final}.${randomUUID()}.tmp`;
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    validateBackup(temporary);
    // Publish only a complete snapshot, without replacing a backup from another process.
    try { linkSync(temporary, final); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    validateBackup(final);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** SQLite repositories and shared transaction boundary for domain state and effects. */
export class Store {
  #depth = 0;
  #savepoint = 0;
  constructor(path, { beforeWrite, readOnly = false } = {}) {
    this.path = path; this.beforeWrite = beforeWrite; this.readOnly = readOnly;
    if (!readOnly) assertDatabaseAvailable(path);
    this.db = new DatabaseSync(path, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      if (version > 15) throw new Error(`Unsupported state schema: ${version}`);
      // A v1 process must still be able to open its database and cancel work after refusal.
      // Do this before changing the schema or creating a migration backup.
      if (version === 1 && !readOnly) {
        for (const row of this.db.prepare('SELECT data FROM tickets').all()) {
          const ticket = JSON.parse(row.data);
          if (ticket.status !== 'running') continue;
          const owner = ticket.owner;
          if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
            throw new Error(`Cannot migrate running legacy ticket ${ticket.id}: execution owner cannot be verified`);
          }
          let dead = false;
          try { process.kill(owner.pid, 0); }
          catch (error) {
            if (error.code === 'ESRCH') dead = true;
            else throw new Error(`Cannot migrate running legacy ticket ${ticket.id}: execution owner cannot be verified`, { cause: error });
          }
          if (!dead) throw new Error(`Cannot migrate running legacy ticket ${ticket.id}: execution owner is still alive`);
        }
      }
      if (version === 1 && path !== ':memory:' && !readOnly) backupLegacy(this.db, path);
      if (!readOnly) this.db.exec('PRAGMA journal_mode = WAL');
      if (!readOnly) this.atomic(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS effects (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL,
            payload TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
            attempts INTEGER NOT NULL DEFAULT 0, due REAL NOT NULL, error TEXT NOT NULL DEFAULT '',
            token TEXT, owner TEXT, cancelled INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, key));
          CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS effects_due ON effects(due, seq);`);
        for (const table of ['triggers', 'dispositions', 'threads', 'tickets', 'decisions']) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS domain_${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
        }
        this.db.exec(`PRAGMA user_version = ${Math.max(2, version)}`);
      });
      this.triggers = {
        get: id => this.#get('triggers', id), save: value => this.#save('triggers', value.id, value),
        disposition: id => this.#get('dispositions', id), saveDisposition: (id, value) => this.#save('dispositions', id, value),
      };
      this.threads = {
        get: id => this.#get('threads', id), save: value => this.#save('threads', value.key, value),
        list: () => this.#list('threads'),
        active: () => this.threads.list().filter(value => value.pending.length > 0 || value.evaluating !== undefined),
      };
      this.tickets = {
        get: id => this.#get('tickets', id), save: value => this.#save('tickets', value.id, value),
        list: () => this.#list('tickets', true),
        open: () => this.tickets.list().filter(value => !value.ended),
        active: () => this.tickets.list().filter(value => value.undelivered.length > 0 || ['pending', 'running'].includes(value.assignments.at(-1)?.state ?? '')),
      };
      this.decisions = {
        get: id => this.#get('decisions', id), save: value => this.#save('decisions', value.id, value),
        byThread: key => this.#list('decisions').filter(value => value.threadKey === key),
      };
    } catch (error) { this.db.close(); throw error; }
  }
  get inTransaction() { return this.#depth > 0; }
  assertWritable() {
    if (this.readOnly) throw Object.assign(new Error('Project identity requires explicit relocation or reinitialization; state is read-only'), { code: 'PROJECT_IDENTITY_CONFLICT' });
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 15) throw new Error(`Unsupported state schema: ${version}`);
    assertDatabaseAvailable(this.path); this.beforeWrite?.();
  }
  atomic(fn) {
    this.assertWritable();
    if (fn.constructor.name === 'AsyncFunction') throw new Error('Transactions must be synchronous');
    const outer = this.#depth === 0;
    const name = `transaction_${++this.#savepoint}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.#depth++;
    try {
      // Recheck after acquiring SQLite's writer lock. Maintenance establishes its
      // marker, then a writer barrier before taking its snapshot.
      this.assertWritable();
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('Transactions must be synchronous');
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      if (outer) this.db.exec('ROLLBACK');
      else this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally { this.#depth--; }
  }
  #get(table, id) {
    const row = this.db.prepare(`SELECT data FROM domain_${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : undefined;
  }
  #save(table, id, value) {
    if (!this.inTransaction) return this.atomic(() => this.#save(table, id, value));
    this.assertWritable();
    this.db.prepare(`INSERT INTO domain_${table}(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(value));
  }
  #list(table, reverse = false) {
    return this.db.prepare(`SELECT data FROM domain_${table} ORDER BY rowid ${reverse ? 'DESC' : 'ASC'}`).all().map(row => JSON.parse(row.data));
  }
  getMeta(key) {
    const row = this.db.prepare('SELECT data FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.data) : undefined;
  }
  setMeta(key, value) {
    if (!this.inTransaction) return this.atomic(() => this.setMeta(key, value));
    this.assertWritable();
    this.db.prepare('INSERT INTO kv(key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(key, JSON.stringify(value));
  }
  deleteMeta(key) { if (!this.inTransaction) return this.atomic(() => this.deleteMeta(key)); this.assertWritable(); this.db.prepare('DELETE FROM kv WHERE key = ?').run(key); }
  listMeta(prefix = '') {
    return this.db.prepare('SELECT key, data FROM kv ORDER BY rowid').all()
      .filter(row => row.key.startsWith(prefix)).map(row => ({ key: row.key, value: JSON.parse(row.data) }));
  }
  legacyList() { return this.db.prepare('SELECT data FROM tickets ORDER BY rowid').all().map(row => JSON.parse(row.data)); }
  legacyGet(id) {
    const row = this.db.prepare('SELECT data FROM tickets WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : undefined;
  }
  close() {
    if (this.inTransaction) throw new Error('Cannot close a store during a transaction');
    this.db.close();
  }
}

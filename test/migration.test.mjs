import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { Effects } from '../src/effects.mjs';
import { migrateLegacy } from '../src/migration.mjs';

const at = '2026-11-01T00:00:00.000Z';
function legacy(id, status = 'queued', extra = {}) {
  return { id, projectId: 'project-a', text: `Task ${id}`, scope: 'Only this project', status,
    createdAt: at, updatedAt: at, runId: status === 'queued' ? null : `run-${id}`,
    cancelRequested: status === 'cancelled',
    messages: [{ text: `Task ${id}`, at }, { text: 'Preserve the existing files', at }],
    reports: ['waiting', 'completed', 'failed', 'interrupted'].includes(status)
      ? [{ status, summary: `Previous ${status} report`, runId: `run-${id}`, at, artifacts: ['result.txt'] }] : [], ...extra };
}
function fixture(t, records, { alreadyUpgraded = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'js-superagent-migration-'));
  const path = join(dir, 'state.sqlite');
  let old, store;
  t.after(() => {
    try { old?.close(); store?.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  old = new DatabaseSync(path);
  old.exec('CREATE TABLE tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = 1');
  // Model a successful schema upgrade followed by an earlier failed domain import.
  // This exercises migrateLegacy's own refusal, independently of Store's v1 preflight.
  if (alreadyUpgraded) old.exec('PRAGMA user_version = 2');
  for (const record of records) old.prepare('INSERT INTO tickets VALUES (?, ?)').run(record.id, JSON.stringify(record));
  old.close(); old = undefined;
  store = new Store(path);
  const effects = new Effects(store);
  return { store, effects, path };
}

test('imports every legacy state, identity and history without changing archival rows', t => {
  const statuses = ['queued', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'];
  const records = statuses.map(status => legacy(status, status));
  const { store, effects } = fixture(t, records);
  migrateLegacy(store, effects, 'project-a');
  assert.deepEqual(store.legacyList(), records);
  assert.equal(store.getMeta('legacy-imported'), true);
  assert.equal(store.tickets.list().length, records.length);
  for (const old of records) {
    const ticket = store.tickets.get(old.id);
    const meta = store.getMeta(`ticket:${old.id}`);
    assert.equal(ticket.id, old.id);
    assert.equal(meta.domainId, old.id);
    assert.equal(store.getMeta(`public:${old.id}`), old.id);
    assert.equal(ticket.mandate.scope, old.scope);
    assert.deepEqual(meta.messages, old.messages);
    assert.deepEqual(meta.reports, old.reports);
    assert.equal(meta.runId, old.runId);
    assert.equal(ticket.inputs.length, old.messages.length);
    assert.ok(ticket.inputs.every(input => input.readAt === null));
    const decision = store.decisions.get(ticket.decisionId);
    assert.equal(decision.reason[0].code, 'legacyImport');
    assert.equal(decision.audit.modelAssessment, false);
  }
  assert.equal(store.tickets.get('queued').assignments[0].state, 'pending');
  assert.equal(store.tickets.get('waiting').attention.question, 'Previous waiting report');
  assert.equal(store.tickets.get('completed').ended.outcome, 'completed');
  assert.equal(store.tickets.get('cancelled').ended.by, 'human');
  assert.equal(store.tickets.get('failed').assignments[0].report.state, 'failed');
  assert.equal(store.getMeta('ticket:interrupted').interrupted, true);
  assert.equal(effects.list().length, 1);
  assert.equal(effects.list()[0].kind, 'launch');
  const before = store.tickets.list();
  migrateLegacy(store, effects, 'project-a');
  assert.deepEqual(store.tickets.list(), before);
  assert.equal(effects.list().length, 1);
});

test('invalid input leaves no partial domain import or queued effects', t => {
  const records = [legacy('good'), legacy('bad', 'unknown')];
  const { store, effects } = fixture(t, records);
  assert.throws(() => migrateLegacy(store, effects, 'project-a'), /Unknown legacy status/);
  assert.deepEqual(store.tickets.list(), []);
  assert.deepEqual(store.threads.list(), []);
  assert.deepEqual(effects.list(), []);
  assert.equal(store.getMeta('legacy-imported'), undefined);
  assert.deepEqual(store.legacyList(), records);
});

test('effect persistence failure rolls back all domain, metadata and queue writes', t => {
  const { store, effects } = fixture(t, [legacy('first'), legacy('second')]);
  let enqueued = 0;
  const broken = { enqueue(...args) { effects.enqueue(...args); if (++enqueued === 2) throw new Error('disk failure'); } };
  assert.throws(() => migrateLegacy(store, broken, 'project-a'), /disk failure/);
  assert.deepEqual(store.tickets.list(), []);
  assert.deepEqual(store.threads.list(), []);
  assert.deepEqual(store.listMeta('ticket:'), []);
  assert.deepEqual(effects.list(), []);
  assert.equal(store.getMeta('legacy-imported'), undefined);
});

test('refuses live or unverifiable legacy execution owners', t => {
  for (const [id, owner] of [
    ['live', { pid: process.pid, host: hostname() }],
    ['remote', { pid: process.pid, host: 'another-host' }],
    ['invalid', { pid: 0, host: hostname() }],
  ]) {
    const { store, effects } = fixture(t, [legacy(id, 'running', { owner })], { alreadyUpgraded: true });
    assert.throws(() => migrateLegacy(store, effects, 'project-a'), /Cannot migrate running/);
    assert.deepEqual(store.tickets.list(), []);
    assert.equal(store.getMeta('legacy-imported'), undefined);
  }
});

test('dead legacy owner becomes interrupted without replaying execution', async t => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'close');
  const old = legacy('dead', 'running', { owner: { pid, host: hostname() } });
  const { store, effects } = fixture(t, [old]);
  migrateLegacy(store, effects, 'project-a');
  assert.equal(store.getMeta('ticket:dead').interrupted, true);
  assert.deepEqual(store.getMeta('ticket:dead').reports, old.reports);
  assert.equal(store.tickets.get('dead').assignments[0].report.state, 'failed');
  assert.deepEqual(effects.list(), []);
  assert.deepEqual(store.legacyList(), [old]);
});

test('rejects cross-project records and records empty migrations once', t => {
  const { store, effects } = fixture(t, [legacy('other')]);
  assert.throws(() => migrateLegacy(store, effects, 'project-b'), /different project/);
  assert.equal(store.getMeta('legacy-imported'), undefined);
  const empty = fixture(t, []);
  migrateLegacy(empty.store, empty.effects, 'project-a');
  assert.equal(empty.store.getMeta('legacy-imported'), true);
  assert.deepEqual(empty.effects.list(), []);
});


test('retains empty error summaries produced by the v1 driver failure path', t => {
  const record = legacy('empty-error', 'failed');
  record.reports[0].summary = '';
  const { store, effects } = fixture(t, [record]);
  migrateLegacy(store, effects, 'project-a');
  assert.deepEqual(store.getMeta('ticket:empty-error').reports, record.reports);
  assert.equal(store.tickets.get('empty-error').assignments[0].report.state, 'failed');
});


test('preserves a cancellation requested before the legacy worker died', async t => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'close');
  const old = legacy('cancelled-crash', 'running', { owner: { pid, host: hostname() }, cancelRequested: true });
  const { store, effects } = fixture(t, [old]);
  migrateLegacy(store, effects, 'project-a');
  const domain = store.tickets.get(old.id);
  assert.equal(domain.ended.by, 'human');
  assert.equal(domain.ended.outcome, 'stopped');
  assert.equal(domain.assignments[0].state, 'ended');
  assert.deepEqual(domain.undelivered, []);
  assert.equal(store.getMeta(`ticket:${old.id}`).interrupted, false);
  assert.deepEqual(effects.list(), []);
  assert.deepEqual(store.legacyList(), [old]);
});

test('explicit legacy cancellation takes precedence over every settled status', t => {
  const records = ['queued', 'waiting', 'failed', 'interrupted', 'completed', 'cancelled']
    .map(status => legacy(`cancel-${status}`, status, { cancelRequested: true }));
  const { store, effects } = fixture(t, records);
  migrateLegacy(store, effects, 'project-a');
  for (const old of records) {
    const domain = store.tickets.get(old.id);
    assert.equal(domain.ended.by, 'human');
    assert.equal(domain.ended.outcome, 'stopped');
    assert.equal(store.getMeta(`ticket:${old.id}`).interrupted, false);
    assert.deepEqual(store.threads.get(`local:legacy:${old.id}`).subscriptions, []);
  }
  assert.deepEqual(effects.list(), []);
});

test('cancellation does not permit taking over a live legacy owner and must be boolean', t => {
  const running = fixture(t, [legacy('active-stop', 'running', { cancelRequested: true, owner: { pid: process.pid, host: hostname() } })], { alreadyUpgraded: true });
  assert.throws(() => migrateLegacy(running.store, running.effects, 'project-a'), /owner is still alive/);
  assert.equal(running.store.getMeta('legacy-imported'), undefined);
  for (const value of [undefined, null, 'true', 1]) {
    const invalid = fixture(t, [legacy('bad-stop', 'queued', { cancelRequested: value })]);
    assert.throws(() => migrateLegacy(invalid.store, invalid.effects, 'project-a'), /Invalid legacy cancelRequested/);
    assert.deepEqual(invalid.store.tickets.list(), []);
    assert.deepEqual(invalid.effects.list(), []);
  }
});

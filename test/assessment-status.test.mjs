import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { assessmentStatus } from '../src/runtime/assessment-status.mjs';

test('assessment status distinguishes attach, stop and old failed records without mutating them', t => {
  const root = mkdtempSync(join(tmpdir(), 'js-assessment-status-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.triggers.save({ id: 'original', source: 'local', threads: [{ source: 'local', id: 'conversation' }] });
  store.threads.save({ key: 'local:conversation', pending: [], subscriptions: [] });
  store.triggers.saveDisposition('original', { evalId: 'evaluation', decisionId: 'decision' });
  store.setMeta('public:domain-ticket', 'public-ticket');
  const save = kind => {
    store.decisions.save({ id: 'decision', evalId: 'evaluation', threadKey: 'local:conversation', triggerIds: ['original'], kind, ticketId: 'domain-ticket' });
    store.setMeta('assessment:evaluation', { status: 'finished', outcome: { reason: 'Current request facts' }, result: { applied: true, kind,
      ...(kind === 'attach' ? { ticket: { id: 'domain-ticket' } } : { decision: { ticketId: 'domain-ticket' } }) } });
  };
  save('attach'); assert.equal(assessmentStatus(store, 'original').status, 'attached');
  save('stop'); const stopped = assessmentStatus(store, 'original');
  assert.equal(stopped.status, 'stop'); assert.equal(stopped.ticketId, 'public-ticket');
  assert.equal(stopped.reason, 'Current request facts');
  store.decisions.save({ id: 'decision', evalId: 'evaluation', threadKey: 'local:conversation', triggerIds: ['original'], kind: 'unavailable' });
  const oldRecord = { status: 'failed', error: 'Answer fields are only valid for an answer outcome; triggerId may also select attach, ignore or unavailable input' };
  store.setMeta('assessment:evaluation', oldRecord);
  store.decisions.save({ id: 'decision', evalId: 'input-evaluation', threadKey: 'local:conversation', triggerIds: ['original'], kind: 'unavailable',
    audit: { triggerDecision: { sourceEvalId: 'evaluation', triggerId: 'original' } } });
  store.triggers.saveDisposition('original', { evalId: 'input-evaluation', decisionId: 'decision' });
  store.db.exec('PRAGMA query_only=ON');
  const failed = assessmentStatus(store, 'original');
  assert.equal(failed.evalId, 'evaluation'); assert.equal(failed.status, 'failed'); assert.equal(failed.failureKind, 'format'); assert.equal(failed.retryable, true);
  assert.match(failed.message, /格式/); assert.deepEqual(store.getMeta('assessment:evaluation'), oldRecord);
});

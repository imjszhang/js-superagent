import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createManagedJobs, normalizeManagedJobsSettings } from '../src/runtime/jobs.mjs';
import { prepareWorkspace } from '../src/workspaces.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 600; i++) { if (check()) return; await delay(10); } assert.fail('Timed out waiting for managed job'); }
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function fixture(t, profiles, extra = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'js-superagent-persistent-jobs-'));
  writeFileSync(join(projectRoot, 'example.txt'), 'initial');
  const workspace = prepareWorkspace({ projectRoot, ticketId: 'parent', config: { mode: 'copy' }, persist() {} });
  const records = new Map(), wakes = [], slots = [];
  const manager = createManagedJobs({ projectRoot, persistentMode: true,
    parent: { ticketId: 'ticket', assignmentId: 'assignment', runId: 'turn-1', workspace, scope: { instruction: 'Only example.txt', paths: ['example.txt'] } }, profiles,
    journal: { list: () => [...records.values()].map(record => structuredClone(record)), save: record => records.set(record.id, structuredClone(record)) },
    wakeParent: event => wakes.push(event), slotChanged: event => slots.push(event), limits: { maxDurationMs: 20_000 }, ...extra });
  t.after(async () => { await manager.close(); rmSync(projectRoot, { recursive: true, force: true }); });
  return { projectRoot, workspace, records, wakes, slots, manager };
}
const command = args => ({ kind: 'command', version: '1', command: process.execPath, args, environment: 'host', allowHostExecution: true, timeoutMs: 15_000 });

test('assignment jobs survive a turn boundary and complete once with their original parent evidence', async t => {
  const f = fixture(t, { check: command(['-e', 'setTimeout(()=>{},500)']) });
  const handle = f.manager.launch({ profileId: 'check' }, { requestId: 'first-call' });
  assert.deepEqual(await f.manager.endTurn(), { pending: 1, previews: 0, holdsSlot: true });
  f.manager.beginTurn({ runId: 'turn-2' });
  assert.equal(f.manager.get(handle.id).parent.runId, 'turn-1');
  assert.equal(f.manager.launch({ profileId: 'check' }, { requestId: 'first-call' }).id, handle.id);
  assert.equal((await f.manager.wait(handle.id)).status, 'completed');
  f.manager.recover(); f.manager.recover();
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].parent.runId, 'turn-1');
  assert.equal(f.slots.at(-1).parent.runId, 'turn-2');
  assert.deepEqual(await f.manager.endTurn(), { pending: 0, previews: 0, holdsSlot: false });
});

test('human handoff cancels unleased work while preserving an owned preview without a completion wake', { timeout: 15_000 }, async t => {
  const port = await freePort(), profile = { ...command(['-e', `require('http').createServer((q,r)=>r.end('review')).listen(${port},'127.0.0.1')`]), preview: { url: `http://127.0.0.1:${port}/`, ttlMs: 10_000 } };
  const f = fixture(t, { preview: profile, other: command(['-e', 'setInterval(()=>{},1000)']) });
  const preview = f.manager.launch({ profileId: 'preview' });
  await until(() => f.manager.get(preview.id).execution?.childPid);
  await delay(150);
  const lease = await f.manager.preview(preview.id);
  assert.equal(lease.status, 'active'); assert.ok(lease.endpoint.listeners.length);
  const other = f.manager.launch({ profileId: 'other' });
  await until(() => f.manager.get(other.id).execution?.childPid);
  const handoff = await f.manager.endTurn({ handoff: true });
  assert.deepEqual(handoff, { pending: 0, previews: 1, holdsSlot: false });
  assert.equal(f.manager.get(other.id).status, 'handed-off');
  assert.equal(await (await fetch(lease.url)).text(), 'review');
  const renewed = await f.manager.renewPreview(preview.id, { ttlMs: 5000 });
  assert.equal(renewed.id, lease.id); assert.ok(renewed.renewedAt);
  const before = f.wakes.length;
  const ended = await f.manager.closePreview(preview.id);
  assert.equal(ended.previewLease.status, 'closed'); assert.equal(ended.completion.suppressed, 'human-preview');
  const saved = f.records.get(preview.id);
  f.manager.recover(); f.manager.recover(); assert.equal(f.wakes.length, before);
  assert.equal(f.records.get(preview.id), saved, 'Already suppressed preview completion must not rewrite its journal every sweep');
  for (const owner of ended.guardians) assert.throws(() => process.kill(owner.pid, 0), error => error.code === 'ESRCH');
});

test('preview TTL expires and shutdown does not leave a listener', { timeout: 12_000 }, async t => {
  const port = await freePort();
  const f = fixture(t, { preview: { ...command(['-e', `require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`]), preview: { url: `http://127.0.0.1:${port}/` } } });
  const handle = f.manager.launch({ profileId: 'preview' });
  await until(() => f.manager.get(handle.id).execution?.childPid); await delay(150);
  await f.manager.preview(handle.id, { ttlMs: 1000 });
  const result = await handle.done;
  assert.equal(result.status, 'preview-expired'); assert.equal(result.previewLease.status, 'expired');
  assert.equal(f.wakes.length, 0);
  for (const owner of result.guardians) assert.throws(() => process.kill(owner.pid, 0), error => error.code === 'ESRCH');
});

test('a listening port from another process cannot become this job preview', { timeout: 10_000 }, async t => {
  const server = createServer(socket => socket.end()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const port = server.address().port;
  const f = fixture(t, { preview: { ...command(['-e', 'setInterval(()=>{},1000)']), preview: { url: `http://127.0.0.1:${port}/` } } });
  const handle = f.manager.launch({ profileId: 'preview' });
  await until(() => f.manager.get(handle.id).execution?.childPid);
  await assert.rejects(f.manager.preview(handle.id), /not exclusively owned/);
  assert.equal(f.manager.get(handle.id).previewLease, undefined);
});

test('persistent settings are explicit and reject arbitrary preview URLs', () => {
  const settings = { paths: ['example.txt'], profiles: { preview: { ...command(['-e', '']), preview: { url: 'http://127.0.0.1:12345/' } } }, lifecycle: 'assignment', childWorkspace: 'parent-snapshot' };
  const normalized = normalizeManagedJobsSettings(settings);
  assert.deepEqual(normalizeManagedJobsSettings(normalized), normalized);
  assert.equal(normalized.lifecycle, 'assignment');
  assert.throws(() => normalizeManagedJobsSettings({ ...settings, lifecycle: 'turn' }), /assignment job lifecycle/);
  assert.throws(() => normalizeManagedJobsSettings({ ...settings, profiles: { preview: { ...settings.profiles.preview, preview: { url: 'https://example.com:443/' } } } }), /loopback/);
});

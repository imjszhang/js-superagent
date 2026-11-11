import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store } from '../src/store.mjs';
import { ensureProjectIdentity } from '../src/project-identity.mjs';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { resolveMaterialBinding } from '../src/materials.mjs';
import { createWorkerProjectReads } from '../src/runtime/worker-project-context.mjs';
import { createWorkerToolHost } from '../src/runtime/agent-tools.mjs';
import { contextBytes } from '../src/runtime/worker-context.mjs';

function fixture(t, { include = ['.'] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'material-pages-'))), projectId = 'material-pagination-fixture';
  ensureProjectIdentity(root, projectId);
  const store = new Store(':memory:'), observations = [], actor = { source: 'local', id: 'operator' };
  const binding = resolveMaterialBinding({ projectRoot: root, projectId, revision: 1, actor, destinations: [actor],
    settings: { entries: [{ id: 'project', project: 'self', include, views: ['current'], readers: [actor], destinations: [actor] }] },
    request: { sources: [{ id: 'project', view: { kind: 'current' } }] } });
  const restore = () => createWorkerProjectReads({ binding, observations, onObservation: value => observations.push(value) });
  const hostFor = provider => createWorkerToolHost({ store, identity: { ticketId: 'ticket', assignmentId: 'assignment', runId: 'run' },
    assertActive() {}, sessionId: () => 'session', resources: () => [], remoteReads: provider,
    limits: { maxReads: 64, readBytes: 256 * 1024 } });
  let sequence = 0;
  const request = (ref, options = {}) => ({ name: 'js_superagent_read', arguments: { resource: 'materials', id: ref.id, ...options },
    sessionId: 'session', turnId: 'turn', callId: `page-${++sequence}` });
  const write = (path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(projectStateDirectory(root), { recursive: true, force: true }); });
  return { root, store, observations, restore, hostFor, request, write };
}
function checkPage(page, limit) {
  assert.ok(contextBytes(page) <= limit + 4096, 'the complete JSON response fits the unchanged host reserve');
  assert.ok(contextBytes(page.text) <= limit);
  assert.ok(!page.text.includes('\ufffd'));
  if (page.nextOffset !== null) assert.equal(page.nextOffset, page.offset + contextBytes(page.text));
}

for (const limit of [256, 8192]) test(`large directory reads register only delivered page references at limit ${limit}`, async t => {
  const f = fixture(t);
  for (let n = 0; n < 288; n++) f.write(`documents/entry-${String(n).padStart(4, '0')}.md`, `file-${n}`);
  const provider = f.restore(), host = f.hostFor(provider);
  await host.call(f.request(provider.references().find(ref => ref.value.kind === 'directory')));
  const directory = provider.references().find(ref => ref.value.path === 'documents');
  const first = await host.call(f.request(directory, { limit })); checkPage(first, limit);
  assert.ok(first.references.length > 0 && first.references.length < 288);
  assert.equal(provider.references().length, 3 + first.references.length);
  assert.equal(f.observations.at(-1).references.length, first.references.length);
  assert.deepEqual(f.observations.at(-1).page, { offset: 0, nextOffset: first.nextOffset, length: first.length });
  const before = provider.references(); assert.equal(provider.checkFreshness().fresh, true); assert.deepEqual(provider.references(), before);
  let page = first, text = first.text, pages = 1;
  while (page.nextOffset !== null && (limit === 8192 || pages < 3)) {
    page = await host.call(f.request(directory, { version: first.version, offset: page.nextOffset, limit }));
    checkPage(page, limit); text += page.text; pages++;
  }
  if (limit === 8192) {
    const value = JSON.parse(text); assert.equal(value.items.length, 288); assert.equal(page.nextOffset, null);
    assert.equal(new Set(value.items.map(item => item.id)).size, 288);
    const last = value.items.find(item => item.path.endsWith('entry-0287.md'));
    assert.equal(JSON.parse((await host.call(f.request(last))).text).text, 'file-287');
  }
  assert.ok(f.observations.some(observation => observation.page.offset > 0));
});

test('a first small page and freshness check do not exhaust the reference cap on a directory over 4096 children', async t => {
  const f = fixture(t);
  for (let n = 0; n < 4100; n++) f.write(`entry-${String(n).padStart(4, '0')}.md`, 'entry');
  const provider = f.restore(), host = f.hostFor(provider), root = provider.references().find(ref => ref.value.kind === 'directory');
  const first = await host.call(f.request(root, { limit: 256 })); checkPage(first, 256);
  assert.ok(provider.references().length < 6);
  const before = provider.references(); assert.equal(provider.checkFreshness().fresh, true); assert.deepEqual(provider.references(), before);
});

test('restoring page observations preserves only delivered references and cached receipts while rejecting changed pagination', async t => {
  const f = fixture(t);
  for (let n = 0; n < 288; n++) f.write(`entry-${String(n).padStart(4, '0')}.md`, 'entry');
  const provider = f.restore(), host = f.hostFor(provider), root = provider.references().find(ref => ref.value.kind === 'directory');
  const request = f.request(root, { limit: 256 }), first = await host.call(request), originalRefs = provider.references();
  const restored = f.restore(), resumedHost = f.hostFor(restored);
  assert.deepEqual(restored.references(), originalRefs); assert.deepEqual(await resumedHost.call(request), first);
  const next = await resumedHost.call(f.request(root, { limit: 256, version: first.version, offset: first.nextOffset })); checkPage(next, 256);
  const before = restored.references(); f.write('new-file.md', 'new');
  assert.equal(restored.checkFreshness().fresh, false); assert.deepEqual(restored.references(), before);
  assert.deepEqual(await resumedHost.call(request), first, 'the same call retains its historical bytes');
  const count = f.observations.length;
  await assert.rejects(() => resumedHost.call(f.request(root, { limit: 256, version: first.version, offset: next.nextOffset })), { code: 'MATERIAL_CHANGED' });
  assert.equal(f.observations.length, count); assert.deepEqual(restored.references(), before);
});

for (const limit of [256, 8192]) test(`escaped UTF-8 file pages fit the full response envelope at limit ${limit}`, async t => {
  const f = fixture(t), body = ('\\"'.repeat(16) + '汉🙂\u0001\n\t').repeat(limit === 256 ? 40 : 180);
  f.write('escaped.md', body);
  const provider = f.restore(), host = f.hostFor(provider);
  await host.call(f.request(provider.references().find(ref => ref.value.kind === 'directory')));
  const file = provider.references().find(ref => ref.value.kind === 'file');
  const first = await host.call(f.request(file, { limit })); checkPage(first, limit);
  let page = first, text = first.text, shrunk = contextBytes(first.text) < limit && first.nextOffset !== null;
  while (page.nextOffset !== null) {
    page = await host.call(f.request(file, { limit, version: first.version, offset: page.nextOffset }));
    checkPage(page, limit); text += page.text; shrunk ||= contextBytes(page.text) < limit && page.nextOffset !== null;
  }
  assert.equal(JSON.parse(text).text, body);
  if (limit === 8192) assert.equal(shrunk, true, 'JSON escaping requires a smaller text page, without enlarging the shared budget');
});

test('status pages with heavily escaped scope metadata also fit the reserved JSON envelope', async t => {
  const include = Array.from({ length: 64 }, (_, n) => `scope-${n}-${'"'.repeat(120)}`), f = fixture(t, { include });
  const provider = f.restore(), host = f.hostFor(provider), status = provider.references().find(ref => ref.value.kind === 'status');
  const first = await host.call(f.request(status, { limit: 8192 })); checkPage(first, 8192);
  assert.ok(contextBytes(first.text) < 8192); let page = first, text = first.text;
  while (page.nextOffset !== null) {
    page = await host.call(f.request(status, { limit: 8192, version: first.version, offset: page.nextOffset })); checkPage(page, 8192); text += page.text;
  }
  assert.deepEqual(JSON.parse(text).include, [...include].sort()); assert.equal(provider.references().length, 2);
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessRegistry, createProjectAgent } from './helpers/runtime-fixture.mjs';
import { createProjectAgent as createPublishedAgent } from '../src/index.mjs';
import { Store } from '../src/store.mjs';

function adapter(run) {
  return { id: 'w0-fixture', version: '1', roles: ['worker', 'child'], validate: options => options,
    createDriver: () => ({ reportVersion: 2, capabilities: { sessionResume: true }, run }) };
}
function project(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'js-superagent-w0-'));
  const harnessRegistry = createHarnessRegistry({ adapters: [adapter(run)] });
  const opened = [];
  const open = () => { const runtime = createProjectAgent({ projectRoot: root, harnessRegistry }).init(); opened.push(runtime); return runtime; };
  t.after(async () => { for (const runtime of opened.reverse()) { await runtime.stop(); runtime.close(); } rmSync(root, { recursive: true, force: true }); });
  return { root, open, harnessRegistry };
}
const report = (state, summary, attention = null) => ({ version: 2, state, summary, attention });

test('W0 exposes the native adapters and requires registered modern extensions', () => {
  const registry = createHarnessRegistry();
  const listed = registry.list();
  assert.deepEqual(listed.map(item => item.id).sort(), ['codex-app-server', 'cursor-agent', 'dsh-sdk']);
  assert.equal(listed.find(item => item.id === 'codex-app-server').label, 'Codex');
  assert.deepEqual(listed.find(item => item.id === 'dsh-sdk').settingsFields, ['backend', 'permission', 'contextMode', 'materialAccess']);
  assert.deepEqual(listed.find(item => item.id === 'codex-app-server').preserveOnSave, ['executable']);
  for (const driver of ['codex', 'dsh-headless']) assert.throws(() => registry.createDriver({ driver }), /migrat|retired|removed/i);
  registry.register({ ...adapter(async () => ({ status: 'completed', summary: 'old' })), createDriver: () => ({ run() {} }) });
  assert.throws(() => registry.createDriver({ driver: 'w0-fixture' }), /reportVersion|version 2|v2/i);
  assert.throws(() => createPublishedAgent({ projectRoot: '/unused', driver: { run() {} } }), /register|registry|retired|removed/i);
});

test('W0 registered adapter preserves question, original ticket and session across reopen', async t => {
  const seen = [];
  const f = project(t, async input => {
    seen.push(input.session ?? null);
    input.checkpoint({ driver: 'w0-fixture', id: input.session?.id ?? 'native-one' });
    return seen.length === 1 ? report('waiting', 'Need a format', { question: 'Which format?' }) : report('ready', 'Markdown written');
  });
  let runtime = f.open();
  runtime.configureExecutor({ driver: 'w0-fixture' }, { expectedRevision: 0 });
  const ticket = runtime.submit({ text: 'Write a report' });
  assert.equal((await runtime.runNext()).status, 'waiting');
  const binding = runtime.sessionStatus(ticket.id).harnessBinding;
  runtime.close(); runtime = f.open();
  runtime.reply(ticket.id, 'Markdown');
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.deepEqual(seen, [null, { driver: 'w0-fixture', id: 'native-one' }]);
  assert.deepEqual(runtime.sessionStatus(ticket.id).harnessBinding, binding);
  assert.equal(runtime.get(ticket.id).messages.at(-1).text, 'Markdown');
});

test('W0 cancellation reaches registered adapter and prevents concurrent reconfiguration', { timeout: 5000 }, async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let aborted = false;
  const f = project(t, async input => {
    input.checkpoint({ driver: 'w0-fixture', id: 'cancel-me' });
    enter();
    await new Promise(resolve => input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    throw new Error('Cancelled');
  });
  const runtime = f.open();
  runtime.configureExecutor({ driver: 'w0-fixture' }, { expectedRevision: 0 });
  const ticket = runtime.submit({ text: 'Wait for cancellation' });
  const running = runtime.runNext(); await entered;
  assert.throws(() => runtime.configureExecutor({ driver: 'w0-fixture' }, { expectedRevision: 1 }), /Stop work/);
  runtime.cancel(ticket.id); await running;
  assert.equal(aborted, true);
  assert.equal(runtime.get(ticket.id).status, 'cancelled');
  assert.deepEqual(runtime.getSession(ticket.id), { driver: 'w0-fixture', id: 'cancel-me' });
});

test('W0 retired configuration remains inspectable and explicit migration preserves old session history', async t => {
  const f = project(t, async input => {
    input.checkpoint({ driver: 'w0-fixture', id: 'replacement' });
    return report('waiting', 'Inspect saved work', { question: 'Continue?' });
  });
  let runtime = f.open();
  const ticket = runtime.submit({ text: 'Historical task' });
  runtime.close();
  const configPath = join(stateDir(f.root), 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.execution = { driver: 'codex', model: 'old-model' };
  writeFileSync(configPath, JSON.stringify(config));
  const path = join(stateDir(f.root), 'state.sqlite');
  const store = new Store(path), key = `ticket:${ticket.id}`, meta = store.getMeta(key);
  meta.driverSession = { driver: 'codex', id: 'old-native-session' };
  meta.executionConfig = { driver: 'codex', model: 'old-model' };
  store.setMeta(key, meta); store.close();
  runtime = f.open();
  const beforeFiles = readdirSync(stateDir(f.root)).sort();
  const beforeConfig = readFileSync(configPath, 'utf8');
  const preview = runtime.executorStatus();
  assert.equal(preview.migration.required, true);
  assert.equal(preview.migration.tickets.some(item => item.id === ticket.id && item.action === 'replace-session'), true);
  assert.deepEqual(runtime.getSession(ticket.id), meta.driverSession);
  assert.deepEqual(readdirSync(stateDir(f.root)).sort(), beforeFiles);
  assert.throws(() => runtime.configureExecutor({ driver: 'w0-fixture' }, { expectedRevision: 99 }), /revision conflict/);
  assert.equal(readFileSync(configPath, 'utf8'), beforeConfig);
  assert.deepEqual(readdirSync(stateDir(f.root)).sort(), beforeFiles);
  runtime.configureExecutor({ driver: 'w0-fixture' }, { expectedRevision: 0 });
  assert.ok(readdirSync(stateDir(f.root)).some(name => name.endsWith('.backup')));
  assert.deepEqual(runtime.getSession(ticket.id), meta.driverSession);
  assert.equal(runtime.sessionStatus(ticket.id).execution.driver, 'codex');
  await runtime.replaceSession(ticket.id, { reason: 'Use the registered adapter', expectedSessionId: 'old-native-session', adoptCurrentSettings: true });
  assert.equal(runtime.sessionStatus(ticket.id).history.at(-1).previous.id, 'old-native-session');
  assert.equal(runtime.getSession(ticket.id), null);
  await runtime.runNext();
  assert.deepEqual(runtime.getSession(ticket.id), { driver: 'w0-fixture', id: 'replacement' });
  assert.equal(runtime.get(ticket.id).text, ticket.text);
});

test('W0 sessionless retired binding can migrate while completed history stays read-only', async t => {
  const f = project(t, async () => report('waiting', 'Need input', { question: 'Continue?' }));
  let runtime = f.open();
  runtime.configureExecutor({ driver: 'w0-fixture' }, { expectedRevision: 0 });
  const ticket = runtime.submit({ text: 'Old sessionless task' });
  await runtime.runNext(); runtime.close();
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  const meta = store.getMeta(`ticket:${ticket.id}`);
  meta.executionConfig = { driver: 'dsh-headless' }; delete meta.driverSession; delete meta.harnessBinding;
  store.setMeta(`ticket:${ticket.id}`, meta); store.close();
  runtime = f.open();
  assert.equal(runtime.actionAvailability(ticket.id).sessionReplace.allowed, true);
  assert.throws(() => runtime.configureV2({execution:{driver:'codex-app-server'}}), /executor set/);
  await runtime.replaceSession(ticket.id, { reason: 'Migrate retired sessionless execution', expectedSessionId: null, adoptCurrentSettings: true });
  assert.equal(runtime.sessionStatus(ticket.id).history.at(-1).previous, null);
  await runtime.runNext();
  assert.equal(runtime.sessionStatus(ticket.id).execution.driver, 'w0-fixture');
  runtime.cancel(ticket.id);
  assert.equal(runtime.executorStatus().migration.tickets.some(item => item.id === ticket.id), false);
});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
import { fakeAppServerProcessScript } from './helpers/app-server-process-fixture.mjs';

const options = { timeout: 10_000 };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-workspace-runtime-')));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes.reverse()) { await runtime.stop(); runtime.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open(options = {}) {
      const runtime = createProjectAgent({ projectRoot: root, ...options }).init();
      runtimes.push(runtime); return runtime;
    },
  };
}
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function initGit(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Workspace Test');
  git(root, 'config', 'user.email', 'workspace-test@example.invalid');
  writeFileSync(join(root, 'input.txt'), 'committed baseline\n');
  git(root, 'add', 'input.txt'); git(root, 'commit', '-qm', 'fixture baseline');
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('legacy SDK driver remains in-place unless isolation is explicitly selected', options, async t => {
  const f = fixture(t);
  const runtime = f.open({ driver: { async run(input) {
    assert.equal(input.projectRoot, f.root);
    assert.equal(input.sourceProjectRoot, f.root);
    writeFileSync(join(input.projectRoot, 'result.txt'), 'in-place');
    return { status: 'completed', summary: 'Written' };
  } } });
  const ticket = runtime.submit({ text: 'Write result' });
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.equal(runtime.getWorkspace(ticket.id).mode, 'in-place');
  assert.equal(readFileSync(join(f.root, 'result.txt'), 'utf8'), 'in-place');
});

test('plain-directory auto creates independent ticket copies and persists a workspace across reply/reopen', options, async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'input.txt'), 'original');
  const session = { driver: 'fixture', id: 'saved-session' };
  let workspace;
  const runtime = f.open({ workspace: { mode: 'auto' }, driver: { async run(input) {
    workspace = input.projectRoot;
    assert.notEqual(workspace, f.root);
    assert.equal(input.sourceProjectRoot, f.root);
    assert.equal(input.workspace.mode, 'copy');
    writeFileSync(join(workspace, 'draft.txt'), 'unfinished');
    input.checkpoint(session);
    return { status: 'waiting', summary: 'Which final value?' };
  } } });
  const ticket = runtime.submit({ text: 'Edit only the isolated copy' });
  assert.equal(runtime.getWorkspace(ticket.id), null);
  assert.equal((await runtime.runNext()).status, 'waiting');
  assert.equal(existsSync(join(f.root, 'draft.txt')), false);
  const saved = runtime.getWorkspace(ticket.id);
  assert.equal(saved.path, workspace);
  runtime.close();
  const reopened = f.open({ driver: { async run(input) {
    assert.equal(input.projectRoot, workspace);
    assert.deepEqual(input.session, session);
    assert.equal(readFileSync(join(workspace, 'draft.txt'), 'utf8'), 'unfinished');
    writeFileSync(join(workspace, 'input.txt'), 'isolated final');
    return { status: 'completed', summary: 'Completed isolated edit', artifacts: ['input.txt'] };
  } } });
  reopened.reply(ticket.id, 'Use isolated final');
  assert.equal((await reopened.runNext()).status, 'completed');
  assert.equal(readFileSync(join(f.root, 'input.txt'), 'utf8'), 'original');
  assert.equal(reopened.getWorkspace(ticket.id).path, workspace);
  const review = reopened.inspectWorkspace(ticket.id);
  assert.ok(review.changes.some(change => change.path === 'input.txt'));
  assert.ok(review.changes.some(change => change.path === 'draft.txt'));
  reopened.close();
  let secondPath;
  const second = f.open({ workspace: { mode: 'auto' }, driver: { async run(input) {
    secondPath = input.projectRoot;
    assert.equal(input.session, undefined);
    assert.equal(readFileSync(join(secondPath, 'input.txt'), 'utf8'), 'original');
    assert.equal(existsSync(join(secondPath, 'draft.txt')), false);
    return { status: 'completed', summary: 'Separate baseline verified' };
  } } });
  second.submit({ text: 'Inspect a separate copy' });
  assert.equal((await second.runNext()).status, 'completed');
  assert.notEqual(secondPath, workspace);
});

test('Git worktree execution preserves the source HEAD, index and dirty files', options, async t => {
  const f = fixture(t); initGit(f.root);
  const head = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'input.txt'), 'staged user edit');
  git(f.root, 'add', 'input.txt');
  writeFileSync(join(f.root, 'input.txt'), 'unstaged user edit');
  writeFileSync(join(f.root, 'untracked.txt'), 'user file');
  const index = git(f.root, 'ls-files', '--stage');
  const runtime = f.open({ workspace: { mode: 'auto' }, driver: { async run(input) {
    assert.equal(input.workspace.mode, 'worktree');
    assert.equal(readFileSync(join(input.projectRoot, 'input.txt'), 'utf8'), 'committed baseline\n');
    writeFileSync(join(input.projectRoot, 'input.txt'), 'agent change');
    writeFileSync(join(input.projectRoot, 'result.txt'), 'artifact');
    return { status: 'completed', summary: 'Worktree changed', artifacts: ['input.txt', 'result.txt'] };
  } } });
  const ticket = runtime.submit({ text: 'Edit worktree' });
  assert.equal((await runtime.runNext()).status, 'completed');
  const workspace = runtime.getWorkspace(ticket.id);
  assert.equal(workspace.baseCommit, head);
  assert.equal(workspace.sourceDirty, true);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.root, 'ls-files', '--stage'), index);
  assert.equal(readFileSync(join(f.root, 'input.txt'), 'utf8'), 'unstaged user edit');
  assert.equal(readFileSync(join(f.root, 'untracked.txt'), 'utf8'), 'user file');
  assert.equal(existsSync(join(f.root, 'result.txt')), false);
  const review = runtime.inspectWorkspace(ticket.id);
  assert.ok(review.changes.some(change => change.path === 'input.txt'));
  assert.ok(review.changes.some(change => change.path === 'result.txt'));
});

test('cancel and retry preserve the workspace and session under new authorization', options, async t => {
  const f = fixture(t), entered = deferred();
  writeFileSync(join(f.root, 'source.txt'), 'original');
  let path, call = 0;
  const runtime = f.open({ workspace: { mode: 'copy' }, driver: { async run(input) {
    if (++call === 1) {
      path = input.projectRoot;
      writeFileSync(join(path, 'partial.txt'), 'preserve me');
      input.checkpoint({ driver: 'fixture', id: 'cancel-session' });
      entered.resolve();
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('Cancelled');
    }
    assert.equal(input.projectRoot, path);
    assert.equal(input.session.id, 'cancel-session');
    assert.equal(readFileSync(join(path, 'partial.txt'), 'utf8'), 'preserve me');
    return { status: 'completed', summary: 'Resumed inspected copy' };
  } } });
  const ticket = runtime.submit({ text: 'Change copy' });
  const oldDomain = runtime.getDomainTicket(ticket.id).id;
  const pending = runtime.runNext(); await entered.promise;
  runtime.cancel(ticket.id); await pending;
  assert.equal(runtime.get(ticket.id).status, 'cancelled');
  runtime.retry(ticket.id);
  assert.notEqual(runtime.getDomainTicket(ticket.id).id, oldDomain);
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.equal(existsSync(join(f.root, 'partial.txt')), false);
});

test('configuration changes cannot move an active execution and workspace failures require retry', options, async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const runtime = f.open({ workspace: { mode: 'copy' }, driver: { async run() {
    entered.resolve(); await release.promise;
    return { status: 'waiting', summary: 'More input?' };
  } } });
  const ticket = runtime.submit({ text: 'Wait in a copy' });
  const pending = runtime.runNext(); await entered.promise;
  const observer = f.open();
  assert.throws(() => observer.configure({ workspace: { mode: 'in-place' } }), /active|running|execut/i);
  release.resolve(); await pending;
  const saved = runtime.getWorkspace(ticket.id);
  rmSync(saved.path, { recursive: true, force: true });
  runtime.reply(ticket.id, 'Continue');
  assert.equal((await runtime.runNext()).status, 'failed');
  assert.equal(existsSync(saved.path), false);
  assert.equal(await runtime.runNext(), null);
});

test('failed worktree preparation never invokes a driver or falls back to the source', options, async t => {
  const f = fixture(t); let calls = 0;
  writeFileSync(join(f.root, 'source.txt'), 'preserve');
  const runtime = f.open({ workspace: { mode: 'worktree' }, driver: { async run() {
    calls++; return { status: 'completed', summary: 'Should not run' };
  } } });
  const ticket = runtime.submit({ text: 'Require Git isolation' });
  assert.equal((await runtime.runNext()).status, 'failed');
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'preserve');
  assert.equal(await runtime.runNext(), null);
  runtime.retry(ticket.id);
  assert.equal((await runtime.runNext()).status, 'failed');
  assert.equal(calls, 0);
});

test('a pre-workspace native session retains its original cwd after isolation is enabled', options, async t => {
  const f = fixture(t);
  const session = { driver: 'fixture', id: 'phase3-native-session' };
  const original = f.open({ driver: { async run(input) {
    input.checkpoint(session);
    writeFileSync(join(input.projectRoot, 'partial.txt'), 'phase3 progress');
    return { status: 'waiting', summary: 'Continue?' };
  } } });
  const ticket = original.submit({ text: 'Continue previous in-place work' });
  assert.equal((await original.runNext()).status, 'waiting');
  original.close();
  // Simulate the durable shape of a phase3 ticket, which predates workspace metadata.
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  const meta = store.getMeta(`ticket:${ticket.id}`);
  assert.ok(meta.runId);
  delete meta.workspace; delete meta.workspaceVersion; delete meta.harnessBinding;
  store.setMeta(`ticket:${ticket.id}`, meta); store.close();
  const resumed = f.open({ driver: { async run(input) {
    assert.equal(input.projectRoot, f.root);
    assert.equal(input.workspace.mode, 'in-place');
    assert.deepEqual(input.session, session);
    assert.equal(readFileSync(join(input.projectRoot, 'partial.txt'), 'utf8'), 'phase3 progress');
    return { status: 'completed', summary: 'Legacy cwd preserved' };
  } } });
  resumed.configure({ workspace: { mode: 'copy' } });
  resumed.reply(ticket.id, 'Continue');
  const result = await resumed.runNext();
  assert.equal(result.status, 'completed', JSON.stringify(result.reports));
  assert.equal(resumed.getWorkspace(ticket.id).path, f.root);
  assert.equal(resumed.getConfig().workspace.mode, 'copy');
});

test('an explicit SDK driver takes precedence over configured Codex execution', options, async t => {
  const f = fixture(t); let calls = 0;
  const runtime = f.open({ driver: { async run(input) {
    calls++;
    assert.equal(input.workspace.mode, 'copy');
    return { status: 'completed', summary: 'Injected driver selected' };
  } } });
  runtime.configure({ workspace: { mode: 'copy' }, execution: { driver: 'codex-app-server', executable: join(f.root, 'unavailable-codex') } });
  runtime.submit({ text: 'Use the injected executor' });
  assert.equal((await runtime.runNext()).status, 'completed');
  assert.equal(calls, 1);
});

test('failed legacy workspace persistence cannot relocate a native session on retry', options, async t => {
  const f = fixture(t);
  const session = { driver: 'fixture', id: 'phase3-before-migration' };
  const original = f.open({ driver: { async run(input) {
    input.checkpoint(session);
    return { status: 'waiting', summary: 'Continue?' };
  } } });
  const ticket = original.submit({ text: 'Resume legacy cwd safely' });
  await original.runNext(); original.close();
  const store = new Store(join(stateDir(f.root), 'state.sqlite'));
  const meta = store.getMeta(`ticket:${ticket.id}`);
  delete meta.workspace; delete meta.workspaceVersion; delete meta.harnessBinding;
  store.setMeta(`ticket:${ticket.id}`, meta); store.close();
  const resumed = f.open({ driver: { async run(input) {
    assert.equal(input.projectRoot, f.root);
    assert.deepEqual(input.session, session);
    return { status: 'completed', summary: 'Original cwd preserved across failed migration' };
  } } });
  resumed.configure({ workspace: { mode: 'copy' } });
  resumed.reply(ticket.id, 'Continue');
  const setMeta = Store.prototype.setMeta;
  let injected = false;
  Store.prototype.setMeta = function (key, value) {
    if (!injected && key === `ticket:${ticket.id}` && value.workspace?.mode === 'in-place') {
      injected = true;
      throw new Error('Injected workspace persistence failure');
    }
    return setMeta.call(this, key, value);
  };
  try { assert.equal((await resumed.runNext()).status, 'failed'); }
  finally { Store.prototype.setMeta = setMeta; }
  assert.equal(injected, true);
  resumed.retry(ticket.id);
  const result = await resumed.runNext();
  assert.equal(result.status, 'completed', JSON.stringify(result.reports));
  assert.equal(resumed.getWorkspace(ticket.id).path, f.root);
});

test('SDK execution selection preserves persistent settings and resolve relative executables from the source', options, async t => {
  const f = fixture(t);
  const configured = f.open();
  mkdirSync(join(f.root, '.js-superagent'));
  const executable = join(f.root, '.js-superagent', 'fake-codex.mjs');
  writeFileSync(executable, fakeAppServerProcessScript(), { mode: 0o700 });
  configured.configure({ workspace: { mode: 'copy' }, execution: { driver: 'codex-app-server', executable: './.js-superagent/fake-codex.mjs', model: 'stored-model', timeoutMs: 30_000, killGraceMs: 1 } });
  configured.close();
  const runtime = f.open({ execution: { driver: 'codex-app-server', executable, model: 'per-call-model', timeoutMs: 5_000 } });
  assert.equal(runtime.getConfig().execution.model, 'per-call-model');
  assert.equal(runtime.getConfig().execution.timeoutMs, 5_000);
  assert.equal(runtime.getConfig().execution.executable, executable);
  const ticket = runtime.submit({ text: 'Run the saved executable with temporary overrides' });
  const result = await runtime.runNext();
  assert.equal(result.status, 'completed', JSON.stringify(result.reports));
  const workspace = runtime.getWorkspace(ticket.id);
  const seen = JSON.parse(readFileSync(join(workspace.path, 'seen.json'), 'utf8'));
  assert.equal(seen.executable, executable);
  assert.equal(seen.cwd, workspace.path);
  assert.equal(seen.model, 'per-call-model');
  assert.equal(existsSync(join(workspace.path, '.js-superagent', 'fake-codex.mjs')), false);
  runtime.close();
  const reopened = f.open({ execution: { driver: 'codex-app-server', executable: './.js-superagent/fake-codex.mjs', model: 'stored-model', timeoutMs: 30_000 } });
  assert.equal(reopened.getConfig().execution.model, 'stored-model');
  assert.equal(reopened.getConfig().execution.timeoutMs, 30_000);
  reopened.submit({ text: 'Resolve a relative per-call executable against the original source' });
  const overridden = await reopened.runNext();
  assert.equal(overridden.status, 'completed', JSON.stringify(overridden.reports));
  assert.equal(JSON.parse(readFileSync(join(reopened.getWorkspace(overridden.id).path, 'seen.json'), 'utf8')).executable, executable);
});

// Opt-in acceptance: calls real Codex through an offline-installed package.
// Keep --output as evidence; this script never applies workspaces to their sources.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash } from 'node:crypto';

const { values, artifact } = parseArgs({ options: {
  output: { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' },
} });
if (!values.output) throw new Error('Pass --output <new-directory>; this script uses your Codex login and makes model calls.');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Use a new output directory to preserve earlier evidence.');
mkdirSync(output, { recursive: true, mode: 0o700 });
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
function run(executable, args, cwd, timeout = 120_000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function git(project, ...args) { return run('git', ['-C', project, ...args], output).trim(); }
const packed = artifact;
const consumer = join(output, 'consumer'); mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], consumer);
const installed = join(consumer, 'node_modules/js-superagent');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const cli = join(installed, 'bin/js-superagent.mjs');
const invoke = (project, ...args) => JSON.parse(run(process.execPath, [cli, '--project', project, ...args], output, 360_000));
const source = 'def total(price, quantity, discount=0):\n    return price + quantity - discount\n';
const evidence = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  codex: run(values['codex-path'] ?? 'codex', ['--version'], output).trim(), package: packed.filename,
  status: 'running', scenarios: [],
  implementationSha256: Object.fromEntries([
    'src/index.mjs', 'src/config.mjs', 'src/workspaces.mjs', 'src/drivers/codex-app-server.mjs',
    'src/drivers/app-server-supervisor.mjs', 'src/drivers/posix-process-tree.mjs', 'bin/js-superagent.mjs',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
};
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
const log = message => console.log(`[real-workspace] ${message}`);
const runtimes = new Set();
function open(project) {
  // No injected driver/options: must resolve the persisted project configuration.
  const runtime = createProjectAgent({ projectRoot: project }).init();
  runtimes.add(runtime); return runtime;
}
function close(runtime) { runtime.close(); runtimes.delete(runtime); }
function fixture(name, useGit) {
  const project = join(output, name); mkdirSync(project);
  writeFileSync(join(project, 'AGENTS.md'), 'This is an isolated js-superagent engineering acceptance fixture. Work only inside the current execution directory. No network, external messages, commits, merges, or changes to parent/source directories. Do not change .js-superagent. Use python3 for verification.\n');
  writeFileSync(join(project, 'pricing.py'), source);
  writeFileSync(join(project, 'test_pricing.py'), `import unittest
from pricing import total
class PricingTest(unittest.TestCase):
    def test_basic(self): self.assertEqual(total(10, 3), 30)
    def test_discount(self): self.assertEqual(total(20, 2, 25), 30)
    def test_zero(self): self.assertEqual(total(12, 0), 0)
`);
  writeFileSync(join(project, 'README.txt'), 'committed baseline\n');
  if (useGit) {
    git(project, 'init', '-q');
    git(project, 'config', 'user.name', 'js-superagent acceptance');
    git(project, 'config', 'user.email', 'acceptance@example.invalid');
    git(project, 'add', 'AGENTS.md', 'pricing.py', 'test_pricing.py', 'README.txt');
    git(project, 'commit', '-qm', 'acceptance baseline');
    writeFileSync(join(project, 'README.txt'), 'staged source change\n');
    git(project, 'add', 'README.txt');
    writeFileSync(join(project, 'README.txt'), 'unstaged source change\n');
  }
  writeFileSync(join(project, 'user-untracked.txt'), 'leave source alone\n');
  // These are artificial sentinels, never credentials copied from the host.
  writeFileSync(join(project, '.env'), 'ACCEPTANCE_SENTINEL=DO_NOT_COPY\n');
  const outside = join(output, `${name}-outside.txt`);
  writeFileSync(outside, 'outside fixture sentinel\n');
  symlinkSync(outside, join(project, 'external-link'));
  assert.equal(existsSync(join(project, 'package.json')), false);
  const options = ['--workspace', 'auto', '--driver', 'codex-app-server', '--timeout-ms', '300000'];
  if (values['codex-path']) options.push('--codex-path', values['codex-path']);
  if (values.model) options.push('--model', values.model);
  invoke(project, 'init', ...options);
  return project;
}
save();
try {
  for (const [name, mode] of [['git-project', 'worktree'], ['plain-project', 'copy']]) {
    const isGit = mode === 'worktree';
    const project = fixture(name, isGit);
    const config = invoke(project, 'config');
    assert.equal(config.workspace.mode, 'auto');
    assert.equal(config.execution.driver, 'codex-app-server');
    assert.equal(config.execution.timeoutMs, 300_000);
    const baseline = {
      source: readFileSync(join(project, 'pricing.py'), 'utf8'),
      tests: readFileSync(join(project, 'test_pricing.py'), 'utf8'),
      readme: readFileSync(join(project, 'README.txt'), 'utf8'),
      ...(isGit ? { head: git(project, 'rev-parse', 'HEAD'), index: git(project, 'ls-files', '--stage') } : {}),
    };
    const assertSourceUntouched = () => {
      assert.equal(readFileSync(join(project, 'pricing.py'), 'utf8'), baseline.source);
      assert.equal(readFileSync(join(project, 'test_pricing.py'), 'utf8'), baseline.tests);
      assert.equal(readFileSync(join(project, 'README.txt'), 'utf8'), baseline.readme);
      assert.equal(readFileSync(join(project, 'user-untracked.txt'), 'utf8'), 'leave source alone\n');
      assert.equal(readFileSync(join(project, '.env'), 'utf8'), 'ACCEPTANCE_SENTINEL=DO_NOT_COPY\n');
      assert.equal(existsSync(join(project, 'baseline.txt')), false);
      if (isGit) {
        assert.equal(git(project, 'rev-parse', 'HEAD'), baseline.head);
        assert.equal(git(project, 'ls-files', '--stage'), baseline.index);
      }
    };
    const ticket = invoke(project, 'submit', 'Fix pricing.total to calculate price * quantity with percentage discount, and add tests for discounts outside 0..100. Before modifying code, inspect the existing tests and ask me what to do with out-of-range discounts; do not select that policy yourself. After my answer, implement and run python3 -m unittest -v.');
    log(`${mode}: CLI uses persisted configuration and asks the missing policy.`);
    const waiting = invoke(project, 'run');
    assert.equal(waiting.status, 'waiting', JSON.stringify(waiting));
    let runtime = open(project);
    const workspace = runtime.getWorkspace(ticket.id);
    assert.equal(workspace.mode, mode); assert.equal(workspace.state, 'ready');
    assert.notEqual(workspace.path, project);
    assert.equal(readFileSync(join(workspace.path, 'pricing.py'), 'utf8'), source);
    assert.equal(existsSync(join(workspace.path, '.env')), false);
    assert.equal(existsSync(join(workspace.path, 'external-link')), false);
    if (isGit) {
      assert.equal(workspace.baseCommit, baseline.head);
      assert.equal(workspace.sourceDirty, true);
      assert.equal(readFileSync(join(workspace.path, 'README.txt'), 'utf8'), 'committed baseline\n');
    }
    const session = runtime.getSession(ticket.id); assert.equal(session.driver, 'codex-app-server');
    assertSourceUntouched(); close(runtime);
    invoke(project, 'reply', ticket.id, 'Raise ValueError below 0 or above 100; accept both endpoints. Use ordinary numeric arithmetic, no rounding required. Implement and test now.');
    runtime = open(project);
    log(`${mode}: SDK reopens the project and resumes its saved workspace/session.`);
    const completed = await runtime.runNext();
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(runtime.getWorkspace(ticket.id).path, workspace.path);
    assert.deepEqual(runtime.getSession(ticket.id), session);
    const checks = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: workspace.path, encoding: 'utf8', timeout: 30_000 });
    assert.equal(checks.status, 0, checks.stderr);
    run('python3', ['-c', 'from pricing import total\nassert total(10,3)==30\nassert total(20,2,25)==30\nassert total(10,2,100)==0\nfor d in (-1,101):\n try: total(10,2,d)\n except ValueError: pass\n else: raise AssertionError("missing validation")'], workspace.path);
    const review = invoke(project, 'workspace', ticket.id);
    assert.equal(review.workspace.path, workspace.path);
    assert.ok(review.changes.some(change => change.path === 'pricing.py'));
    assert.ok(review.changes.some(change => change.path === 'test_pricing.py'));
    assertSourceUntouched();
    if (isGit) assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), baseline.head);
    close(runtime);

    // New ticket must start at the source baseline, not the prior ticket's edited files.
    const second = invoke(project, 'submit', 'Verify that pricing.py still contains the exact line return price + quantity - discount. Do not fix pricing.py or run its intentionally failing unit tests. Create only baseline.txt containing BASELINE_SEPARATE, then run a Python assertion that both the original formula and this new file are present. Report completion after that targeted verification.');
    log(`${mode}: a second real ticket verifies an independent baseline.`);
    const secondResult = invoke(project, 'run');
    assert.equal(secondResult.status, 'completed', JSON.stringify(secondResult));
    runtime = open(project);
    const secondWorkspace = runtime.getWorkspace(second.id);
    assert.notEqual(secondWorkspace.path, workspace.path);
    assert.notDeepEqual(runtime.getSession(second.id), session);
    assert.equal(readFileSync(join(secondWorkspace.path, 'pricing.py'), 'utf8'), source);
    assert.equal(readFileSync(join(secondWorkspace.path, 'baseline.txt'), 'utf8').trim(), 'BASELINE_SEPARATE');
    assert.equal(existsSync(join(workspace.path, 'baseline.txt')), false);
    assertSourceUntouched();
    evidence.scenarios.push({
      name: `${mode}-configuration-isolation-resume`, status: 'passed', project: name,
      ticketId: ticket.id, session, workspace, config, review, sourceUnchanged: true,
      independentTests: checks.stderr, reports: completed.reports,
      secondTicket: { id: second.id, workspace: secondWorkspace, session: runtime.getSession(second.id), independentBaseline: true },
      ...(isGit ? { sourceHead: baseline.head, sourceIndexUnchanged: true, noAutomaticCommit: true } : {}),
    });
    save(); close(runtime);
  }
  evidence.status = 'passed';
  log('Both real workspace scenarios passed.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
} finally {
  for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${join(output, 'acceptance.json')}`);
}

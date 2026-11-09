// Explicit opt-in acceptance: uses your Codex login and makes real model calls.
// Keeps the fixture, installed tarball, reports and logs in --output for inspection.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values, artifact } = parseArgs({ options: {
  output: { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' },
} });
if (!values.output) throw new Error('Pass --output <new-directory>; this acceptance run calls the real Codex CLI.');
const output = resolve(values.output);
if (existsSync(output)) throw new Error('Use a new output directory so previous evidence is preserved.');
mkdirSync(output, { recursive: true, mode: 0o700 });
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const packed = artifact;
const consumer = join(output, 'consumer');
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], consumer);
const installed = join(consumer, 'node_modules/js-superagent');
const { createProjectAgent } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const cli = join(installed, 'bin/js-superagent.mjs');
const evidence = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  codex: run(values['codex-path'] ?? 'codex', ['--version'], output).trim(),
  package: packed.filename, scenarios: [], status: 'running',
  implementationSha256: Object.fromEntries(['src/index.mjs', 'src/drivers/codex-app-server.mjs', 'src/drivers/app-server-supervisor.mjs', 'src/drivers/posix-process-tree.mjs'].map(path => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
};
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
const log = text => console.log(`[real-codex] ${text}`);
const driverOptions = { executable: values['codex-path'], model: values.model, timeoutMs: 300_000 };
const runtimes = new Set();
function open(project) {
  const runtime = createProjectAgent({ projectRoot: project, execution: { driver: 'codex-app-server', ...driverOptions } }).init();
  runtimes.add(runtime); return runtime;
}
function close(runtime) { runtime.close(); runtimes.delete(runtime); }
function invoke(project, ...args) { return JSON.parse(run(process.execPath, [cli, '--project', project, ...args], output)); }
async function until(predicate, label, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function fixture(name) {
  const project = join(output, name); mkdirSync(project);
  // This explicit fixture scope keeps inherited project instructions from causing unrelated work.
  writeFileSync(join(project, 'AGENTS.md'), 'This is an isolated js-superagent acceptance fixture. Work only in this directory. No network, external messages, commits, or changes to parent directories. Do not change .js-superagent state. Use python3 unittest for verification.\n');
  assert.equal(existsSync(join(project, '.git')), false);
  assert.equal(existsSync(join(project, 'package.json')), false);
  return project;
}
save();
try {
  const project = fixture('python-repair');
  writeFileSync(join(project, 'pricing.py'), 'def total(price, quantity, discount=0):\n    return price + quantity - discount\n');
  writeFileSync(join(project, 'test_pricing.py'), `import unittest
from pricing import total

class PricingTest(unittest.TestCase):
    def test_basic(self): self.assertEqual(total(10, 3), 30)
    def test_discount(self): self.assertEqual(total(20, 2, 25), 30)
    def test_zero(self): self.assertEqual(total(12, 0), 0)
`);
  invoke(project, 'init');
  const ticket = invoke(project, 'submit', 'Fix pricing.total to compute price * quantity with percentage discount. Add tests for discount outside 0..100, but first ask me which invalid-discount policy to use; do not choose a policy or modify pricing.py before my reply. Inspect the existing tests first. After my reply implement, add validation tests and run python3 -m unittest -v.');
  let runtime = open(project);
  log('Requesting the missing validation policy.');
  const cliOptions = [];
  if (values['codex-path']) cliOptions.push('--codex-path', values['codex-path']);
  if (values.model) cliOptions.push('--model', values.model);
  const waiting = invoke(project, 'run', ...cliOptions);
  assert.equal(waiting.status, 'waiting', JSON.stringify(waiting));
  assert.match(readFileSync(join(project, 'pricing.py'), 'utf8'), /price \+ quantity/);
  const session = runtime.getSession(ticket.id); assert.equal(session.driver, 'codex-app-server');
  close(runtime);
  invoke(project, 'reply', ticket.id, 'Raise ValueError when discount is below 0 or above 100. Accept both endpoints. Keep ordinary numeric arithmetic; rounding is not required. Implement the fix and tests now.');
  runtime = open(project);
  log('Resuming the saved session to modify code and run its tests.');
  const completed = await runtime.runNext();
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.deepEqual(runtime.getSession(ticket.id), session);
  const independentTests = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: project, encoding: 'utf8' });
  assert.equal(independentTests.status, 0, independentTests.stderr);
  run('python3', ['-c', 'from pricing import total\nassert total(10,3)==30\nassert total(20,2,25)==30\nassert total(10,2,100)==0\nfor d in (-1,101):\n try: total(10,2,d)\n except ValueError: pass\n else: raise AssertionError("missing validation")'], project);
  evidence.scenarios.push({ name: 'modify-verify-question-reply', status: 'passed', project: 'python-repair', ticketId: ticket.id, session, reports: completed.reports, independentTests: independentTests.stderr });
  save(); close(runtime);

  for (const action of ['cancel', 'stop']) {
    const project = fixture(`python-${action}`);
    writeFileSync(join(project, 'slow_check.py'), `import os, time
from pathlib import Path
Path('worker.pid').write_text(str(os.getpid()))
while not Path('release.flag').exists():
    Path('heartbeat.txt').write_text(str(time.time_ns()))
    time.sleep(0.1)
print('slow check passed')
`);
    writeFileSync(join(project, 'test_recovery.py'), `import unittest
from pathlib import Path
class RecoveryTest(unittest.TestCase):
    def test_recovered(self): self.assertEqual(Path('recovery.txt').read_text().strip(), 'recovered')
`);
    runtime = open(project);
    const ticket = runtime.submit({ text: 'Run python3 slow_check.py and wait for it to succeed. It waits for a release.flag controlled by the acceptance harness; never create or change that flag, the script, worker.pid, or heartbeat.txt yourself. Only after it succeeds, write recovery.txt containing recovered and run python3 -m unittest -v. If resumed, inspect existing files and rerun the check as necessary before completing.' });
    log(`Starting real execution for ${action} and resume.`);
    const pending = runtime.runNext();
    let settled, failed;
    pending.then(result => { settled = result; }, error => { failed = error; });
    await until(() => {
      if (failed) throw failed;
      if (settled) throw new Error(`Execution ended before cancellation checkpoint: ${JSON.stringify(settled)}`);
      return existsSync(join(project, 'heartbeat.txt'));
    }, 'real tool heartbeat');
    const pid = Number(readFileSync(join(project, 'worker.pid'), 'utf8'));
    const session = runtime.getSession(ticket.id); assert.equal(session.driver, 'codex-app-server');
    assert.equal(existsSync(join(project, 'recovery.txt')), false);
    if (action === 'cancel') invoke(project, 'cancel', ticket.id);
    else await runtime.stop();
    await pending;
    const stopped = runtime.get(ticket.id);
    assert.equal(stopped.status, action === 'cancel' ? 'cancelled' : 'interrupted');
    await until(() => !alive(pid), 'tool process exit', 10_000);
    const heartbeat = readFileSync(join(project, 'heartbeat.txt'), 'utf8');
    await delay(500);
    assert.equal(readFileSync(join(project, 'heartbeat.txt'), 'utf8'), heartbeat);
    const oldDomainId = runtime.getDomainTicket(ticket.id).id;
    close(runtime);
    // The harness has now inspected effects and makes an explicit retry authorization.
    writeFileSync(join(project, 'release.flag'), 'release after checking stopped process\n');
    invoke(project, 'retry', ticket.id);
    runtime = open(project);
    const newDomainId = runtime.getDomainTicket(ticket.id).id;
    if (action === 'cancel') assert.notEqual(newDomainId, oldDomainId);
    log(`Resuming the ${action} session after explicit retry.`);
    const resumed = await runtime.runNext();
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
    assert.deepEqual(runtime.getSession(ticket.id), session);
    run('python3', ['-m', 'unittest', '-v'], project);
    evidence.scenarios.push({ name: `${action}-restart-resume`, status: 'passed', project: `python-${action}`, ticketId: ticket.id, session, toolPid: pid, toolExited: true, heartbeatStopped: true, stoppedStatus: stopped.status, oldDomainId, newDomainId, reports: resumed.reports });
    save(); close(runtime);
  }
  evidence.status = 'passed';
  log('All real acceptance scenarios passed.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
} finally {
  for (const runtime of runtimes) { await runtime.stop(); runtime.close(); }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${join(output, 'acceptance.json')}`);
}

import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs();
// Explicit native-model acceptance. No GitHub calls or messages are sent by this script.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const { createCodexAppServerDriver } = await importFrozenModule(artifact, 'src/drivers/codex-app-server.mjs');

const root = resolve(values.output);
mkdirSync(root, { recursive: true, mode: 0o700 });
const evidence = { version: 1, startedAt: new Date().toISOString(), executableVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), scenarios: [] };
const writeEvidence = () => writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const source = { projectRoot: root, sourceProjectRoot: root };
let session;
function input(task, controller, runId) {
  return { ...source, runId, assignmentId: randomUUID(), signal: controller.signal, session,
    ticket: { text: task, scope: 'Only create and inspect result.txt and cancelled.txt in this isolated acceptance project; do not access other directories or external services.', messages: [], reports: [] },
    checkpoint: value => { session = value; }, registerProcess: () => {},
  };
}
try {
  const controller = new AbortController(), runId = randomUUID(), inputId = randomUUID(), marker = `steered-${randomUUID()}`;
  const reads = [], progress = [];
  let receipt, steering, started = false;
  const driver = createCodexAppServerDriver({ timeoutMs: 180_000, onEvent(event) {
    if (event.method === 'item/started' && event.params.item?.type === 'commandExecution' && !started) {
      started = true;
      steering = driver.sendInput({ runId, inputId, text: `Correction: after the sleep finishes, write exactly ${marker} to result.txt instead. Acknowledge inputId ${inputId} after considering this correction.` }).then(value => { receipt = { ...value, at: new Date().toISOString(), readsAtReceipt: reads.length }; });
    }
  } });
  const report = await driver.run({ ...input('First execute a shell sleep 10. Then write original to result.txt, inspect the file and report its contents.', controller, runId),
    inputRead: value => reads.push({ ...value, at: new Date().toISOString() }), progress: value => progress.push(value) });
  await steering;
  assert.equal(report.state, 'ready'); assert.equal(readFileSync(join(root, 'result.txt'), 'utf8').trim(), marker);
  assert.equal(receipt.read, false); assert.equal(receipt.readsAtReceipt, 0); assert.equal(reads[0].inputId, inputId);
  assert.equal(reads[0].evidence.sessionId, receipt.sessionId); assert.equal(reads[0].evidence.turnId, receipt.turnId);
  evidence.scenarios.push({ name: 'live-steering', runId, session, receipt, reads, progressCount: progress.length, report, fileMatched: true }); writeEvidence();

  const previousSession = { ...session }, resumedRunId = randomUUID();
  const resumed = await driver.run(input('Read result.txt, confirm it contains the corrected value from the previous turn and report it. Do not change the file.', new AbortController(), resumedRunId));
  assert.deepEqual(session, previousSession); assert.equal(resumed.state, 'ready'); assert.ok(resumed.summary.includes(marker));
  evidence.scenarios.push({ name: 'native-session-resume', runId: resumedRunId, sameSession: true, report: resumed }); writeEvidence();

  const cancelled = new AbortController(), cancelRunId = randomUUID(); let cancelRequested = false;
  const cancellationDriver = createCodexAppServerDriver({ timeoutMs: 180_000, onEvent(event) {
    if (event.method === 'item/started' && event.params.item?.type === 'commandExecution' && !cancelRequested) { cancelRequested = true; cancelled.abort(); }
  } });
  await assert.rejects(cancellationDriver.run(input('Execute a shell sleep 20, then create cancelled.txt containing should-not-exist. The sleep must precede writing the file.', cancelled, cancelRunId)), /cancelled|interrupted/);
  assert.equal(cancelRequested, true); assert.equal(existsSync(join(root, 'cancelled.txt')), false);
  evidence.scenarios.push({ name: 'cancel-active-turn', runId: cancelRunId, cancelled: true, postCancelFileAbsent: true }); writeEvidence();
  evidence.completedAt = new Date().toISOString(); evidence.status = 'passed'; writeEvidence();
  process.stdout.write(JSON.stringify({ status: evidence.status, scenarios: evidence.scenarios.map(item => item.name), evidencePath: join(root, 'acceptance.json') }) + '\n');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.message ?? error); writeEvidence(); throw error;
}

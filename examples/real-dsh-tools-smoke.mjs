// One explicit real-provider Worker turn, in a disposable project with no service.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { createProjectAgent } = await importFrozenModule(parseAcceptanceArgs().artifact, 'src/index.mjs');
const { projectStateDirectory: stateDir } = await importFrozenModule(parseAcceptanceArgs().artifact, 'src/state-paths.mjs');

if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY explicitly before this real-provider check');
const root = mkdtempSync(join(tmpdir(), 'js-superagent-dsh-tools-live-'));
writeFileSync(join(root, 'result.txt'), 'before\n');
const agent = createProjectAgent({ projectRoot: root, workspace: 'copy' }).init();
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), projectRoot: root, status: 'running' };
try {
  agent.configureExecutor({ driver: 'dsh-sdk', executable: process.env.JS_SUPERAGENT_DSH_EXECUTABLE ?? 'dsh',
    model: process.env.JS_SUPERAGENT_DSH_MODEL ?? 'deepseek-flash',
    backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    enableAgentTools: true, enableManagedJobs: true, timeoutMs: 180_000 }, { expectedRevision: 0 });
  agent.configureJobs({ paths: ['result.txt'], profiles: {
    check: { kind: 'command', version: '1', command: process.execPath,
      args: ['-e', "const fs=require('node:fs');fs.writeFileSync('result.txt','managed DSH verified\\n');if(fs.readFileSync('result.txt','utf8')!=='managed DSH verified\\n')process.exit(1)"],
      environment: 'host', allowHostExecution: true, timeoutMs: 10_000 },
  } }, { expectedRevision: 0 });
  const ticket = agent.submit({ text: 'First call js_superagent_read with resource inputs to list this assignment context. Then use js_superagent_job_start to start trusted profile check and call js_superagent_job_wait for that returned job ID. The trusted command writes and verifies result.txt. When the job completed, read result.txt to verify its exact text is managed DSH verified followed by a newline, and return the required ready JSON with result.txt as artifact. Do not write files yourself or launch anything else.',
    scope: 'Only inspect owned context and run the trusted check profile for result.txt in the isolated workspace.' });
  evidence.ticketId = ticket.id;
  await agent.runNext();
  assert.equal(agent.get(ticket.id).status, 'completed');
  const jobs = agent.listJobs(ticket.id);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].kind, 'command'); assert.equal(jobs[0].status, 'completed');
  assert.equal(readFileSync(join(agent.getWorkspace(ticket.id).path, 'result.txt'), 'utf8'), 'managed DSH verified\n');
  assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'before\n');
  const db = new DatabaseSync(join(stateDir(root), 'state.sqlite'), { readOnly: true });
  try {
    const calls = db.prepare("SELECT data FROM kv WHERE key LIKE 'agent-tool:%:call:%'").all().map(row => JSON.parse(row.data));
    assert.ok(calls.some(call => call.name === 'js_superagent_read' && call.status === 'completed'));
    evidence.businessCalls = calls.map(call => ({ name: call.name, status: call.status }));
  } finally { db.close(); }
  evidence.session = agent.getSession(ticket.id);
  evidence.jobs = jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status }));
  assert.equal(agent.status().active, false);
  evidence.status = 'passed';
} catch {
  evidence.status = 'failed';
  evidence.failure = 'Host assertion or execution failed; inspect the isolated project records.';
  process.exitCode = 1;
} finally {
  await agent.stop(); agent.close();
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}

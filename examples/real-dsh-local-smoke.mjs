// Explicit small real-provider check. Never starts or updates an installed service.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { createProjectAgent } = await importFrozenModule(parseAcceptanceArgs().artifact, 'src/index.mjs');

if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY explicitly before this real-provider check');
const root = mkdtempSync(join(tmpdir(), 'js-superagent-dsh-live-'));
const options = {
  executable: process.env.JS_SUPERAGENT_DSH_EXECUTABLE ?? 'dsh',
  model: process.env.JS_SUPERAGENT_DSH_MODEL ?? 'deepseek-flash',
  backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages',
    baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  timeoutMs: 180_000,
};
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), provider: 'deepseek-official', requestedModel: options.model, scenarios: [], projectRoot: root };
let agent;
try {
  const sdkRoot = join(root, 'sdk'); mkdirSync(sdkRoot);
  agent = createProjectAgent({ projectRoot: sdkRoot, workspace: 'copy' }).init();
  agent.configureExecutor({ driver: 'dsh-sdk', ...options }, { expectedRevision: 0 });
  const ticket = agent.submit({ text: 'Create greeting.txt with exactly the greeting I choose plus a newline. First ask me which greeting to use and do not create the file until I reply. After my reply write the file, read it back to verify exact contents, then report ready. Do no other work.', scope: 'Only create greeting.txt in the task workspace; ask for missing greeting, then verify.' });
  await agent.runNext();
  assert.equal(agent.get(ticket.id).status, 'waiting');
  assert.ok(agent.getDomainTicket(ticket.id).attention?.question);
  assert.equal(existsSync(join(agent.getWorkspace(ticket.id).path, 'greeting.txt')), false);
  const session = agent.getSession(ticket.id); assert.equal(session.driver, 'dsh-sdk');
  await agent.stop(); agent.close(); agent = undefined;
  // Reopen the host runtime as well as the native DSH process.
  agent = createProjectAgent({ projectRoot: sdkRoot }).init();
  agent.reply(ticket.id, 'Use exactly: Hello DSH');
  await agent.runNext();
  assert.equal(agent.get(ticket.id).status, 'completed');
  assert.deepEqual(agent.getSession(ticket.id), session);
  const workspace = agent.getWorkspace(ticket.id);
  assert.equal(readFileSync(join(workspace.path, 'greeting.txt'), 'utf8'), 'Hello DSH\n');
  evidence.scenarios.push({ name: 'sdk-question-reopen-resume-write', status: 'passed', ticketId: ticket.id, session, verifiedFile: 'greeting.txt' });
  await agent.stop(); agent.close(); agent = undefined;

  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error instanceof assert.AssertionError ? 'A host assertion failed; inspect the isolated task records.' : 'Execution failed; inspect isolated redacted diagnostics.';
  process.exitCode = 1;
} finally {
  if (agent) { await agent.stop(); agent.close(); }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}

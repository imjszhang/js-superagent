// Explicit small real-model check. Never starts or updates an installed service.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { createProjectAgent } = await importFrozenModule(parseAcceptanceArgs().artifact, 'src/index.mjs');

const apiKeyEnv = process.env.JS_SUPERAGENT_CURSOR_API_KEY_ENV;
if (apiKeyEnv && !process.env[apiKeyEnv]) throw new Error(`Set ${apiKeyEnv} explicitly before this real-model check`);
const root = mkdtempSync(join(tmpdir(), 'js-superagent-cursor-live-'));
const options = {
  executable: process.env.JS_SUPERAGENT_CURSOR_EXECUTABLE ?? 'cursor-agent',
  model: process.env.JS_SUPERAGENT_CURSOR_MODEL ?? 'grok-4.7-high-fast',
  ...(apiKeyEnv ? { apiKeyEnv } : {}),
  timeoutMs: 600_000,
};
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), requestedModel: options.model,
  login: apiKeyEnv ? 'dedicated-api-key' : 'personal-keychain', accountRules: apiKeyEnv ? 'api-key-account' : 'personal-account-rules-apply', scenarios: [], projectRoot: root };
let agent;
try {
  const sdkRoot = join(root, 'sdk'); mkdirSync(sdkRoot);
  agent = createProjectAgent({ projectRoot: sdkRoot, workspace: 'copy' }).init();
  agent.configureExecutor({ driver: 'cursor-agent', ...options }, { expectedRevision: 0 });
  const ticket = agent.submit({ text: 'Create greeting.txt with exactly the greeting I choose plus a newline. First ask me which greeting to use and do not create the file until I reply. After my reply write the file, read it back to verify exact contents, then report ready. Do no other work.', scope: 'Only create greeting.txt in the task workspace; ask for missing greeting, then verify.' });
  await agent.runNext();
  assert.equal(agent.get(ticket.id).status, 'waiting');
  assert.ok(agent.getDomainTicket(ticket.id).attention?.question);
  assert.equal(existsSync(join(agent.getWorkspace(ticket.id).path, 'greeting.txt')), false);
  const session = agent.getSession(ticket.id); assert.equal(session.driver, 'cursor-agent');
  await agent.stop(); agent.close(); agent = undefined;
  // Reopen the host runtime; Cursor itself runs one process per turn.
  agent = createProjectAgent({ projectRoot: sdkRoot }).init();
  agent.reply(ticket.id, 'Use exactly: Hello Cursor');
  await agent.runNext();
  assert.equal(agent.get(ticket.id).status, 'completed');
  assert.deepEqual(agent.getSession(ticket.id), session);
  const workspace = agent.getWorkspace(ticket.id);
  assert.equal(readFileSync(join(workspace.path, 'greeting.txt'), 'utf8'), 'Hello Cursor\n');
  evidence.scenarios.push({ name: 'cursor-question-reopen-resume-write', status: 'passed', ticketId: ticket.id, session, verifiedFile: 'greeting.txt' });
  await agent.stop(); agent.close(); agent = undefined;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error instanceof assert.AssertionError ? 'A host assertion failed; inspect the isolated task records.' : 'Execution failed; inspect isolated redacted diagnostics.';
  evidence.detail = String(error?.message ?? error).slice(0, 500);
  process.exitCode = 1;
} finally {
  if (agent) { await agent.stop(); agent.close(); }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}

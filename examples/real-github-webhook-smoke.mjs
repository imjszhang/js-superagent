// Opt-in acceptance against a registered GitHub App and its installed repository.
// The public HTTPS tunnel and App webhook configuration must already point to --port.
// This script writes only a dedicated acceptance Issue and comments; it never publishes code.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseGitHubDeliveryList } from './github-webhook-delivery-metadata.mjs';

const { values, artifact } = parseArgs({ options: {
  output: { type: 'string' }, repository: { type: 'string' }, actor: { type: 'string' }, issue: { type: 'string' },
  'app-id': { type: 'string' }, 'installation-id': { type: 'string' }, 'private-key-path': { type: 'string' },
  'webhook-secret-path': { type: 'string' }, 'public-url': { type: 'string' }, port: { type: 'string' },
  'gh-path': { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' }, write: { type: 'boolean' },
} });
const required = ['output', 'repository', 'actor', 'app-id', 'installation-id', 'private-key-path', 'webhook-secret-path', 'public-url', 'port'];
if (!values.write || required.some(key => !values[key])) throw new Error('Pass --write --output <new-directory> --repository <owner/repo> --actor <login> --app-id <id> --installation-id <id> --private-key-path <file> --webhook-secret-path <file> --public-url <https-webhook-url> --port <local-port>. This creates a dedicated Issue or uses --issue, calls real Codex, and writes test comments.');
const positive = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(values.actor) ||
    !positive(values['app-id']) || !positive(values['installation-id']) || !positive(values.port) || Number(values.port) > 65535 ||
    (values.issue !== undefined && !positive(values.issue))) throw new Error('Invalid acceptance repository, actor, App, installation or port');
const publicUrl = new URL(values['public-url']);
if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/github/webhook') throw new Error('The public URL must use HTTPS and the /github/webhook path, without credentials or query');
const repository = values.repository.toLowerCase(), actor = values.actor.toLowerCase(), appId = values['app-id'], installationId = Number(values['installation-id']);
const output = resolve(values.output), packageRoot = fileURLToPath(new URL('..', import.meta.url));
const privateKeyPath = resolve(values['private-key-path']), secretPath = resolve(values['webhook-secret-path']), gh = values['gh-path'] ?? 'gh';
if (existsSync(output)) throw new Error('Use a new output directory to preserve earlier evidence');
if (!existsSync(privateKeyPath) || !existsSync(secretPath)) throw new Error('Credential reference files must already exist');
function run(executable, args, cwd, timeout = 120_000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`); return result.stdout;
}
function api(method, endpoint, body, paginate = false) {
  return new Promise((resolveResult, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
    if (paginate) args.push('--paginate', '--slurp');
    if (body !== undefined) args.push('--input', '-');
    const child = spawn(gh, args, { cwd: packageRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const timer = setTimeout(() => { failure = new Error('Acceptance GitHub request timed out'); child.kill('SIGKILL'); }, 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { failure = new Error('Acceptance response too large'); child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
    child.on('error', error => { failure = error; }); child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure ?? new Error(`Acceptance GitHub request failed (${code}): ${stderr}`)); return; }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('Acceptance GitHub response was not JSON')); }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
// App-level delivery management deliberately stays in this opt-in harness. The
// production transport grants only repository operations to the runtime.
async function appHookApi(method, endpoint) {
  if (!(method === 'GET' && ['/app', '/app/hook/deliveries?per_page=100'].includes(endpoint)) &&
      !(method === 'POST' && /^\/app\/hook\/deliveries\/[1-9]\d*\/attempts$/.test(endpoint))) throw new Error('Unexpected App acceptance endpoint');
  const seconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId })).toString('base64url');
  let authorization;
  try {
    const bytes = readFileSync(privateKeyPath);
    if (bytes.length > 65_536) throw new Error('oversized key');
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('invalid key');
    authorization = `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
  } catch { throw new Error('Cannot load the acceptance GitHub App signing key'); }
  const response = await fetch(`https://api.github.com${endpoint}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'js-superagent-acceptance', Authorization: `Bearer ${authorization}` } });
  if (response.status !== (method === 'GET' ? 200 : 202)) {
    await response.body?.cancel(); throw new Error(`GitHub App delivery acceptance request failed (HTTP ${response.status})`);
  }
  if (method === 'POST') { await response.body?.cancel(); return; }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error('GitHub App delivery metadata exceeded 1 MiB');
    chunks.push(chunk);
  }
  let data;
  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    data = endpoint === '/app' ? JSON.parse(raw) : parseGitHubDeliveryList(raw);
  } catch { throw new Error('Invalid GitHub App acceptance metadata'); }
  if (endpoint === '/app') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid GitHub App identity');
  } else if (!Array.isArray(data)) throw new Error('Invalid GitHub App delivery list');
  return data;
}
assert.equal((await api('GET', 'user')).login.toLowerCase(), actor);
const appIdentity = await appHookApi('GET', '/app');
assert.equal(String(appIdentity.id), appId); assert.match(appIdentity.slug, /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i);
const botLogin = `${appIdentity.slug.toLowerCase()}[bot]`, botIdentity = await api('GET', `users/${encodeURIComponent(botLogin)}`);
assert.equal(botIdentity.type, 'Bot'); assert.equal(botIdentity.login.toLowerCase(), botLogin);
assert.ok(Number.isSafeInteger(botIdentity.id) && botIdentity.id > 0);
mkdirSync(output, { recursive: true, mode: 0o700 });
const packed = artifact;
const consumer = join(output, 'consumer'); mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], consumer);
const installed = join(consumer, 'node_modules/js-superagent');
const { createProjectAgent, listenGitHubWebhook } = await import(pathToFileURL(join(installed, 'src/index.mjs')));
const prefix = `repos/${repository}`;
const runTag = randomUUID();
const issue = values.issue ? await api('GET', `${prefix}/issues/${values.issue}`) : await api('POST', `${prefix}/issues`, {
  title: `[js-superagent webhook acceptance] App and signed delivery ${runTag.slice(0, 8)}`,
  body: `Dedicated GitHub App/Webhook acceptance fixture ${runTag}. Awaiting an explicit task command in a new comment after the receiver starts. No repository code changes, commits, merges, publishing, or edits outside the local fixture are authorized.`,
});
assert.equal(issue.state, 'open'); assert.equal(issue.pull_request, undefined);
assert.match(issue.title, /^\[js-superagent webhook acceptance\]/);
assert.equal(issue.user.login.toLowerCase(), actor); assert.doesNotMatch(issue.body ?? '', /^\s*\/js-superagent\s/);
const issueNumber = issue.number, commentsPath = `${prefix}/issues/${issueNumber}/comments`;
const comments = async () => (await api('GET', `${commentsPath}?per_page=100`, undefined, true)).flat();
assert.equal((await comments()).length, 0, 'Use a fresh acceptance Issue without comments');
const project = join(output, 'python-project'); mkdirSync(project);
const sourceFiles = {
  'pricing.py': 'def total(price, quantity, discount=0):\n    return price + quantity * (1 - discount / 100)\n',
  'test_pricing.py': 'import unittest\nfrom pricing import total\n\nclass PricingTest(unittest.TestCase):\n    def test_basic(self):\n        self.assertEqual(total(10, 3), 30)\n    def test_discount(self):\n        self.assertEqual(total(20, 2, 25), 30)\n    def test_zero(self):\n        self.assertEqual(total(10, 0), 0)\n\nif __name__ == "__main__":\n    unittest.main()\n',
  'AGENTS.md': 'This is an isolated js-superagent GitHub App/Webhook acceptance project. Work only inside the execution workspace. No network, GitHub commands, external messages, commits, merges, or writes outside this workspace. Do not modify .js-superagent. The host handles App authentication and all GitHub communication. Run python3 -m unittest -v and report actual results.\n',
};
for (const [name, text] of Object.entries(sourceFiles)) writeFileSync(join(project, name), text);
const git = (...args) => run('git', ['-C', project, ...args], output).trim();
git('init', '-q'); git('config', 'user.name', 'js-superagent acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
git('add', ...Object.keys(sourceFiles)); git('commit', '-qm', 'isolated webhook acceptance baseline');
const sourceHead = git('rev-parse', 'HEAD'), sourceIndex = git('ls-files', '--stage');
const sourceUnchanged = () => { for (const [name, text] of Object.entries(sourceFiles)) assert.equal(readFileSync(join(project, name), 'utf8'), text);
  assert.equal(git('rev-parse', 'HEAD'), sourceHead); assert.equal(git('ls-files', '--stage'), sourceIndex); };
const independentTests = path => { const result = spawnSync('python3', ['-m', 'unittest', '-v'], { cwd: path, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); return result.stderr; };
const evidence = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  codex: run(values['codex-path'] ?? 'codex', ['--version'], output).trim(), gh: run(gh, ['--version'], output).split('\n')[0],
  package: packed.filename, repository, appId, installationId, appActor: { id: botIdentity.id, login: botLogin }, issueNumber, issueUrl: issue.html_url,
  publicWebhookUrl: publicUrl.href, periodicPollIntervalMs: 86_400_000, sourceHead, status: 'running', checks: [],
  implementationSha256: Object.fromEntries(['src/index.mjs', 'src/config.mjs', 'src/outbox.mjs', 'src/channels/github.mjs',
    'src/channels/github-app.mjs', 'src/channels/github-webhook.mjs', 'src/github-webhook-inbox.mjs', 'src/github-intake.mjs',
    'src/github-pull-intake.mjs', 'src/workspaces.mjs', 'src/drivers/codex-app-server.mjs', 'bin/js-superagent.mjs']
    .map(path => [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')])),
};
const save = () => writeFileSync(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const log = text => console.log(`[real-github-webhook] ${text}`);
const captures = new Map(), observations = new Map(), syntheticIds = new Set();
mkdirSync(join(output, 'signed-deliveries'), { mode: 0o700 });
let runtime, receiver;
const open = () => createProjectAgent({ projectRoot: project }).init();
async function startReceiver() {
  receiver = await listenGitHubWebhook({ receiveGitHubWebhook(input) {
    const result = runtime.receiveGitHubWebhook(input);
    observations.set(result.deliveryId, { count: (observations.get(result.deliveryId)?.count ?? 0) + 1, status: result.status });
    // Capture only authenticated fixture events. These files are private local evidence,
    // never part of the package or shareable acceptance summary.
    if (result.status !== 'ignored' && !syntheticIds.has(result.deliveryId) && !captures.has(result.deliveryId)) {
      const payload = JSON.parse(Buffer.from(input.body).toString('utf8'));
      if (payload.repository?.full_name?.toLowerCase() === repository && payload.issue?.number === issueNumber && payload.sender?.login?.toLowerCase() === actor) {
        const captured = { body: Buffer.from(input.body), headers: { ...input.headers } };
        captures.set(result.deliveryId, captured);
        writeFileSync(join(output, 'signed-deliveries', `${result.deliveryId}.body`), captured.body, { mode: 0o600 });
        writeFileSync(join(output, 'signed-deliveries', `${result.deliveryId}.headers.json`), JSON.stringify(captured.headers, null, 2) + '\n', { mode: 0o600 });
      }
    }
    return result;
  } }, { host: '127.0.0.1', port: Number(values.port), path: '/github/webhook' });
}
async function waitFor(predicate, label, timeoutMs = 360_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tickets = runtime.list();
    if (tickets.some(ticket => ticket.status === 'failed')) throw new Error(`Real Worker failed during ${label}: ${tickets.find(ticket => ticket.status === 'failed').reports.at(-1)?.summary}`);
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; local error: ${runtime.status().lastError ?? runtime.githubWebhookStatus().lastError ?? 'none'}`);
}
function replayHeaders(captured, overrides = {}) {
  return { 'content-type': 'application/json', 'x-github-event': captured.headers['x-github-event'],
    'x-github-delivery': captured.headers['x-github-delivery'], 'x-hub-signature-256': captured.headers['x-hub-signature-256'], ...overrides };
}
async function postLocal(captured, { body = captured.body, headers = replayHeaders(captured) } = {}) {
  const response = await fetch(receiver.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() };
}
async function stopIngressAndDrain() {
  // Bot result echoes may still arrive after a completion was observed. Freeze
  // intake before checking a durable restart boundary, then finish every accepted
  // generation (including a retry deferred by stop during canonical polling).
  if (receiver) { await receiver.close(); receiver = undefined; }
  await runtime.stop();
  await waitFor(async () => {
    await runtime.processGitHubWebhooks();
    return runtime.githubWebhookStatus().pending === 0 &&
      !runtime.status().effects.some(effect => effect.kind === 'github-webhook' && !effect.cancelled);
  }, 'all accepted webhook generations committed before restart', 120_000);
}
function commentCapture(commentId) {
  return [...captures.entries()].find(([, captured]) => captured.headers['x-github-event'] === 'issue_comment' &&
    JSON.parse(captured.body.toString('utf8')).comment?.id === commentId);
}
const deliveryMetadata = delivery => Object.fromEntries(['id', 'guid', 'delivered_at', 'redelivery', 'duration', 'status', 'status_code',
  'event', 'action', 'installation_id', 'repository_id'].map(key => [key, delivery[key]]));
save();
try {
  runtime = open(); runtime.configure({ workspace: { mode: 'worktree' }, execution: { driver: 'codex-app-server', timeoutMs: 300_000,
    ...(values['codex-path'] ? { executable: values['codex-path'] } : {}), ...(values.model ? { model: values.model } : {}) },
  github: { repository, allowedActors: [actor], issues: [issueNumber], pollIntervalMs: 86_400_000,
    app: { appId, installationId, privateKeyPath }, webhook: { secretPath, host: '127.0.0.1', port: Number(values.port), path: '/github/webhook' } } });
  await startReceiver();
  // Establish a baseline before the first command, proving periodic polling is not the trigger.
  await runtime.syncGitHub(); assert.equal(runtime.list().length, 0);
  runtime.start({ intervalMs: 100 });
  log(`Receiver ready at ${receiver.url}; waiting for real App webhook deliveries through ${publicUrl.host}.`);
  const command = await api('POST', commentsPath, { body: '/js-superagent Fix pricing.total to compute price * quantity with percentage discount. Run the three existing unit tests. For this first turn only fix the arithmetic; do not add input-validation policies or extra tests yet. This task includes later related pricing regression feedback. Keep all changes in the isolated workspace. Do not access the network, commit, push, merge, publish, or change files outside the fixture.' });
  evidence.commandComment = { id: command.id, url: command.html_url }; save();
  await waitFor(() => commentCapture(command.id) && runtime.list().length === 1 && runtime.list()[0].status === 'completed' && runtime.notifications().filter(item => item.status === 'sent').length >= 2, 'webhook-triggered initial completion');
  const first = runtime.list()[0], ticketId = first.id, session = runtime.getSession(ticketId), workspace = runtime.getWorkspace(ticketId);
  assert.ok(captures.size >= 1); assert.equal(session.driver, 'codex-app-server'); assert.equal(workspace.mode, 'worktree');
  assert.notEqual(workspace.path, project); sourceUnchanged();
  evidence.ticketId = ticketId; evidence.projectId = runtime.projectId; evidence.session = session; evidence.workspace = workspace;
  evidence.initialIndependentTests = independentTests(workspace.path);
  evidence.checks.push('real-app-signed-webhook-triggered-initial-task', 'real-codex-modification-and-independent-tests', 'isolated-worktree-source-unchanged'); save();

  log('Initial App webhook and real Codex turn passed; sending related human feedback.');
  const feedback = await api('POST', commentsPath, { body: 'Related acceptance feedback: add a named unittest test_fractional_discount asserting total(12.5, 2, 10) == 22.5. Preserve the behavior and rerun python3 -m unittest -v in the existing workspace.' });
  evidence.feedbackComment = { id: feedback.id, url: feedback.html_url }; save();
  await waitFor(() => commentCapture(feedback.id) && runtime.get(ticketId).reports.length === 2 && runtime.get(ticketId).status === 'completed' && runtime.notifications().filter(item => item.status === 'sent').length >= 3, 'webhook-triggered related feedback');
  assert.equal(runtime.list().length, 1); assert.deepEqual(runtime.getSession(ticketId), session); assert.equal(runtime.getWorkspace(ticketId).path, workspace.path);
  assert.match(readFileSync(join(workspace.path, 'test_pricing.py'), 'utf8'), /def test_fractional_discount\(/);
  evidence.finalIndependentTests = independentTests(workspace.path); sourceUnchanged();
  const [commandDeliveryId, original] = commentCapture(command.id), [feedbackDeliveryId] = commentCapture(feedback.id);
  assert.notEqual(commandDeliveryId, feedbackDeliveryId, 'Both human comments must arrive as distinct authentic App deliveries');
  evidence.actualDeliveryIds = [commandDeliveryId, feedbackDeliveryId]; evidence.checks.push('related-feedback-same-ticket-session-worktree'); save();

  log('Verifying GitHub delivery records and requesting one actual GitHub redelivery.');
  const reportsBefore = runtime.get(ticketId).reports.length;
  let actualDeliveries, listedDeliveries;
  await waitFor(async () => {
    listedDeliveries = await appHookApi('GET', '/app/hook/deliveries?per_page=100');
    actualDeliveries = evidence.actualDeliveryIds.map(guid => listedDeliveries.find(delivery => delivery.guid === guid && !delivery.redelivery && delivery.status_code === 202));
    return actualDeliveries.every(Boolean);
  }, 'GitHub successful delivery metadata for both human comments', 120_000, 3000);
  for (const delivery of actualDeliveries) {
    assert.equal(delivery.installation_id, installationId); assert.equal(delivery.event, 'issue_comment'); assert.equal(delivery.action, 'created');
    assert.match(delivery.id, /^[1-9]\d*$/); assert.ok(Number.isFinite(delivery.duration));
  }
  evidence.githubDeliveries = actualDeliveries.map(deliveryMetadata); save();
  const originalDelivery = actualDeliveries[0], observationsBefore = observations.get(commandDeliveryId).count;
  const knownDeliveryIds = new Set(listedDeliveries.map(delivery => delivery.id));
  const redeliveryRequestedAt = Date.now();
  await appHookApi('POST', `/app/hook/deliveries/${originalDelivery.id}/attempts`);
  let redelivery;
  await waitFor(async () => {
    const deliveries = await appHookApi('GET', '/app/hook/deliveries?per_page=100');
    // The list can contain an earlier manual replay of this same guid. Require a
    // newly observed attempt after our request, allowing five seconds of clock skew.
    redelivery = deliveries.find(delivery => delivery.guid === commandDeliveryId && delivery.redelivery && !knownDeliveryIds.has(delivery.id) &&
      delivery.status_code === 200 && Date.parse(delivery.delivered_at) >= redeliveryRequestedAt - 5000);
    return redelivery && observations.get(commandDeliveryId).count > observationsBefore && observations.get(commandDeliveryId).status === 'duplicate';
  }, 'GitHub actual redelivery acknowledged as a durable duplicate', 120_000, 3000);
  assert.equal(redelivery.installation_id, installationId); assert.equal(redelivery.event, 'issue_comment');
  assert.equal(runtime.get(ticketId).reports.length, reportsBefore); assert.equal(runtime.list().length, 1);
  evidence.githubRedelivery = { requestedAt: new Date(redeliveryRequestedAt).toISOString(), ...deliveryMetadata(redelivery) };
  evidence.checks.push('github-actual-redelivery-deduplicated'); save();

  log('Testing local envelope replay, changed bytes, delivery collisions and canonical polling deduplication.');
  const duplicate = await postLocal(original); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.status, 'duplicate');
  const tampered = await postLocal(original, { body: Buffer.concat([original.body, Buffer.from(' ')]) }); assert.equal(tampered.status, 401);
  const conflict = await postLocal(original, { headers: replayHeaders(original, { 'x-github-event': 'issues' }) }); assert.equal(conflict.status, 409);
  const syntheticId = randomUUID(); syntheticIds.add(syntheticId);
  const newDelivery = await postLocal(original, { headers: replayHeaders(original, { 'x-github-delivery': syntheticId }) }); assert.equal(newDelivery.status, 202);
  await waitFor(() => runtime.githubWebhookStatus().pending === 0, 'replayed canonical event deduplication');
  await stopIngressAndDrain();
  await runtime.syncGitHub(); await runtime.syncGitHub(); assert.equal(await runtime.runNext(), null);
  assert.equal(runtime.get(ticketId).reports.length, reportsBefore); assert.equal(runtime.list().length, 1);
  evidence.localReplayChecks = { duplicate: duplicate.status, tamperedBody: tampered.status, identityConflict: conflict.status, newDeliverySameEvent: newDelivery.status };
  evidence.checks.push('local-exact-replay-deduplicated', 'local-tampered-raw-body-rejected', 'local-delivery-collision-rejected', 'webhook-and-poll-native-event-deduplication');

  await runtime.stop(); runtime.close(); runtime = open(); await startReceiver();
  const afterRestart = await postLocal(original); assert.equal(afterRestart.status, 200); assert.equal(afterRestart.body.status, 'duplicate');
  await stopIngressAndDrain(); assert.equal(await runtime.runNext(), null); assert.equal(runtime.get(ticketId).reports.length, 2);
  assert.deepEqual(runtime.getSession(ticketId), session); assert.equal(runtime.getWorkspace(ticketId).path, workspace.path); sourceUnchanged();
  evidence.checks.push('delivery-deduplication-survives-restart');
  const remote = await comments();
  evidence.receipts = runtime.notifications().filter(receipt => receipt.channel.source === 'github').map(receipt => {
    assert.equal(receipt.status, 'sent');
    const marker = `<!-- js-superagent:${runtime.projectId}:${receipt.id} -->`;
    const found = remote.filter(comment => comment.body.includes(marker)); assert.equal(found.length, 1);
    assert.equal(found[0].user.type, 'Bot'); assert.equal(found[0].user.id, botIdentity.id); assert.equal(found[0].user.login.toLowerCase(), botLogin);
    // GitHub may omit this field; the JWT-authenticated App slug and immutable
    // Bot user ID above remain the authoritative identity binding.
    if (found[0].performed_via_github_app != null) assert.equal(String(found[0].performed_via_github_app.id), appId);
    assert.equal(receipt.delivery.url, found[0].html_url);
    return { id: receipt.id, kind: receipt.kind, status: receipt.status, commentId: found[0].id, url: found[0].html_url,
      actor: found[0].user.login, actorId: found[0].user.id, appId, reportedAppId: found[0].performed_via_github_app?.id ?? null };
  });
  assert.equal(evidence.receipts.length, 3);
  evidence.reports = runtime.get(ticketId).reports; evidence.webhookStatus = runtime.githubWebhookStatus();
  evidence.workspaceReview = runtime.inspectWorkspace(ticketId); evidence.checks.push('results-posted-by-registered-app-bot', 'source-files-head-index-unchanged');
  evidence.status = 'passed'; log('Real App authentication, signed deliveries, two Codex turns and durable deduplication passed.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
} finally {
  if (receiver) await receiver.close();
  if (runtime) { await runtime.stop(); runtime.close(); }
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(`Evidence: ${join(output, 'acceptance.json')}`);
}

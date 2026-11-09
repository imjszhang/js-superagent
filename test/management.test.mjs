import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManagementServer } from '../src/management.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';

function fixture() {
  let paused = false, revision = 1;
  const calls = [];
  const ticket = { id: 'task-1', text: '<script>alert(1)</script>', scope: 'Modify example', status: 'waiting', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', messages: [], reports: [], pullRequests: [] };
  const settings = { revision, version: 'settings-v1', policy: { mode: 'off' }, assessor: { driver: 'codex-app-server', executable: '/private/tools/codex', model: 'test', prompt: 'Coordinate' }, at: '2026-11-01T00:00:00Z' };
  const runtime = {
    list: () => [structuredClone(ticket)], get: id => { if (id !== ticket.id) throw new Error('Unknown ticket'); return structuredClone(ticket); },
    getDetailed: id => ({ version: 2, ticket: runtime.get(id), stage: 'person', action: 'answer', attention: { question: 'Which file?' }, execution: { projectRoot: '/private/host/project', path: '/private/host/project/run' }, reports: [] }),
    status: () => ({ running: true, active: true, paused, effects: [{ kind: 'reply', payload: { privateKey: 'private-value' }, error: 'ghp_123456789012345678901234567890' }], lastError: null }),
    githubStatus: () => ({ configured: true, repository: 'owner/repo', lastSync: null, lastError: 'Cannot read /private/host/credentials/app.pem', notifications: [{ status: 'pending' }] }),
    inspectWorkspace: () => ({ workspace: { path: '/private/host/project/run', mode: 'worktree' }, changes: [{ path: 'src/example.mjs', status: 'M' }] }),
    coordinatorStatus: () => ({ settings: { ...settings, revision }, history: [{ ...settings, revision: 0, version: 'previous', assessor: { ...settings.assessor, prompt: 'Historical prompt' } }] }),
    configureCoordinator: (input, options) => { if (options.expectedRevision !== revision) throw new Error('Coordinator revision conflict; reload before saving'); calls.push(['configure', input]); revision++; return { ...input, revision }; },
    readContext: (resource, opts) => ({ resource, items: [], opts, nextCursor: null }),
    pause: reason => { calls.push(['pause', reason]); paused = true; return { paused }; }, resume: () => { paused = false; return { paused }; },
    reply: (id, text) => { calls.push(['reply', id, text]); return ticket; }, retry: id => { calls.push(['retry', id]); return ticket; }, cancel: id => { calls.push(['cancel', id]); return ticket; },
    listHarnesses: () => [
      { id: 'codex-app-server', version: '1', label: 'Codex', roles: ['worker', 'coordinator'], settingsFields: [], preserveOnSave: ['executable'] },
      { id: 'dsh-sdk', version: '1', label: 'DSH', roles: ['worker', 'coordinator'], settingsFields: ['backend', 'permission', 'contextMode'], preserveOnSave: ['executable', 'backend', 'permission', 'contextMode'] },
    ],
  };
  return { runtime, calls };
}
async function open(t, options = {}) {
  const state = fixture(), server = await createManagementServer(state.runtime, options);
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const request = (path, body, headers = {}) => fetch(new URL(path, server.url), {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { Origin: origin, 'X-Superagent-Request': 'local-ui', 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...state, server, origin, request };
}

test('background control receipts use authenticated, redacted endpoints and preserve the delivery policy gate', async t => {
  const f = await open(t);
  const receipt = { operationId:'a'.repeat(64),requestId:'request-one',method:'verifyTicket',args:['task-1'],status:'queued',createdAt:'2026-11-03T00:00:00Z',result:{token:'private-value',path:'/private/task/result'} };
  f.runtime.requestControl = request => { f.calls.push(['control',request]); return receipt; };
  f.runtime.listControls = () => [receipt];
  f.runtime.controlStatus = id => id===receipt.operationId?receipt:null;
  assert.equal((await fetch(new URL('/api/controls', f.server.url))).status,401);
  const request={requestId:'request-one',method:'verifyTicket',args:['task-1']};
  const response=await f.request('/api/controls',request);
  assert.equal(response.status,200);
  const accepted=await response.json();assert.equal(accepted.status,'queued');
  assert.equal(accepted.result.token,undefined);assert.equal(accepted.result.path,'[local path]');
  assert.equal((await (await f.request('/api/controls')).json())[0].operationId,receipt.operationId);
  assert.equal((await (await f.request(`/api/controls/${receipt.operationId}`)).json()).status,'queued');
  assert.equal((await f.request('/api/controls',{...request,method:'deliverTicket'})).status,409);
  assert.equal((await f.request('/api/controls',{...request,method:'replaceSession',args:['task-1',{reason:'replace',expectedSessionId:null}]})).status,400);
  assert.equal((await f.request('/api/controls',{...request,method:'controlNativePreview',args:['task-1',{leaseId:'lease',jobId:'job',action:'renew',ttlMs:1}]})).status,400);
  assert.equal((await f.request('/api/controls',{...request,unexpected:true})).status,400);
  assert.equal(f.calls.length,1);
});

test('diagnostic GET routes redact before search and expose only read operations',async t=>{
  const f=await open(t),secret='ghp_123456789012345678901234567890';
  const raw={id:'github:event',source:'github',text:secret+' ordinary text',intake:{status:'filtered',reason:'senderNotMember'}};
  f.runtime.eventDiagnostics=options=>{f.calls.push(['read-events',options.source]);const view=options.projectForSearch(raw);return {items:options.query&&!JSON.stringify(view).includes(options.query)?[]:[view],total:1,nextCursor:null,summary:{total:1}};};
  f.runtime.eventDiagnostic=(id,options)=>id===raw.id?options.projectForSearch(raw):null;
  f.runtime.replyDiagnostics=()=>({items:[{id:'reply',status:'dropped',reason:'locked',text:'-----BEGIN PRIVATE KEY-----\npartial-private-content'}],total:1,nextCursor:null,summary:{dropped:1}});
  assert.equal((await fetch(new URL('/api/diagnostics/events',f.server.url))).status,401);
  assert.equal((await (await f.request(`/api/diagnostics/events?q=${secret}&source=github`)).json()).items.length,0);
  const result=await (await f.request('/api/diagnostics/event?id=github%3Aevent')).json();assert.doesNotMatch(JSON.stringify(result),/ghp_/);
  assert.equal((await f.request('/api/diagnostics/event?id=missing')).status,404);
  assert.equal((await f.request('/api/diagnostics/events?problems=yes')).status,400);
  assert.equal((await f.request('/api/diagnostics/events?limit=0')).status,400);
  const replies=await (await f.request('/api/diagnostics/replies')).json();assert.equal(replies.items[0].text,'[redacted]');
  assert.equal((await f.request('/api/diagnostics/events',{})).status,404);
  assert.deepEqual(f.calls,[['read-events','github']]);
});

test('registered harness catalog drives settings and changing harness does not inherit a private executable or backend', async t => {
  const f = await open(t);
  f.runtime.listHarnesses = () => [
    { id: 'codex-app-server', version: '1', roles: ['worker', 'coordinator'], preserveOnSave: ['executable'], settingsFields: [] },
    { id: 'dsh-sdk', version: '1', roles: ['worker', 'coordinator'], capabilities: { sessionResume: true }, settingsFields: ['backend', 'permission', 'contextMode'], preserveOnSave: ['executable', 'backend', 'permission', 'contextMode'] },
  ];
  f.runtime.executorStatus = () => ({ settings: { revision: 0, execution: { driver: 'codex-app-server', executable: '/private/codex' } }, history: [] });
  f.runtime.configureExecutor = settings => { f.calls.push(settings); return { revision: 1, execution: settings }; };
  const data = await (await f.request('/api/executor')).json();
  assert.equal(data.harnesses[1].id, 'dsh-sdk');
  const backend = { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DSH_TEST_KEY' };
  assert.equal((await f.request('/api/executor', { settings: { driver: 'dsh-sdk', model: 'test', backend }, expectedRevision: 0 })).status, 200);
  assert.equal(f.calls.at(-1).executable, undefined);
  assert.deepEqual(f.calls.at(-1).backend, backend);
  assert.equal((await f.request('/api/coordinator', { settings: { assessor: { driver: 'dsh-sdk', model: 'test', backend } }, expectedRevision: 1 })).status, 200);
  assert.equal(f.calls.at(-1)[1].assessor.executable, undefined);
  assert.equal((await f.request('/api/executor', { settings: { driver: 'unknown' }, expectedRevision: 0 })).status, 400);
});

test('adapter settings fields accept declared options and reject undeclared ones', async t => {
  const f = await open(t);
  f.runtime.listHarnesses = () => [{ id: 'custom', version: '1', label: 'Custom', roles: ['worker', 'coordinator'], settingsFields: ['workspaceMode'], preserveOnSave: ['tokenEnv'] }];
  f.runtime.executorStatus = () => ({ settings: { revision: 0, execution: { driver: 'custom', tokenEnv: 'CUSTOM_TOKEN' } }, history: [] });
  f.runtime.configureExecutor = settings => { f.calls.push(settings); return { revision: 1, execution: settings }; };
  assert.equal((await f.request('/api/executor', { settings: { driver: 'custom', workspaceMode: 'isolated' }, expectedRevision: 0 })).status, 200);
  assert.equal(f.calls.at(-1).tokenEnv, 'CUSTOM_TOKEN');
  assert.equal(f.calls.at(-1).workspaceMode, 'isolated');
  assert.equal((await f.request('/api/executor', { settings: { driver: 'custom', backend: { auth: 'api-key' } }, expectedRevision: 0 })).status, 400);
});

test('API data requires authentication and rejects a foreign origin or Host', async t => {
  const f = await open(t);
  assert.equal((await fetch(new URL('/api/status', f.server.url))).status, 401);
  assert.equal((await f.request('/api/status', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.request('/api/status', undefined, { Origin: 'https://evil.test' })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/api/status', f.server.url), { headers: { Host: 'evil.test', Authorization: `Bearer ${f.server.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await f.request('/api/status')).status, 200);
  assert.equal((await f.request('/api/context/triggers')).status, 200);
});

test('all mutations require exact same-origin marker even with bearer auth', async t => {
  const f = await open(t);
  assert.equal((await f.request('/api/pause', {}, { Origin: '' })).status, 403);
  assert.equal((await f.request('/api/pause', {}, { 'X-Superagent-Request': '' })).status, 403);
  assert.equal((await f.request('/api/pause', { reason: 'Inspect first' })).status, 200);
  assert.deepEqual(f.calls.at(-1), ['pause', 'Inspect first']);
  assert.equal((await f.request('/api/resume', {})).status, 200);
  assert.equal((await f.request('/api/tickets/task-1/reply', { text: 'Use the existing file' })).status, 200);
  assert.deepEqual(f.calls.at(-1), ['reply', 'task-1', 'Use the existing file']);
  assert.equal((await f.request('/api/tickets/task-1/cancel', {})).status, 200);
});

test('one-use fragment setup exchanges for HttpOnly cookie plus origin-bound request secret', async t => {
  const f = await open(t);
  const setupToken = new URLSearchParams(new URL(f.server.bootstrapUrl).hash.slice(1)).get('setup');
  const establish = () => fetch(new URL('/auth/session', f.server.url), { method: 'POST', headers: { Origin: f.origin, 'X-Superagent-Request': 'local-ui', 'Content-Type': 'application/json' }, body: JSON.stringify({ setupToken }) });
  const response = await establish();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const { csrf } = await response.json();
  assert.equal(typeof csrf, 'string');
  assert.equal((await establish()).status, 401);
  assert.equal((await fetch(new URL('/api/tickets', f.server.url), { headers: { Cookie: cookie.split(';')[0] } })).status, 401);
  const authenticated = await fetch(new URL('/api/tickets', f.server.url), { headers: { Cookie: cookie.split(';')[0], 'X-Superagent-Request': csrf } });
  assert.equal(authenticated.status, 200);
  const write = await fetch(new URL('/api/pause', f.server.url), { method: 'POST', headers: { Cookie: cookie.split(';')[0], Origin: f.origin, 'X-Superagent-Request': csrf, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(write.status, 200);
});

test('diagnostics omit effect payloads, credential names, and local filesystem paths', async t => {
  const f = await open(t);
  const status = await (await f.request('/api/status')).json();
  assert.equal(status.runtime.running, true);
  assert.equal(status.ingress.healthy, false);
  assert.equal(status.processHealthIsBusinessHealth, false);
  assert.equal(status.queue.count, 1);
  const encoded = JSON.stringify(status);
  assert.doesNotMatch(encoded, /private-value|ghp_|app\.pem|\/private/);
  const detail = await (await f.request('/api/tickets/task-1/details')).json();
  assert.equal(detail.execution.projectRoot, undefined);
  assert.equal(detail.execution.path, '[local path]');
  const workspace = await (await f.request('/api/tickets/task-1/workspace')).json();
  assert.equal(workspace.changes[0].path, 'src/example.mjs');
  const config = await (await f.request('/api/coordinator')).json();
  assert.equal(config.settings.assessor.executable, undefined);
});

test('coordinator revision conflicts return 409 and edits preserve the private executable setting', async t => {
  const f = await open(t);
  assert.equal((await f.request('/api/coordinator', { settings: { policy: { mode: 'off' } }, expectedRevision: 0 })).status, 409);
  assert.equal((await f.request('/api/coordinator', { settings: { assessor: { prompt: 'New prompt' } }, expectedRevision: 1 })).status, 200);
  assert.equal(f.calls.at(-1)[1].assessor.executable, '/private/tools/codex');
  assert.equal(f.calls.at(-1)[1].assessor.prompt, 'New prompt');
  assert.equal((await f.request('/api/coordinator', { settings: { assessor: { executable: '/evil' } }, expectedRevision: 2 })).status, 400);
});

test('delivery recovery requires configured trusted policy and never invokes Worker retry', async t => {
  const f = await open(t); let revision = 0;
  f.runtime.getDeliverySettings = () => ({ revision, mode: 'local' });
  f.runtime.deliverTicket = id => { f.calls.push(['deliver', id]); return { state: 'delivered' }; };
  f.runtime.getDetailed = id => ({ ticket: f.runtime.get(id), deliveryAttempt: { state: 'failed', error: 'Check /private/credential.pem' } });
  assert.equal((await f.request('/api/tickets/task-1/deliver', {})).status, 409); assert.equal(f.calls.length, 0);
  revision = 1;
  const detail = await (await f.request('/api/tickets/task-1/details')).json();
  assert.equal(detail.deliveryAttempt.state, 'failed'); assert.equal(detail.managementActions.deliveryConfigured, true);
  assert.doesNotMatch(detail.deliveryAttempt.error, /private|credential/);
  assert.equal((await f.request('/api/tickets/task-1/deliver', {}, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request('/api/tickets/task-1/deliver', { command: 'override' })).status, 400);
  assert.equal((await f.request('/api/tickets/task-1/deliver', {})).status, 200);
  assert.deepEqual(f.calls, [['deliver', 'task-1']]);
  f.runtime.getDeliverySettings = () => ({ revision: 1, mode: 'draft-pr', repository: 'owner/repo' });
  assert.equal((await f.request('/api/tickets/task-1/deliver', {})).status, 409);
});

test('historical settings remain a draft saved against current revision with existing private configuration', async t => {
  const f = await open(t), state = await (await f.request('/api/coordinator')).json();
  const historical = state.history[0], draft = { policy: historical.policy, assessor: historical.assessor };
  assert.equal(historical.assessor.executable, undefined);
  assert.equal((await f.request('/api/coordinator', { settings: draft, expectedRevision: historical.revision })).status, 409);
  const saved = await f.request('/api/coordinator', { settings: draft, expectedRevision: state.settings.revision });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 2);
  assert.equal(f.calls.at(-1)[1].assessor.prompt, 'Historical prompt');
  assert.equal(f.calls.at(-1)[1].assessor.executable, '/private/tools/codex');
  assert.equal((await f.request('/api/coordinator', { settings: draft, expectedRevision: state.settings.revision })).status, 409);
});

test('Worker settings expose history while preserving host executable and rejecting revision conflicts', async t => {
  const f = await open(t); let revision = 3;
  f.runtime.executorStatus = () => ({ settings: { revision, execution: { driver: 'codex-app-server', executable: '/private/worker/codex', model: 'current-model', prompt: 'Current role' } },
    history: [{ revision: 1, execution: { driver: 'codex-app-server', executable: '/private/historical/codex', prompt: 'Earlier role' } }] });
  f.runtime.configureExecutor = (settings, options) => { if (options.expectedRevision !== revision) throw new Error('Executor revision conflict'); f.calls.push(['executor', settings]); return { revision: ++revision, execution: settings }; };
  const initial = await (await f.request('/api/executor')).json();
  assert.equal(initial.settings.execution.executable, undefined); assert.equal(initial.history[0].execution.executable, undefined);
  assert.equal((await f.request('/api/executor', { settings: initial.history[0].execution, expectedRevision: 1 })).status, 409);
  assert.equal((await f.request('/api/executor', { settings: { driver: 'codex-app-server', executable: '/untrusted' }, expectedRevision: 3 })).status, 400);
  assert.equal((await f.request('/api/executor', { settings: { driver: 'unknown' }, expectedRevision: 3 })).status, 400);
  assert.equal((await f.request('/api/executor', { settings: { driver: 'codex-app-server', command: 'untrusted' }, expectedRevision: 3 })).status, 400);
  assert.equal((await f.request('/api/executor', { settings: initial.history[0].execution, expectedRevision: 3 }, { Origin: 'https://evil.test' })).status, 403);
  const saved = await f.request('/api/executor', { settings: initial.history[0].execution, expectedRevision: 3 });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 4);
  assert.deepEqual(f.calls.at(-1), ['executor', { driver: 'codex-app-server', executable: '/private/worker/codex', prompt: 'Earlier role' }]);
  assert.equal((await f.request('/api/executor', { settings: initial.history[0].execution, expectedRevision: 3 })).status, 409);
});

test('first browser Worker override retains the executable from effective project configuration', async t => {
  const f = await open(t);
  f.runtime.executorStatus = () => ({ settings: { revision: 0, execution: null }, effective: { driver: 'codex-app-server', executable: '/private/project/codex' }, history: [] });
  f.runtime.configureExecutor = (settings, options) => { f.calls.push({ settings, options }); return { revision: 1, execution: settings }; };
  assert.equal((await f.request('/api/executor', { settings: { driver: 'codex-app-server', prompt: 'Use focused verification.' }, expectedRevision: 0 })).status, 200);
  assert.equal(f.calls.at(-1).settings.executable, '/private/project/codex');
  assert.equal((await f.request('/api/executor', { settings: { driver: 'codex-app-server' } })).status, 400);
});

test('repository settings use revision fencing and cannot change credentials or actor authority', async t => {
  const f = await open(t); let settings = { revision: 2, enabled: false, observe: false, streams: { pulls: true, issues: false, comments: false, defaultBranchCI: false } };
  f.runtime.getRepositorySourceSettings = () => structuredClone(settings);
  f.runtime.configureRepositorySource = (input, options) => { if (options.expectedRevision !== settings.revision) throw new Error('Repository source revision conflict'); settings = { ...input, revision: settings.revision + 1 }; f.calls.push(['repository', input]); return settings; };
  const original = await (await f.request('/api/repository')).json(); assert.equal(original.revision, 2);
  const draft = { enabled: true, observe: false, streams: original.streams };
  assert.equal((await f.request('/api/repository', { settings: draft, expectedRevision: 1 })).status, 409);
  assert.equal((await f.request('/api/repository', { settings: { ...draft, allowedActors: ['anyone'] }, expectedRevision: 2 })).status, 400);
  assert.equal((await f.request('/api/repository', { settings: { ...draft, app: { privateKey: 'not-accepted' } }, expectedRevision: 2 })).status, 400);
  assert.equal((await f.request('/api/repository', { settings: { ...draft, streams: { command: true } }, expectedRevision: 2 })).status, 400);
  assert.equal((await f.request('/api/repository', { settings: draft, expectedRevision: 2 })).status, 200);
  assert.deepEqual(f.calls.at(-1), ['repository', draft]);
  assert.equal((await f.request('/api/repository', { settings: draft, expectedRevision: 2 })).status, 409);
});

test('health separates source failures from process health and limits scheduler and queue diagnostics', async t => {
  const f = await open(t);
  f.runtime.sourceStatus = () => [{ id: 'repository', lastSuccess: '2026-11-01T00:00:00Z', lastAttempt: '2026-11-01T00:00:10Z', active: false,
    error: 'private source error', cursor: { secret: 'hidden-cursor' } }];
  f.runtime.schedulerStatus = () => ({ maxWorkers: 3, humanReserve: 1, active: [{ token: 'private-owner' }, { yielded: true, projectRoot: '/private/workspace' }] });
  f.runtime.status = () => ({ running: true, effects: [{ kind: 'reply', due: Date.now() - 12000 }, { kind: 'launch', cancelled: true, due: 1 }] });
  const data = await (await f.request('/api/status')).json();
  assert.equal(data.runtime.running, true); assert.equal(data.sources[0].healthy, false);
  assert.deepEqual(data.scheduler, { maxWorkers: 3, humanReserve: 1, active: 2, held: 1, yielded: 1 });
  assert.equal(data.queue.count, 1); assert.ok(data.queue.oldestDueAgeMs >= 12000);
  assert.doesNotMatch(JSON.stringify(data), /hidden-cursor|private-owner|private source error|\/private/);
});

test('advanced management reads and mutations use scoped runtime APIs without accepting host commands', async t => {
  const f = await open(t), incidentId = 'a'.repeat(24);
  f.runtime.businessHealth = () => ({ sources: [{ id: 'github', state: 'stale' }], incidents: [] });
  f.runtime.getIncidents = () => [{ id: incidentId, status: 'active', revision: 2 }];
  f.runtime.acknowledgeIncident = (id, input) => { f.calls.push(['ack',id,input]); return { id, acknowledgedAt: 'now' }; };
  f.runtime.ticketTrace = (id, options) => ({ ticketId:id,items:[],options,nextCursor:null });
  f.runtime.sessionStatus = id => ({ ticketId:id,session:{id:'session-1'} });
  f.runtime.replaceSession = (id,input) => { f.calls.push(['replace',id,input]); return { queued:true }; };
  f.runtime.listJobs = () => [{ id:'job-1',status:'running' }];
  f.runtime.jobControl = (id,jobId,input) => { f.calls.push(['job',id,jobId,input]); return { queued:true }; };
  f.runtime.planChildAdoption = () => ({ digest:'b'.repeat(64),changes:[] });
  f.runtime.adoptChild = (id,jobId,input) => { f.calls.push(['adopt',id,jobId,input]); return { status:'applied' }; };
  const adoptionId='12345678-1234-1234-1234-123456789012';
  f.runtime.listChildAdoptions = id => [{id:adoptionId,ticketId:id,status:'applying'}];
  f.runtime.recoverChildAdoption = (id,recordId,input) => { f.calls.push(['adoption-recover',id,recordId,input]); return {status:'rolled-back'}; };
  f.runtime.reevaluate = id => { f.calls.push(['reevaluate',id]); return true; };
  f.runtime.requestStatus = id => { f.calls.push(['requestStatus',id]); return true; };
  assert.equal((await (await f.request('/api/status')).json()).business.sources[0].state,'stale');
  assert.equal((await (await f.request('/api/tickets/task-1/trace?limit=5')).json()).options.limit,5);
  assert.equal((await f.request('/api/tickets/task-1/jobs')).status,200);
  assert.equal((await f.request('/api/tickets/task-1/session')).status,200);
  assert.equal((await f.request('/api/tickets/task-1/jobs/job-1/adoption')).status,200);
  assert.equal((await f.request(`/api/incidents/${incidentId}/ack`,{expectedRevision:2})).status,200);
  assert.equal((await f.request('/api/tickets/task-1/session/replace',{reason:'broken',expectedSessionId:'session-1',adoptCurrentSettings:false})).status,200);
  assert.equal((await f.request('/api/tickets/task-1/session/replace',{reason:'broken',expectedSessionId:'session-1',adoptCurrentSettings:false,executable:'/evil'})).status,400);
  assert.equal((await f.request('/api/tickets/task-1/jobs/job-1/renew',{ttlMs:30000})).status,200);
  assert.equal((await f.request('/api/tickets/task-1/jobs/job-1/preview',{url:'http://evil/'})).status,400);
  assert.equal((await f.request('/api/tickets/task-1/jobs/job-1/adopt',{expectedPlanDigest:'b'.repeat(64)})).status,200);
  assert.equal((await f.request('/api/tickets/task-1/adoptions')).status,200);
  assert.equal((await f.request(`/api/tickets/task-1/adoptions/${adoptionId}/recover`,{mode:'rollback'})).status,200);
  assert.deepEqual(f.calls.at(-1),['adoption-recover','task-1',adoptionId,{mode:'rollback'}]);
  assert.equal((await f.request(`/api/tickets/task-1/adoptions/${adoptionId}/recover`,{mode:'unsafe'})).status,400);
  assert.equal((await f.request(`/api/tickets/task-1/adoptions/${adoptionId}/recover`,{mode:'finish',command:'evil'})).status,400);
  assert.equal((await f.request('/api/triggers/github%3Aowner%2Frepo%3A1/reevaluate',{})).status,200);
  assert.deepEqual(f.calls.at(-1),['reevaluate','github:owner/repo:1']);
  assert.equal((await f.request('/api/tickets/task-1/request-status',{})).status,200);
});

test('prompt, scheduler and recovery writes retain revision and reject unknown settings', async t => {
  const f = await open(t);
  f.runtime.promptStatus = () => ({settings:{revision:1},history:[],diff:[],assembled:{}});
  f.runtime.configurePrompts = (settings,options) => { if(options.expectedRevision!==1)throw new Error('Prompt revision conflict'); f.calls.push(['prompts',settings,options]);return {revision:2}; };
  f.runtime.schedulerStatus = () => ({revision:1,maxWorkers:1,humanReserve:0,active:[]});
  f.runtime.configureScheduler = (settings,options) => {f.calls.push(['scheduler',settings,options]);return {revision:2};};
  f.runtime.getRecoverySettings = () => ({revision:1,retryBeforeStart:false,maxAttempts:3,initialDelayMs:15000});
  f.runtime.configureRecovery = (settings,options) => {f.calls.push(['recovery',settings,options]);return {revision:2};};
  for(const path of ['/api/prompts','/api/scheduler','/api/recovery'])assert.equal((await f.request(path)).status,200);
  assert.equal((await f.request('/api/prompts',{settings:{sections:{communication:'Be clear'}},expectedRevision:0})).status,409);
  assert.equal((await f.request('/api/prompts',{settings:{sections:{communication:'Be clear'}},expectedRevision:1})).status,200);
  assert.equal(f.calls.at(-1)[2].origin,'panel');
  assert.equal((await f.request('/api/scheduler',{settings:{maxWorkers:2,humanReserve:1},expectedRevision:1})).status,200);
  assert.equal((await f.request('/api/recovery',{settings:{retryBeforeStart:true,maxAttempts:2,initialDelayMs:1000},expectedRevision:1})).status,200);
  assert.equal((await f.request('/api/recovery',{settings:{retryStartedJobs:true},expectedRevision:1})).status,400);
  assert.equal((await f.request('/api/prompts',{settings:{command:'unsafe'},expectedRevision:1})).status,400);
});

test('delivery panel preserves trusted host profiles and cannot replace commands or credentials', async t => {
  const f=await open(t),verify={id:'trusted-check',command:'/trusted/node',args:['check.mjs'],allowHostExecution:true};
  f.runtime.getDeliverySettings=()=>({revision:2,at:'saved',mode:'local',automatic:false,verify,credentialMode:'native-gh',allowedPaths:['src']});
  f.runtime.configureDelivery=(settings,options)=>{f.calls.push(['delivery',settings,options]);return{...settings,revision:3};};
  assert.equal((await f.request('/api/delivery')).status,200);
  assert.equal((await f.request('/api/delivery',{settings:{mode:'local',automatic:true},expectedRevision:2})).status,200);
  assert.deepEqual(f.calls.at(-1),['delivery',{mode:'local',automatic:true,verify,credentialMode:'native-gh',allowedPaths:['src']},{expectedRevision:2}]);
  assert.equal((await f.request('/api/delivery',{settings:{verify:{command:'evil'}},expectedRevision:2})).status,400);
  assert.equal((await f.request('/api/delivery',{settings:{credentialMode:'other'},expectedRevision:2})).status,400);
});

test('public shell has restrictive CSP and carries no auth or project data', async t => {
  const f = await open(t);
  const shell = await fetch(f.server.url), html = await shell.text();
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(html, /task-1|private-value|<script>alert/);
  assert.equal(html.includes(f.server.token), false);
  const js = await (await fetch(new URL('/app.js', f.server.url))).text();
  assert.doesNotMatch(js, /innerHTML|outerHTML|document\.write/);
  assert.match(js, /history\.replaceState/);
});

test('unsupported methods, excessive bodies and invalid routes are rejected without invoking actions', async t => {
  const f = await open(t, { maxBodyBytes: 1024 });
  assert.equal((await f.request('/api/tickets/task-1/reply', { text: 'x'.repeat(2048) })).status, 413);
  assert.equal((await f.request('/api/tickets/task-1/reply', { text: '' })).status, 400);
  assert.equal((await f.request('/api/tickets/task-1/reply', { text: 'ok', command: 'evil' })).status, 400);
  assert.equal((await f.request('/api/tickets?limit=99999')).status, 400);
  assert.equal((await f.request('/api/tickets/missing')).status, 404);
  assert.equal((await f.request('/api/../../secret')).status, 404);
  assert.equal((await fetch(f.server.url, { method: 'DELETE' })).status, 405);
  assert.equal(f.calls.length, 0);
});

test('server refuses public binds and invalid authentication settings', async () => {
  const { runtime } = fixture();
  await assert.rejects(createManagementServer(runtime, { host: '0.0.0.0' }), /loopback/);
  await assert.rejects(createManagementServer(runtime, { token: 'short' }), /token/);
});

test('real runtime question, reply, pause and revision edits round-trip through HTTP', async t => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-management-runtime-'));
  let turns = 0;
  const runtime = createProjectAgent({ projectRoot: root, driver: { reportVersion: 2, async run() {
    return ++turns === 1 ? { version: 2, state: 'waiting', summary: 'Need a file name', attention: { question: 'Which file should I edit?' } }
      : { version: 2, state: 'ready', summary: 'Recorded the supplied file name' };
  } } }).init();
  const server = await createManagementServer(runtime);
  t.after(async () => { await server.close(); await runtime.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: {
    Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { Origin: new URL(server.url).origin, 'X-Superagent-Request': 'local-ui', 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ticket = runtime.submit({ text: 'Record a file name' });
  await runtime.runNext();
  const detail = await (await request(`/api/tickets/${ticket.id}/details`)).json();
  assert.equal(detail.attention.question, 'Which file should I edit?');
  assert.equal((await request('/api/pause', { reason: 'Review current changes' })).status, 200);
  assert.equal((await request(`/api/tickets/${ticket.id}/reply`, { text: 'example.mjs' })).status, 200);
  assert.equal(await runtime.runNext(), null);
  assert.equal((await request('/api/resume', {})).status, 200);
  await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'completed');
  const settings = await (await request('/api/coordinator')).json();
  assert.equal((await request('/api/coordinator', { settings: { policy: { mode: 'off' } }, expectedRevision: settings.settings.revision })).status, 200);
  assert.equal((await request('/api/coordinator', { settings: { policy: { mode: 'off' } }, expectedRevision: settings.settings.revision })).status, 409);
  const executor = await (await request('/api/executor')).json();
  assert.equal((await request('/api/executor', { settings: { driver: 'codex-app-server', prompt: 'Verify the smallest affected behavior.' }, expectedRevision: executor.settings.revision })).status, 200);
  const savedExecutor = await (await request('/api/executor')).json();
  assert.equal(savedExecutor.settings.execution.prompt, 'Verify the smallest affected behavior.'); assert.equal(savedExecutor.history.length, 1);
  runtime.start({ intervalMs: 10 });
  assert.equal((await request('/api/executor', { settings: { driver: 'codex-app-server', prompt: 'Changed while running' }, expectedRevision: savedExecutor.settings.revision })).status, 400);
  const repository = await (await request('/api/repository')).json();
  const onlineSave = await request('/api/repository', { settings: { enabled: false }, expectedRevision: repository.revision });
  assert.equal(onlineSave.status, 200);
  const receipt = await onlineSave.json();
  assert.equal(receipt.status, 'queued');
  const deadline = Date.now() + 3000;
  while (runtime.controlStatus(receipt.operationId).status === 'queued' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.controlStatus(receipt.operationId).status, 'completed');
  const appliedRepository = await (await request('/api/repository')).json();
  assert.equal(appliedRepository.revision, repository.revision + 1);
  await runtime.stop();
  assert.equal((await request('/api/repository', { settings: { enabled: false, observe: false, streams: { comments: true } }, expectedRevision: appliedRepository.revision })).status, 200);
  assert.equal((await (await request('/api/repository')).json()).streams.comments, true);
  assert.equal((await request('/api/repository', { settings: { enabled: false }, expectedRevision: repository.revision })).status, 409);
});

test('W30 W31 W32 W34 management routes preserve scoped action inputs and trusted settings', async t => {
  const f=await open(t),requestId='a'.repeat(64),review={ready:true,requestReviewers:true,resolveThreads:false,reviewers:['alice'],teams:[]};
  f.runtime.getDeliverySettings=()=>({revision:2,mode:'draft-pr',automatic:false,verify:{command:'trusted'},repository:'owner/repo'});
  f.runtime.configureDelivery=(settings,options)=>{f.calls.push(['delivery',settings,options]);return {...settings,revision:3};};
  f.runtime.configureRepositorySource=(settings,options)=>{f.calls.push(['repository',settings,options]);return {...settings,revision:3};};
  for(const name of ['requestPRReview','runPRReview','setBotReviewBudget','associateBotReviewRun','controlNativePreview'])f.runtime[name]=(...args)=>{f.calls.push([name,...args]);return {id:requestId,status:'pending'};};
  f.runtime.reviewActionStatus=()=>[{id:requestId}];f.runtime.botReviewStatus=()=>[];
  assert.equal((await f.request('/api/delivery',{settings:{review},expectedRevision:2})).status,200);
  assert.deepEqual(f.calls.at(-1),['delivery',{mode:'draft-pr',automatic:false,verify:{command:'trusted'},repository:'owner/repo',review},{expectedRevision:2}]);
  assert.equal((await f.request('/api/delivery',{settings:{review:{arbitraryGraphql:'mutation'}},expectedRevision:2})).status,400);
  const source={enabled:true,streams:{mentions:true,reviewComments:true}};
  assert.equal((await f.request('/api/repository',{settings:source,expectedRevision:2})).status,200);assert.deepEqual(f.calls.at(-1),['repository',source,{expectedRevision:2}]);
  const input={kind:'resolveThread',pullNumber:12,commentId:42,triggerId:'original:42',reason:'Corrected the reported condition'};
  assert.equal((await f.request('/api/tickets/task-1/review',input)).status,200);assert.deepEqual(f.calls.at(-1),['requestPRReview','task-1',input]);
  assert.equal((await f.request('/api/tickets/task-1/review',{...input,threadId:'guessed'})).status,400);
  assert.equal((await f.request(`/api/review-actions/${requestId}/run`,{})).status,200);assert.deepEqual(f.calls.at(-1),['runPRReview',requestId]);
  assert.deepEqual(await (await f.request('/api/review-actions')).json(),[{id:requestId}]);assert.deepEqual(await (await f.request('/api/github/bot-review')).json(),[]);
  const budget={remaining:1,reason:'Reviewed historical use',expectedRevision:3};
  assert.equal((await f.request('/api/github/bot-review/12/345/budget',budget)).status,200);assert.deepEqual(f.calls.at(-1),['setBotReviewBudget',12,'345',budget]);
  assert.equal((await f.request('/api/github/bot-review/12/345/budget',{...budget,expectedRevision:undefined})).status,400);
  const association={eventIds:['original:42'],runId:'review-run-1',reason:'Confirmed original run'};
  assert.equal((await f.request('/api/github/bot-review/12/345/associate',association)).status,200);assert.deepEqual(f.calls.at(-1),['associateBotReviewRun',12,'345',association]);
  const preview={leaseId:'lease-1',jobId:'job-1',action:'renew',ttlMs:900000};
  assert.equal((await f.request('/api/tickets/task-1/native-preview',preview)).status,200);assert.deepEqual(f.calls.at(-1),['controlNativePreview','task-1',preview]);
  assert.equal((await f.request('/api/tickets/task-1/native-preview',{...preview,ttlMs:-1})).status,400);
  assert.equal((await f.request('/api/tickets/task-1/native-preview',{...preview,url:'http://127.0.0.1:9999'})).status,400);
  assert.equal((await f.request('/api/tickets/task-1/native-preview',{...preview,action:'restart'})).status,400);
  assert.equal((await f.request('/api/tickets/task-1/review',input,{Origin:'https://foreign.test'})).status,403);
});

test('ticket pages are ordered by attention and recency before they are sliced', async t => {
  const f = await open(t);
  const tickets = Array.from({ length: 101 }, (_, index) => ({
    id: `task-${String(index).padStart(3, '0')}`, text: `task ${index}`, status: index === 100 ? 'waiting' : 'completed',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    messages: [], reports: [], pullRequests: [],
  }));
  f.runtime.list = () => tickets;
  const first = await (await f.request('/api/tickets?limit=100&offset=0')).json();
  assert.equal(first.total, 101);
  assert.equal(first.items.length, 100);
  assert.equal(first.items[0].id, 'task-100');
  assert.equal(first.items.some(item => item.status === 'completed'), true);
  assert.equal(first.nextOffset, 100);
  const second = await (await f.request('/api/tickets?limit=100&offset=100')).json();
  assert.equal(second.items.some(item => item.id === 'task-100'), false);
  assert.equal(second.nextOffset, null);
});

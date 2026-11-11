import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { openDshToolBridge } from '../src/drivers/dsh-tools.mjs';

const definition = { name: 'js_superagent_read', description: 'Read scoped context', inputSchema: { type: 'object' } };
const payload = { sessionId: 'session-1', callId: 'call-1', name: definition.name, arguments: { text: '中文任务' } };
async function call(bridge, value = payload, authorization) {
  const connection = JSON.parse(bridge.environment);
  const response = await fetch(connection.url, { method: 'POST', headers: { authorization: authorization ?? `Bearer ${connection.token}` }, body: JSON.stringify(value) });
  return { status: response.status, body: await response.json() };
}
test('DSH bridge binds authorization and identity, deduplicates exact calls and preserves UTF-8', async () => {
  const calls = [], receipts = new Map();
  const bridge = await openDshToolBridge({ runId: 'run-1', agentTools: { version: 1, definitions: [definition], call: async value => {
    if (!receipts.has(value.callId)) { calls.push(value); receipts.set(value.callId, { text: value.arguments.text }); }
    return receipts.get(value.callId);
  } } }, { sessionId: 'session-1', options: { enableAgentTools: true }, redact: value => value });
  try {
    assert.equal((await call(bridge, payload, 'Bearer wrong')).status, 403);
    assert.equal((await call(bridge, { ...payload, sessionId: 'another' })).status, 403);
    const responses = await Promise.all([call(bridge), call(bridge)]);
    assert.deepEqual(responses.map(value => value.body), [{ text: '中文任务' }, { text: '中文任务' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].turnId, 'run-1');
    assert.equal(calls[0].sessionId, 'session-1');
    assert.equal((await call(bridge, { ...payload, arguments: { text: 'different' } })).status, 403);
    const connection = JSON.parse(bridge.environment);
    const body = Buffer.from(JSON.stringify({ ...payload, callId: 'utf8-split' }));
    const split = body.indexOf(Buffer.from('中')) + 1;
    const result = await new Promise((resolve, reject) => {
      const req = request(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}` } }, response => {
        let data = ''; response.setEncoding('utf8'); response.on('data', chunk => data += chunk); response.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject); req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 10);
    });
    assert.deepEqual(result, { text: '中文任务' });
  } finally { await bridge.close(); }
});
test('managed tool request identities are unique across runs and interrupted waits reach quiescence', async () => {
  const requestIds = [], cancelled = [];
  let resolveWait, waitStarted;
  const started = new Promise(resolve => waitStarted = resolve);
  const record = { id: 'job-1', kind: 'command', profileId: 'check', status: 'running' };
  const jobs = {
    launch(_args, { requestId }) { requestIds.push(requestId); return { id: record.id }; },
    list() { return [record]; }, get() { return record; },
    wait() { waitStarted(); return new Promise(resolve => resolveWait = resolve); },
    async cancel(id) { cancelled.push(id); record.status = 'cancelled'; resolveWait?.(record); return record; },
  };
  const make = runId => openDshToolBridge({ runId, jobs, jobProfiles: [{ id: 'check', kind: 'command', description: 'Trusted check' }] }, { sessionId: 'session-1', options: { enableManagedJobs: true }, redact: value => value });
  const first = await make('run-1');
  try { assert.equal((await call(first, { ...payload, name: 'js_superagent_job_start', arguments: { profileId: 'check' } })).status, 200); }
  finally { await first.close(); }
  const second = await make('run-2');
  assert.equal((await call(second, { ...payload, name: 'js_superagent_job_start', arguments: { profileId: 'check' } })).status, 200);
  assert.equal(new Set(requestIds).size, 2);
  const pending = call(second, { ...payload, callId: 'wait-1', name: 'js_superagent_job_wait', arguments: { jobId: record.id } }).catch(() => null);
  await started;
  await second.close(); await pending;
  assert.deepEqual(cancelled, ['job-1']);
});
test('a rejected command launch tells the model which fields to send, without host error text', async () => {
  const jobs = {
    launch(args) { if (args.text !== undefined) throw new Error('Invalid command job arguments: send only profileId for a command profile; extra fields are rejected'); return { id: 'job-ok' }; },
    list() { return []; }, get(id) { return { id, kind: 'command', profileId: 'fetch', status: 'running' }; }, wait() {}, async cancel() {},
  };
  const bridge = await openDshToolBridge({ runId: 'run-1', jobs, jobProfiles: [{ id: 'fetch', kind: 'command', description: 'Trusted command profile fetch.' }] }, { sessionId: 'session-1', options: { enableManagedJobs: true }, redact: value => value });
  try {
    const rejected = await call(bridge, { ...payload, callId: 'with-text', name: 'js_superagent_job_start', arguments: { profileId: 'fetch', text: 'run it' } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.category, 'invalid-arguments');
    assert.match(rejected.body.hint, /Command profiles take only profileId/);
    assert.doesNotMatch(JSON.stringify(rejected.body), /extra fields are rejected/);
    assert.equal((await call(bridge, { ...payload, callId: 'id-only', name: 'js_superagent_job_start', arguments: { profileId: 'fetch' } })).status, 200);
  } finally { await bridge.close(); }
});
test('material and preparation failures preserve actionable categories without disclosing private diagnostics', async () => {
  const bridge = await openDshToolBridge({ runId: 'run-1', agentTools: { version: 1, definitions: [definition], call(value) {
    throw Object.assign(new Error('private /home/credentials/source diagnostic'), { code: value.arguments.code });
  } } }, { sessionId: 'session-1', options: { enableAgentTools: true }, redact: value => value });
  try {
    for (const [code, category, hint] of [
      ['MATERIAL_CHANGED', 'source-changed', /new call/],
      ['MATERIAL_BINDING_CHANGED', 'authorization-changed', /Stop using old references/],
      ['PREPARATION_CONFLICT', 'preparation-conflict', /saved result/],
      ['MATERIAL_LIMIT', 'budget-or-capacity', /incomplete coverage/],
      ['MATERIAL_SNAPSHOT', 'source-changed', /do not fall back/],
    ]) {
      const response = await call(bridge, { ...payload, callId: code, arguments: { code } });
      assert.equal(response.status, 403); assert.equal(response.body.category, category); assert.match(response.body.hint, hint);
      assert.doesNotMatch(JSON.stringify(response.body), /private|credentials|diagnostic/);
    }
  } finally { await bridge.close(); }
});
test('completed business receipts still recheck host authorization through the live bridge', async () => {
  let authorized = true, visits = 0;
  const bridge = await openDshToolBridge({ runId: 'run-1', agentTools: { version: 1, definitions: [definition], call() {
    visits++;
    if (!authorized) throw Object.assign(new Error('Private authorization details'), { code: 'MATERIAL_BINDING_CHANGED' });
    return { text: 'durable historical receipt' };
  } } }, { sessionId: 'session-1', options: { enableAgentTools: true }, redact: value => value });
  try {
    assert.equal((await call(bridge)).status, 200);
    authorized = false;
    const replay = await call(bridge);
    assert.equal(replay.status, 403); assert.equal(replay.body.category, 'authorization-changed'); assert.equal(visits, 2);
  } finally { await bridge.close(); }
});

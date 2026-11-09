import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCodexHistory, CODEX_HISTORY_VERSION } from '../src/drivers/codex-history.mjs';
import { dshDigest, inspectDshRecovery } from '../src/drivers/dsh-history.mjs';
import { dshHostCallId } from '../src/drivers/dsh-history.mjs';
import { executeDshTurn } from '../src/drivers/dsh.mjs';
import { recoveryEvidence } from '../src/runtime/recovery.mjs';
import { createHostToolVerifier, recordHostToolResult } from '../src/runtime/host-tool-recovery.mjs';

test('W17 host receipts cannot conceal unfinished adoption or an unreconciled operation', () => {
  const records = new Map(), store = { getMeta: key => records.get(key), setMeta: (key, value) => records.set(key, value),
    listMeta: prefix => [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
  const session = { driver: 'codex-app-server', id: 'thread-1' }, identity = { ticketId: 'ticket-1', runId: 'run-1', sessionId: session.id };
  const query = { driver: session.driver, runId: identity.runId, sessionId: session.id, turnId: 'turn-1', callId: 'call-1', name: 'js_superagent_read', arguments: { resource: 'inputs' }, result: { items: [] } };
  recordHostToolResult(store, identity, query, '2026-11-02T00:00:00Z');
  const verify = createHostToolVerifier({ store, ticketId: identity.ticketId, session, ownerExited: () => true });
  assert.equal(verify(query), true);
  records.set('child-adoption:one', { ticketId: identity.ticketId, status: 'interrupted' });
  assert.equal(verify(query), false);
  records.get('child-adoption:one').status = 'rolled-back';
  assert.equal(verify(query), true);
  records.set('operation:owner', { ticketId: identity.ticketId, pid: -1 });
  assert.equal(verify(query), false, 'An exited process is not operation settlement evidence');
  records.delete('operation:owner');
  records.get('child-adoption:one').status = 'unknown';
  assert.equal(verify(query), false);
});

test('W17 completed Codex host calls need matching native result and host receipt', () => {
  const record = { runId: 'run-1', turnId: 'turn-1', cwd: '/tmp/project', session: { driver: 'codex-app-server', id: 'thread-1' } };
  const call = { type: 'dynamicToolCall', id: 'call-1', tool: 'js_superagent_read', namespace: null, status: 'completed', success: true,
    arguments: { resource: 'inputs' }, contentItems: [{ type: 'inputText', text: '{"items":[]}' }] };
  const history = { id: 'thread-1', cwd: record.cwd, cliVersion: CODEX_HISTORY_VERSION, status: { type: 'notLoaded' },
    turns: [{ id: 'turn-1', status: 'interrupted', items: [{ type: 'userMessage', clientId: 'run-run-1' }, call] }] };
  const seen = [];
  const verifyHostTool = query => { seen.push(query); return query.callId === 'call-1' && query.arguments.resource === 'inputs' && query.result.items.length === 0; };
  assert.equal(inspectCodexHistory(history, record, [], { verifyHostTool }).outcome, 'resume');
  assert.equal(seen[0].turnId, 'turn-1');
  call.arguments.resource = 'other';
  assert.equal(inspectCodexHistory(history, record, [], { verifyHostTool, diagnostics: true }).reason, 'host-tool-receipt-unverified');
  call.status = 'inProgress';
  assert.equal(inspectCodexHistory(history, record), null);
});

function dshFixture(t, { oldJob = false, pending = true, nativeVersion = '0.2.1-rc.5' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'js-w17-dsh-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = { driver: 'dsh-sdk', id: 'js-fixed' }, home = join(stateDir(root), 'harness/dsh', session.id);
  const folder = join(home, 'sessions/project', session.id); mkdirSync(folder, { recursive: true });
  const options = { model: 'fixture-model', permission: 'workspace-write', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'JS_W18_KEY' }, timeoutMs: 5000, killGraceMs: 30 };
  const binding = { version: 1, adapter: 'dsh-sdk', nativeVersion, cwd: root, model: options.model, backend: options.backend,
    permission: options.permission, role: 'worker', promptDigest: dshDigest('') };
  const save = (name, data) => writeFileSync(join(home, name), JSON.stringify(data) + '\n');
  save('binding.json', binding);
  const rows = [], event = (type, data) => rows.push({ seq: rows.length, type, data });
  const user = (id, text) => ({ id, content: [{ type: 'text', text }], source: { kind: 'user' } });
  if (oldJob) {
    event('user/message', user('old-origin', 'old task'));
    save('run-old.json', { version: 1, nativeVersion: binding.nativeVersion, runId: 'old', sessionId: session.id, messageId: 'old-origin', promptDigest: dshDigest('old task') });
    event('tool/call', { callId: 'native-start', name: 'js_superagent_job_start', arguments: '{"profileId":"check"}' });
    event('tool/result', { message: { toolCallId: 'native-start', content: [{ type: 'text', text: '{"id":"job-1","status":"running"}' }] } });
  }
  event('user/message', user('origin-message', 'initial task'));
  event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify({ version: 2, state: 'ready', summary: 'old result', artifacts: [], attention: null }) }] } });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const message = user('queued-native', 'Follow-up inputId: feedback\nAdditional requirement');
  if (pending) event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
  save('run-origin.json', { version: 1, nativeVersion: binding.nativeVersion, runId: 'origin', sessionId: session.id, messageId: 'origin-message', promptDigest: dshDigest('initial task') });
  save('latest-run.json', { runId: 'origin', sessionId: session.id });
  save('input-receipts.json', pending ? { feedback: { state: 'accepted', messageId: message.id, digest: dshDigest('Additional requirement'), nativeDigest: dshDigest(message.content[0].text), sessionId: session.id, runId: 'origin' } } : {});
  const log = join(folder, 'session.v4.jsonl');
  const writeLog = () => writeFileSync(log, [JSON.stringify({ type: 'session', version: 4, id: session.id, cwd: root, isSeeded: false }), ...rows.map(row => JSON.stringify(row))].join('\n') + '\n');
  writeLog();
  const input = { runId: 'origin', session, projectRoot: root, sourceProjectRoot: root, inputs: pending ? [{ inputId: 'feedback', status: 'accepted' }] : [] };
  return { root, home, log, options, input, session, rows, writeLog, save };
}

test('W17 settled older DSH jobs are checked by their own run, not a session-wide prohibition', t => {
  const f = dshFixture(t, { oldJob: true, pending: false }), seen = [];
  f.rows.splice(3, 0, { type: 'user/message', data: { id: 'later-message', content: [{ type: 'text', text: 'later old task' }], source: { kind: 'user' } } });
  f.rows.forEach((row, seq) => { row.seq = seq; }); f.writeLog();
  f.save('run-later.json', { version: 1, nativeVersion: '0.2.1-rc.5', runId: 'later', sessionId: f.session.id, messageId: 'later-message', startSequence: -1, promptDigest: dshDigest('later old task') });
  const verifyHostTool = query => { seen.push(query); return query.runId === 'old' && query.callId === dshHostCallId(f.session.id, 'old', 'native-start') && query.result.id === 'job-1'; };
  assert.equal(inspectDshRecovery(f.options, { ...f.input, verifyHostTool }).outcome, 'completed');
  assert.equal(seen[0].runId, 'old');
  assert.equal(inspectDshRecovery(f.options, { ...f.input, diagnostics: true, verifyHostTool: () => false }).reason, 'host-tool-receipt-unverified');
});

test('W18 known pending is inspected without claiming unsupported rc.5 adoption', t => {
  const f = dshFixture(t), inspected = inspectDshRecovery(f.options, { ...f.input, diagnostics: true });
  assert.equal(inspected.reason, 'native-pending-wakeup-unsupported');
  assert.equal(inspected.safeToResume, false);
  const proof = { version: 1, kind: 'interrupted', safeToResume: true, toolsSettled: true, session: f.session, code: 'HISTORY_VERIFIED', checkpoint: { runId: 'origin', eventSequence: inspected.pendingInputs.eventSequence }, outcome: 'adopt-pending', adoption: inspected.pendingInputs };
  assert.equal(recoveryEvidence(proof, { ...f.input, kind: 'interrupted' }).adoption.pending[0].inputId, 'feedback');
  assert.equal(inspectDshRecovery(f.options, { ...f.input, inputs: [], diagnostics: true }).reason, 'native-pending-input-not-authorized');
  f.rows.at(-1).data.inserted.push({ id: 'stranger', content: [{ type: 'text', text: 'unowned' }] }); f.writeLog();
  assert.equal(inspectDshRecovery(f.options, { ...f.input, diagnostics: true }).reason, 'native-pending-input-not-authorized');
  const again = dshFixture(t), first = again.rows.at(-1).data.inserted[0];
  const second = { ...first, id: 'queued-second', content: [{ type: 'text', text: 'Follow-up inputId: second\nSecond requirement' }] };
  again.rows.at(-1).data.inserted.push(second);
  const receipts = JSON.parse(readFileSync(join(again.home, 'input-receipts.json')));
  receipts.second = { ...receipts.feedback, messageId: second.id, digest: dshDigest('Second requirement'), nativeDigest: dshDigest(second.content[0].text) };
  again.save('input-receipts.json', receipts); again.writeLog();
  const allowed = [...again.input.inputs, { inputId: 'second', status: 'accepted' }];
  const original = { adoption: inspectDshRecovery(again.options, { ...again.input, inputs: allowed, diagnostics: true }).pendingInputs };
  again.save('run-adopting.json', { version: 2, nativeVersion: '0.2.1-rc.5', sessionId: again.session.id, runId: 'adopting', startSequence: original.adoption.eventSequence, adoption: original.adoption });
  again.save('latest-run.json', { runId: 'adopting', sessionId: again.session.id });
  again.rows.push({ seq: again.rows.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } });
  again.rows.push({ seq: again.rows.length, type: 'user/message', data: first }); again.writeLog();
  const resumedProof = inspectDshRecovery(again.options, { ...again.input, runId: 'adopting', inputs: allowed, diagnostics: true });
  assert.equal(resumedProof.reason, 'native-pending-wakeup-unsupported');
  assert.equal(resumedProof.pendingInputs.sourceRunId, 'adopting');
  assert.equal(resumedProof.pendingInputs.pending[0].sourceRunId, 'origin');
  assert.equal(resumedProof.pendingInputs.pending[0].inputId, 'second');
});

test('W18 rc.5 refuses queued-input adoption before native startup', async t => {
  const f = dshFixture(t), inspected = inspectDshRecovery(f.options, { ...f.input, diagnostics: true });
  const before = readFileSync(f.log, 'utf8'), owners = [];
  await assert.rejects(executeDshTurn(f.options, { ...f.input, runId: 'adopting', adoption: inspected.pendingInputs,
    prompt: 'this must not be sent', registerProcess: pid => owners.push(pid), checkpoint() {} }), /wakeup is unsupported/);
  assert.deepEqual(owners, []);
  assert.equal(readFileSync(f.log, 'utf8'), before);
});

test('Alpha.2 history preserves completed evidence and keeps pending queues read-only', t => {
  const completed=dshFixture(t,{nativeVersion:'0.2.2-alpha.2',pending:false});
  assert.equal(inspectDshRecovery(completed.options,{...completed.input,diagnostics:true}).outcome,'completed');
  const pending=dshFixture(t,{nativeVersion:'0.2.2-alpha.2'}),before=readFileSync(pending.log,'utf8');
  const inspected=inspectDshRecovery(pending.options,{...pending.input,diagnostics:true});
  assert.equal(inspected.reason,'native-pending-wakeup-unsupported');assert.equal(inspected.safeToResume,false);
  assert.equal(inspected.pendingInputs.pending[0].inputId,'feedback');assert.equal(readFileSync(pending.log,'utf8'),before);
  const unknown=dshFixture(t,{nativeVersion:'0.2.2-alpha.999'});
  assert.equal(inspectDshRecovery(unknown.options,{...unknown.input,diagnostics:true}).reason,'native-history-binding-mismatch');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectStateDirectory } from '../src/state-paths.mjs';
import { dshDigest, inspectDshRecovery } from '../src/drivers/dsh-history.mjs';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';

const good = { version: 2, state: 'ready', summary: 'Read-only inspection finished.', artifacts: [], attention: null, answers: null };
function fixture(t, content = [{ type: 'reasoning', text: 'synthetic placeholder' }]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-final-report-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = { driver: 'dsh-sdk', id: 'js-final-report' }, runId = 'original-run';
  const home = join(projectStateDirectory(root), 'harness/dsh', session.id), folder = join(home, 'sessions/project', session.id);
  mkdirSync(folder, { recursive: true });
  const options = { model: 'fixture-model', permission: 'workspace-write', backend: { auth: 'api-key', provider: 'deepseek-official', protocol: 'anthropic-messages', baseURL: 'http://127.0.0.1:1/anthropic', apiKeyEnv: 'DSH_UNUSED_TEST_KEY' } };
  const save = (name, value) => writeFileSync(join(home, name), JSON.stringify(value) + '\n');
  save('binding.json', { version: 1, adapter: 'dsh-sdk', nativeVersion: '0.2.2-alpha.2', cwd: root, model: options.model, backend: options.backend, permission: options.permission, promptDigest: dshDigest('') });
  save(`run-${runId}.json`, { version: 1, nativeVersion: '0.2.2-alpha.2', sessionId: session.id, runId, messageId: 'original-input', promptDigest: dshDigest('Read the existing project status.'), contextRecords: [{ resource: 'messages', id: 'input-1', version: 'v1' }] });
  save('latest-run.json', { runId, sessionId: session.id });
  const rows = [
    { type: 'user/message', data: { id: 'original-input', content: [{ type: 'text', text: 'Read the existing project status.' }], source: { kind: 'user' } } },
    // A preceding progress message must never replace an empty final result.
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify(good) }, { type: 'tool-call', id: 'read-status', name: 'bash', arguments: '{"command":"git status --short"}' }] } } },
    { type: 'tool/call', data: { turn: 1, callId: 'read-status', name: 'bash', arguments: '{"command":"git status --short"}' } },
    { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'read-status', isError: false, content: [{ type: 'text', text: 'no changes' }] } } },
    { type: 'assistant/message', data: { turn: 1, message: { content } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const path = join(folder, 'session.v4.jsonl');
  const write = () => writeFileSync(path, [{ type: 'session', version: 4, id: session.id, cwd: root, isSeeded: false }, ...rows.map((event, seq) => ({ ...event, seq }))].map(JSON.stringify).join('\n') + '\n');
  write();
  const input = { session, runId, projectRoot: root, sourceProjectRoot: root, diagnostics: true, inputs: [] };
  return { options, input, rows, write, save, path, inspect: () => inspectDshRecovery(options, input) };
}

test('DSH settled reasoning-only and whitespace finals offer continuation without substituting prior output', t => {
  for (const content of [[{ type: 'reasoning', text: 'synthetic placeholder' }], [{ type: 'text', text: ' \n\t' }], []]) {
    const f = fixture(t, content), before = readFileSync(f.path, 'utf8'), result = f.inspect();
    assert.equal(result.outcome, 'resume'); assert.equal(result.finalReportFailure, 'missing-final-report');
    assert.equal(result.code, 'HISTORY_VERIFIED'); assert.equal(result.toolsSettled, true);
    assert.equal(result.report, undefined); assert.deepEqual(result.contextRecords, [{ resource: 'messages', id: 'input-1', version: 'v1' }]);
    assert.equal(readFileSync(f.path, 'utf8'), before, 'Inspection does not rewrite durable native history');
  }
});

test('DSH malformed completed reports retain a precise recoverable classification', async t => {
  for (const text of ['not a JSON report', '{"version":2', JSON.stringify({ ...good, state: 'invented' }), JSON.stringify({ ...good, answers: 7 })]) {
    const f = fixture(t, [{ type: 'text', text }]);
    const result = await createDshSdkDriver(f.options).inspectRecovery(f.input);
    assert.equal(result.outcome, 'resume'); assert.equal(result.finalReportFailure, 'invalid-final-report');
    assert.equal(result.report, undefined); assert.equal(result.safeToResume, true);
  }
});

test('DSH recovered valid reports share the live parser for bare, leading and fenced JSON', t => {
  for (const text of [JSON.stringify(good), `Finished.\n${JSON.stringify(good)}`, `Finished.\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``]) {
    const f = fixture(t, [{ type: 'text', text }]), result = f.inspect();
    assert.equal(result.outcome, 'completed'); assert.equal(result.report.summary, good.summary);
    assert.equal(result.finalReportFailure, undefined);
  }
});

test('DSH empty-report repair cannot override unsettled or unknown native effects', t => {
  for (const change of [
    f => f.rows.splice(3, 1),
    f => f.rows.splice(4, 0, { type: 'job/registered', data: { jobId: 'job-running', owner: f.input.session.id } }),
    f => { f.rows[3].data.message.meta = { outcome: 'unknown' }; },
    f => { f.rows[3].data.message.content[0].text = 'TOOL_OUTCOME_UNKNOWN'; },
    f => f.rows.splice(4, 0, { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [{ id: 'unknown-pending', content: [{ type: 'text', text: 'unowned input' }] }] } }),
    f => f.rows.splice(4, 0, { type: 'user/message', data: { id: 'unowned-human', content: [{ type: 'text', text: 'changed instruction' }], source: { kind: 'user' } } }),
    f => f.save('input-receipts.json', { unknown: { state: 'accepted', messageId: 'missing', nativeDigest: dshDigest('unknown send'), runId: f.input.runId } }),
    f => f.save('latest-run.json', { runId: 'later-run', sessionId: f.input.session.id }),
  ]) {
    const f = fixture(t); change(f); f.write(); const result = f.inspect();
    assert.equal(result.safeToResume, false); assert.equal(result.kind, 'inspection');
    assert.equal(result.finalReportFailure, undefined);
  }
});

test('DSH recovery separates missing history and non-completed turns from missing final reports', t => {
  const missing = fixture(t); rmSync(missing.path); assert.equal(missing.inspect().reason, 'native-history-unavailable');
  for (const reason of [{ kind: 'cancelled' }, { kind: 'max-tokens' }, { kind: 'error', error: { code: 'AUTH' } }]) {
    const f = fixture(t); f.rows.at(-1).data.reason = reason; f.write();
    assert.equal(f.inspect().reason, 'native-terminal-does-not-allow-resume');
  }
  for (const change of [f => { f.rows.at(-2).data.interrupted = true; }, f => { f.rows.at(-2).data.turn = 0; }]) {
    const f = fixture(t); change(f); f.write(); assert.equal(f.inspect().safeToResume, false);
  }
  const transient = fixture(t); transient.rows.at(-1).data.reason = { kind: 'error', error: { code: 'RATE_LIMIT' } }; transient.write();
  assert.equal(transient.inspect().outcome, 'resume'); assert.equal(transient.inspect().finalReportFailure, undefined);
});

test('DSH report repair cannot proceed when the final message predates tool settlement', t => {
  const f = fixture(t);
  [f.rows[3], f.rows[4]] = [f.rows[4], f.rows[3]]; f.write();
  assert.equal(f.inspect().reason, 'native-result-predates-tool-completion');
});


test('DSH valid completed result retains settled native-job recovery behavior', t => {
  const f = fixture(t, [{ type: 'text', text: JSON.stringify(good) }]);
  f.rows.splice(4, 0, { type: 'job/registered', data: { jobId: 'settled-preview', owner: f.input.session.id } });
  f.rows.splice(6, 0, { type: 'job/settled', data: { jobId: 'settled-preview', owner: f.input.session.id, status: 'completed' } });
  f.write();
  assert.equal(f.inspect().outcome, 'completed');
  assert.equal(f.inspect().report.summary, good.summary);
});

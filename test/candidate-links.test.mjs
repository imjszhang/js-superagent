import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createRuntimePolicy } from '../src/policy.mjs';
import { createCandidateLinks } from '../src/runtime/candidate-links.mjs';
import { AssessmentContextChanged, isAssessmentContextChanged } from '../src/runtime/assessment-refresh.mjs';

const repository = 'fixture/links', at = '2026-11-03T01:00:00.000Z';
function fixture(t, { text = 'Please attach this to #1', pull = false, extra = [], original = false } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { mode: 'auto', rules: [{ id: 'fix', enabled: true, instruction: 'Fix reported defects' }], sourceRows: [
    { id: 'repo', source: 'github', scope: { repository }, actors: ['alice', 'bob'], bots: ['robot'], admission: { listedUnaddressed: true } },
  ] };
  const makePolicy = changes => createRuntimePolicy({ config, ...changes,
    explicitGate: trigger => trigger.source === 'local' ? { admissible: true, strength: 'explicit', basis: { via: 'listed', sender: 'operator' } } : { admissible: false },
    revalidateExplicit: () => true });
  let policy = makePolicy();
  function trigger(id, number, text, pull = false) {
    return { id, source: 'github', actor: { source: 'github', id: 'alice' }, human: true, addressed: 'direct', text, at,
      threads: [{ source: 'github', id: `${repository}#${pull ? 'pr:' : ''}${number}` }],
      meta: { repository, actorId: '10', actorType: 'User', ...(pull ? { pullRequest: { repository, number, headSha: 'a'.repeat(40) } } : { issueNumber: number }) } };
  }
  function saveThread(ref, subscriptions = []) {
    const value = { key: `${ref.source}:${ref.id}`, ref, subscriptions, context: [], pending: [], correlated: [], meta: {}, createdAt: at };
    store.threads.save(value); return value;
  }
  function addTarget(number, { pull = false, id = `ticket-${number}` } = {}) {
    const origin = trigger(`origin-${id}`, number, 'Fix the parser', pull); store.triggers.save(origin);
    const thread = saveThread(origin.threads[0], [id]);
    const ticket = { id, title: `Task ${number}`, createdAt: at, updatedAt: at,
      mandate: { actor: origin.actor, scope: 'Fix the parser', strength: 'explicit', basis: policy.gate(origin).basis },
      origin: { triggerId: origin.id, triggerIds: [origin.id], threadKey: thread.key }, threads: [thread.ref],
      inputs: [], undelivered: [], assignments: [], channels: [], follows: [] };
    store.tickets.save(ticket); return ticket;
  }
  const target = addTarget(1), pr = addTarget(2, { pull: true });
  const input = trigger('request-1', 99, text, pull), inputs = [input, ...extra.map((value, i) => ({ ...trigger(`request-${i + 2}`, 99, value.text, pull), ...value }))];
  for (const value of inputs) { store.triggers.save(value); store.triggers.saveDisposition(value.id, { fanout: [], evalId: 'eval-1', at }); }
  const thread = saveThread(input.threads[0], original ? [target.id] : []);
  thread.evaluating = { id: 'eval-1', policyVersion: policy.version, triggerIds: inputs.map(value => value.id), strength: 'explicit' }; store.threads.save(thread);
  const candidate = { evalId: 'eval-1', policyVersion: policy.version, strength: 'explicit', thread, triggers: inputs, tickets: original ? [target] : [] };
  const create = options => createCandidateLinks({ store, candidate, repository, policy: () => policy, ...options });
  return { store, candidate, input, target, pr, create, addTarget, config, makePolicy,
    setPolicy(value) { policy = value; },
    changeTicket(id, change) { const value = store.tickets.get(id); change(value); store.tickets.save(value); },
    changeThread(key, change) { const value = store.threads.get(key); change(value); store.threads.save(value); } };
}
const refused = (call, reason, triggerId) => assert.throws(call, error => !isAssessmentContextChanged(error) && error.code === 'CANDIDATE_LINKS_REJECTED' && error.reason === reason && (triggerId === undefined || error.triggerId === triggerId));

test('explicit Issue links discover saved Issue/PR owners without mutating domain records', t => {
  const f = fixture(t, { text: `Please route #1 and https://github.com/${repository}/pull/2#discussion_r42 here.` });
  const before = f.store.threads.list(), links = f.create();
  assert.deepEqual(links.candidate.tickets.map(ticket => ticket.id).sort(), [f.target.id, f.pr.id]);
  assert.deepEqual(links.candidate.ticketReferences.toSorted((a, b) => a.ticketId.localeCompare(b.ticketId)), [
    { ticketId: f.target.id, triggerIds: [f.input.id], threads: [`github:${repository}#1`] },
    { ticketId: f.pr.id, triggerIds: [f.input.id], threads: [`github:${repository}#pr:2`] },
  ]);
  assert.deepEqual(f.candidate.tickets, []); assert.deepEqual(f.store.threads.list(), before);
  assert.equal(f.store.atomic(() => links.verify(f.target.id, f.input.id)), true); assert.equal(links.verify(), true);
  assert.equal(links.verify(f.pr.id), true);
});

test('PR sources and same-repository short references use the saved canonical discussion namespace', t => {
  const f = fixture(t, { pull: true, text: `Continue ${repository}#1 and #2; see https://github.com/${repository}/issues/1#issuecomment-123.` });
  const links = f.create(); assert.equal(links.candidate.tickets.length, 2); assert.equal(links.verify(f.target.id), true);
  assert.deepEqual(links.candidate.ticketReferences.find(link => link.ticketId === f.target.id).threads, [`github:${repository}#1`]);
});

test('foreign, nested, malformed and arbitrary references cannot donate local issue numbers', t => {
  const values = ['other/repo#1', 'https://evil.example/fixture/links/issues/1',
    `https://evil.example/?next=https://github.com/${repository}/issues/1`,
    `https://github.com.evil.example/${repository}/issues/1`, `https://github.com@evil.example/${repository}/issues/1`,
    `https://github.com/${repository}/issues/1?next=#2`, `https://github.com/${repository}/issues/1#unknown-2`,
    `https://github.com/${repository}/issues/1#issuecomment-123#2`, `https://github.com/other/repo/issues/1`,
    `ftp://github.com/${repository}/issues/1`, `/wrapped/https://github.com/${repository}/issues/1`,
    `https://github.com/${repository}/issues/%31`, `${repository}#1suffix`, 'ticket-1', 'file#1', '#0 #01 #9007199254740993'];
  for (const text of values) {
    const f = fixture(t, { text }), links = f.create();
    assert.deepEqual(links.candidate.ticketReferences, [], text); assert.deepEqual(links.candidate.tickets, [], text);
  }
});

test('context-only, revoked, human-stopped, handed-back and sourceless targets are excluded', t => {
  for (const mode of ['context', 'revoked', 'stopped', 'handback', 'missing-origin', 'foreign-origin']) {
    const f = fixture(t);
    if (mode === 'context') f.changeThread(`github:${repository}#1`, value => { value.context = [f.target.id]; });
    if (mode === 'revoked') f.changeTicket(f.target.id, value => { value.mandate.actor.id = 'outsider'; });
    if (mode === 'stopped') f.changeTicket(f.target.id, value => { value.ended = { by: 'human', outcome: 'stopped', at }; });
    if (mode === 'handback') f.store.triggers.saveDisposition(f.input.id, { fanout: [f.target.id], handbacks: [{ ticketId: f.target.id, reason: 'Different scope', at }], at });
    if (mode === 'missing-origin') f.store.db.prepare('DELETE FROM domain_triggers WHERE id=?').run(f.target.origin.triggerId);
    if (mode === 'foreign-origin') { const origin = f.store.triggers.get(f.target.origin.triggerId); origin.meta.repository = 'other/repo'; f.store.triggers.save(origin); }
    assert.deepEqual(f.create().candidate.ticketReferences, [], mode);
  }
});

test('completed non-human-ended work and local-origin work may remain valid referenced owners', t => {
  const f = fixture(t); f.changeTicket(f.target.id, value => { value.ended = { by: 'executor', outcome: 'completed', at }; });
  assert.equal(f.create().candidate.ticketReferences.length, 1);
  const origin = f.store.triggers.get(f.target.origin.triggerId); origin.source = 'local'; f.store.triggers.save(origin);
  assert.equal(f.create().verify(f.target.id), true);
});

test('mixed batches attribute links to each original input and cannot borrow another person’s reference', t => {
  const f = fixture(t, { extra: [{ text: 'Please inspect the queue', actor: { source: 'github', id: 'bob' } },
    { text: '#2', actor: { source: 'github', id: 'robot' }, human: false, meta: { repository, issueNumber: 99, actorType: 'Bot', actorId: '22' } }] });
  const links = f.create(); assert.equal(links.candidate.ticketReferences.length, 1);
  assert.equal(links.verify(f.target.id, f.input.id), true);
  refused(() => links.verify(f.target.id, 'request-2'), 'target-not-referenced-by-trigger', 'request-2');
  refused(() => links.verify(f.target.id, 'request-3'), 'selected-trigger-not-explicit', 'request-3');
  refused(() => links.verify(f.target.id), 'selected-trigger-not-explicit');
});

test('existing targets retain their original route but selected input still needs a current explicit gate', t => {
  const f = fixture(t, { original: true, text: 'Continue this task' }), links = f.create();
  assert.deepEqual(links.candidate.ticketReferences, []); assert.equal(links.verify(f.target.id), true);
  refused(() => links.verify('arbitrary-ticket', f.input.id), 'target-outside-candidate', f.input.id);
  f.changeTicket(f.target.id, value => { value.ended = { by: 'human', outcome: 'stopped', at }; });
  refused(() => links.verify(f.target.id), 'target-no-longer-routeable');
});

test('verification rejects changed target, origin, referenced ownership and source snapshots', t => {
  for (const mode of ['missing-ticket', 'origin', 'thread', 'source', 'source-thread', 'disposition']) {
    const f = fixture(t), links = f.create();
    if (mode === 'missing-ticket') f.store.db.prepare('DELETE FROM domain_tickets WHERE id=?').run(f.target.id);
    if (mode === 'origin') f.store.db.prepare('DELETE FROM domain_triggers WHERE id=?').run(f.target.origin.triggerId);
    if (mode === 'thread') f.changeThread(`github:${repository}#1`, value => { value.context = [f.target.id]; });
    if (mode === 'source') { const value = f.store.triggers.get(f.input.id); value.text = '#2 instead'; f.store.triggers.save(value); }
    if (mode === 'source-thread') f.changeThread(f.candidate.thread.key, value => { value.subscriptions.push(f.target.id); });
    if (mode === 'disposition') f.store.triggers.saveDisposition(f.input.id, { fanout: [f.target.id], at });
    const reasons = { 'missing-ticket': 'target-missing', origin: 'target-source-missing-or-changed', thread: 'referenced-thread-changed',
      source: 'source-missing-or-changed', 'source-thread': 'source-thread-changed', disposition: 'source-disposition-changed' };
    refused(() => links.verify(), reasons[mode], ['source', 'source-thread', 'disposition'].includes(mode) ? f.input.id : undefined);
  }
});

test('ordinary target updates invalidate the whole card with typed, body-free snapshot evidence', t => {
  for (const original of [false, true]) for (const mode of ['input', 'assignment', 'completed', 'title']) {
    const f = fixture(t, { original }), links = f.create();
    f.changeTicket(f.target.id, value => {
      if (mode === 'input') value.inputs.push({ id: 'new-input', kind: 'text', text: 'private-supplement-body', at });
      if (mode === 'assignment') value.assignments.push({ id: 'active-assignment', state: 'running', report: { summary: 'private-worker-report' } });
      if (mode === 'completed') value.ended = { by: 'executor', outcome: 'completed', at };
      if (mode === 'title') value.title = 'private-updated-title';
    });
    assert.equal(links.verifyAuthority(f.target.id, f.input.id), true);
    for (const verify of [() => links.verify(), () => links.verify(f.target.id, f.input.id)]) assert.throws(verify, error => {
      assert.ok(error instanceof AssessmentContextChanged);
      assert.equal(error.reason, 'candidate-target-snapshot');
      assert.deepEqual(Object.keys(error.targetSnapshot).sort(), ['changeKind', 'currentVersion', 'previousVersion', 'ticketId']);
      assert.equal(error.targetSnapshot.ticketId, f.target.id);
      assert.equal(error.targetSnapshot.changeKind, 'ticket-snapshot');
      assert.match(error.targetSnapshot.previousVersion, /^[a-f\d]{64}$/);
      assert.match(error.targetSnapshot.currentVersion, /^[a-f\d]{64}$/);
      assert.notEqual(error.targetSnapshot.previousVersion, error.targetSnapshot.currentVersion);
      assert.doesNotMatch(JSON.stringify(error), /private-/);
      return true;
    });
    // Only a newly captured candidate can become current; the hard-only check
    // above did not update or waive the old card's whole-ticket fingerprint.
    if (original) f.candidate.tickets = [f.store.tickets.get(f.target.id)];
    assert.equal(f.create().verify(f.target.id, f.input.id), true);
  }
});

test('authority, identity and reply-route changes never qualify as snapshot refreshes', t => {
  for (const original of [false, true]) for (const mode of ['stopped', 'revoked', 'scope', 'origin', 'channel', 'identity', 'missing-origin']) {
    const f = fixture(t, { original }), links = f.create();
    f.changeTicket(f.target.id, value => {
      value.inputs.push({ id: 'simultaneous-input', kind: 'text', text: 'new state', at });
      if (mode === 'stopped') value.ended = { by: 'human', outcome: 'stopped', at };
      if (mode === 'revoked') value.mandate.actor.id = 'outsider';
      if (mode === 'scope') value.mandate.scope = 'A different task';
      if (mode === 'origin') value.origin.triggerId = f.pr.origin.triggerId;
      if (mode === 'channel') value.channels.push({ source: 'local', address: { user: 'someone-else' } });
      if (mode === 'identity') value.decisionId = 'replacement-decision';
    });
    if (mode === 'missing-origin') f.store.db.prepare('DELETE FROM domain_triggers WHERE id=?').run(f.target.origin.triggerId);
    const reason = ['stopped', 'revoked'].includes(mode) ? 'target-no-longer-routeable'
      : mode === 'missing-origin' ? 'target-source-missing-or-changed' : 'target-authority-or-route-changed';
    refused(() => links.verifyAuthority(), reason);
    refused(() => links.verify(f.target.id, f.input.id), reason);
  }
});

test('a different target hard refusal wins over an earlier target snapshot change', t => {
  for (const mode of ['missing', 'stopped', 'revoked', 'origin']) {
    const f = fixture(t, { text: '#1 and #2' }), links = f.create();
    f.changeTicket(f.target.id, value => { value.title = 'An ordinary update'; });
    if (mode === 'missing') f.store.db.prepare('DELETE FROM domain_tickets WHERE id=?').run(f.pr.id);
    if (mode === 'stopped') f.changeTicket(f.pr.id, value => { value.ended = { by: 'human', outcome: 'stopped', at }; });
    if (mode === 'revoked') f.changeTicket(f.pr.id, value => { value.mandate.actor.id = 'outsider'; });
    if (mode === 'origin') f.store.db.prepare('DELETE FROM domain_triggers WHERE id=?').run(f.pr.origin.triggerId);
    refused(() => links.verify(f.target.id, f.input.id), mode === 'missing' ? 'target-missing'
      : mode === 'origin' ? 'target-source-missing-or-changed' : 'target-no-longer-routeable');
  }
});

test('source and selected attachment refusals outrank simultaneous target updates', t => {
  for (const mode of ['source', 'membership', 'handback', 'outside', 'not-referenced', 'not-explicit']) {
    const f = fixture(t, { extra: [{ text: 'A separate request' }, { text: '#1', actor: { source: 'github', id: 'robot' }, human: false }] }), links = f.create();
    f.changeTicket(f.target.id, value => { value.title = 'Updated during assessment'; });
    if (mode === 'source') { const value = f.store.triggers.get(f.input.id); value.text = 'Edited request'; f.store.triggers.save(value); }
    if (mode === 'membership') f.changeThread(`github:${repository}#1`, value => { value.context.push(f.target.id); });
    if (mode === 'handback') f.store.triggers.saveDisposition(f.input.id, { fanout: [], handbacks: [{ ticketId: f.target.id, reason: 'not mine', at }], at });
    const reason = { source: 'source-missing-or-changed', membership: 'referenced-thread-changed', handback: 'source-disposition-changed',
      outside: 'target-outside-candidate', 'not-referenced': 'target-not-referenced-by-trigger', 'not-explicit': 'selected-trigger-not-explicit' }[mode];
    refused(() => links.verify(mode === 'outside' ? 'outside-ticket' : f.target.id,
      mode === 'not-referenced' ? 'request-2' : mode === 'not-explicit' ? 'request-3' : f.input.id), reason);
  }
});

test('stable stopped, revoked and context-only original tickets remain ordinary context, not attachment authority', t => {
  for (const mode of ['stopped', 'revoked', 'context']) {
    const f = fixture(t, { original: true, text: 'A separate new request' });
    if (mode === 'stopped') f.changeTicket(f.target.id, value => { value.ended = { by: 'human', outcome: 'stopped', at }; });
    if (mode === 'revoked') f.changeTicket(f.target.id, value => { value.mandate.actor.id = 'outsider'; });
    if (mode === 'context') f.changeThread(f.candidate.thread.key, value => { value.context.push(f.target.id); });
    f.candidate.tickets = [f.store.tickets.get(f.target.id)];
    f.candidate.thread = f.store.threads.get(f.candidate.thread.key);
    const links = f.create();
    assert.equal(links.verify(), true); assert.equal(links.verifyAuthority(), true);
    if (mode !== 'context') refused(() => links.verify(f.target.id, f.input.id), 'target-no-longer-routeable');
    f.changeTicket(f.target.id, value => { value.title = 'Changed, but no refresh authority'; });
    refused(() => links.verify(), 'target-no-longer-routeable');
  }
});

test('loss of a previously valid mandate is hard even when ticket bytes and policy version stay the same', t => {
  const f = fixture(t, { original: true }), links = f.create();
  f.setPolicy({ ...f.makePolicy(), revalidate: () => false });
  refused(() => links.verifyAuthority(), 'target-no-longer-routeable');
  refused(() => links.verify(), 'target-no-longer-routeable');
});

test('a target origin change is hard even when the original ticket bytes did not change', t => {
  for (const mode of ['edited', 'missing']) {
    const f = fixture(t, { original: true }), links = f.create();
    if (mode === 'missing') f.store.db.prepare('DELETE FROM domain_triggers WHERE id=?').run(f.target.origin.triggerId);
    else { const origin = f.store.triggers.get(f.target.origin.triggerId); origin.text = 'Changed original authorization'; f.store.triggers.save(origin); }
    refused(() => links.verifyAuthority(), 'target-source-missing-or-changed');
    refused(() => links.verify(), 'target-source-missing-or-changed');
  }
  const f = fixture(t, { original: true });
  f.store.db.prepare('DELETE FROM domain_triggers WHERE id=?').run(f.target.origin.triggerId);
  const links = f.create();
  assert.equal(links.verify(), true); // A stable historical context record remains context.
  f.changeTicket(f.target.id, value => { value.title = 'Changed but missing origin proof'; });
  refused(() => links.verify(), 'target-source-missing-or-changed');
});

test('a prior handback for one input does not revoke another input’s existing route', t => {
  for (const original of [false, true]) {
    const f = fixture(t, { original, extra: [{ text: '#1 please continue' }] });
    f.store.triggers.saveDisposition(f.input.id, { fanout: [f.target.id], handbacks: [{ ticketId: f.target.id, reason: 'different scope', at }], evalId: 'eval-1', at });
    const links = f.create();
    assert.equal(links.verify(), true);
    assert.equal(links.verify(f.target.id, 'request-2'), true);
    refused(() => links.verify(f.target.id, f.input.id), 'target-no-longer-routeable');
    f.changeTicket(f.target.id, value => { value.title = 'New worker snapshot'; });
    assert.equal(links.verifyAuthority(f.target.id, 'request-2'), true);
    assert.throws(() => links.verify(f.target.id, 'request-2'), AssessmentContextChanged);
    refused(() => links.verify(f.target.id, f.input.id), 'target-no-longer-routeable');
  }
});

test('policy replacement, pause and an expired evaluation invalidate saved links', t => {
  for (const mode of ['policy', 'paused', 'expired']) {
    const f = fixture(t), links = f.create();
    if (mode === 'policy') f.setPolicy(f.makePolicy({ version: 'new-policy' }));
    if (mode === 'paused') f.setPolicy(f.makePolicy({ paused: true }));
    if (mode === 'expired') f.changeThread(f.candidate.thread.key, value => { delete value.evaluating; });
    refused(() => links.verify(), mode === 'expired' ? 'candidate-expired' : 'policy-changed-or-paused', f.input.id);
    refused(() => f.create(), mode === 'expired' ? 'candidate-expired' : 'policy-changed-or-paused', f.input.id);
  }
});

test('observed source revision retirement prevents routing an old comment', t => {
  const f = fixture(t), links = f.create();
  f.store.setMeta(`github:comment-version:${f.input.id}`, { eventId: 'replacement-source' });
  refused(() => links.verify(), 'source-revision-retired', f.input.id);
  refused(() => f.create(), 'source-revision-retired', f.input.id);
});

test('a ticket handback does not retire the current source for a fresh assessment', t => {
  const f = fixture(t);
  f.store.setMeta(`input:retired:${f.target.id}:${f.input.id}`, { reason: 'beyond this ticket', at, eventId: f.input.id });
  f.store.setMeta(`github:retired:other-ticket:${f.input.id}`, { reason: 'PR association explicitly removed', at, eventId: f.input.id });
  assert.equal(f.create().verify(), true);
  f.store.setMeta(`github:comment-version:${f.input.id}`, { eventId: 'replacement-source' });
  refused(() => f.create(), 'source-revision-retired', f.input.id);
});

test('discovery fails explicitly at text, reference and target budgets', t => {
  let f = fixture(t, { text: '#1 ' + 'x'.repeat(32000) }); refused(() => f.create(), 'text-budget-exceeded', f.input.id);
  f = fixture(t, { text: Array(21).fill('#1').join(' ') }); refused(() => f.create(), 'reference-budget-exceeded', f.input.id);
  f = fixture(t, { text: Array.from({ length: 9 }, (_, i) => `#${i + 1}`).join(' ') });
  for (let n = 3; n <= 9; n++) f.addTarget(n);
  refused(() => f.create(), 'target-budget-exceeded', f.input.id);
});

test('ordinary long Issues and large batches without references keep their assessment path', t => {
  for (const options of [
    { text: 'Please inspect this log. ' + 'ordinary text '.repeat(2400) },
    { text: 'Please inspect this result.', extra: Array.from({ length: 25 }, (_, i) => ({ text: `Ordinary follow-up ${i}.` })) },
  ]) {
    const f = fixture(t, options), links = f.create();
    assert.deepEqual(links.candidate.triggers, f.candidate.triggers);
    assert.deepEqual(links.candidate.tickets, []); assert.deepEqual(links.candidate.ticketReferences, []);
    assert.equal(links.verify(), true);
  }
});

test('ordinary neighboring inputs consume no discovery budget or reference authority', t => {
  const f = fixture(t, { text: 'Please inspect this log. ' + 'ordinary text '.repeat(2400),
    extra: [{ text: 'Continue the existing task in #1.' }, ...Array.from({ length: 25 }, (_, i) => ({ text: `Ordinary follow-up ${i}.` }))] });
  const links = f.create();
  assert.deepEqual(links.candidate.ticketReferences, [{ ticketId: f.target.id, triggerIds: ['request-2'], threads: [`github:${repository}#1`] }]);
  assert.equal(links.verify(f.target.id, 'request-2'), true);
  refused(() => links.verify(f.target.id, f.input.id), 'target-not-referenced-by-trigger', f.input.id);
});

test('no repository, inferred and non-human candidates retain their ordinary context without link discovery', t => {
  for (const mode of ['no-repository', 'inferred', 'bot', 'local', 'context-only']) {
    const f = fixture(t, { text: '#1 ' + 'x'.repeat(33000) });
    if (mode === 'inferred') f.candidate.strength = 'inferred';
    if (['bot', 'local', 'context-only'].includes(mode)) {
      const value = f.candidate.triggers[0];
      if (mode === 'bot') { value.human = false; value.meta.actorType = 'Bot'; }
      if (mode === 'local') { value.source = 'local'; value.actor.source = 'local'; }
      if (mode === 'context-only') value.meta.contextOnly = true;
      f.store.triggers.save(value);
    }
    const links = f.create(mode === 'no-repository' ? { repository: undefined } : {});
    assert.deepEqual(links.candidate.tickets, []); assert.equal(links.verify(), true);
  }
});

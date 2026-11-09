// In-memory protocol demonstration: no model calls, external writes, or persistent recovery.
// Production ports must persist queued work in the same transaction as the domain change.
import { Engine, MemoryRepositories, runningAssignment, ticketOutcome } from 'js-superagent/core';

const repo = new MemoryRepositories();
const candidates = [];
const launches = [];
const deliveries = [];
const receipts = new Map();
const policy = {
  version: 'local-demo-v1', paused: false, evalTimeoutMs: 60_000,
  gate: trigger => trigger.human && trigger.actor.source === 'local' && trigger.actor.id === 'operator'
    ? { admissible: true, strength: 'explicit', basis: { via: 'listed', sender: 'operator' } }
    : { admissible: false, reason: 'not-authorized' },
  revalidate: mandate => mandate.actor.source === 'local' && mandate.actor.id === 'operator',
  admitsInferred: () => false,
};
const engine = new Engine({
  repo, policy: () => policy,
  scope: { scope: input => input.source === 'local' ? { listened: true, observed: false } : { listened: false, reason: 'not-local' } },
  assessor: { request: candidate => candidates.push(candidate) },
  executor: {
    start: (ticket, assignment) => launches.push([ticket.id, assignment.id]),
    deliver: (ticket, assignment) => deliveries.push([ticket.id, assignment.id, [...ticket.undelivered]]),
    stop: () => {},
  },
  outbox: {
    send: message => { if (!receipts.has(message.id)) receipts.set(message.id, 'pending'); },
    status: id => receipts.get(id),
    withdraw: id => receipts.set(id, 'dropped'),
  },
});
engine.receive({
  id: 'demo-request', source: 'local', threads: [{ source: 'local', id: 'demo-thread' }],
  actor: { source: 'local', id: 'operator' }, human: true,
  at: new Date().toISOString(), text: 'Demonstrate the extracted domain lifecycle.', meta: {},
});
engine.evaluateDue();
const candidate = candidates.shift();
const decision = engine.decide('demo-request', {
  evalId: candidate.evalId, kind: 'accept', title: 'Core demonstration',
  scope: 'In-memory state transitions only', reason: 'Explicit local request',
});
for (const [id, assignmentId] of launches.splice(0)) engine.assignmentStarted(id, assignmentId);
for (const [id, assignmentId, inputs] of deliveries.splice(0)) {
  engine.inputsDelivered(id, assignmentId, inputs);
  engine.inputsRead(id, inputs);
}
const assignment = runningAssignment(repo.tickets.get(decision.ticketId));
engine.report(decision.ticketId, { state: 'ready', summary: 'Protocol demonstration complete; no AI work performed.' });
const ticket = repo.tickets.get(decision.ticketId);
console.log(JSON.stringify({ status: ticketOutcome(ticket), ticketId: ticket.id, assignmentId: assignment.id, mandate: ticket.mandate.scope }, null, 2));

# Host facts and coordinator context

The host runtime accepts bounded operational facts from a trusted local integration. The integration remains the owner of its task definitions, deadlines, reviews and settlement. These records are persisted query copies: publication cannot create a ticket, notify anyone, grant material access, inject Worker input, or execute a business transition. The DSH domain, scheduler and retry policy remain unchanged.

## Local SDK

```js
const ticket = agent.submit({
  text: 'Inspect the fictional sample project',
  hostReference: { producer: 'example-scheduler', taskId: 'task-one', runId: 'run-one', kind: 'research' },
});
const identity = agent.getDetailed(ticket.id);
agent.publishHostFacts({
  scope: 'ticket', producer: 'example-scheduler', key: 'settlement',
  ticketId: ticket.id, domainId: identity.domainId, assignmentId: identity.assignmentId,
  sourceVersion: 'outcome-v1', observedAt: '2026-11-20T00:00:00.000Z',
  facts: { state: 'awaiting-review', resultCount: 2 },
});
```

`hostFactsCapabilities()` returns `{version:1}`. `listHostFacts({scope?,producer?,ticketId?})` returns complete local records, including historical generations. No Worker tool or remote write endpoint exposes these methods.

Project records use `scope:'project'` and omit ticket/domain/assignment IDs. Publish sanitized state, times, identities and counts; do not put credentials, chat transcripts, material bodies or executable instructions into project records. Project records have no ticket material grant: they are shown only to the authenticated local operator or the configured Feishu operator's verified private conversation. External follow-ups receive no project facts, including through the reader, and cannot reuse the operator's fact-bearing native session.

A record is identified by project, scope, producer, key and, for a ticket, the explicit domain/assignment tuple. IDs and `sourceVersion` are bounded identifier strings. Facts are a JSON object, at most 8192 UTF-8 bytes, depth 8, with bounded fields, arrays and strings. `observedAt` is a canonical ISO timestamp from the business source. It is not evidence that the integration just inspected external state.

The result is `{status:'stored'|'unchanged'|'stale',record}`. The same `sourceVersion` and normalized facts are unchanged even if a publisher supplies a newer observation time: no clock write, transaction, watcher wake-up or proof refresh occurs. An older observation cannot overwrite different newer facts; equal-time differing content raises `HOST_FACTS_CONFLICT`. Real updates revalidate identity and commit atomically. Publishers must retain source times and versions rather than sampling a new time on every reconciliation.

## Identity and historical evidence

`submit({hostReference})` atomically records the integration's four-field reference with the accepted domain and assignment. `getDetailed()` exposes current `domainId` / `assignmentId`, original `hostReferenceDomainId` / `hostReferenceAssignmentId`, and the original `hostReference`. A reference proves its original association, never current execution authority.

`initialDomainId` / `initialAssignmentId` are a matched original tuple. For older records the host uses retained public-domain associations and the earliest unambiguous saved domain whose creation time matches the original public ticket; it returns null if evidence cannot establish the original identity. The assignment is taken from that original domain, never from the current replacement. No historical record is rewritten to manufacture provenance.

Facts require a domain known to belong to the public ticket and an assignment retained in that domain. An omitted assignment is accepted only for a domain with exactly one assignment; after retry, ambiguous publication fails with `HOST_DOMAIN_CHANGED`. Publishing the same old record after a retry remains attached to its old tuple, even when its payload changes. Historical facts are explicitly labeled and never become the replacement execution's outcome. Current identity, report time, execution observation and fact observation time remain distinct.

Ticket facts capture the ticket's material dependencies at publication. Coordinator projection rechecks destination authorization and freshness for inline cards, search and record expansion. Stale bodies are replaced with metadata; historical records without captured material evidence do not acquire current material authority. Revoked grants still prevent disclosure. Local `listHostFacts()` is a trusted administration API, not the coordinator's projection.

## Cancellation provenance

```js
agent.cancel(ticket.id, {
  source: 'example-scheduler', reason: 'execution_timeout',
  expectedDomainId: identity.domainId, expectedAssignmentId: identity.assignmentId,
  reference: { taskId: 'task-one', runId: 'run-one' },
});
```

The Engine still records its existing human/stopped authorization category. `getDetailed().cancellation` separately records source, reason, saved time, domain/assignment, optional reference and authenticated actor. A local SDK call defaults to source `local` and unknown actor (`null`); caller-provided actor fields are rejected. Authenticated coordinator and GitHub stops retain their real actor/event evidence. `ended.by='human'` does not prove that a named human clicked cancel. Domain/assignment guards reject stale integration stops before changing the mandate. Historical cancellations are preserved without inventing new provenance or attaching them to a replacement domain.

## Bounded coordination and failure receipts

The initial context prioritizes the event's target, then running/queued/waiting work, with deterministic saved-time ordering. It includes `createdAt`, `updatedAt`, `reportAt`, current execution identity and observation times, original host reference, cancellation provenance, and bounded facts. `omittedTickets`, `omittedActiveTickets`, `omittedHostFacts` and `omittedProjectFacts` describe what was left out. The existing bounded reader supports `resource:'project'` as well as ticket search/expansion with versioned cursors. It gains no arbitrary filesystem or network access. Context hashes use saved facts, never a sampled current time.

A newly processed authenticated operator event that finally fails or is unsupported queues one fixed, content-free receipt in the existing Outbox. It identifies the failed event/generation internally and rechecks original actor, route, status and generation before delivery. A retried event or changed operator route withdraws a pending receipt; a previously sent receipt remains auditable. Pending automatic attempts, background reports, paused/stopping processing and already historical failures produce no new receipt. This adds neither an automatic retry nor a replay pass. It does not claim that existing work or earlier results were undone.

Regression coverage: `test/host-facts.test.mjs`, `test/material-projection-safety.test.mjs`, existing work-event, ended-ticket and material authorization tests. Fixtures contain fictional projects and identities only.

# Recovering a Worker that ends without a report

An execution engine ending its turn does not prove that the Worker produced a usable report. A model may finish after returning only a reasoning block. Earlier versions rejected that result, but recovery attempted to parse the empty text as JSON and incorrectly described the failure as unavailable native history.

## Failure classification

The DSH adapter distinguishes an incomplete native turn, a completed turn without visible final text, and an invalid structured report. Earlier progress text and reasoning are never promoted to a final report. Tool calls without visible text are normal intermediate responses and must continue through the native loop.

Native history inspection checks the session binding, run identity, tool and job settlement, and input ownership before considering continuation. Missing or unreadable history remains an inspection failure. A readable completed session with no report is a separate condition.

## Continuing the original work

Recovery retains the public ticket and native session. It adds a continuation instruction using the settled history, rather than replaying the original request. Existing input consumption receipts remain authoritative. The Worker must inspect prior results and continue unfinished work without repeating completed external actions.

Automatic recovery remains controlled by the existing recovery policy. A missing or invalid final report receives at most one automatic repair attempt in a recovery chain. Repeated failure remains visible and requires an explicit decision. Unresolved tools, background jobs, input delivery, pending delivery results or changed authorization block recovery until reconciled.

## Recovery from operator conversations

`retryRequest` recovers an original request that has not yet become a ticket. `retryTicket` recovers an existing failed or interrupted ticket. The latter references the host-provided ticket ID and recovery version; the host revalidates current authority and state before accepting it.

A status question does not trigger recovery. Repeated instructions cannot launch overlapping work. A recovery acknowledgement reports what the host actually accepted; a later blocked inspection must also produce a truthful outcome. Recovery and final results return through the existing operator conversation without creating a replacement ticket.

## Verification scope

Regression tests cover reasoning-only completion after successful tools, invalid report text, consumed inputs, unsettled work, bounded automatic repair, stale versions, duplicate messages and authenticated conversation routing. A real recovery acceptance must additionally verify the original ticket ID, native session ID, resumed run and delivered result. A simulated channel or isolated model response alone is not evidence of a complete live messaging flow.

With a supported DSH executable installed, run `DSH_EXECUTABLE=/absolute/path/to/dsh node --import ./test/helpers/state-home.mjs test/dsh-native-final-report.mjs` for native-process acceptance against a local mock provider. It verifies one completed tool action followed by a missing report, same-session recovery and no repeated action. It does not contact a hosted model or messaging service.

# Worker inputs and host failure notices

The domain Engine still owns tickets, assignments, inputs, reports and attention. The host assembles bounded context, verifies consumption and delivers authorized messages. Harness adapters transport that shared view; they do not decide whether an unread input may be ignored. The imported prototype Engine and native DSH consumption protocol are unchanged.

## Required input text

After uncertain-input reconciliation, the host projects the original triggers of the current execution's inputs into the same view used by the initial context pack and read tools. An input's routing note is not its original text. Existing message IDs, values and ordering remain stable; missing original messages are appended once, by trigger identity. This is an in-memory projection, not a second persisted message history.

The initial pack prefers current required inputs within the existing message count and byte limits. Coverage distinguishes complete, truncated and unavailable text; existing read references allow the Worker to retrieve the rest. Listing a reference or reading a summary does not consume the original input. Only complete, version-matched delivery or a complete read counts. Native queued inputs remain under their existing session/run/message adoption proof.

## A host rejection is not a model result

If required input remains unread at final verification, the host preserves a blocked report and the original unread input, with `code: WORKER_INPUT_UNREAD`, `origin: host-context-unread` and `requiresInspection: true`. The diagnostic keeps a bounded list of original input IDs and a total count. It does not claim budget exhaustion without evidence.

This failure is neither a business question nor a native process failure. It does not create attention, schedule recovery, invoke a Coordinator model round or relax the Engine's result gate. A model-written error code or ordinary blocked/failed report cannot authorize this path.

## One fixed notice to the original conversation

The host commits the fault, report, notice proof, receipt and delivery effect atomically. The notice contains a fixed explanation and public ticket ID, never rejected model text, project material or the supplementary input. Its proof binds the ticket, domain, assignment, run, original trigger, route identity, template and digests. The latest supplement cannot move the notification to another conversation.

Before sending, the host rechecks the current fault, assignment, original route and mandate, including Feishu application, bot and tenant identity. This narrow host-template proof allows a content-free status even when project material has changed; it does not exempt ordinary `notice` messages from material authorization. Source deletion, identity changes, human cancellation and proof tampering block delivery without a recursive fallback notice.

The existing Outbox and channel deduplication remain responsible for transport. A stable local receipt prevents duplicate enqueueing of the same failure. This does not promise exactly-once external side effects under every network failure.

An obsolete notice is withdrawn only when no send was started. An in-flight or response-lost send remains an auditable unknown outcome; stopping its future sends does not recall a remote message. That uncertain old notice cannot indefinitely hold the recovered ticket's later authorized result. Accepted remote receipts remain recorded.

## Recovery and deployment

No configuration, budget, retry count, schema or history cursor changes. Older blocked reports are not rewritten or backfilled with notices. Inspect the original input, session, process ownership, workspace and pending effects, then use the existing explicit local `retry <ticket>` entry point once when authorized. Do not reevaluate a candidate that already has a ticket, replace its session or create a substitute task.

Source tests, registry publication and deployment are separate facts. Release through the repository's GitHub trusted publishing workflow, install the exact verified package, retain a consistent stopped-state backup, and validate the real source channel. The implementation and acceptance matrix are recorded in [the plan](worker-input-and-host-failure-notice-plan.md).

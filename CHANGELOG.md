# Changelog

## Unreleased

- Persist bounded host project/ticket query facts and atomic original task references; retain explicit domain/assignment identity, saved times, semantic no-op publication and historical generations.
- Prioritize active coordinator work and provide permission-safe, freshness-aware facts through the existing bounded reader. Keep project facts and native sessions restricted to authenticated operators.
- Preserve cancellation source, reason and authenticated actor separately from the unchanged DSH human/stopped category; reject stale domain/assignment stops.
- Queue one fixed Outbox receipt for newly terminal operator coordination failures, with route/generation revalidation. Preserve retry policies and historical records; no new work, Worker input or replay is introduced.
- Add identity, no-write, active-work visibility, material freshness, route withdrawal and failed-event regressions. See [host context](docs/host-context.md).

## 0.15.0-alpha.15 — 2026-11-16

- Record stable machine, boot-session and PID-namespace identity for service processes, machine leases and maintenance owners; hostname changes and prior-boot PID reuse no longer strand v2 owners.
- Share the identity inspector between service control and independent wrapper startup; preserve live/unknown owner protection and conservative legacy receipt handling.
- Add rename/reboot, foreign-machine, unavailable-probe, PID reuse, lease reclamation and actual wrapper/child lifecycle regression coverage. See [process identity](docs/process-identity.md) for upgrade and legacy boundaries.

## 0.15.0-alpha.14 — 2026-11-16

- Describe a material-protected message withdrawal without claiming that the ticket failed, its final result was not delivered, or a new investigation is required.
- Keep exact legacy notice text verifiable with its retained digest, preserving queued messages, receipt identities and restart deduplication. New notices use the corrected fixed text.
- Preserve material authorization and freshness checks, Engine behavior, delivery rules, configuration, budgets and retry counts.

## 0.15.0-alpha.13 — Released 2026-11-16

- Project the original text of current execution inputs into one shared bounded Worker view, including inputs attached or fanned out before launch. Preserve record identities, require version-matched full consumption, and keep native pending-input adoption separate.
- Prioritize required current inputs inside the existing context limits and expose complete, truncated and missing coverage with the existing read references. No configuration, budget or retry limit is added.
- Record the host-verified `WORKER_INPUT_UNREAD` / `host-context-unread` failure without falsely attributing it to budget exhaustion. Keep the blocked report and original unread inputs; do not invoke business coordination or native automatic recovery.
- Atomically retain a fixed, content-free host failure notice for the original authorized route. Validate run, assignment, fault, template and channel identity before sending; use existing Outbox delivery and deduplication. Ordinary model reports and historical failures do not qualify.
- Withdraw superseded notices only before a proven first send. Preserve uncertain or accepted remote delivery facts, and prevent an uncertain superseded notice from blocking a later authorized result. No notice creates attention, a new task or an automatic retry.

## 0.15.0-alpha.12 — Released 2026-11-15

- Scope running assessment invalidation to the context actually exposed, while retaining conservative native-session isolation and source authorization.
- Distinguish a material binding from disclosed material body content so normal worker reads do not invalidate metadata-only routing cards.
- Freeze exposed material proofs and preserve bounded invalidation evidence when the existing two-refresh allowance is exhausted.
- Preserve candidate target checks, Engine ownership, Feishu intake, Worker execution and original-request recovery; no new configuration or retry counts.

Details: [Assessment context boundaries](docs/assessment-context-boundaries.md).

## 0.15.0-alpha.11 — Released 2026-11-15

- Align candidate context references with the host-authorized record view so enabling material protection does not advertise unreadable thread records.
- Preserve the original operator request while providing bounded, source-bound conversation context for routing; keep material provenance, freshness and destination checks.
- Distinguish unavailable assessment context from actual material authorization refusal, retaining original request recovery and durable receipts.
- Preserve prototype domain ownership, Worker execution, material grants and longrun settlement boundaries; no new access settings or automatic replay of historical failures.

Details: [Assessment context boundaries](docs/assessment-context-boundaries.md).

## 0.15.0-alpha.10 — Released 2026-11-14

- Retain bounded Feishu read failure reasons, allowlisted transport codes, HTTP status, failure stage, elapsed time and timestamp without retaining credentials or message content.
- Distinguish read deadlines from stop/caller cancellation even when the official SDK reports a generic cancellation; retain the original error and dispatched-write lifecycle.
- Carry safe diagnostics through persisted source state, business health and bounded service summaries; distinguish known local validation errors from network/API failures.
- Preserve cursor recovery, admission, ordering, deduplication, timeouts, request budgets and retry counts. No new configuration or performance changes.

Details: [Feishu history diagnostics](docs/feishu-history-diagnostics.md).

## 0.15.0-alpha.9 — Released 2026-11-13

- Classify host-confirmed changes to an authorized candidate ticket snapshot separately from missing targets, revoked authority, changed routes and input ownership conflicts.
- Recheck hard refusals before material invalidation and before consuming the existing two-refresh allowance; preserve the original evaluation deadline, input and fresh assessment sessions.
- Retain bounded target/version diagnostics across native callback error copying, and keep exhausted requests available for explicit recovery without replaying historical failures.
- Preserve the prototype domain, Feishu admission and worker ownership rules. No configuration, retry-count or material-access changes.

## 0.15.0-alpha.8 — Released 2026-11-13

- Add GitHub Actions trusted npm publishing with an isolated publishing job and no stored npm token.
- Publish the exact package validated on macOS, checking its source commit and integrity; safely verify repeated runs without republishing an existing version.
- Keep publication explicit and limited to main. No runtime, skill or project configuration changes.

## 0.15.0-alpha.7 — Released 2026-11-13

- Retain attempt-local evidence of host context invalidation across assessor callback error redaction, so a copied error still follows the existing bounded refresh path.
- Discard an assessor result after a trusted callback invalidation even when the assessor catches the callback error; keep authority, ownership, deadline and other host refusals ahead of refresh.
- Preserve original failed requests for explicit recovery. Do not replay old failures, change driver error redaction or add configuration.

## 0.15.0-alpha.6 — Released 2026-11-13

- Retain authorized human Feishu topic supplements before ticket creation in the existing pending/evaluation flow, without granting independent work authority or replaying previously filtered messages.
- Permit the existing single-input ignore command to close an unadmitted batch input without borrowing the batch's authority or altering worker ownership.
- Refresh host-verified stale assessment snapshots at most twice per original request, retaining the evaluation deadline and durable allowance across restarts. Recheck authority, isolate model sessions and report exhaustion only for the affected original request.
- Cancel Feishu history/context reads at the actual SDK transport, fence late connection callbacks during shutdown, and retain in-flight write receipts.
- Confirm both owned service processes have exited before reporting a stop or allowing replacement; do not kill unknown processes or force-stop active work.

Scope, invariants and acceptance: [Feishu continuity and reliability plan](docs/feishu-continuity-reliability-plan.md).

## 0.15.0-alpha.5 — Released 2026-11-13

- Recover configured Feishu group messages and active/subscribed topic replies through bounded, resumable history scans, preserving admission rules and existing ticket associations.
- Validate returned message/container identities, retain platform thread routing metadata, and deduplicate live and historical intake transactionally.
- Make public business-health queries read-only; let the running owner persist observations and report connection/history failures separately without masking failed groups behind successful private-chat scans.
- Preserve actionable platform error codes and verify migration, pagination, partial failure, offline recovery, and diagnostic-read invariants.

Implementation and deployment acceptance: [Feishu history recovery](docs/feishu-history-recovery.md).

## 0.14.0-alpha.4 — Released 2026-11-11

- Distinguish a completed DSH turn with no final report from an incomplete turn or an invalid report, preserving the original native evidence.
- Recover settled native sessions without replaying consumed inputs or completed tools; keep final-report repair bounded by the existing recovery policy.
- Let authenticated operator conversations request recovery of an existing failed ticket, with current-state validation and durable outcome receipts.
- Cover missing reports after tool execution, recovery limits, stale state, duplicate instructions and conversation-based ticket recovery.

Published with the alpha tag from `50a70419904e9ea8c6fa8bd1141fd637e9594743`; registry integrity and clean consumer verification passed.

## 0.14.0-alpha.3 — Released 2026-11-11

- Let authenticated operator conversations recover original failed requests through a scoped retryRequest action.
- Expose current recovery eligibility and bounded lookup for older requests; preserve authorization and original request identity.
- Return durable acknowledgements for recovery, pending work, existing tickets and blocked requests without duplicate admissions.
- Cover conversation recovery, replay, stale state, current authority and request lookup in regression tests.

Published to npm with the alpha tag from `4108e81e817479c6c6276ab60b7e902ca74ffb3b`; registry integrity and clean consumer verification passed.

## 0.14.0-alpha.2 — Released 2026-11-10

- Make per-action candidate assessment constraints explicit in the model contract and runtime validation.
- Correct malformed assessment output within a bounded budget, without retrying authorization or ownership failures.
- Preserve failed assessment diagnostics and original request identity for safe recovery; expose request outcomes to operator conversations.
- Add regression coverage for format correction, exhaustion, recovery, policy changes and duplicate prevention.

Published to npm on 2026-11-10 with the alpha tag from commit `923a1c09761b46f785ba4faf06877cf6cd2bfdde`; registry integrity matches the tested artifact.

## 0.14.0-alpha.1 — Released 2026-11-10

- Apply per-ticket `managedJobs: false` to the effective DSH execution configuration as well as runtime tool inputs.
- Keep execution and recovery capability settings consistent; allow retry of tickets that failed before a native session was created.
- Add regression coverage for disabled jobs, default-enabled jobs and recovery bindings.

Published to npm with the `alpha` tag; Git tag `v0.14.0-alpha.1` points to `88adf7ea6b2288af9cd162a82eab08a07f7c1cd9`. Registry integrity matches the tested artifact. The existing `latest` tag remains on alpha.0.

## 0.14.0-alpha.0 — First standalone npm release (2026-11-09)

- Persistent CLI/SDK agent runtime with isolated workspaces, task ownership and restart recovery.
- Registered Codex, DSH and Cursor execution adapters; optional GitHub and Feishu integrations.
- Structured human review, host snapshots and cross-process state change observation.
- Per-ticket controls for managed jobs and operator notifications.
- Standalone repository, MIT license, release metadata checks and reproducible package preparation.

Earlier version numbers reflect development inside x-pkm-research, not npm releases. Published to npm under the `alpha` dist-tag. Registry integrity and clean consumer CLI/SDK checks passed. Git tag: `v0.14.0-alpha.0`; source commit: `b176f5a073a467aa499189712cdb0a222674c98a`.

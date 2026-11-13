# Changelog

## 0.15.0-alpha.8 — Unreleased

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

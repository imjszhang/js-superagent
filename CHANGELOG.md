# Changelog

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

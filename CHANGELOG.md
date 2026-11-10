# Changelog

## 0.14.0-alpha.1 — Unreleased

- Apply per-ticket `managedJobs: false` to the effective DSH execution configuration as well as runtime tool inputs.
- Keep execution and recovery capability settings consistent; allow retry of tickets that failed before a native session was created.
- Add regression coverage for disabled jobs, default-enabled jobs and recovery bindings.

Local package preparation and deployment do not publish this version or move npm dist-tags.

## 0.14.0-alpha.0 — First standalone npm release (2026-11-09)

- Persistent CLI/SDK agent runtime with isolated workspaces, task ownership and restart recovery.
- Registered Codex, DSH and Cursor execution adapters; optional GitHub and Feishu integrations.
- Structured human review, host snapshots and cross-process state change observation.
- Per-ticket controls for managed jobs and operator notifications.
- Standalone repository, MIT license, release metadata checks and reproducible package preparation.

Earlier version numbers reflect development inside x-pkm-research, not npm releases. Published to npm under the `alpha` dist-tag. Registry integrity and clean consumer CLI/SDK checks passed. Git tag: `v0.14.0-alpha.0`; source commit: `b176f5a073a467aa499189712cdb0a222674c98a`.

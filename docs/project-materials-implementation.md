# Project materials implementation record

Implementation of [the reviewed plan](project-materials-execution-plan.md), authorized on 2026-11-11. Candidate versions: js-superagent `0.15.0-alpha.0`, js-longrun `0.1.0-alpha.3`, js-superagent-skill `0.6.0`.

## Changes

- Existing scoped reads now support explicitly configured current project files, exact commits and immutable host snapshots. Source identity, reader and output destination grants are independently validated.
- DSH host-only execution disables native filesystem, search, shell and job tools. Ordinary native execution remains an explicitly different permission mode; this feature makes no operating-system sandbox claim.
- A Worker can request host preparation without changing its active directory. The host retains the original Ticket and Assignment, archives the old workspace/session/evidence, prepares a new material copy, and starts a fresh native session only after the old turn settles.
- Material copies retain their import baseline. Local application considers only Worker changes, checks current source conflicts, journals each write and supports explicit recovery. Longrun-owned outputs cannot be applied by superagent.
- Reports, resumed results, coordinator summaries, derived task inputs and outgoing messages retain material provenance. Current observations are checked again before use; an old tool-call receipt remains immutable.
- Longrun's opt-in frozen-material contract validates capability before consuming a round, preserves snapshot and output contract hashes, waits through preparation, and checks workspace lineage before its sole-writer settlement.
- The deployment skill recognizes exact package/schema combinations, keeps coordinator knowledge separate, and uses public SDK/CLI configuration for material grants.

## Validation in progress

Targeted tests currently cover current/uncommitted reads, fixed commit/snapshot reads, scoped cross-project reads, pagination and directory freshness, output authorization, same-Assignment preparation, preserved unresolved inputs, controlled application and explicit rollback after revocation. Separate processes are killed during local application and between workspace publication and activation to verify recovery from durable journals.

The final release record must append the complete regression results, exact package/commit identities and real-provider acceptance evidence. A passing service health check is not business acceptance. No release or target-project switch is claimed by this document until those results are recorded.

## Compatibility and limits

Existing schema 14 projects retain their old behavior until explicit material configuration or `upgrade` moves the stopped project to schema 15. Upgrade keeps one pre-upgrade backup; preopened old writers refuse schema 15. Relocation preserves the source schema and minimum writer version.

Current-input editing uses material copies. Dirty overlays into worktrees and automatic copy-to-PR conversion are not supported. Material-derived automatic draft PR creation is refused because the new output destination has not been explicitly granted. Cross-project sources are for authorized reading; one task does not mutate several source projects. Preparation refuses an in-place predecessor without an isolated baseline or any unresolved changes, jobs, deliveries or input consumption.

An interrupted local application owns its source until explicitly finished or rolled back. A lost runtime acknowledgement does not hide the disk journal. Operator rollback after cancellation or grant removal can undo only that journal's own unchanged writes; it neither restarts the Worker nor restores execution authority.

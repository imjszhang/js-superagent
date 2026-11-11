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

## Validation

Tests cover current/uncommitted reads, fixed commit/snapshot reads, scoped cross-project reads, pagination and directory freshness, output authorization, concrete channel identity changes, same-Assignment preparation, preserved unresolved inputs, controlled application and explicit rollback after revocation. Separate processes are killed during local application and between workspace publication and activation to verify recovery from durable journals. Application tests distinguish preflight freshness from the journal's per-file baseline so multiple writes and exact-operation replay do not invalidate themselves.

The first complete regression run passed 1,342 runtime tests, 153 core tests and the same 153 tests against SQLite, plus type checking and clean-package installation. Subsequent boundary fixes add focused regression cases and require the final CI run to pass before release. Longrun passed 89 tests plus the explicit candidate SDK integration; the skill passed its old-package suite and the new-package knowledge/material compatibility checks.

Real DSH acceptance on the frozen package from commit `39b413eebf924647b70e89318ad65a1151a6f409` passed all five scenarios: current dirty reads, fixed commit/snapshot reads, same-Assignment workspace preparation, verified Worker-only local application, and explicitly authorized cross-project reads. The archive SHA-256 was `f73ceec053ed705f7db51b7a300fa2cc0fc3deb9db8d57ff1990e95df8073ae9`. These are candidate results, not evidence that the final package has already been published.

The release procedure repeats this acceptance against the final frozen archive, records its source commit and integrity, checks the registry download, and retains private target-project/Feishu evidence in that project's deployment record. Public examples and tests use fictional fixtures. A passing service health check is not business acceptance; neither publication nor target-project switching is claimed by this source document.

## Alpha.1 pagination correction

The wider deployment acceptance uncovered a directory case absent from the initial small fixtures: the body was paginated but every response repeated all child references. Large directories could therefore exceed the existing tool envelope reservation and be reported as unavailable, even though the host had observed the directory. Reducing the requested body page did not solve the repeated reference overhead.

The `0.15.0-alpha.1` correction pages the child references with the body, measures the complete escaped response, and keeps source-version and shared-budget checks intact. Large-directory, escaped-text, continuation and restored-provider tests exercise the real tool bridge. The real-provider current-input fixture now also requires traversal of a large directory. Earlier candidate results remain historical evidence; deployment acceptance must be rerun with the corrected package. Schema 15, existing grants, fixed snapshots, workspaces and historical receipts remain unchanged.

## Compatibility and limits

Existing schema 14 projects retain their old behavior until explicit material configuration or `upgrade` moves the stopped project to schema 15. Upgrade keeps one pre-upgrade backup; preopened old writers refuse schema 15. Relocation preserves the source schema and minimum writer version.

Current-input editing uses material copies. Dirty overlays into worktrees and automatic copy-to-PR conversion are not supported. Material-derived automatic draft PR creation is refused because the new output destination has not been explicitly granted. Cross-project sources are for authorized reading; one task does not mutate several source projects. Preparation refuses an in-place predecessor without an isolated baseline or any unresolved changes, jobs, deliveries or input consumption.

An interrupted local application owns its source until explicitly finished or rolled back. A lost runtime acknowledgement does not hide the disk journal. Operator rollback after cancellation or grant removal can undo only that journal's own unchanged writes; it neither restarts the Worker nor restores execution authority.

# Project materials implementation record

Implementation of [the reviewed plan](project-materials-execution-plan.md), authorized on 2026-11-11. M0–M9 are complete. The final source, published package, registry download, isolated DSH validation and target-project technical acceptance have each passed their recorded checks. Business-report interpretation remains subject to review.

| Component | Version | Release source |
| --- | --- | --- |
| js-superagent | `0.15.0-alpha.3` | `21351c9f3719835f86de73198c9c638ed5b18e64`, tag `v0.15.0-alpha.3` |
| js-longrun | `0.1.0-alpha.3` | `c655fe63e6996057d69e2165f35586c7ab74183c`, tag `v0.1.0-alpha.3` |
| js-superagent-skill | `0.6.3` | `d45f4410d786cdf6c0ea34b37f2545856a0d8d83`, tag `v0.6.3` |

The skill is delivered through Git, not npm. The core alpha.3 change commit is `edba2b64c3b5802cbb861d720a659a7fc39da9e1`; its release merge and tag identify the source above.

## Changes

- Existing scoped reads support explicitly configured current project files, exact commits and immutable host snapshots. Source identity, reader and output destination grants are independently validated.
- DSH host-only execution disables native filesystem, search, shell and job tools. Ordinary native execution remains a different permission mode; this feature makes no operating-system sandbox claim.
- A Worker can request host preparation without changing its active directory. The host retains the original Ticket and Assignment, archives the old workspace/session/evidence, prepares a new material copy, and starts a fresh native session only after the old turn settles.
- Material copies retain their import baseline. Local application considers only Worker changes, checks current source conflicts, journals each write and supports explicit recovery. Longrun-owned outputs cannot be applied by superagent.
- Reports, resumed results, coordinator summaries, derived task inputs and outgoing messages retain material provenance. Current observations are checked again before use; an old tool-call receipt remains immutable.
- Longrun's opt-in frozen-material contract validates capability before consuming a round, preserves snapshot and output contract hashes, waits through preparation, and checks workspace lineage before its sole-writer settlement.
- The deployment skill recognizes exact package/schema combinations, keeps coordinator knowledge separate, and uses public SDK/CLI configuration for material grants.

## Validation and package identity

Final alpha.3 CI passed 1,391 runtime tests, 153 core tests and the same 153 tests against SQLite, together with type checking, release preparation and clean-package checks. Longrun's implementation passed 89 tests plus candidate SDK integration. The exact alpha.3 candidate combination passed 27 skill tests, 10 installed-consumer tests and the installed longrun frozen-material integration, with one core installation.

Tests cover current/uncommitted reads, fixed commit/snapshot reads, scoped cross-project reads, pagination and directory freshness, output authorization, concrete channel identity changes, same-Assignment preparation, preserved unresolved inputs, controlled application and explicit rollback after revocation. Separate processes are killed during local application and between workspace publication and activation to verify recovery from durable journals. Application tests distinguish preflight freshness from the journal's per-file baseline so multiple writes and exact-operation replay do not invalidate themselves.

The final `js-superagent-0.15.0-alpha.3.tgz` archive has SHA-256 `fdc0a761ebddcd86250bb1c80bfe83b0e719c4dd10cb6e8beddbd0d229ea5751` and npm integrity `sha512-RPRIk2T/+EzeRvvBSpjRWdkgNVC2dgntMEUrkV1owGwPBqkio+lrvfoBICauNXZev7cUiRebU8so16xkbiDm5w==`. Packaging the release merge reproduced the same archive used for candidate validation; the real-run attestation names the change commit, while the final package manifest names the release merge.

Real DSH validation against that frozen archive passed all five scenarios: current dirty reads through a 320-entry directory, fixed commit/snapshot reads, same-Assignment workspace preparation, verified Worker-only local application, and explicitly authorized cross-project reads. These are isolated fictional-fixture results, not evidence of unrestricted access or universal model reliability.

The first alpha.3 real-model attempt did not pass: the model copied a directory continuation version incorrectly and repeated invalid calls until the existing 180-second deadline. The host rejected malformed or mismatching references; the retained observations did not establish a directory change or a stalled tool bridge. A separate rerun of the unchanged archive passed all five scenarios. Both attempts remain in the acceptance evidence. No package change, deadline extension or relaxed version check was used to turn the first failure into success.

Earlier alpha.0 candidate validation remains historical evidence. Its first full regression run passed 1,342 runtime tests and the two 153-test core suites; its five-scenario real DSH result belongs to its own candidate archive, not to the final alpha.3 package.

Public examples and tests use fictional fixtures. Private target-project and Feishu evidence remains in that project's deployment record. Publication, registry download, service health, transport delivery and business-report accuracy are distinct checks; passing one does not establish the others.

## Release and target acceptance

The alpha.3 npm release is published. Its registry download matches the archive SHA-256 and integrity above. A clean registry-installed consumer passed the 10 skill checks and the longrun frozen-material integration with a single core installation.

The target project was updated to the exact core and skill versions above and its service passed health checks. A previously failed Feishu correction event was manually requeued through the public `retryCoordination` maintenance API. It then completed with an operator reply only; all four existing tickets and their run identities remained unchanged. This was explicit operator recovery, not automatic recovery or a Feishu-triggered retry.

A separate new-ticket Feishu check passed the complete path: the fixed acceptance receipt was received, an in-turn `js_superagent_report` returned `accepted: true`, the final report reached ready/completed, and the completion result was received in Feishu. Authorized current-file bodies and SHA-256 values matched the source, including uncommitted content; all 15 successful material reads, covering eight distinct records, remained fresh. The check preserved existing business files and did not create long-running tasks.

These results establish the observed technical path, not blanket semantic accuracy. For example, a model report labeled byte counts as character counts; such wording needs a conversational correction, not another execution or a rewrite of the historical report.

## Alpha.1 pagination correction

Deployment acceptance uncovered a directory case absent from the initial small fixtures: the body was paginated but every response repeated all child references. Large directories could therefore exceed the tool envelope reservation and be reported as unavailable, even though the host had observed the directory. Reducing the requested body page did not solve the repeated reference overhead.

The `0.15.0-alpha.1` correction pages child references with the body, measures the complete escaped response, and keeps source-version and shared-budget checks intact. Large-directory, escaped-text, continuation and restored-provider tests exercise the real tool bridge. Final alpha.3 real validation includes large-directory traversal. Schema 15, existing grants, fixed snapshots, workspaces and historical receipts remain unchanged.

## Alpha.2 material freshness correction

Authorization to disclose material-derived information is separate from the freshness required to reuse its body. An authorized but stale ticket remains discoverable through host-generated metadata; its old scope, report, attention and raw history do not enter a new coordinator context. The same projection applies to bounded record reads, searches, recent events and request cards. Freshness transitions change the native session identity so an earlier body cannot re-enter through resumed history.

Body provenance retains its original observation identity. Rereading the same source ticket cannot refresh an older event, inherited note or queued body. A new run's observations do not attest its previous report. Missing or conflicting body identities are handled conservatively.

Projected metadata retains all disclosure dependencies. Output checks still revalidate grants, concrete recipients and settings; only exposed bodies require current-file freshness. Compatibility fields preserve all source dependencies for older proof readers. Existing withdrawn messages are not rewritten to remove dependencies; subsequent replies are generated from newly checked context.

## Alpha.3 receipt and conversation corrections

A fixed assessment receipt could be withdrawn when its new ticket acquired a run identity. Fixed acceptance and attachment receipts now retain their complete disclosure and destination checks while using a host-verified status template instead of a material-body observation stamp. The proof binds the original assessment, trigger, ticket and full message. Edited or forged receipts receive no exemption; reports still require their original material versions.

A correction or status explanation about an ended ticket must use an operator reply. Proposals to append a note, request execution status, answer or stop that ended ticket are rejected against supplied context before commit. Recognized output-shape and action-contract errors can be corrected at most twice within the same deadline and read allowance. This does not guarantee correction of every invalid JSON response from an adapter. Changed authority, context versions and host-read failures are not converted into correction retries; actions still commit together after live authorization checks. A conversational correction does not rewrite the historical report.

DSH records initial context delivery after both the prompt receipt and matching native user-message event, before an in-turn business report may answer that message. Startup without confirmed delivery does not mark input consumed, and repeated events do not duplicate its delivery receipt. Final-report validation and business-report agreement remain unchanged.

## Compatibility and limits

Schema 14 projects retain their old behavior until an explicit supported upgrade/configuration operation moves the stopped project to schema 15. Upgrade preserves a pre-upgrade backup; schema 14 writers refuse schema 15. Relocation preserves the source schema and minimum writer version. Alpha.0 through alpha.3 share schema 15: the schema number and minimum-version metadata alone do not guarantee that an earlier writer enforces the later corrections. Use the exact tested package combination and assess rollback from durable receipts and backups rather than treating equal schema numbers as downgrade approval.

Current-input editing uses material copies. Dirty overlays into worktrees and automatic copy-to-PR conversion are unsupported. Material-derived automatic draft PR creation is refused because its new output destination has not been explicitly granted. Cross-project sources are for authorized reading; one task does not mutate several source projects. Preparation refuses an in-place predecessor without an isolated baseline or any unresolved changes, jobs, deliveries or input consumption.

An interrupted local application owns its source until explicitly finished or rolled back. A lost runtime acknowledgement does not hide the disk journal. Operator rollback after cancellation or grant removal can undo only that journal's own unchanged writes; it neither restarts the Worker nor restores execution authority.

Host checks prove authorization, observed versions and recorded execution/delivery facts. They do not prove that a model used every relevant source or interpreted a business document correctly. Reports remain limited to their stated observation window and coverage; semantic conclusions require review. The first real-model pagination failure demonstrates that valid tooling and bounded recovery do not guarantee every model attempt succeeds.

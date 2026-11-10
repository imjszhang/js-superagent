# Candidate assessment recovery

An operator conversation and candidate admission are separate stages. A `request` action records a candidate; an accepted, authorized assessment creates its ticket. A completed conversation event alone does not prove admission or execution.

## Output contract and bounded repair

The per-action contract in `src/runtime/assessment.mjs` generates field guidance and portable JSON Schema descriptions and supplies the runtime field checks. For example, `accept` requires a title and scope and must not select `triggerId`; `attach`, `ignore`, `unavailable` and `answer` can select original input under their own ownership rules. Irrelevant envelope fields are null. Native-provider schemas retain a flat envelope for compatibility; host validation is authoritative.

Built-in assessors may correct malformed JSON or invalid field shape at most twice in a candidate evaluation. They receive the concrete validation error and original facts. No invalid proposal produces a host action. Corrections share the original time and context-read budgets. Explicit transient transport errors receive bounded delayed retries within that same deadline. Unknown failures, authentication errors, out-of-context references and authority failures are not repaired by broadening access or dropping fields.

The host rechecks evaluation identity, policy, ownership and context before applying a result. Replaying an already owned request cannot create a second ticket. No assessment output is made valid by silently removing fields.

## Inspect and recover

Use event diagnostics for the original trigger and coordination status for its originating operator conversation. Assessment failures retain structured failure information alongside the existing domain decision. This distinguishes a failed evaluator from a valid semantic `unavailable` result, and lets a later status response explain why a request has no ticket.

Before recovering, inspect the original trigger's decision, current ownership and failure reason. Fix non-transient causes first. Use the existing `reevaluate <trigger-id>` entry point to reconsider that original request under current policy; do not submit duplicate work or edit saved decisions. This does not bypass authorization or turn an incomplete result into success. No background retry runs indefinitely.

Operator request outcomes use the existing durable outbox and originating reply route. The receipt identifies an accepted ticket or explains a failure; actual Worker completion remains a separate result. Existing request receipts remain readable after upgrade. Public examples and regression fixtures use synthetic projects only.

## Recovery from an operator conversation

Starting with alpha.3, an authenticated operator can explicitly ask to retry or continue an existing failed request. The coordinator proposes `retryRequest` with the original `triggerId` and the host-supplied recovery version. It cannot rewrite the scope, replace the origin or submit a duplicate request to repair a failure. A status question only reads status; an ambiguous target requires clarification.

The host supplies current eligibility, a reason and a version for each visible request. Historical `retryable` metadata is diagnostic information, not an authorization grant. Conversation recovery is limited to format, transient transport and timeout failures; unknown/internal, authority and context failures require inspection rather than repeated retries. Older requests can be located through bounded request reads. Before mutation, the host checks current identity, permission, request state and ownership again. A pending/evaluating request is not queued twice, and an already accepted request returns its existing ticket. Stale observations cannot create duplicate admissions.

The recovery acknowledgment is committed through the existing durable outbox on the current operator entry. It reports queued recovery or an existing/blocked state, not Worker execution. The later assessment outcome follows the original request route. Retrying an event or restarting the service must not duplicate its action or acknowledgment. Upgrading does not automatically rerun historical failures.

## Upgrade

This change retains state schema 14 and the existing project identity, prompts, source connections and task data. Stop the managed service before replacing the installed package and restart through the project's configured wrapper. A wrapper that pins a verified package version must be checked against the new package before restarting. A prepared prerelease tarball is not evidence of npm publication.

# Assessment context boundaries

A request such as “add those approved entries to the catalogue” needs its original conversation to identify “those”. Reading that context is a routing operation, not permission to execute the work or access arbitrary project files.

## Problem and ownership

In earlier material-aware assessments, the host derived `availableRecords` from candidate relations while the guarded reader excluded shared thread/decision records. A model following an advertised thread reference could therefore encounter a refusal. The missing record was classified as `MATERIAL_ACCESS_DENIED`, producing a misleading instruction to change the requester's material grants. This could affect an ordinary request even without material defaults: history protection is active whenever material-bearing records may exist.

The fix belongs to js-superagent's host context assembly. It does not change the prototype Engine or make the semantic assessor an executor. The prototype's rules remain: the host enforces authorization, conversation context cannot grant authority, and advertised read references must have a corresponding scoped read path. See the imported baseline's [authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/002-authorization.md) and [read resources](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md).

## Boundaries retained

- The channel preserves the original sender, message and conversation identity. The coordinator proposes routing, and the host revalidates it.
- The assessed request remains the original text. Prior discussion explains references; it does not become a replacement user instruction or an expanded mandate.
- The host exposes bounded context through the same authorization view used for actual reads. It does not turn on unrestricted shared-record access or expose raw database rows, native model transcripts or hidden ticket relations.
- Operator conversation context is tied to the original request's source and chronology. Later messages do not silently change the meaning of an earlier request. Material-derived content retains disclosure and freshness checks; historical metadata is not current file evidence.
- Context references and reads remain versioned and bounded. Source changes, changed authority and stale material are not bypassed to complete an assessment.
- A Worker investigates current project facts and carries out accepted work within its mandate. An assessor's conversation read is not a current-file observation.
- Material grants still control explicitly selected project materials. Configuring entries without defaults does not convert all ordinary tasks to host-only execution.
- longrun remains responsible for its frozen rounds, review evidence and settlement. Skill instructions, lark-cli and execution adapters do not acquire a new authorization role.

New remote operator events and their replies retain source-route proofs in the existing metadata format, including when no project materials are configured. Older remote history without a verifiable route proof remains unavailable; an upgrade does not assign it the current account identity. No database schema migration is required.

Reply context requires a coordinator result produced no later than the original request and a current successful outbox receipt. Existing receipts do not record delivery timestamps: this proves prior authorship and eventual recorded delivery, not that the user had already received the reply when making the request. Such context never grants execution authority.

There is no new user permission switch. A real grant refusal still requires inspection of the applicable grant; missing or unavailable assessment context should not tell the operator to widen file access. If the required referent remains unavailable, retain that limitation instead of guessing or automatically accepting work.

## Verification and recovery

Regression coverage must exercise the actual bounded assessor's read proposal, not only a fake assessor returning accept. It covers reference/read consistency, bounded current-thread context, original operator context, missing facts, hidden/stale material, route and version changes, accurate failure receipts and reuse of the original trigger. Fixtures use synthetic projects and conversations only.

After upgrading, inspect the original failure and current ownership. Explicitly reevaluate the same trigger through the existing recovery entry point; do not send a duplicate request, edit old decisions or automatically replay all historical failures. Successful evaluation, ticket creation, Worker execution and result adoption are separate facts and must be verified separately.

Publication, deployment and real-channel acceptance are recorded separately from source tests. A passing isolated regression does not establish delivery of a real Feishu response or adoption of a project's business changes.

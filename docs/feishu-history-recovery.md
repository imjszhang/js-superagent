# Feishu history recovery and health reads

This change restores missed inputs through the existing source registry. It does not change admission, semantic assessment, domain thread identity, Worker execution, material authorization, or output destinations. No new project configuration options are introduced.

## Ownership and recovery contract

- The Feishu adapter reads only configured chats. It discovers active platform topics in those chats and receives the existing subscribed-topic set from the host. The adapter does not create tickets or grant authority.
- Platform message, parent, root, and thread identities remain distinct. Existing domain keys retain `tenant:chat:root`; platform thread IDs are supplementary routing metadata. Validate the actual returned chat and thread before normalization.
- Initial chat setup keeps its present-time baseline. Upgrade retains existing chat cursors. A separate, bounded discovery scan identifies recent roots without replaying old main messages or lowering the intake baseline. Existing subscriptions recover from the accepted origin message's platform timestamp, not its potentially delayed processing time; adding history support must not skip the disconnected interval.
- Chat scans use a fixed server-side time window. Feishu thread listing does not support time filters: use bounded pagination and locally enforce the fixed window. Descending scans retain a complete window before chronological intake; exceeding 500 buffered events or 1 MiB restarts the same window in ascending order. Keep continuation state after partial scans and failures, isolate failures, and share work fairly among containers.
- Live and historical copies use the same stable message identity and transactional source ingestion. Advancing a cursor cannot commit independently of receiving the corresponding inputs. Replies stay in their original chat/topic.
- Permissions are checked separately from intake policy. Reading group history requires the application's group-message scope; user OAuth is not a substitute. Broader platform visibility does not authorize ordinary unaddressed group messages as new work.

## Health ownership

Public health queries read the last persisted observation. Only the running owner records a new observation. SDK inspection, CLI queries, management views, and heartbeat publication cannot erase incidents, reset counters, or infer recovery from an empty adapter list.

Real-time connection and historical synchronization are separate facts. Preserve bounded platform error codes and container identifiers without credentials or message bodies. A successful private-chat scan does not conceal a failed group scan. Missing or stale observations must not be presented as verified health.

## Validation before release

1. Exercise missing bot permissions, one failed container alongside a successful one, real-time connectivity, and repeated read-only health queries.
2. Exercise chat and thread pagination, partial progress, token cycles, restart, old-cursor migration, transaction rollback, identity mismatches, and live/history deduplication.
3. Exercise addressed requests in active topics, non-addressed replies to subscribed topics, unaddressed unrelated messages, and revoked source scope. Preserve existing ticket identities and policy decisions.
4. Run the full release checks, packaged-consumer tests, and the matching skill checks. Publish only the verified clean-source artifact.

## Deployment and live acceptance

Preserve the project's dependency, runtime, and business baselines; use the supported consistent backup. Inspect the stalled history interval before enabling application permissions: unseen old addressed messages may enter normal assessment, while previously received messages must deduplicate. Never clear or advance the cursor merely to hide the backlog.

The database remains schema 15, but Feishu's internal cursor advances from version 1 to version 2. This is not a downgrade-compatible source state: alpha.4 treats an unfamiliar cursor as a fresh baseline. Do not reinstall an older runtime against the upgraded cursor. Any rollback must preserve post-upgrade intake/delivery evidence and explicitly reconcile it with the consistent pre-upgrade backup through the supported restore procedure.

After installing the exact published package and synchronized skill, retain the original service wrapper and project settings. Enable the missing application scope and publish the Feishu app revision. Confirm the effective tenant grants and actual group/thread history calls with the bot identity.

Use the authorized user identity and lark-cli to verify: a live group mention and original-topic reply; messages sent while the project service is stopped and then recovered after restart; a non-addressed supplement in an existing topic; and a first addressed request inside a recently active topic. Correlate message IDs with source intake, domain decisions, ticket inputs/results, and outgoing messages. Record whether intake was live or historical; successful restart alone does not prove historical recovery. Verify no duplicate tickets or inputs and leave the project service in its original running state.

# Feishu history read diagnostics

Starting with `0.15.0-alpha.10`, failed history reads retain bounded diagnostic facts. This change adds observation only: it does not increase timeouts, requests, concurrency, retry allowances or configured access. The schema version and history cursor format are unchanged.

## Reading a failure

The source state and `businessHealth().sources[].history.issues` retain the original chat/thread container along with these optional fields:

| Field | Meaning |
| --- | --- |
| `reason` | `timeout`, `cancelled`, `network`, `http`, `api`, `response`, `validation` or `unknown` |
| `phase` | `auth` for token preparation, `history` for the history request/response, `validation` for local message processing; the transport's internal generic phase is `request` |
| `transportCode` | An explicitly allowed SDK/network code, such as `ERR_CANCELED` or `ECONNRESET` |
| `statusCode` | HTTP status when available, independent of the Feishu integer business `code` |
| `elapsedMs` | Elapsed read time, including token preparation when captured by the transport |
| `failedAt` | UTC time of the failure, for correlation with network and process observations |
| `cancellationSource` | `deadline`, `stop`, `caller` or `request`, when the cancellation origin is known |

The existing `category` remains a broad compatibility label (`permission`, `transport`, `validation`). In particular, `transport` alone is not proof of a network failure: an unknown local processing exception remains `reason: unknown`, `phase: validation`. Known local identifier, content and size validation failures are classified as validation. Unexpected API envelopes use `reason: response`; numeric platform failures use `reason: api`. An unavailable detail stays absent; unknown errors are not diagnosed from their free-form text.

The official SDK can turn an aborted request into `ERR_CANCELED`, including when the read deadline expired. Its Node HTTP timer can also win the race and throw `ECONNABORTED`. A known Axios Node request timeout is diagnosed as a timeout while preserving its original code and error; it does not claim that the read scope was cancelled. The transport records cancellation sources from its own read scope and does not treat every cancellation or arbitrary `ECONNABORTED` error as a timeout. Neither timer nor SDK options are changed. A business error discarded by SDK token preparation may only retain `phase: auth` and `reason: unknown`.

Axios documents the default timeout code and its distinction from explicit cancellation in its [error handling reference](https://github.com/axios/axios/blob/v1.x/docs/pages/advanced/error-handling.md).

`service health` and the service heartbeat expose only small diagnostic summaries under `business.sources[].history.diagnostics`. The summary excludes chat/thread identities and error text, shares a global limit of 20 entries and 4 KiB of added facts, and respects headroom within the existing service file limit. Full per-container facts remain in source state and business health. Old snapshots without these fields remain readable; restarting does not invent details for old failures.

## Investigation and recovery boundaries

Use `failedAt` to correlate the original failed attempt. A retained failure may not have been retried during the latest round because history reads have a bounded, rotating request budget. `lastSuccess` means a batch committed, not that every container succeeded. A live WebSocket also does not prove history is healthy.

Inspect existing source state or service health without starting another runtime or invoking production `poll`/`sync`. If needed, read the same container through the same application bot identity. A separate successful request demonstrates access at that time, not recovery of the production cursor. Never save raw Axios errors, request/config/header objects, tokens or message content in diagnostics. Codes, phases and cancellation reasons are allowlisted; elapsed time and timestamps are bounded.

The failed page retains its existing window. Other containers can continue, and the next normal poll can recover the affected container; only that container's successful read clears its failure. Existing page order, fair rotation, transactional intake, message-ID deduplication, ownership and stop fences remain in effect. A stop still cancels reads and drains dispatched writes without replaying them. Diagnostics do not grant admission, create tickets, replay ignored inputs or change material authorization.

Network routing and database performance changes are outside this patch. Capture the actual failure first, then investigate the corresponding layer rather than adding retries or changing health thresholds to hide the warning.

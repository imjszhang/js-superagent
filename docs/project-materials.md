# Project materials and execution workspaces

The `0.15.0-alpha.0` source tree adds a host-controlled material contract. A material source tells the Worker which project files it may inspect. A workspace tells the native executor where it runs and writes. They are separate identities. `workspace.mode: auto` retains its existing Git worktree/copy choice unless a trusted submission explicitly selects material preparation.

This is a prerelease implementation, not a statement that an npm version has been published. Existing projects do not gain file access or material defaults merely by installing the package. Opening an existing schema 14 project does not promote it to schema 15. Stop the project's service and active execution before explicitly running `upgrade` or `configureMaterials`; these operations back up and migrate to schema 15. Schema 14 writers must refuse schema 15. Moving an existing project preserves its schema and minimum writer version, and invalidates material bindings tied to the previous project root.

## Configure a project source

Use the public SDK or CLI while the runtime is stopped. The following identities and paths are fictional deployment examples; replace the Feishu reader with the configured operator's actual channel identity before enabling that reader.

```json
{
  "version": 1,
  "entries": [
    {
      "id": "project",
      "project": "self",
      "include": ["README.md", "AGENTS.md", "docs", "research", "deliverables", "working/receipts"],
      "exclude": ["research/private"],
      "views": ["current", "commit", "snapshot"],
      "readers": [
        {"source": "local", "id": "operator"},
        {"source": "feishu", "id": "ou_example_operator"}
      ],
      "destinations": [
        {"source": "local", "id": "operator"},
        {"source": "feishu", "id": "operator"}
      ]
    }
  ],
  "defaults": {
    "access": "host-only",
    "sources": [{"id": "project", "view": {"kind": "current"}}],
    "allowPreparation": false,
    "allowApply": false
  }
}
```

`include` and `exclude` are relative file/directory prefixes, without globs, shell expansion or Gitignore semantics. Include root and nested project rules and skills when the Worker needs them. Business receipts ignored by Git are readable if explicitly inside the allowed prefixes. Excludes win. An additional project uses `project: {root, projectId, instanceId}` with an absolute host-configured root; listing a project in the machine registry does not grant access or initialize that project.

Readers and output destinations are different checks. Local output is `local/operator`. The configured operator's Feishu channel uses `feishu/operator`; other Feishu destinations use their chat identity. GitHub destinations use `github/owner/repository#number`. A Feishu message retains its actual Feishu reader identity through coordinator assessment; it cannot borrow the local operator's grant. When defaults are not authorized for a request, the ticket receives no material binding. An explicit unauthorized `submit({materials})` is rejected before ticket creation.

```bash
js-superagent --project /absolute/example/project materials status
js-superagent --project /absolute/example/project materials set materials.json 0
```

The final argument is the expected revision from `materials status`. A change invalidates existing material bindings; retries do not silently adopt new settings. Knowledge documents should explain the project's navigation and these public operations. They do not replace material settings, confer permissions, or contain live project reports.

## Submit and inspect

```js
const current = agent.getMaterialSettings();
agent.configureMaterials(settings, {expectedRevision: current.revision});
const ticket = agent.submit({
  text: 'Inspect the current project, including allowed uncommitted content',
  materials: {
    access: 'host-only',
    sources: [{id: 'project', view: {kind: 'current'}}]
  }
});
const evidence = agent.getDetailed(ticket.id);
```

`materialCapabilities()` advertises versioned bounded reading, preparation and local application. `getDetailed()` includes the persistent `materialBinding`, `materialObservations`, `materialFreshness`, actual `workspace`, `workspacePreparation` and past material workspace identities in `workspaceHistory`. A view is one of:

| View | Material identity and recovery |
| --- | --- |
| `current` | Live permitted files, including uncommitted and untracked files. New reads observe current bytes; conclusions must pass freshness checks. |
| `commit` | `{kind: 'commit', sha: '<full 40-character commit>'}`. Reads use fixed Git blobs and never advance with HEAD. |
| `snapshot` | `{kind: 'snapshot', snapshotId: '<host receipt id>'}`. Reads use immutable host-saved content and never fall back to the source file. |

`createMaterialSnapshot({sourceId, actor?, view?})` captures a configured source, rechecks it during collection and returns `{id, digest, source, observedAt}`. `actor` defaults to `local/operator`, `view` to `current`. The host stores the bytes privately outside the project checkout. Use the receipt ID for later fixed-view submission; the source identity and digest stay unchanged through workspace preparation. Snapshot creation does not start a Worker.

The Worker uses the existing `js_superagent_read` tool with host-minted `materials` references for source status, directory indexes and file records. It cannot supply arbitrary paths, commands, roots or credentials. Pagination carries a content version and rejects mixed versions; directory versions detect additions and deletions. Replaying a tool call returns its historical receipt, so a new observation needs a new call. Materials and GitHub context share the existing per-run limits and budget. An oversized file/index returns an explicit limit error.

Host-only material execution requires an adapter declaring `boundedMaterialReadsVersion: 1`, explicitly enabled agent tools, and a supported DSH host-only profile. That profile disables native filesystem/search/shell, native jobs and managed jobs. Existing incompatible sessions require explicit replacement; retry does not change their capability contract. Other adapters do not inherit support from their name or general read-only setting.

## Prepare work and apply results

With `allowPreparation: true`, a native Worker may request the existing `prepare_workspace` host operation for a bound current source in the main project. The host waits for the old execution and background work to finish, captures a consistent snapshot and prepares a new isolated copy. A new workspace generation receives a new native session. This retains the same ticket, mandate and assignment and preserves the failure-recovery budget; it is not a new work request or a failed-run retry. `workspacePreparationStatus(id)` exposes queued/preparing/ready/blocked/cancelled state; inspect the cause and use `retryWorkspacePreparation(id)` for a blocked preparation.

A trusted SDK caller may select an initial material copy with `workspaceSourceId`, `access: 'native'` and `allowPreparation: true`. The source ID must already be bound. This is useful for an upper-layer frozen task: freeze a snapshot, bind its ID, include `owner: {kind: 'longrun', id, contractHash}`, and select that source for the initial workspace. Longrun-owned contracts reject live `current` sources and `allowApply`; their upper layer retains result adoption and idempotency ownership.

Local host-owned application is separate from preparation, verification and publication. An operator-owned native ticket with `allowApply: true` can call `previewMaterialApplication(id, {paths})`, review the exact returned plan, then `applyMaterialChanges(id, {plan, operationId})`. Only Worker changes relative to the imported material baseline are considered. New source edits cause a conflict. Durable backups and receipts support `recoverMaterialApplication(id, {operationId, mode: 'finish' | 'rollback'})` after an interrupted application. Reusing an operation ID does not repeat a completed application. These methods never commit, push or publish.

Inspect `materialApplicationStatus(id, operationId)` before recovery. It reads the durable application journal and checks that it belongs to the selected ticket; it does not rely on an incomplete ticket metadata callback. `finish` still requires the current material grant and normal execution authority. A trusted local operator may explicitly request `rollback` after the project is paused or the original mandate is cancelled. This exception only restores the journal's own writes whose bytes have not changed again; newer edits cause a conflict. It grants no new paths, does not resume execution and does not transfer application ownership from a longrun contract.

CLI counterparts accept JSON files:

| Command | JSON input |
| --- | --- |
| `materials snapshot <file>` | `{sourceId, actor?, view?}` |
| `materials prepare <ticket> <file>` | `{materialId, provisionId, reason}` |
| `materials prepare-status <ticket>` | None |
| `materials prepare-retry <ticket>` | None |
| `materials apply-preview <ticket> <file>` | `{paths}` |
| `materials apply <ticket> <file>` | `{plan, operationId}` |
| `materials apply-status <ticket> <operation>` | None; the operation ID is a positional argument |
| `materials apply-recover <ticket> <file>` | `{operationId, mode}` |

## Limits

The provider rejects traversal, symbolic links, regular files with more than one hard link, special files and unsafe project identities. Fixed private names such as `.git`, `.js-superagent`, `.env*`, dependency caches and known credential directories are excluded. This is a bounded host contract, not operating-system process isolation or general secret detection. Configure narrow business prefixes and explicit exclusions for other private files.

Text reads require UTF-8 and are bounded to 2 MiB per retained record; host snapshots support binary regular files, up to 32 MiB per file, 20,000 files and 256 MiB total. Directory/reference limits can reject broad trees before a complete inspection. Source status records scope and observation time; a successful read is evidence of those observed bytes, not evidence that every project file was investigated.

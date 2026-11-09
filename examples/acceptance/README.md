# Frozen-package real acceptance

Prepare/build/pack separately. Every `real-*-smoke.mjs` now requires:

```bash
node examples/real-codex-smoke.mjs \
  --tarball /absolute/path/js-superagent.tgz \
  --expected-sha256 <sha256> \
  --package-commit <full-source-commit> \
  --output /absolute/path/new-evidence-directory
```

`--package-commit` records the caller's freeze manifest and does not independently prove a commit produced the archive. Package bytes and installed `src/bin/dist` contents are verified and recorded in `artifact-evidence.json`; `acceptance.json` contains the scenario assertions. A successful process exit alone is not a real scenario pass. Scripts never repack and never load the worktree runtime source.

Existing remote scripts also require their explicit `--write`, repository, actor, and other scope arguments. Run only against designated acceptance resources. `real-github-full-chain-smoke.mjs` requires the dedicated `owner/js-superagent-acceptance` repository and its fixture workflow, plus `--app-config` pointing to a local configuration containing credential references. `--app-pr-comments` opts the isolated runtime into the App PR-comment permission; the App installation must actually permit it. No automatic identity fallback is allowed.

The upgrade script additionally takes `--old-tarball` and `--old-sha256`; `--tarball` is the new candidate. Optional legacy `--new-tarball` must identify that same file. The defaults assert schema 3 → 4. Override `--old-schema` / `--new-schema` only when validating a different declared migration. It installs both supplied archives, proves the old package refuses the new database, then opens a matching restored backup with the actual old SDK and CLI.

Module-only scripts now use the same frozen inputs and `--output`; previous positional output arguments are replaced by the explicit flag. Temporary offline consumers remain beside the output directory for inspection. The ordinary package `npm run check` and unit tests remain distinct from opt-in real model and remote tests.

`real-repository-intake-smoke.mjs --fetch-pull-head` leaves the newly created PR commit absent locally and asserts that the installed runtime fetches that exact SHA, keeps project HEAD unchanged, and removes its private fetch ref. Omit the flag when checking older archives that predate this capability. Add `--app-pr-comments` only for an installed package and App installation that support the explicit PR reply capability.

`real-default-ci-smoke.mjs` is restricted to a **private** `owner/js-superagent-acceptance` repository. It injects a deliberate failure in that fixture's main branch, observes the real failed Actions check, lets the real coordinator and Worker create a repair draft PR, and requires its actual Actions check to pass. It restores the original fixture through a new non-forced commit and closes its PR without merging. It requires either `--app-config <config>` or an explicit `--native-gh` identity; these are mutually exclusive, and neither falls back to the other. Run it sequentially with other fixture tests and update the local source clone to the restored main before another run.

# Versioning and npm release

## Current status

The first standalone release is `0.14.0-alpha.0`, intended for the `alpha` dist-tag. It is not a stable 1.0 release. The original implementation's version is retained rather than resetting history. The project is MIT-licensed; bundled upstream MIT notices must remain in every package.

A prepared tarball, Git tag, GitHub release and npm publication are different states. Version `0.14.0-alpha.0` was published on 2026-11-09; registry integrity and clean consumer checks passed. Its annotated tag is `v0.14.0-alpha.0` at `b176f5a073a467aa499189712cdb0a222674c98a`; the [GitHub prerelease](https://github.com/imjszhang/js-superagent/releases/tag/v0.14.0-alpha.0) includes the tarball and manifest. Preparation never calls npm publish or creates a release tag.

## Prepare

From a clean checkout, use Node 24 and run:

```bash
npm ci --ignore-scripts
npm run release:prepare
```

This runs all checks, builds the core before checking declarations, validates package/lock/license/channel consistency and tests installation in a clean consumer. It then creates `release/js-superagent-0.14.0-alpha.0.tgz` and `release/manifest.json`, recording integrity, sizes and source commit/dirty status. `release/` is ignored. A dirty-source artifact is diagnostic, not the final release candidate: commit first, then regenerate and require sourceDirty=false.

The CI workflow performs the same preparation and retains an artifact. It cannot publish; it has only contents:read permission. The separate `publish.yml` workflow described below performs its own preparation for the exact dispatched main commit. Manual native-model/network acceptance scripts are not run by the normal test suite.

## Version changes

Update CHANGELOG, then use `npm version <exact-version> --no-git-tag-version` so package.json and package-lock.json agree. Keep prereleases on alpha/beta/rc as appropriate in publishConfig.tag; only a stable release uses latest. Run preparation, commit and push, and regenerate the final artifact from that commit. Do not reuse a version that already exists on npm.

Git release tags use `v<package.version>`; `RELEASE_TAG=v0.14.0-alpha.0 npm run check:release` checks agreement. After trusted publication succeeds, create the annotated tag and GitHub prerelease for the workflow's exact source commit and artifact, not a later main commit.

## Trusted publishing from GitHub

The standard release path is `.github/workflows/publish.yml` in `imjszhang/js-superagent`. It is explicitly dispatched on `main` with the expected package version:

```bash
gh workflow run publish.yml --ref main -f version=0.15.0-alpha.8
```

Merge the version, changelog and implementation first. The workflow publishes only its own `GITHUB_SHA`, and the input must match that commit's package and lock version. Do not change checkout to an arbitrary tag or ref: npm provenance uses the workflow's original SHA/ref. Ordinary pushes, PRs and CI checks do not publish.

The macOS preparation job runs the full release checks, including native service tests, without an OIDC publishing permission. A separate publishing job downloads that same run's archive and manifest. It checks the clean source commit, package metadata and SHA-512, then publishes the existing tarball with lifecycle scripts disabled. Only this job has `id-token: write`; no npm token or npm login is configured in GitHub.

The one-time npm trusted publisher configuration is:

| Field | Value |
| --- | --- |
| Package | `js-superagent` |
| Repository | `imjszhang/js-superagent` |
| Workflow file | `publish.yml` |
| GitHub environment | `npm` |
| Allowed operation | Direct `npm publish` |

The GitHub `npm` environment permits deployments from the `main` branch only, with no per-release approval or wait timer. Match the environment name exactly in npm. Direct publication must be enabled; staged-only publication would still require an operator to approve each release. Creating/changing this binding can require a one-time npm account verification. The first real publication must complete within two days of creating a new binding. Subsequent runs authenticate through GitHub's short-lived OIDC identity, and npm generates provenance automatically for this public repository/package.

The workflow uses Node 24 and npm 11.19.1, pins its actions, and serializes publication. If the exact version already exists with identical integrity, a rerun verifies it without republishing or moving the channel backwards. A conflicting archive fails. Only an explicit registry 404 is treated as an absent version; other registry failures stop publication. Each run invokes `npm publish` at most once, then checks the registry for up to a bounded processing period. An ambiguous result must be inspected before another run; do not bump the version just to bypass uncertainty.

After success, download `npm-release-candidate` from that run, inspect the registry version/integrity, provenance and channel, and install the exact registry version in a clean consumer. Retain the artifact/manifest with the GitHub release. Existing local runtimes are not automatically upgraded, and the historical `latest` tag is not changed by alpha publication. Local manual `npm publish` can still require npm verification; this setup removes that prompt from the authorized GitHub workflow.

Official references: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## First publication (separate explicit action)

Before publishing, authenticate locally (`npm login`), confirm the publishing account (`npm whoami`), check package-name availability/permissions and the version on the public registry, verify sourceDirty=false and the recorded SHA-512, and confirm that the commit passed CI.

```bash
npm publish ./release/js-superagent-0.14.0-alpha.0.tgz --access public --tag alpha --registry https://registry.npmjs.org/
```

This command is shown for the authorized release step; preparation does not run it. Complete any interactive authentication requirement. Verify the resulting version, dist-tag and integrity with npm view before recording the release as published; after an ambiguous network failure, inspect the registry before retrying. Create/push the matching annotated Git tag and GitHub prerelease with its changelog and integrity metadata. Install the exact registry version in a clean project as the final consumer check.

npm's [publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/) describes publication and dist-tags. This historical manual path is retained for recovery; prefer the trusted GitHub workflow above for subsequent releases. Package preparation alone never changes registry trust settings or publishes. No token is stored in this repository.

## First-release registry processing

The first publish returned success before the version became publicly available. During processing, npm exposed a temporary `0.0.0-stage` placeholder and no manually approvable staged item. Wait for the exact version and integrity to appear; do not republish. npm also assigned `latest` to the first published prerelease, despite the explicit `alpha` tag. Inspect dist-tags after publication and remove `latest` for an alpha-only release (this can require another browser authentication).

For this release, removal of the automatically assigned `latest` tag was attempted after browser authentication, but npm returned HTTP 400. Registry verification still showed both `alpha` and `latest` pointing to `0.14.0-alpha.0`. The version remains an alpha prerelease; use the exact version or explicit `alpha` tag. Do not describe this publication as alpha-only.

## 0.14.0-alpha.1 publication

Published 2026-11-10 from clean commit `88adf7ea6b2288af9cd162a82eab08a07f7c1cd9` after CI and full release preparation passed. Registry integrity matched the prepared tarball. The annotated tag and GitHub prerelease include the tarball and source manifest. `alpha` points to alpha.1; `latest` remains alpha.0. Consumers should install `js-superagent@0.14.0-alpha.1` explicitly.

## 0.14.0-alpha.2 publication

Published 2026-11-10 from clean commit `923a1c09761b46f785ba4faf06877cf6cd2bfdde` after full checks and CI passed. Registry integrity matches the prepared artifact. `alpha` points to alpha.2; `latest` remains alpha.0. Tag `v0.14.0-alpha.2` identifies the tested source.

## 0.14.0-alpha.3 publication

Published 2026-11-11 (Asia/Shanghai) from clean commit `4108e81e817479c6c6276ab60b7e902ca74ffb3b`. Full checks (1,561 tests), CI, isolated live-model routing and registry clean-consumer verification passed. Registry integrity matches the tested artifact. Tag and GitHub prerelease `v0.14.0-alpha.3` include the package and manifest; alpha points to alpha.3, latest remains alpha.0.

## 0.14.0-alpha.4 publication

Published 2026-11-11 (Asia/Shanghai) from clean commit `50a70419904e9ea8c6fa8bd1141fd637e9594743`. Full checks (1,586 tests), CI, native-process acceptance and isolated live-model recovery passed. The real-model recovery used an explicitly injected missing report and verified the same session, consumed inputs and no repeated file read. Registry integrity matches the tested artifact; an independent registry consumer verified CLI, SDK and persistent history. Registry metadata appeared before an earlier cached tarball 404 expired, so the consumer fetched the official tarball with a fresh query and verified it through npm's content-addressed cache. Tag and GitHub prerelease `v0.14.0-alpha.4` include the package and manifest; alpha points to alpha.4, latest remains alpha.0.

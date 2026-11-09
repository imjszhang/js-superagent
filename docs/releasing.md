# Versioning and npm release

## Current status

The first standalone candidate is `0.14.0-alpha.0`, intended for the `alpha` dist-tag. It is not a stable 1.0 release. The original implementation's version is retained rather than resetting history. The project is MIT-licensed; bundled upstream MIT notices must remain in every package.

A prepared tarball, Git tag, GitHub release and npm publication are different states. CHANGELOG currently marks this version unreleased. Preparation never calls npm publish or creates a release tag.

## Prepare

From a clean checkout, use Node 24 and run:

```bash
npm ci --ignore-scripts
npm run release:prepare
```

This runs all checks, builds the core before checking declarations, validates package/lock/license/channel consistency and tests installation in a clean consumer. It then creates `release/js-superagent-0.14.0-alpha.0.tgz` and `release/manifest.json`, recording integrity, sizes and source commit/dirty status. `release/` is ignored. A dirty-source artifact is diagnostic, not the final release candidate: commit first, then regenerate and require sourceDirty=false.

The CI workflow performs the same preparation and retains an artifact. It cannot publish; it has only contents:read permission. Manual native-model/network acceptance scripts are not run by the normal test suite.

## Version changes

Update CHANGELOG, then use `npm version <exact-version> --no-git-tag-version` so package.json and package-lock.json agree. Keep prereleases on alpha/beta/rc as appropriate in publishConfig.tag; only a stable release uses latest. Run preparation, commit and push, and regenerate the final artifact from that commit. Do not reuse a version that already exists on npm.

Git release tags use `v<package.version>`; `RELEASE_TAG=v0.14.0-alpha.0 npm run check:release` checks agreement. Create the annotated tag and GitHub prerelease only for the exact artifact being released, not for every preparation commit.

## First publication (separate explicit action)

Before publishing, authenticate locally (`npm login`), confirm the publishing account (`npm whoami`), check package-name availability/permissions and the version on the public registry, verify sourceDirty=false and the recorded SHA-512, and confirm that the commit passed CI.

```bash
npm publish ./release/js-superagent-0.14.0-alpha.0.tgz --access public --tag alpha --registry https://registry.npmjs.org/
```

This command is shown for the authorized release step; preparation does not run it. Complete any interactive authentication requirement. Verify the resulting version, dist-tag and integrity with npm view before recording the release as published; after an ambiguous network failure, inspect the registry before retrying. Create/push the matching annotated Git tag and GitHub prerelease with its changelog and integrity metadata. Install the exact registry version in a clean project as the final consumer check.

npm's [publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/) describes publication and dist-tags. Subsequent automation can use [trusted publishing](https://docs.npmjs.com/trusted-publishers/), but it must be configured for the package and exact repository/workflow. It is not configured by this preparation, and no token is stored in this repository. Existing local runtimes are not automatically upgraded by publication.

# Project instructions

Read README.md for project scope and docs/releasing.md before release work.

## npm publication

- All future npm releases use `.github/workflows/publish.yml` through GitHub trusted publishing (OIDC).
- Update the version and changelog, pass checks, merge to `main`, then dispatch `gh workflow run publish.yml --ref main -f version=<exact-version>`.
- Do not publish locally, request per-release npm authorization, or add a stored npm publishing token as a fallback.
- On failure, inspect workflow logs and registry state; fix the GitHub flow. Never blindly republish an ambiguous result.
- Verify the published version, integrity, provenance and clean installation; tag the exact workflow source commit and retain its artifacts in the GitHub Release.
- Publication does not automatically upgrade deployed projects.

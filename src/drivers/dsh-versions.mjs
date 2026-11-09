// Exact inspected CLI releases, not a semver compatibility promise.
export const DSH_VERSIONS = Object.freeze(['0.2.1-rc.5', '0.2.2-alpha.2']);
export const isSupportedDshVersion = version => DSH_VERSIONS.includes(version);

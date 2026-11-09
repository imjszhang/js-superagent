// Exact inspected CLI releases, not a semver compatibility promise.
export const CURSOR_AGENT_VERSIONS = Object.freeze(['2026.11.05-86047df']);
export const isSupportedCursorVersion = version => CURSOR_AGENT_VERSIONS.includes(version);

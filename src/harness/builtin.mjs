import { codexAppServerAdapter } from './adapters/codex-app-server.mjs';
export { createCodexAppServerDriver } from './adapters/codex-app-server.mjs';
import { dshSdkAdapter } from './adapters/dsh-sdk.mjs';
import { cursorAgentAdapter } from './adapters/cursor-agent.mjs';
export { createCursorAgentDriver, validateCursorOptions, createCursorAssessor } from './adapters/cursor-agent.mjs';

export const BUILTIN_ADAPTERS = Object.freeze([codexAppServerAdapter, dshSdkAdapter, cursorAgentAdapter]);
export const DEFAULT_DRIVER = 'codex-app-server';
export const RETIRED_DRIVERS = Object.freeze({ codex: 'codex-app-server', 'dsh-headless': 'dsh-sdk' });
export const PROJECT_EXECUTION_DRIVERS = Object.freeze([...new Set([
  ...BUILTIN_ADAPTERS.map(adapter => adapter.id), ...Object.keys(RETIRED_DRIVERS), ...Object.values(RETIRED_DRIVERS),
])]);

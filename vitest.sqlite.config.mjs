import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/core-engine.spec.ts', 'tests/core-single-trigger.spec.ts', 'tests/stage.spec.ts'],
  setupFiles: ['tests/sqlite-setup.mjs'],
} });

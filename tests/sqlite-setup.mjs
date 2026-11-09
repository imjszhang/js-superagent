// Run the unchanged upstream domain suite against the production SQLite repositories too.
import { vi, afterEach } from 'vitest';
const { stores } = vi.hoisted(() => ({ stores: [] }));
vi.mock('../src/core/index.ts', async importOriginal => {
  const original = await importOriginal();
  const { Store } = await import('../src/store.mjs');
  return { ...original, MemoryRepositories: class {
    constructor() { const store = new Store(':memory:'); stores.push(store); return store; }
  } };
});
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

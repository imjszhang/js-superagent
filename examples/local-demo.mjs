// Protocol demonstration only: no model calls or project edits.
import { createHarnessRegistry, createProjectAgent } from '../src/index.mjs';
if (!process.argv[2]) throw new Error('Usage: node examples/local-demo.mjs /path/to/scratch-project');
const harnessRegistry = createHarnessRegistry({ adapters: [{
  id: 'local-demo', version: '1', roles: ['worker'],
  validate(options) {
    if (Object.keys(options).length) throw new Error('local-demo takes no options');
    return {};
  },
  createDriver() {
    return {
      reportVersion: 2,
      async run({ ticket, signal }) {
        signal.throwIfAborted();
        return { version: 2, state: 'ready', summary: `Demo received ${ticket.messages.length} input(s). No model or file modification.` };
      },
    };
  },
}] });
const runtime = createProjectAgent({ projectRoot: process.argv[2], harnessRegistry }).init();
try {
  runtime.configureExecutor({ driver: 'local-demo' }, { expectedRevision: runtime.getExecutorSettings().revision });
  const ticket = runtime.submit({ text: 'Demonstrate local ticket persistence.' });
  console.log('Queued:', ticket.id);
  console.log(await runtime.runNext());
} finally { await runtime.stop(); runtime.close(); }

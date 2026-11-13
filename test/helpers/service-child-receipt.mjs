import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

// Short-lived test CLIs must stay alive until the real wrapper has sampled both
// process identities. A fixed delay races ps/sysctl under a busy CI runner.
export async function waitForServiceReceipt(directory, { heartbeat = false, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const read = name => {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  };
  const identity = (owner, pid) => owner?.pid === pid && typeof owner.host === 'string' && owner.host.length > 0 &&
    typeof owner.birth === 'string' && owner.birth.length > 0 && typeof owner.bootId === 'string' && owner.bootId.length > 0;
  while (Date.now() < deadline) {
    const receipt = read('runtime.json');
    if (receipt?.healthProtocol === 1 && receipt.runId === process.env.JS_SUPERAGENT_SERVICE_RUN_ID &&
        receipt.pid === process.ppid && receipt.childPid === process.pid &&
        identity(receipt.owner, process.ppid) && identity(receipt.childOwner, process.pid)) {
      const pulse = heartbeat ? read('heartbeat.json') : null;
      if (!heartbeat || pulse?.runId === receipt.runId && pulse.pid === receipt.pid && pulse.childPid === receipt.childPid && pulse.business?.paused === true) return receipt;
    }
    await setTimeout(10);
  }
  throw new Error('Fixture timed out waiting for this wrapper run to persist process identities and its requested heartbeat');
}

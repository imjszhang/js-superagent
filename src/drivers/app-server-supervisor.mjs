// Own the interactive server and its process tree, including when the runtime disappears.
import { spawn } from 'node:child_process';
import { PosixProcessTree } from './posix-process-tree.mjs';

let child, tree, tick, done = false, stopping, childClosed = false, acknowledged = false;
let exitCode, exitSignal, error, reason, grace = 1000;
const send = message => { if (process.connected) process.send(message, () => {}); };
function cleanup(why) {
  reason ??= why;
  if (stopping) return stopping;
  stopping = (async () => {
    await tree?.stop(grace);
    if (child && !childClosed) await new Promise(resolve => child.once('close', resolve));
    clearInterval(tick);
    if (done) return;
    done = true; send({ type: 'result', code: exitCode ?? null, signal: exitSignal ?? null, error, reason });
    if (process.connected) process.disconnect();
  })();
  return stopping;
}
process.on('message', message => {
  if (message.type === 'abort') { void cleanup(message.reason ?? 'cancelled'); return; }
  if (message.type === 'ack-child') { acknowledged = true; return; }
  if (message.type === 'write' && child && acknowledged && !stopping) {
    if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 1024 * 1024) { void cleanup('Invalid input frame'); return; }
    child.stdin.write(message.data, cause => { if (cause) { error = cause.message; void cleanup('stdin failed'); } }); return;
  }
  if (message.type === 'end' && child && acknowledged && !stopping) { child.stdin.end(); return; }
  if (message.type !== 'start' || child || done || stopping) return;
  grace = message.killGraceMs;
  child = spawn(message.executable, message.args, { cwd: message.cwd, detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
  tree = new PosixProcessTree(child.pid);
  child.stdin.on('error', () => {});
  child.once('spawn', () => send({ type: 'child', pid: child.pid }));
  child.once('error', cause => { error = cause.message; void cleanup('spawn failed'); });
  child.once('exit', (code, signal) => { exitCode = code; exitSignal = signal; void cleanup(); });
  child.once('close', () => { childClosed = true; void cleanup(); });
  tick = setInterval(() => tree.scan(), 100);
});
process.once('disconnect', () => { void cleanup('runtime disconnected'); });
process.once('SIGTERM', () => { void cleanup('supervisor terminated'); });
process.once('SIGINT', () => { void cleanup('supervisor interrupted'); });
send({ type: 'ready' });

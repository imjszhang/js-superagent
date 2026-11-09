// A separate owner survives a runtime crash long enough to stop Codex and its tools.
import { spawn } from 'node:child_process';
import { PosixProcessTree } from './posix-process-tree.mjs';

let child, completed = false, stopping = false, childClosed = false, tick, graceTimer, verifyTimer;
let reason, exitCode, exitSignal, spawnError, prompt, tree;
let killGraceMs = 1000;
function send(value) { if (process.connected) process.send(value, () => {}); }
function scan() { return tree?.scan() ?? true; }
function signalAll(signal) { tree?.signal(signal); }
function finish() {
  if (completed) return;
  completed = true; clearInterval(tick); clearTimeout(graceTimer); clearTimeout(verifyTimer);
  send({ type: 'result', code: exitCode ?? null, signal: exitSignal ?? null, error: spawnError, reason });
  if (process.connected) process.disconnect();
}
function verifyStopped() {
  const observed = scan();
  if ((!child || childClosed) && observed && !tree?.descendants.size) { finish(); return; }
  // Retain ownership if the OS has not stopped every tracked process yet.
  signalAll('SIGKILL');
  verifyTimer = setTimeout(verifyStopped, 25);
}
function cleanup(why) {
  reason ??= why;
  if (stopping) return;
  stopping = true;
  scan(); signalAll('SIGTERM');
  graceTimer = setTimeout(() => {
    graceTimer = undefined;
    clearInterval(tick);
    scan(); signalAll('SIGKILL');
    verifyStopped();
  }, killGraceMs);
}
process.on('message', message => {
  if (message.type === 'abort') { cleanup(message.reason ?? 'cancelled'); return; }
  if (message.type === 'ack-child' && child && !stopping && !completed && prompt !== undefined) {
    child.stdin.end(prompt); prompt = undefined; return;
  }
  if (message.type !== 'start' || child || completed || stopping) return;
  killGraceMs = message.killGraceMs;
  prompt = message.prompt;
  child = spawn(message.executable, message.args, { cwd: message.cwd, detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
  tree = new PosixProcessTree(child.pid);
  child.stdin.on('error', () => {});
  // Do not deliver work before both CLI and supervisor ownership are durable.
  child.on('spawn', () => send({ type: 'child', pid: child.pid }));
  tick = setInterval(scan, 100);
  child.on('error', error => { spawnError = `${error.code ?? 'SPAWN'}: ${error.message}`; cleanup('spawn failed'); });
  child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; cleanup(); });
  child.on('close', () => {
    childClosed = true;
    // Even a normal CLI exit may leave tool grandchildren. Keep the guard until cleanup ends.
    if (!stopping) cleanup();
  });
});
process.on('disconnect', () => cleanup('runtime disconnected'));
process.on('SIGTERM', () => cleanup('supervisor terminated'));
process.on('SIGINT', () => cleanup('supervisor interrupted'));
// Parent must register this process before sending start.
send({ type: 'ready' });

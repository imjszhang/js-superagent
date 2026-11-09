import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { PosixProcessTree } from './posix-process-tree.mjs';

// No native input is delivered before both the guardian and the native
// process have been registered by the runtime.
export function openSupervisedProcess({ label, executable, args, cwd, env, signal, timeoutMs, killGraceMs, registerProcess, onLine }) {
  const file = fileURLToPath(new URL('./app-server-supervisor.mjs', import.meta.url));
  const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let outcome, failure, tree, fallback, bytes = 0, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A failure before consumers await readiness must not become an unhandled rejection.
  ready.catch(() => {});
  const send = value => { if (child.connected) child.send(value, cause => { if (cause) abort(new Error(`${label} guardian transport closed`)); }); };
  const abort = cause => { failure ??= cause instanceof Error ? cause : new Error(String(cause)); readyReject(failure); sendAbort(); };
  const sendAbort = () => { if (child.connected) child.send({ type: 'abort', reason: `${label} execution stopped` }, () => {}); };
  const cancel = () => abort(new Error(`${label} execution cancelled`));
  let timer;
  const setDeadline = deadline => {
    if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 86400000) throw new Error(`Invalid ${label} owner deadline`);
    clearTimeout(timer); timer = setTimeout(() => abort(new Error(`${label} execution timed out`)), Math.max(1,deadline-Date.now()));
  };
  setDeadline(Date.now()+timeoutMs);
  let currentSignal = signal;
  currentSignal?.addEventListener('abort', cancel, { once: true });
  const streams = [];
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    const decoder = new StringDecoder('utf8'); let buffer = '';
    const consume = value => {
      try { onLine(name, value); } catch (error) { abort(error); }
    };
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { abort(new Error(`${label} output exceeded 16 MiB`)); return; }
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > 1024 * 1024) { abort(new Error(`${label} event exceeded 1 MiB`)); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!failure) consume(line);
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024) abort(new Error(`${label} event exceeded 1 MiB`));
    });
    streams.push(() => { buffer += decoder.end(); if (buffer.trim() && !failure) consume(buffer); });
  }
  child.on('message', message => {
    if (message.type === 'result') { outcome = message; return; }
    if (message.type === 'ready' && !failure) {
      try {
        registerProcess(child.pid);
        send({ type: 'start', executable, args, cwd, killGraceMs });
      } catch (error) { abort(error); }
    }
    if (message.type === 'child') {
      if (!Number.isSafeInteger(message.pid) || message.pid <= 1) { abort(new Error(`Invalid ${label} process identity`)); return; }
      tree = new PosixProcessTree(message.pid);
      try {
        registerProcess(message.pid);
        if (!failure) { send({ type: 'ack-child' }); readyResolve(); }
      } catch (error) { abort(error); }
    }
  });
  const closed = new Promise(resolve => {
    child.once('error', error => { failure ??= new Error(`${label} guardian failed: ${error.code ?? 'SPAWN'}`); readyReject(failure); });
    child.once('exit', () => {
      if (!outcome) {
        failure ??= new Error(`${label} guardian exited without cleanup acknowledgement`); readyReject(failure);
        fallback = (async () => { await tree?.stop(killGraceMs); child.stdout.destroy(); child.stderr.destroy(); })();
        fallback.then(resolve, error => { failure ??= error; resolve(); });
      }
    });
    child.once('close', () => { if (!fallback) resolve(); });
  }).then(() => {
    clearTimeout(timer); currentSignal?.removeEventListener('abort', cancel); streams.forEach(finish => finish());
    readyReject(failure ?? new Error(`${label} process closed before ready`));
    if (currentSignal?.aborted) failure ??= new Error(`${label} execution cancelled`);
    if (failure) throw failure;
    if (!outcome || outcome.code !== 0 || outcome.signal || outcome.error || outcome.reason) {
      throw Object.assign(new Error(`${label} process failed or stopped without a clean exit`), { exitCode: outcome?.code ?? null, exitSignal: outcome?.signal ?? null });
    }
    return outcome;
  });
  closed.catch(() => {});
  if (signal?.aborted) cancel();
  return { ready, closed, abort, setDeadline, setSignal(next) { currentSignal?.removeEventListener('abort', cancel); currentSignal = next; currentSignal?.addEventListener('abort', cancel, { once: true }); if (currentSignal?.aborted) cancel(); }, write(value) {
    if (failure || outcome) throw new Error(`${label} process is not writable`);
    const data = JSON.stringify(value) + '\n'; if (Buffer.byteLength(data) > 1024 * 1024) throw new Error(`${label} input exceeds 1 MiB`);
    send({ type: 'write', data });
  }, writeText(value) {
    if (failure || outcome) throw new Error(`${label} process is not writable`);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) throw new Error(`${label} input exceeds 1 MiB`);
    send({ type: 'write', data: value });
  }, endInput() {
    if (failure || outcome) throw new Error(`${label} process is not writable`);
    send({ type: 'end' });
  } };
}

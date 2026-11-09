import { watch, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Advisory invalidation, not an event journal. Re-read durable state in listener. */
export function watchStateChanges(databasePath, listener, { onError = () => {} } = {}) {
  if (typeof listener !== 'function') throw new TypeError('Change listener must be a function');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');
  const name = basename(databasePath), files = new Set([name, `${name}-wal`, `${name}-shm`]);
  const identity = statSync(databasePath);
  let closed = false, pending = false, running = false, timer;
  // Watch the directory: WAL files and the database itself may be replaced.
  const watcher = watch(dirname(databasePath), (_event, filename) => {
    if (filename !== null && !files.has(String(filename))) return;
    pending = true;
    schedule();
  });
  function report(error) {
    try { onError(error); } catch { /* An error observer cannot crash the state reader. */ }
  }
  function schedule() {
    if (closed || running || timer || !pending) return;
    // Collapse one transaction's WAL/SHM writes, without overlapping async readers.
    timer = setTimeout(async () => {
      timer = undefined;
      if (closed) return;
      try {
        const current = statSync(databasePath);
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Database file was replaced');
      } catch (cause) {
        close();
        report(Object.assign(new Error('State database changed identity; close and reopen the runtime', { cause }), { code: 'WATCH_REOPEN_REQUIRED' }));
        return;
      }
      pending = false; running = true;
      try { await listener(); } catch (error) { report(error); }
      finally { running = false; schedule(); }
    }, 20);
  }
  function close() {
    if (closed) return;
    closed = true; pending = false; clearTimeout(timer); watcher.close();
  }
  watcher.on('error', cause => {
    close();
    report(Object.assign(new Error('State file watcher failed; register a new watcher', { cause }), { code: 'WATCH_FAILED' }));
  });
  return close;
}

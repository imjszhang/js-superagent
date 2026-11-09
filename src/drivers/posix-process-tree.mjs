import { execFileSync } from 'node:child_process';

// Cooperative process cleanup, not containment of intentionally hidden daemons.
export class PosixProcessTree {
  constructor(pid) { this.pid = pid; this.descendants = new Map(); this.groups = new Set(); }
  scan() {
    if (!this.pid) return true;
    try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 })
        .trim().split('\n').map(line => {
          const [pid, ppid, pgid, state, ...birth] = line.trim().split(/\s+/);
          return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state, birth: birth.join(' ') };
        });
      const active = new Map(rows.filter(row => !row.state?.startsWith('Z')).map(row => [row.pid, row]));
      for (const [pid, birth] of this.descendants) if (active.get(pid)?.birth !== birth) this.descendants.delete(pid);
      const found = new Set([this.pid, ...this.descendants.keys()]);
      this.groups.clear();
      let changed;
      do {
        changed = false;
        for (const { pid, ppid, pgid, birth } of active.values()) {
          if ((found.has(ppid) || pgid === this.pid) && !found.has(pid)) { found.add(pid); changed = true; }
          if (found.has(pid) && pid !== process.pid) { this.descendants.set(pid, birth); if (pgid > 1 && pgid !== process.pid) this.groups.add(pgid); }
        }
      } while (changed);
      return true;
    } catch { return false; }
  }
  signal(signal) {
    if (this.pid) this.groups.add(this.pid);
    for (const pgid of this.groups) { try { process.kill(-pgid, signal); } catch {} }
    for (const pid of this.descendants.keys()) { if (pid !== process.pid) { try { process.kill(pid, signal); } catch {} } }
  }
  async stop(killGraceMs) {
    this.scan(); this.signal('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, killGraceMs));
    this.scan(); this.signal('SIGKILL');
    // Keep the runtime's ownership if the OS cannot verify cleanup.
    while (!this.scan() || this.descendants.size) {
      this.signal('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

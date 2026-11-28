import { readFileSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { coordinationError } from './project-identity.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) && !/^0+(?:-0+)*$/.test(value);
const machine = value => typeof value === 'string' && /^sha256:[a-f\d]{64}$/.test(value);
const DARWIN_BOOT = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*\d+\s*\}/;
// Only for pre-v2 receipts. New owners use the immutable OS boot-session UUID.
export function sameBoot(recorded, current) {
  if (typeof recorded !== 'string' || typeof current !== 'string' || !recorded || !current) return false;
  if (recorded === current) return true;
  const a = DARWIN_BOOT.exec(recorded), b = DARWIN_BOOT.exec(current);
  return !!a && !!b && Math.abs(Number(a[1]) - Number(b[1])) <= 60;
}

function nativeBirth(pid) {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 }).trim();
    if (!value || value.startsWith('Z')) return null;
    return value.split(/\s+/).slice(1).join(' ');
  } catch (error) { return error.status === 1 ? null : undefined; }
}
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024 }).trim();
export function readNativeMachineId(platform = process.platform, read = readFileSync, run = command) {
  let raw;
  if (platform === 'darwin') {
    raw = /"IOPlatformUUID"\s*=\s*"([a-f\d-]+)"/i.exec(run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1];
    if (!uuid(raw)) throw Error('Machine UUID unavailable');
  } else if (platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const value = read(file, 'utf8').trim(); if (/^[a-f\d]{32}$/i.test(value) && !/^0+$/.test(value)) { raw = value; break; } } catch { /* Try the standard fallback. */ }
    }
    if (!raw) throw Error('Machine ID unavailable');
  } else throw Error('Process identity platform unsupported');
  // Persist an application-scoped digest, never the raw hardware / OS machine ID.
  return `sha256:${createHash('sha256').update(`js-superagent/process-machine/v1\0${platform}\0${raw.toLowerCase()}`).digest('hex')}`;
}
const diagnostic = read => { try { const value = read(); return typeof value === 'string' ? value : ''; } catch { return ''; } };
export function readNativeScope(platform = process.platform, read = readFileSync, link = readlinkSync, run = command) {
  const linux = platform === 'linux';
  const bootSessionId = linux ? read('/proc/sys/kernel/random/boot_id', 'utf8').trim() : run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
  return {
    machineId: readNativeMachineId(platform, read, run),
    bootSessionId: bootSessionId.toLowerCase(),
    pidNamespace: linux ? link('/proc/self/ns/pid') : 'host',
    bootId: linux ? bootSessionId : diagnostic(() => run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])),
  };
}
const validScope = scope => scope && machine(scope.machineId) && uuid(scope.bootSessionId) &&
  (scope.pidNamespace === 'host' || /^pid:\[\d+\]$/.test(scope.pidNamespace));
const v2 = owner => ['identityVersion', 'machineId', 'bootSessionId', 'pidNamespace'].some(key => Object.hasOwn(owner, key));

// Used for re-entering an owned maintenance operation; hostname is not a process key.
export function sameProcessIdentity(a, b) {
  if (!a || !b || !positive(a.pid) || a.pid !== b.pid || !a.birth || a.birth !== b.birth) return false;
  if (v2(a) || v2(b)) return a.identityVersion === 2 && b.identityVersion === 2 && validScope(a) && validScope(b) &&
    a.machineId === b.machineId && a.bootSessionId.toLowerCase() === b.bootSessionId.toLowerCase() && a.pidNamespace === b.pidNamespace;
  return a.host === b.host && sameBoot(a.bootId, b.bootId);
}

/** Probe seam is internal: every production caller uses the same native inspector. */
export function createProcessIdentityInspector({ scope = readNativeScope, birth = nativeBirth, host = hostname, pid = process.pid } = {}) {
  let cachedScope, cachedBirth;
  const readScope = () => {
    if (cachedScope) return cachedScope;
    try { const value = scope(); if (validScope(value)) cachedScope = value; } catch { /* Unavailable evidence must never mean dead. */ }
    return cachedScope;
  };
  const captureProcessIdentity = processId => {
    if (!positive(processId)) throw Error('Expected a process ID');
    const started = birth(processId);
    if (started === null) return null;
    const current = readScope();
    if (!started || !current) return undefined;
    return { identityVersion: 2, host: diagnostic(host), pid: processId, birth: started, ...current };
  };
  const currentProcessIdentity = () => {
    cachedBirth ??= birth(pid);
    const current = readScope();
    if (!cachedBirth || !current) throw coordinationError('PROCESS_IDENTITY_UNKNOWN', 'Cannot verify this process start identity');
    return { identityVersion: 2, host: diagnostic(host), pid, birth: cachedBirth, ...current };
  };
  const inspectProcessOwner = owner => {
    if (!owner || !positive(owner.pid)) return 'unknown';
    const current = readScope();
    if (!current) return 'unknown';
    if (v2(owner)) {
      // A present but incomplete/newer identity must not downgrade to hostname checks.
      if (owner.identityVersion !== 2 || !validScope(owner) || typeof owner.birth !== 'string' || !owner.birth) return 'unknown';
      if (owner.machineId !== current.machineId) return 'unknown';
      // A proven prior boot has no surviving processes, regardless of hostname or PID reuse.
      if (owner.bootSessionId.toLowerCase() !== current.bootSessionId.toLowerCase()) return 'dead';
      if (owner.pidNamespace !== current.pidNamespace) return 'unknown';
    } else {
      // Legacy receipts cannot prove machine identity across BOTH a rename and reboot.
      // Preserve their conservative behavior; never guess locality from an absent local PID.
      if (typeof owner.host !== 'string' || !owner.host) return 'unknown';
      if (typeof current.bootId !== 'string' || !current.bootId) return 'unknown';
      if (owner.host !== diagnostic(host) && !sameBoot(owner.bootId, current.bootId)) return 'unknown';
      if (typeof owner.birth !== 'string' || !owner.birth || typeof owner.bootId !== 'string' || !owner.bootId) return 'unknown';
    }
    const actual = birth(owner.pid);
    if (actual === undefined) return 'unknown';
    if (actual === null) return 'dead';
    if (!v2(owner) && !sameBoot(owner.bootId, current.bootId)) return 'dead';
    return actual === owner.birth ? 'alive' : 'dead';
  };
  return { captureProcessIdentity, currentProcessIdentity, inspectProcessOwner };
}

export const { captureProcessIdentity, currentProcessIdentity, inspectProcessOwner } = createProcessIdentityInspector();

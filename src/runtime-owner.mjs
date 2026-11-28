import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { currentProcessIdentity, captureProcessIdentity, inspectProcessOwner, sameProcessIdentity } from './process-identity.mjs';

const hasIdentity = owner => ['identityVersion','machineId','bootSessionId','pidNamespace','birth','bootId'].some(key => Object.hasOwn(owner, key));
/** New durable business owners carry the same identity as service/machine leases. */
export const runtimeOwner = () => currentProcessIdentity();
const diagnosticHostname = () => { try { return hostname(); } catch { return ''; } };
export function childOwner(pid) { const owner = captureProcessIdentity(pid); return owner === undefined ? {pid,host:diagnosticHostname(),unknown:true} : owner; }
export function childOwners(pid) { const owner = childOwner(pid); return owner === null ? [] : [owner]; }
export function registerChildOwner(guardians, pid) {
  const owner = childOwner(pid);
  if (owner !== null && !guardians.some(guardian => sameRuntimeOwner(guardian, owner))) guardians.push(owner);
  return owner;
}

/** Bare pre-v2 host/PID journals cannot prove locality after a rename or PID reuse.
 * Retain their same-host kernel check; never downgrade an incomplete modern owner. */
export function inspectRuntimeOwner(owner) {
  if (!owner || owner.unknown || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  if (hasIdentity(owner)) {
    // The current process cannot reuse its own PID during its lifetime. Preserve
    // stable-scope checks without spawning ps in every scheduling transaction.
    if (owner.pid === process.pid) {
      try { if (sameProcessIdentity(owner, currentProcessIdentity())) return 'alive'; } catch { /* The shared inspector decides whether remaining evidence is sufficient. */ }
    }
    return inspectProcessOwner(owner);
  }
  if (typeof owner.host !== 'string' || !owner.host || owner.host !== diagnosticHostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    if (process.platform !== 'win32') {
      try { if (execFileSync('ps', ['-p', String(owner.pid), '-o', 'stat='], {encoding:'utf8',timeout:1000,maxBuffer:1024}).trim().startsWith('Z')) return 'dead'; } catch { /* Keep unverifiable live owners. */ }
    }
    return 'alive';
  } catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
export function sameRuntimeOwner(a, b) {
  if (!a || !b || a.unknown || b.unknown) return false;
  if (hasIdentity(a) && !sameProcessIdentity(a,a) || hasIdentity(b) && !sameProcessIdentity(b,b)) return false;
  if (hasIdentity(a) && hasIdentity(b)) return sameProcessIdentity(a,b);
  // A bare legacy journal cannot prove that it is the incarnation in a modern receipt.
  if (hasIdentity(a) || hasIdentity(b)) return false;
  return Number.isSafeInteger(a.pid) && a.pid > 0 && a.pid === b.pid && typeof a.host === 'string' && a.host.length > 0 && a.host === b.host;
}
export const isCurrentRuntimeOwner = owner => sameRuntimeOwner(owner, runtimeOwner());
export function nativeGuardianOwners(record) {
  return (record.guardianPids ?? []).map(pid => (Array.isArray(record.guardianOwners) ? record.guardianOwners.find(owner => owner?.pid === pid) : undefined) ?? {pid,host:record.owner?.host});
}

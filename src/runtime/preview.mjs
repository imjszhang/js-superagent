import { execFileSync } from 'node:child_process';

const DEFAULT_TTL = 30 * 60 * 1000, MAX_TTL = 2 * 60 * 60 * 1000;
export function previewTtl(value = DEFAULT_TTL) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > MAX_TTL) throw new Error('Preview TTL must be 1000 ms to two hours');
  return value;
}
export function normalizePreviewProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['url', 'ttlMs'].includes(key))) throw new Error('Invalid trusted preview profile');
  let url; try { url = new URL(value.url); } catch { throw new Error('Preview URL must be a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search || !url.port) throw new Error('Preview URL must use an explicit loopback HTTP port without credentials');
  return { url: url.toString(), ttlMs: previewTtl(value.ttlMs) };
}

/** Confirm that the listener is in the supervised command's process tree before opening its HTTP endpoint. */
export async function verifyOwnedPreview({ url, commandPid, signal }) {
  const normalized = normalizePreviewProfile({ url });
  if (!Number.isSafeInteger(commandPid) || commandPid <= 1 || commandPid === process.pid) throw new Error('Preview command has no verifiable process owner');
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n').map(line => {
    const [pid, ppid, state, ...birth] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), state, birth: birth.join(' ') };
  }).filter(row => !row.state.startsWith('Z'));
  const owned = new Set([commandPid]); let changed;
  do { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } } while (changed);
  if (!rows.some(row => row.pid === commandPid)) throw new Error('Preview command is no longer running');
  const port = new URL(normalized.url).port;
  let output;
  try { output = execFileSync('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024 }); }
  catch { throw new Error('Preview listener ownership is unavailable or the port is not listening'); }
  const listeners = [...new Set(output.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  if (!listeners.length || listeners.some(pid => !owned.has(pid))) throw new Error('Preview port is not exclusively owned by this managed command');
  const addresses = output.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  if (!addresses.length || addresses.some(address => ![`127.0.0.1:${port}`, `[::1]:${port}`].includes(address))) throw new Error('Preview listener must bind only to loopback');
  const signals = [AbortSignal.timeout(2000), ...(signal ? [signal] : [])];
  const response = await fetch(normalized.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any(signals) });
  await response.body?.cancel();
  if (response.status < 200 || response.status >= 400 || response.status >= 300 && response.headers.has('location')) throw new Error(`Preview endpoint is not ready (${response.status})`);
  return { url: normalized.url, checkedAt: new Date().toISOString(), status: response.status, listeners: listeners.map(pid => ({ pid, birth: rows.find(row => row.pid === pid)?.birth })) };
}

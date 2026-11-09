import { createServer } from 'node:http';
import { checkProjectSetup } from './setup.mjs';
import { createServiceManager } from './service.mjs';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_KEYS = /(?:password|private.?key|secret|token|authorization|cookie|environment|credential|executable|projectRoot|sourceProjectRoot|logPath|manifestPath|plistPath)/i;
const text = value => String(value).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
  .replace(/\b(?:github_pat_[A-Za-z\d_]+|gh[pousr]_[A-Za-z\d_]+|sk-[A-Za-z\d_-]{12,})\b/g, '[redacted]')
  .replace(/(?:\/[A-Za-z\d._-]+){2,}(?:\/[A-Za-z\d._-]+)*|[A-Za-z]:\\[^\s]+/g, match => '[local path]');
function sanitize(value, depth = 0, complete = false) {
  if (depth > (complete ? 64 : 15)) { if (complete) throw failure(413, 'Record nesting exceeds the readable limit'); return '[omitted]'; }
  if (typeof value === 'string') {
    if (/^https?:\/\/[^\s]+$/i.test(value)) {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[redacted URL]'; }
    }
    const redacted = text(value); return complete ? redacted : redacted.slice(0, 20_000);
  }
  if (Array.isArray(value)) return (complete ? value : value.slice(0, 200)).map(item => sanitize(item, depth + 1, complete));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).slice(0, complete ? undefined : 200)
    .map(([key, item]) => [key, key === 'path' && typeof item === 'string' && /^(?:\/|[A-Za-z]:)/.test(item) ? '[local path]' : sanitize(item, depth + 1, complete)]));
  return value;
}
const credential = () => randomBytes(32).toString('base64url');
function matches(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  const actualBytes = Buffer.from(actual), expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
const publicError = Symbol('management error');
function failure(statusCode, message) { return Object.assign(new Error(message), { statusCode, [publicError]: true }); }
const ticketRank = ticket => ['failed', 'interrupted', 'waiting'].includes(ticket?.status) ? 0 : ticket?.status === 'running' ? 1 : 2;
const ticketListOrder = (a, b) => ticketRank(a) - ticketRank(b) || String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
function onlyFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw failure(400, 'Invalid request fields');
}
function nativePreviewInput(body) {
  onlyFields(body,['leaseId','jobId','action','ttlMs']);
  if(!['renew','close'].includes(body.action)||!['leaseId','jobId'].every(key=>typeof body[key]==='string'&&/^[A-Za-z\d._:-]{1,160}$/.test(body[key]))||body.ttlMs!==undefined&&(!Number.isSafeInteger(body.ttlMs)||body.ttlMs<1000||body.ttlMs>7200000))throw failure(400,'Select an owned preview and a lifetime between one second and two hours');
}
function sessionReplacementInput(body) {
  onlyFields(body, ['reason', 'expectedSessionId', 'adoptCurrentSettings']);
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000 || (body.expectedSessionId !== null && (typeof body.expectedSessionId !== 'string' || body.expectedSessionId.length > 200)) || typeof body.adoptCurrentSettings !== 'boolean') throw failure(400, 'Session replacement needs a reason, current session and explicit settings choice');
}
function harnesses(runtime) {
  return typeof runtime.listHarnesses === 'function' ? runtime.listHarnesses() : [];
}
const commonExecutionFields = ['driver', 'adapterVersion', 'model', 'prompt', 'timeoutMs', 'killGraceMs', 'enableManagedJobs', 'enableAgentTools', 'contextLimits', 'requiredCapabilities'];
function knownHarness(runtime, driver, role) {
  if (!harnesses(runtime).some(item => item.id === driver && item.roles.includes(role))) throw failure(400, `Select a registered ${role} harness`);
}
function executionFieldsFor(runtime, driver) {
  const extra = harnesses(runtime).find(item => item.id === driver)?.settingsFields ?? [];
  if (!Array.isArray(extra) || extra.some(field => typeof field !== 'string')) throw failure(400, 'Invalid harness settings fields');
  return [...commonExecutionFields, ...extra];
}
function numberParam(value, fallback, max = 100) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw failure(400, 'Invalid pagination');
  return Number(value);
}
function queryParam(value) {
  if (value === null) return '';
  if (value.length > 200 || Buffer.byteLength(value) > 300 || /[\u0000-\u001f\u007f]/.test(value)) throw failure(400, 'Search text exceeds the supported limit');
  return value.trim();
}
function diagnosticOptions(url) {
  const cursor=url.searchParams.get('cursor'),source=url.searchParams.get('source'),problems=url.searchParams.get('problems');
  if(cursor&&cursor.length>2048 || source&&(!/^[A-Za-z\d._:-]{1,100}$/.test(source)) || problems!==null&&!['0','1'].includes(problems))throw failure(400,'Invalid diagnostic filters');
  const limit=numberParam(url.searchParams.get('limit'),20);
  if(!limit)throw failure(400,'Limit must be positive');
  return {limit,query:queryParam(url.searchParams.get('q')),...(cursor?{cursor}:{}),...(source?{source}:{}),problemsOnly:problems==='1',projectForSearch:value=>sanitize(value,0,true)};
}
function associationCatalog(runtime) {
  if (typeof runtime.getDomainTicket !== 'function') return [];
  return runtime.list().map(ticket => ({ ticket, domain: runtime.getDomainTicket(ticket.id) }));
}
async function contextAssociations(runtime, resource, id, value, catalog) {
  const links = { tickets: [], triggers: [], decisions: [], urls: [], truncated: false };
  const add = (kind, item) => { const key = kind === 'urls' ? 'url' : 'id'; if (links[kind].some(entry => entry[key] === item[key])) return; if (links[kind].length >= 20) { links.truncated = true; return; } links[kind].push(item); };
  const triggerIds = new Set(resource === 'triggers' ? [id] : []);
  for (const triggerId of [value?.triggerId, ...(Array.isArray(value?.triggerIds) ? value.triggerIds : []), value?.origin?.triggerId, value?.trigger?.id, ...(Array.isArray(value?.inputs) ? value.inputs : []).filter(input => input.kind === 'trigger').map(input => input.triggerId)]) if (typeof triggerId === 'string') triggerIds.add(triggerId);
  for (const triggerId of triggerIds) add('triggers', { id: triggerId });
  if (resource === 'decisions') add('decisions', { id });
  for (const { ticket, domain } of catalog) {
    const related = resource === 'tickets' && domain.id === id || value?.ticketId === domain.id || resource === 'threads' && Array.isArray(value?.subscriptions) && value.subscriptions.includes(domain.id)
      || [...triggerIds].some(triggerId => domain.origin?.triggerId === triggerId || domain.inputs?.some(input => input.kind === 'trigger' && input.triggerId === triggerId));
    if (related) { add('tickets', { id: ticket.id, title: String(ticket.text ?? '').slice(0, 160) }); for (const raw of [ticket.source?.url, ...(ticket.pullRequests ?? []).map(pull => pull.url)]) addURL(raw); }
  }
  if (resource === 'triggers' && id.length <= 200 && Buffer.byteLength(id) <= 300 && typeof runtime.readContext === 'function') {
    const decisions = await runtime.readContext('decisions', { query: id, limit: 100, textLimit: 16000 });
    for (const item of decisions.items ?? []) if (item.value?.triggerId === id || item.value?.triggerIds?.includes(id)) add('decisions', { id: item.id });
    if (decisions.nextCursor) links.truncated = true;
  }
  function addURL(raw) { if (typeof raw !== 'string') return; try { const url = new URL(raw); if (url.protocol !== 'https:') return; url.username = ''; url.password = ''; url.search = ''; url.hash = ''; add('urls', { url: url.href }); } catch {} }
  const visitURLs = (item, depth = 0) => { if (!item || typeof item !== 'object' || depth > 5) return; for (const [key, entry] of Object.entries(item).slice(0, 100)) { if (SECRET_KEYS.test(key)) continue; if (['url', 'html_url', 'webUrl'].includes(key)) addURL(entry); else if (entry && typeof entry === 'object') visitURLs(entry, depth + 1); } };
  visitURLs(value);
  return links;
}
const MAX_CONTEXT_RECORD_BYTES = 2 * 1024 * 1024;
/** Read a version-fenced local record through the existing SDK contract. Redact
 * the complete value before pagination so split secrets cannot bypass filtering. */
async function contextRecordView(runtime, resource, id, { offset, limit, version }) {
  if (typeof id !== 'string' || !id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id)) throw failure(400, 'Invalid record identity');
  if (limit < 100 || version !== null && !/^[a-f\d]{64}$/.test(version)) throw failure(400, 'Invalid record range or version');
  if (offset && !version) throw failure(400, 'Continuation requires the record version');
  const chunks = []; let sourceVersion, length, position = 0;
  while (true) {
    let record;
    try { record = await runtimeMethod(runtime, 'readContextRecord', resource, id, { offset: position, limit: 32_000, ...(sourceVersion ? { version: sourceVersion } : {}) }); }
    catch (error) { if (/record changed|current version/i.test(String(error.message))) throw failure(409, 'Record changed; reread from its first page'); throw error; }
    if (!record) throw failure(404, 'Context record was not found');
    if (!Number.isSafeInteger(record.length) || record.length < 0 || record.length > MAX_CONTEXT_RECORD_BYTES) throw failure(413, 'Record exceeds the 2 MiB readable limit');
    if (typeof record.text !== 'string' || record.text.length > 32_000 || record.offset !== position || sourceVersion && (sourceVersion !== record.version || length !== record.length)) throw failure(409, 'Record changed; reread from its first page');
    sourceVersion = record.version; length = record.length; chunks.push(record.text); position += record.text.length;
    if (record.nextOffset === null) { if (position !== length) throw failure(409, 'Record changed; reread from its first page'); break; }
    if (!record.text.length || record.nextOffset !== position || position >= length) throw failure(409, 'Record changed; reread from its first page');
  }
  const raw = chunks.join(''); if (Buffer.byteLength(raw) > MAX_CONTEXT_RECORD_BYTES) throw failure(413, 'Record exceeds the 2 MiB readable limit');
  const value = JSON.parse(raw), projected = JSON.stringify(sanitize(value, 0, true));
  if (Buffer.byteLength(projected) > MAX_CONTEXT_RECORD_BYTES) throw failure(413, 'Record exceeds the 2 MiB readable limit');
  const current = createHash('sha256').update('management-record-v1\0').update(projected).digest('hex');
  if (version && version !== current) throw failure(409, 'Record changed; reread from its first page');
  if (offset > projected.length) throw failure(400, 'Record offset is outside its content');
  const associations = offset === 0 ? sanitize(await contextAssociations(runtime, resource, id, value, associationCatalog(runtime))) : undefined;
  return { resource, id: sanitize(id), version: current, redacted: true, offset, text: projected.slice(offset, offset + limit), nextOffset: offset + limit < projected.length ? offset + limit : null, length: projected.length, ...(associations ? { associations } : {}) };
}
function runtimeMethod(runtime, name, ...args) {
  if (typeof runtime[name] !== 'function') throw failure(501, 'This runtime capability is not available');
  return runtime[name](...args);
}
function statusView(runtime) {
  const runtimeStatus = runtimeMethod(runtime, 'status');
  const github = typeof runtime.githubStatus === 'function' ? runtime.githubStatus() : { configured: false };
  const effects = (runtimeStatus.effects ?? []).filter(effect => !effect.cancelled);
  const sources = typeof runtime.sourceStatus === 'function' ? runtime.sourceStatus() : [];
  const scheduler = typeof runtime.schedulerStatus === 'function' ? runtime.schedulerStatus() : null;
  const business = typeof runtime.businessHealth === 'function' ? runtime.businessHealth() : null;
  const ingressHealth = business?.sources?.find(source => source.id === 'github:explicit');
  const oldestDue = effects.map(effect => typeof effect.due === 'number' ? effect.due : Date.parse(effect.due)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const groups = {};
  for (const effect of effects) groups[effect.kind] = (groups[effect.kind] ?? 0) + 1;
  return { projectId: runtime.projectId ?? null, runtime: { running: !!runtimeStatus.running, active: !!runtimeStatus.active, paused: !!runtimeStatus.paused,
    pause: runtimeStatus.pause ?? null, ingressActive: !!runtimeStatus.ingressActive, lastError: runtimeStatus.lastError ?? null },
  ingress: { configured: !!github.configured, repository: github.repository ?? null, lastSuccess: github.lastSync ?? null,
    lastError: github.lastError ?? null, state: ingressHealth?.state ?? null, healthy: !github.configured ? null : ingressHealth ? ingressHealth.healthy : !github.lastError && !!github.lastSync },
  sources: sources.map(source => ({ id: source.id, active: !!source.active, connection: source.connection ?? null, lastAttempt: source.lastAttempt ?? null, lastSuccess: source.lastSuccess ?? null,
    healthy: business?.sources?.find(item => item.id === source.id)?.healthy ?? (!source.error && source.connection !== 'error' && !!source.lastSuccess), error: source.connection === 'error' ? 'Feishu connection is unavailable.' : source.error ? 'Source synchronization failed; inspect local diagnostics.' : null })),
  scheduler: scheduler ? { maxWorkers: scheduler.maxWorkers, humanReserve: scheduler.humanReserve, active: (scheduler.active ?? []).length,
    held: (scheduler.active ?? []).filter(item => !item.yielded).length, yielded: (scheduler.active ?? []).filter(item => item.yielded).length } : null,
  queue: { count: effects.length, byKind: groups, oldestDue: oldestDue === undefined ? null : new Date(oldestDue).toISOString(), oldestDueAgeMs: oldestDue === undefined ? null : Math.max(0, Date.now() - oldestDue) },
  notifications: { pending: (github.notifications ?? []).filter(item => item.status === 'pending').length },
  business,
  capabilities: { delivery: typeof runtime.getDeliverySettings === 'function', incidents: typeof runtime.getIncidents === 'function', prompts: typeof runtime.promptStatus === 'function', scheduler: typeof runtime.configureScheduler === 'function', recovery: typeof runtime.getRecoverySettings === 'function', trace: typeof runtime.ticketTrace === 'function' },
  processHealthIsBusinessHealth: false };
}
function deliveryPolicyConfigured(runtime) {
  if (typeof runtime.getDeliverySettings !== 'function') return false;
  const settings = runtime.getDeliverySettings();
  return Number.isSafeInteger(settings?.revision) && settings.revision > 0 && ['local', 'draft-pr'].includes(settings.mode)
    && (settings.mode !== 'draft-pr' || settings.credentialMode === 'native-gh' && typeof settings.repository === 'string' && Array.isArray(settings.allowedPaths) && settings.allowedPaths.length > 0);
}

/** Explicit, loopback-only management endpoint. Importing it opens no socket and starts no runtime work. */
export async function createManagementServer(runtime, {
  host = '127.0.0.1', port = 0, token = credential(), maxBodyBytes = 64 * 1024,
  requestTimeoutMs = 10_000, maxConcurrentRequests = 32, sessionTtlMs = 8 * 60 * 60 * 1000,
} = {}) {
  if (!runtime || typeof runtime.list !== 'function' || typeof runtime.status !== 'function') throw new Error('A project runtime is required');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Management host must be loopback only');
  if (host === 'localhost') host = '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Management port must be 0 to 65535');
  if (typeof token !== 'string' || !/^[A-Za-z\d_-]{32,128}$/.test(token)) throw new Error('Management token must be 32 to 128 URL-safe characters');
  for (const [name, value, min, max] of [
    ['maxBodyBytes', maxBodyBytes, 1024, 1024 * 1024], ['requestTimeoutMs', requestTimeoutMs, 100, 30_000],
    ['maxConcurrentRequests', maxConcurrentRequests, 1, 256], ['sessionTtlMs', sessionTtlMs, 1000, 24 * 60 * 60 * 1000],
  ]) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: readFileSync(new URL('./ui/index.html', import.meta.url)) }],
    ['/drafts.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('./ui/drafts.js', import.meta.url)) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('./ui/app.js', import.meta.url)) }],
    ['/style.css', { type: 'text/css; charset=utf-8', body: readFileSync(new URL('./ui/style.css', import.meta.url)) }],
  ]);
  let origin, authority, closing = false, closePromise;
  let setupToken = credential();
  const setupExpires = Date.now() + 5 * 60 * 1000;
  const sessions = new Map();
  const cookieName = `js_superagent_${randomBytes(8).toString('hex')}`;
  const pending = new Set();
  const headerTimers = new WeakMap();
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin', 'Connection': 'close' };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: requestTimeoutMs, headersTimeout: requestTimeoutMs }, (request, response) => {
    clearTimeout(headerTimers.get(request.socket));
    let done = false, timer;
    const send = (status, value, extra = {}) => {
      if (done) return;
      done = true; clearTimeout(timer); pending.delete(abort);
      if (!response.destroyed) {
        let payload = typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(sanitize(value));
        if (Buffer.byteLength(payload) > 4 * 1024 * 1024) { status = 413; payload = JSON.stringify({ error: 'Response is too large; narrow the request' }); }
        response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); response.end(payload);
      }
      request.resume();
    };
    const abort = () => send(503, { error: 'Management server is closing' });
    const reject = error => {
      const message = String(error?.message ?? '');
      const status = error[publicError] ? error.statusCode : /revision conflict/i.test(message) ? 409 : /Unknown ticket/i.test(message) ? 404 : 400;
      send(status, { error: error[publicError] ? error.message : status === 409 ? 'Settings changed; reload before saving' : status === 404 ? 'Ticket was not found' : 'Operation is unavailable or its inputs are invalid' });
    };
    response.on('close', () => { done = true; clearTimeout(timer); pending.delete(abort); });
    request.on('error', () => send(400, { error: 'Invalid request' }));
    request.on('aborted', () => send(400, { error: 'Incomplete request' }));
    if (closing) { abort(); return; }
    if (pending.size >= maxConcurrentRequests) { send(429, { error: 'Too many requests' }); return; }
    pending.add(abort);
    timer = setTimeout(() => send(408, { error: 'Request timed out' }), requestTimeoutMs);
    try {
      const protectedNames = new Set(['host', 'origin', 'authorization', 'cookie', 'x-superagent-request', 'content-type', 'content-length', 'transfer-encoding', 'content-encoding']);
      const seen = new Set();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const key = request.rawHeaders[i].toLowerCase();
        if (protectedNames.has(key) && seen.has(key)) throw failure(400, 'Duplicate protected header');
        seen.add(key);
      }
      if (request.headers.host !== authority) throw failure(403, 'Host is not allowed');
      if (request.headers.origin && request.headers.origin !== origin) throw failure(403, 'Origin is not allowed');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Cross-site requests are not allowed');
      if (typeof request.url !== 'string' || request.url.length > 2048 || !request.url.startsWith('/') || request.url.startsWith('//')) throw failure(400, 'Invalid URL');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw failure(403, 'Origin is not allowed');
      if (!['GET', 'POST'].includes(request.method)) throw failure(405, 'Method is not allowed');
      if (request.method === 'GET' && assets.has(url.pathname) && !url.search) {
        const asset = assets.get(url.pathname); send(200, asset.body, { 'Content-Type': asset.type }); return;
      }
      let session, bearer = false;
      const auth = request.headers.authorization;
      if (auth !== undefined) {
        if (!matches(auth, `Bearer ${token}`)) throw failure(401, 'Authentication is required');
        bearer = true;
      } else {
        const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim().split('='));
        const matched = cookies.filter(([name]) => name === cookieName);
        if (matched.length === 1) {
          const candidate = sessions.get(matched[0][1]);
          if (candidate?.expires > Date.now() && matches(request.headers['x-superagent-request'], candidate.csrf)) session = candidate;
        }
      }
      if (url.pathname !== '/auth/session' && !bearer && !session) throw failure(401, 'Authentication is required');
      if (request.method === 'POST') {
        if (request.headers.origin !== origin || (!session && request.headers['x-superagent-request'] !== 'local-ui')) throw failure(403, 'A same-origin request marker is required');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) throw failure(415, 'JSON content is required');
        const length = request.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw failure(400, 'Invalid content length');
        if (Number(length) > maxBodyBytes) throw failure(413, 'Request body is too large');
        let bytes = 0; const chunks = [];
        request.on('data', chunk => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > maxBodyBytes) { chunks.length = 0; send(413, { error: 'Request body is too large' }); return; }
          chunks.push(chunk);
        });
        request.on('end', () => {
          if (done) return;
          if (!request.complete || (length !== undefined && Number(length) !== bytes)) { send(400, { error: 'Incomplete request' }); return; }
          let body;
          try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
          catch { send(400, { error: 'Invalid JSON' }); return; }
          void (async () => {
            if (url.pathname === '/auth/session') {
              onlyFields(body, ['setupToken']);
              if (setupToken === null || Date.now() > setupExpires || !matches(body.setupToken, setupToken)) throw failure(401, 'Setup link expired or already used');
              setupToken = null;
              for (const [id, saved] of sessions) if (saved.expires <= Date.now()) sessions.delete(id);
              const id = credential(), csrf = credential();
              sessions.set(id, { csrf, expires: Date.now() + sessionTtlMs });
              send(200, { csrf, expiresInMs: sessionTtlMs }, { 'Set-Cookie': `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}` }); return;
            }
            let result;
            if (url.pathname === '/api/controls') {
              onlyFields(body, ['requestId','method','args']);
              if (body.method === 'deliverTicket' && !deliveryPolicyConfigured(runtime)) throw failure(409, 'Configure a trusted delivery policy locally before resuming delivery');
              if (body.method === 'controlNativePreview') nativePreviewInput(body.args?.[1]);
              if (body.method === 'replaceSession') sessionReplacementInput(body.args?.[1]);
              result = await runtimeMethod(runtime, 'requestControl', body);
            }
            else if (url.pathname === '/api/pause') { onlyFields(body, ['reason']); await runtimeMethod(runtime, 'pause', body.reason); result = statusView(runtime); }
            else if (url.pathname === '/api/resume') { onlyFields(body, []); await runtimeMethod(runtime, 'resume'); result = statusView(runtime); }
            else if (url.pathname === '/api/coordinate') {
              onlyFields(body, ['text', 'id', 'management']);
              if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000 || (body.id !== undefined && (typeof body.id !== 'string' || !body.id.trim() || body.id.length > 256))) throw failure(400, 'A bounded project coordination message is required');
              result = await runtimeMethod(runtime, 'coordinate', body);
            }
            else if (url.pathname === '/api/coordination/retry') {
              onlyFields(body, ['id']);
              if (typeof body.id !== 'string' || !body.id.trim() || body.id.length > 256) throw failure(400, 'A coordination event ID is required');
              result = await runtimeMethod(runtime, 'retryCoordination', body.id);
            }
            else if (url.pathname === '/api/threads/unsubscribe') { onlyFields(body,['thread','expectedRevision']); result=await runtimeMethod(runtime,'unsubscribeThread',body.thread,{expectedRevision:body.expectedRevision}); }
            else if (url.pathname === '/api/decisions/dismiss') { onlyFields(body,['decisionId','expectedRevision']); result=await runtimeMethod(runtime,'dismissDecision',body.decisionId,{expectedRevision:body.expectedRevision}); }
            else if (url.pathname === '/api/coordinator') {
              onlyFields(body, ['settings', 'expectedRevision']);
              if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'expectedRevision is required');
              onlyFields(body.settings, ['policy', 'assessor', 'workflowMode', 'workRetry']);
              const settings = structuredClone(body.settings);
              if (settings.assessor) {
                const current = await runtimeMethod(runtime, 'coordinatorStatus');
                const previous = (current.settings ?? current).assessor;
                const driver = settings.assessor.driver ?? previous?.driver;
                if (typeof driver !== 'string' || !driver) throw failure(400, 'Select a registered coordinator harness');
                knownHarness(runtime, driver, 'coordinator');
                onlyFields(settings.assessor, executionFieldsFor(runtime, driver));
                settings.assessor = { ...(previous?.driver === driver ? previous : {}), ...settings.assessor, driver };
              }
              result = await runtimeMethod(runtime, 'configureCoordinator', settings, { expectedRevision: body.expectedRevision });
            } else if (url.pathname === '/api/executor') {
              onlyFields(body, ['settings', 'expectedRevision']);
              if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'expectedRevision is required');
              knownHarness(runtime, body.settings.driver, 'worker');
              onlyFields(body.settings, executionFieldsFor(runtime, body.settings.driver));
              const current = await runtimeMethod(runtime, 'executorStatus');
              const previous = current.settings?.execution ?? current.effective ?? {};
              const preserve = harnesses(runtime).find(item => item.id === body.settings.driver)?.preserveOnSave ?? [];
              const preserved = previous.driver === body.settings.driver ? Object.fromEntries(preserve.filter(key => previous[key] !== undefined).map(key => [key, previous[key]])) : {};
              const settings = { ...preserved, ...body.settings };
              result = await runtimeMethod(runtime, 'configureExecutor', settings, { expectedRevision: body.expectedRevision });
            } else if (url.pathname === '/api/repository') {
              onlyFields(body, ['settings', 'expectedRevision']);
              if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'expectedRevision is required');
              onlyFields(body.settings, ['enabled', 'observe', 'streams']);
              if (body.settings.streams !== undefined) onlyFields(body.settings.streams, ['pulls', 'issues', 'comments', 'reviewComments', 'mentions', 'defaultBranchCI']);
              result = await runtimeMethod(runtime, 'configureRepositorySource', body.settings, { expectedRevision: body.expectedRevision });
            } else if (url.pathname === '/api/delivery') {
              onlyFields(body, ['settings', 'expectedRevision']); onlyFields(body.settings, ['mode', 'automatic', 'review', 'uiEvidence']);
              if(body.settings.uiEvidence!==undefined) { onlyFields(body.settings.uiEvidence,['mode','scenario','viewport','theme','paths']); const previous=await runtimeMethod(runtime,'getDeliverySettings'); body.settings.uiEvidence={...previous.uiEvidence,...body.settings.uiEvidence}; }
              if(body.settings.review!==undefined)onlyFields(body.settings.review,['ready','requestReviewers','resolveThreads','reviewers','teams']);
              if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'expectedRevision is required');
              const { revision, at, ...previous } = await runtimeMethod(runtime, 'getDeliverySettings');
              result = await runtimeMethod(runtime, 'configureDelivery', { ...previous, ...body.settings }, { expectedRevision: body.expectedRevision });
            } else if (url.pathname === '/api/prompts/preview') {
              onlyFields(body, ['settings', 'expectedRevision']); onlyFields(body.settings, ['sections', 'overrides', 'knowledge']);
              result = await runtimeMethod(runtime, 'previewPrompts', body.settings, { expectedRevision: body.expectedRevision });
            } else if (['/api/prompts', '/api/scheduler', '/api/recovery'].includes(url.pathname)) {
              onlyFields(body, ['settings', 'expectedRevision']);
              if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'expectedRevision is required');
              if (url.pathname === '/api/prompts') { onlyFields(body.settings, ['sections', 'overrides', 'knowledge']); result = await runtimeMethod(runtime, 'configurePrompts', body.settings, { expectedRevision: body.expectedRevision, origin: 'panel' }); }
              else if (url.pathname === '/api/scheduler') { onlyFields(body.settings, ['maxWorkers', 'humanReserve']); result = await runtimeMethod(runtime, 'configureScheduler', body.settings, { expectedRevision: body.expectedRevision }); }
              else { onlyFields(body.settings, ['autoResume', 'retryBeforeStart', 'maxAttempts', 'initialDelayMs']); result = await runtimeMethod(runtime, 'configureRecovery', body.settings, { expectedRevision: body.expectedRevision }); }
            } else {
              const review = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/review$/.exec(url.pathname);
              const reviewRun = /^\/api\/review-actions\/([a-f\d]{64})\/run$/.exec(url.pathname);
              const botReview = /^\/api\/github\/bot-review\/([1-9]\d*)\/([1-9]\d*)\/(budget|associate)$/.exec(url.pathname);
              const nativePreview = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/native-preview$/.exec(url.pathname);
              const incident = /^\/api\/incidents\/([a-f\d]{24})\/ack$/.exec(url.pathname);
              const trigger = /^\/api\/triggers\/([^/]{1,3000})\/reevaluate$/.exec(url.pathname);
              const session = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/session\/replace$/.exec(url.pathname);
              const job = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/jobs\/([A-Za-z\d._:-]{1,200})\/(preview|renew|close|cancel|adopt|message|reply|resume)$/.exec(url.pathname);
              const statusRequest = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/request-status$/.exec(url.pathname);
              const adoptionRecovery = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/adoptions\/([a-f\d-]{36})\/recover$/.exec(url.pathname);
              if(review) {
                onlyFields(body,['kind','pullNumber','reviewers','teams','commentId','triggerId','reason','disposition']);
                if(!['ready','requestReviewers','resolveThread','finding'].includes(body.kind))throw failure(400,'Select a supported PR review action');
                result=await runtimeMethod(runtime,'requestPRReview',review[1],body);
              } else if(reviewRun) {onlyFields(body,[]);result=await runtimeMethod(runtime,'runPRReview',reviewRun[1]);}
              else if(botReview) {
                onlyFields(body,botReview[3]==='budget'?['remaining','reason','expectedRevision']:['eventIds','runId','reason']);
                if(!Number.isSafeInteger(Number(botReview[1])) || !Number.isSafeInteger(Number(botReview[2])))throw failure(400,'Invalid PR or actor identity');
                if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500)throw failure(400,'An explanation of at most 500 characters is required');
                if(botReview[3]==='budget' && (!Number.isSafeInteger(body.remaining)||body.remaining<0||body.remaining>3||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0))throw failure(400,'Select 0 to 3 remaining rounds and the current revision');
                if(botReview[3]==='associate' && (!Array.isArray(body.eventIds)||!body.eventIds.length||body.eventIds.length>100||body.eventIds.some(id=>typeof id!=='string'||!id||id.length>500)||typeof body.runId!=='string'||!body.runId.trim()||body.runId.length>500))throw failure(400,'Use original event IDs and a bounded review-run ID');
                result=await runtimeMethod(runtime,botReview[3]==='budget'?'setBotReviewBudget':'associateBotReviewRun',Number(botReview[1]),botReview[2],body);
              } else if(nativePreview) {
                nativePreviewInput(body);
                result=await runtimeMethod(runtime,'controlNativePreview',nativePreview[1],body);
              } else if (incident) { onlyFields(body, ['expectedRevision']); result = await runtimeMethod(runtime, 'acknowledgeIncident', incident[1], body); }
              else if (trigger) { onlyFields(body, []); result = await runtimeMethod(runtime, 'reevaluate', decodeURIComponent(trigger[1])); }
              else if (session) {
                sessionReplacementInput(body);
                result = await runtimeMethod(runtime, 'replaceSession', session[1], body);
              } else if (job) {
                onlyFields(body, job[3] === 'adopt' ? ['expectedPlanDigest'] : ['message','reply','resume'].includes(job[3]) ? ['text','requestId'] : ['ttlMs', 'reason']);
                result = await runtimeMethod(runtime, job[3] === 'adopt' ? 'adoptChild' : 'jobControl', job[1], job[2], job[3] === 'adopt' ? body : { ...body, action: job[3] });
              } else if (statusRequest) { onlyFields(body, []); result = await runtimeMethod(runtime, 'requestStatus', statusRequest[1]); }
              else if (adoptionRecovery) { onlyFields(body, ['mode']); if(!['rollback','finish'].includes(body.mode))throw failure(400,'Select rollback or finish'); result = await runtimeMethod(runtime, 'recoverChildAdoption', adoptionRecovery[1], adoptionRecovery[2], body); }
              else {
              const match = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/(reply|retry|cancel|deliver)$/.exec(url.pathname);
              if (!match) throw failure(404, 'Endpoint was not found');
              onlyFields(body, match[2] === 'reply' ? ['text'] : []);
              if (match[2] === 'reply' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000)) throw failure(400, 'Reply text must be 1 to 20000 characters');
              if (match[2] === 'deliver' && !deliveryPolicyConfigured(runtime)) throw failure(409, 'Configure a trusted delivery policy locally before resuming delivery');
              result = await runtimeMethod(runtime, match[2] === 'deliver' ? 'deliverTicket' : match[2], match[1], body.text);
              }
            }
            send(200, result);
          })().catch(reject);
        });
        return;
      }
      void (async () => {
        let result;
        if (url.pathname === '/api/status') result = statusView(runtime);
        else if (url.pathname === '/api/tickets') {
          const offset = numberParam(url.searchParams.get('offset'), 0, 1_000_000), limit = numberParam(url.searchParams.get('limit'), 50);
          if (!limit) throw failure(400, 'Limit must be positive');
          const query = queryParam(url.searchParams.get('q')), all = await runtimeMethod(runtime, 'list');
          const tickets = (query ? all.filter(ticket => {
            const domain = typeof runtime.getDomainTicket === 'function' ? runtime.getDomainTicket(ticket.id) : null;
            return JSON.stringify(sanitize({ ticket, origin: domain?.origin, inputs: domain?.inputs }, 0, true)).toLowerCase().includes(query.toLowerCase());
          }) : all).toSorted(ticketListOrder);
          result = { items: tickets.slice(offset, offset + limit), total: tickets.length, nextOffset: offset + limit < tickets.length ? offset + limit : null, query };
        } else if (url.pathname === '/api/coordinator') result = { ...await runtimeMethod(runtime, 'coordinatorStatus'), harnesses: harnesses(runtime) };
        else if (url.pathname === '/api/diagnostics/events') result=await runtimeMethod(runtime,'eventDiagnostics',diagnosticOptions(url));
        else if (url.pathname === '/api/diagnostics/replies') result=await runtimeMethod(runtime,'replyDiagnostics',diagnosticOptions(url));
        else if (url.pathname === '/api/diagnostics/event') {
          const id=url.searchParams.get('id');
          if(!id||id.length>1024||/[\u0000-\u001f\u007f]/.test(id))throw failure(400,'Invalid event identity');
          result=await runtimeMethod(runtime,'eventDiagnostic',id,{projectForSearch:value=>sanitize(value,0,true)});
          if(!result)throw failure(404,'Event record was not found');
        }
        else if (url.pathname === '/api/setup') result=await checkProjectSetup({projectRoot:runtime.projectRoot});
        else if (url.pathname === '/api/service-health') result=process.platform==='darwin'?createServiceManager({projectRoot:runtime.projectRoot}).health():{state:'unsupported',healthy:false};
        else if (url.pathname === '/api/controls') result=await runtimeMethod(runtime,'listControls',{limit:numberParam(url.searchParams.get('limit'),30)});
        else if (/^\/api\/controls\/[A-Za-z\d._:-]{1,200}$/.test(url.pathname)) result=await runtimeMethod(runtime,'controlStatus',url.pathname.split('/').at(-1));
        else if (url.pathname === '/api/management') result=await runtimeMethod(runtime,'managementStatus');
        else if (url.pathname === '/api/coordination') result = await runtimeMethod(runtime, 'coordinationStatus');
        else if (url.pathname === '/api/executor') result = { ...await runtimeMethod(runtime, 'executorStatus'), harnesses: harnesses(runtime) };
        else if (url.pathname === '/api/repository') result = await runtimeMethod(runtime, 'getRepositorySourceSettings');
        else if (url.pathname === '/api/github/bot-review') result = await runtimeMethod(runtime, 'botReviewStatus');
        else if (url.pathname === '/api/review-actions') result = await runtimeMethod(runtime, 'reviewActionStatus');
        else if (url.pathname === '/api/delivery') result = await runtimeMethod(runtime, 'getDeliverySettings');
        else if (url.pathname === '/api/prompts') result = await runtimeMethod(runtime, 'promptStatus');
        else if (url.pathname === '/api/incidents') result = await runtimeMethod(runtime, 'getIncidents', { includeResolved: url.searchParams.get('resolved') !== 'false', limit: numberParam(url.searchParams.get('limit'), 100, 500) });
        else if (url.pathname === '/api/scheduler') result = await runtimeMethod(runtime, 'schedulerStatus');
        else if (url.pathname === '/api/recovery') result = await runtimeMethod(runtime, 'getRecoverySettings');
        else {
          const ticket = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})(?:\/(details|workspace|trace|jobs|session|adoptions))?$/.exec(url.pathname);
          const adoption = /^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/jobs\/([A-Za-z\d._:-]{1,200})\/adoption$/.exec(url.pathname);
          const context = /^\/api\/context\/(tickets|threads|decisions|triggers)$/.exec(url.pathname);
          const contextRecord = /^\/api\/context\/(tickets|threads|decisions|triggers)\/record$/.exec(url.pathname);
          const uiImage=/^\/api\/tickets\/([A-Za-z\d._:-]{1,200})\/ui-evidence\/(before|after)\.png$/.exec(url.pathname);
          if(uiImage){send(200,await runtimeMethod(runtime,'readUIEvidenceImage',uiImage[1],uiImage[2]),{'Content-Type':'image/png'});return;}
          if (ticket) {
            const method = { details: 'getDetailed', workspace: 'inspectWorkspace', trace: 'ticketTrace', jobs: 'listJobs', session: 'sessionStatus', adoptions: 'listChildAdoptions' }[ticket[2]] ?? 'get';
            const cursor = url.searchParams.get('cursor'); if (cursor && cursor.length > 2048) throw failure(400, 'Cursor is too long');
            result = await runtimeMethod(runtime, method, ticket[1], ticket[2] === 'trace' ? { ...(cursor ? { cursor } : {}), limit: numberParam(url.searchParams.get('limit'), 30) } : undefined);
            if (ticket[2] === 'details') result = { ...result, managementActions: { deliveryConfigured: deliveryPolicyConfigured(runtime), trace: typeof runtime.ticketTrace === 'function', jobs: typeof runtime.listJobs === 'function', jobControl: typeof runtime.jobControl === 'function', adoption: typeof runtime.adoptChild === 'function', adoptionRecovery: typeof runtime.recoverChildAdoption === 'function', session: typeof runtime.sessionStatus === 'function', requestStatus: typeof runtime.requestStatus === 'function', prReview: typeof runtime.requestPRReview === 'function', botReview: typeof runtime.setBotReviewBudget === 'function', nativePreview: typeof runtime.controlNativePreview === 'function' } };
            if (['details', 'session'].includes(ticket[2]) && typeof runtime.actionAvailability === 'function') result = { ...result, actionAvailability: await runtime.actionAvailability(ticket[1]) };
            if (ticket[2] === 'trace') { const catalog = associationCatalog(runtime); result = { ...result, items: await Promise.all(result.items.map(async event => ({ ...event, associations: await contextAssociations(runtime, ({trigger:'triggers',decision:'decisions',thread:'threads'})[event.kind] ?? 'trace', event.id, event.kind === 'trigger' ? event.value.trigger : event.value, catalog) }))) }; }
          }
          else if (adoption) result = await runtimeMethod(runtime, 'planChildAdoption', adoption[1], adoption[2]);
          else if (contextRecord) {
            result = await contextRecordView(runtime, contextRecord[1], url.searchParams.get('id'), { offset: numberParam(url.searchParams.get('offset'), 0, MAX_CONTEXT_RECORD_BYTES), limit: numberParam(url.searchParams.get('limit'), 8000, 16000), version: url.searchParams.get('version') });
            // This exact JSON projection was redacted before slicing. Sending it as
            // serialized JSON prevents a second lossy filter from changing offsets.
            send(200, JSON.stringify(result)); return;
          }
          else if (context) {
            const cursor = url.searchParams.get('cursor');
            if (cursor && cursor.length > 1024) throw failure(400, 'Cursor is too long');
            result = await runtimeMethod(runtime, 'readContext', context[1], { ...(cursor ? { cursor } : {}), limit: numberParam(url.searchParams.get('limit'), 20), query: queryParam(url.searchParams.get('q')), projectForSearch: value => sanitize(value, 0, true) });
            const catalog = associationCatalog(runtime);
            result = { ...result, items: await Promise.all((result.items ?? []).map(async item => {
              if (item.truncated) {
                try { const view = await contextRecordView(runtime, context[1], item.id, { offset: 0, limit: 4000, version: null }); return { ...item, preview: view.text, associations: view.associations, redacted: true }; }
                catch (error) { if (error[publicError] && error.statusCode === 413) return { ...item, preview: '[Record exceeds the readable limit; inspect local diagnostics]', redacted: true, associations: await contextAssociations(runtime, context[1], item.id, undefined, catalog) }; throw error; }
              }
              return { ...item, associations: await contextAssociations(runtime, context[1], item.id, item.value, catalog) };
            })) };
          } else throw failure(404, 'Endpoint was not found');
        }
        send(200, result);
      })().catch(reject);
    } catch (error) { reject(error); }
  });
  server.keepAliveTimeout = 1000;
  server.maxConnections = maxConcurrentRequests * 2;
  server.maxRequestsPerSocket = 100;
  server.on('connection', socket => {
    const timer = setTimeout(() => socket.destroy(), requestTimeoutMs);
    headerTimers.set(socket, timer); socket.on('close', () => clearTimeout(timer));
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  authority = `${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  origin = `http://${authority}`;
  return { url: `${origin}/`, token, bootstrapUrl: `${origin}/#setup=${setupToken}`,
    close() {
      if (closePromise) return closePromise;
      closing = true; setupToken = null; sessions.clear();
      for (const abort of [...pending]) abort();
      closePromise = new Promise((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), 1000); force.unref();
        server.close(error => { clearTimeout(force); if (error) reject(error); else resolve(); });
        server.closeIdleConnections();
      });
      return closePromise;
    } };
}

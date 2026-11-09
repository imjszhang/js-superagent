import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

const DEFAULT_LIMIT = 1024 * 1024;
const MAX_LIMIT = 25 * 1024 * 1024;
const DELIVERY = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const EVENT = /^[a-z][a-z\d_]{0,63}$/;
const MESSAGES = {
  400: 'Invalid webhook request', 401: 'Invalid webhook signature', 403: 'Webhook source is not allowed',
  404: 'Webhook endpoint not found', 405: 'POST required', 408: 'Webhook request timed out',
  409: 'Webhook delivery conflicts with a recorded delivery', 413: 'Webhook body is too large',
  415: 'Webhook requires uncompressed application/json', 422: 'Webhook payload cannot be processed',
  429: 'Too many webhook requests', 431: 'Webhook headers are too large',
  500: 'Webhook processing failed', 503: 'Webhook receiver is unavailable',
};
function failure(statusCode) {
  const error = new Error(MESSAGES[statusCode] ?? MESSAGES[500]);
  error.statusCode = statusCode;
  return error;
}
function bodyLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw new Error('Webhook maxBodyBytes must be between 1 and 26214400');
  return value;
}
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  // A plain header record preserves case variants and array-valued duplicates.
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  const matches = entries.filter(([key]) => String(key).toLowerCase() === name);
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') return undefined;
  return matches[0][1];
}

/** Verify the original wire bytes before decoding or interpreting any payload fields. */
export function verifyGitHubWebhook({ body, headers, secret, maxBodyBytes = DEFAULT_LIMIT } = {}) {
  const limit = bodyLimit(maxBodyBytes);
  if (!(body instanceof Uint8Array)) throw failure(400);
  if (body.byteLength > limit) throw failure(413);
  if (!((typeof secret === 'string' && secret.length > 0) || (secret instanceof Uint8Array && secret.byteLength > 0))) throw failure(503);
  const signature = headerValue(headers, 'x-hub-signature-256');
  if (typeof signature !== 'string' || !/^sha256=[a-f\d]{64}$/i.test(signature)) throw failure(401);
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(signature.slice(7), 'hex');
  if (!timingSafeEqual(expected, actual)) throw failure(401);
  const deliveryId = headerValue(headers, 'x-github-delivery'), event = headerValue(headers, 'x-github-event');
  if (typeof deliveryId !== 'string' || !DELIVERY.test(deliveryId) || typeof event !== 'string' || !EVENT.test(event)) throw failure(400);
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw failure(400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure(400);
  return { deliveryId: deliveryId.toLowerCase(), event, payload, bodySha256: createHash('sha256').update(body).digest('hex') };
}

/**
 * Start a bounded HTTP ingress explicitly. The runtime synchronously verifies and
 * persists deliveries; this handler never polls GitHub or starts a Worker.
 */
export async function listenGitHubWebhook(runtime, {
  host = '127.0.0.1', port = 0, path = '/github/webhook', maxBodyBytes = DEFAULT_LIMIT,
  requestTimeoutMs = 10_000, maxConcurrentRequests = 32,
} = {}) {
  if (!runtime || typeof runtime.receiveGitHubWebhook !== 'function') throw new Error('A runtime with receiveGitHubWebhook is required');
  if (typeof host !== 'string' || !(isIP(host) || host === 'localhost')) throw new Error('Webhook host must be an IP address or localhost');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Webhook port must be between 0 and 65535');
  if (typeof path !== 'string' || !/^\/[A-Za-z\d/_-]*$/.test(path) || path.length > 256) throw new Error('Webhook path must be an absolute URL path without a query');
  const limit = bodyLimit(maxBodyBytes);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 10_000) throw new Error('Webhook requestTimeoutMs must be between 100 and 10000');
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 256) throw new Error('Webhook maxConcurrentRequests must be between 1 and 256');
  const pending = new Set();
  const respondedSockets = new WeakSet();
  const connections = new WeakMap();
  let closing = false, closePromise;
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: requestTimeoutMs, headersTimeout: requestTimeoutMs }, (request, response) => {
    const connection = connections.get(request.socket);
    clearTimeout(connection?.timer);
    let ended = false, timer, counted = false;
    const finish = (code, result) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      if (counted) pending.delete(abort);
      if (!response.destroyed && !response.writableEnded) {
        respondedSockets.add(request.socket);
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'close',
          ...(code === 405 ? { Allow: 'POST' } : {}) });
        response.end(JSON.stringify(result ?? { error: MESSAGES[code] ?? MESSAGES[500] }));
      }
      request.resume();
    };
    const abort = () => finish(503);
    request.on('error', () => finish(400));
    request.on('aborted', () => finish(400));
    response.on('close', () => { clearTimeout(timer); pending.delete(abort); ended = true; });
    if (closing) { finish(503); return; }
    if (request.url !== path) { finish(404); return; }
    if (request.method !== 'POST') { finish(405); return; }
    if (pending.size >= maxConcurrentRequests) { finish(429); return; }
    const protectedHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'content-type', 'content-encoding', 'x-hub-signature-256', 'x-github-event', 'x-github-delivery']);
    const seen = new Set();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index].toLowerCase();
      if (protectedHeaders.has(name) && seen.has(name)) { finish(400); return; }
      seen.add(name);
    }
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(contentType) ||
        (request.headers['content-encoding'] && request.headers['content-encoding'].toLowerCase() !== 'identity')) { finish(415); return; }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { finish(400); return; }
    if (length !== undefined && Number(length) > limit) { finish(413); return; }
    const transfer = request.headers['transfer-encoding'];
    if (transfer && transfer.toLowerCase() !== 'chunked') { finish(400); return; }
    counted = true; pending.add(abort);
    timer = setTimeout(() => finish(408), Math.max(1, requestTimeoutMs - (Date.now() - (connection?.startedAt ?? Date.now()))));
    let bytes = 0;
    const chunks = [];
    request.on('data', chunk => {
      if (ended) return;
      bytes += chunk.byteLength;
      if (bytes > limit) { chunks.length = 0; finish(413); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (ended) return;
      if (!request.complete || (length !== undefined && Number(length) !== bytes)) { finish(400); return; }
      try {
        const result = runtime.receiveGitHubWebhook({ body: Buffer.concat(chunks, bytes), headers: request.headers });
        if (result && typeof result.then === 'function') {
          // Do not accidentally acknowledge an asynchronous or non-durable adapter.
          Promise.resolve(result).catch(() => {});
          throw failure(500);
        }
        if (!result || !['accepted', 'duplicate', 'ignored'].includes(result.status) || !DELIVERY.test(result.deliveryId ?? '')) throw failure(500);
        finish(result.status === 'accepted' ? 202 : 200, { status: result.status, deliveryId: result.deliveryId });
      } catch (error) {
        const status = Object.hasOwn(MESSAGES, error?.statusCode) ? Number(error.statusCode) : 500;
        finish(status);
      }
    });
  });
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = maxConcurrentRequests * 2;
  server.on('connection', socket => {
    const entry = { startedAt: Date.now(), timer: undefined };
    entry.timer = setTimeout(() => {
      if (!socket.writable || respondedSockets.has(socket)) { socket.destroy(); return; }
      respondedSockets.add(socket);
      const body = JSON.stringify({ error: MESSAGES[408] });
      socket.end(`HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }, requestTimeoutMs);
    connections.set(socket, entry);
    socket.on('close', () => clearTimeout(entry.timer));
  });
  server.on('clientError', (error, socket) => {
    if (!socket.writable) { socket.destroy(); return; }
    // A parser error after an early rejection must not append a second HTTP response.
    if (respondedSockets.has(socket)) { socket.end(); return; }
    respondedSockets.add(socket);
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const body = JSON.stringify({ error: MESSAGES[status] });
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${hostname}:${address.port}${path}`,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const abort of [...pending]) abort();
      closePromise = new Promise((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), Math.min(1000, requestTimeoutMs));
        force.unref();
        server.close(error => { clearTimeout(force); if (error) reject(error); else resolve(); });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}

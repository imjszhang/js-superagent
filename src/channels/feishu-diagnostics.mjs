// Diagnostics are observations only: they never authorize a retry or change source progress.
const readErrors = new WeakMap();
const reasons = new Set(['timeout', 'cancelled', 'network', 'http', 'api', 'response', 'validation', 'unknown']);
const phases = new Set(['auth', 'request', 'history', 'validation']);
const cancellations = new Set(['deadline', 'stop', 'caller', 'request']);
const transportCodes = new Set([
  'FEISHU_READ_TIMEOUT', 'FEISHU_STOPPED', 'ERR_CANCELED', 'ERR_NETWORK', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE',
  'ERR_FR_TOO_MANY_REDIRECTS', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EPROTO', 'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const timeoutCodes = new Set(['ETIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_TLS_HANDSHAKE_TIMEOUT']);
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const field = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
function axiosHttpTimeout(error) {
  // Axios's Node HTTP timer constructs ECONNABORTED directly. Wrapped socket errors
  // carry a cause, while XHR aborts have no Node request methods. Do not infer from text.
  const timeout = field(field(error, 'config'), 'timeout'), request = field(error, 'request');
  return field(error, 'code') === 'ECONNABORTED' && field(error, 'isAxiosError') === true &&
    field(error, 'cause') === undefined && field(error, 'response') === undefined &&
    typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 &&
    typeof field(request, 'setTimeout') === 'function' && typeof field(request, 'on') === 'function';
}

/** A shared, bounded allowlist for source persistence, health and service summaries. */
export function sanitizeFeishuDiagnostic(value) {
  const reason = field(value, 'reason'), phase = field(value, 'phase'), transportCode = field(value, 'transportCode');
  const cancellationSource = field(value, 'cancellationSource'), statusCode = field(value, 'statusCode'), elapsedMs = field(value, 'elapsedMs');
  const failedAt = field(value, 'failedAt');
  const validTime = typeof failedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(failedAt) &&
    Number.isFinite(Date.parse(failedAt)) && new Date(failedAt).toISOString() === failedAt;
  return {
    ...(reasons.has(reason) ? { reason } : {}),
    ...(transportCodes.has(transportCode) ? { transportCode } : {}),
    ...(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
    ...(phases.has(phase) ? { phase } : {}),
    ...(Number.isInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 86_400_000 ? { elapsedMs } : {}),
    ...(cancellations.has(cancellationSource) ? { cancellationSource } : {}),
    ...(validTime ? { failedAt } : {}),
  };
}

/** Safe fallback for custom SDK clients. Untrusted error/config/signal text is never retained. */
export function getFeishuTransportErrorDiagnostic(error) {
  const code = field(error, 'code'), causeCode = field(field(error, 'cause'), 'code');
  const transportCode = transportCodes.has(code) ? code : transportCodes.has(causeCode) ? causeCode : undefined;
  const status = field(field(error, 'response'), 'status');
  const statusCode = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const reason = statusCode !== undefined ? 'http' : transportCode === 'ERR_CANCELED' ? 'cancelled'
    : timeoutCodes.has(transportCode) || axiosHttpTimeout(error) ? 'timeout'
      : transportCode && !['FEISHU_READ_TIMEOUT', 'FEISHU_STOPPED'].includes(transportCode) ? 'network' : 'unknown';
  return sanitizeFeishuDiagnostic({ reason, transportCode, statusCode });
}

/** Record only facts produced by the read wrapper; leave the SDK's thrown value untouched. */
export function recordFeishuReadDiagnostic(error, details) {
  if (!object(error)) return;
  const diagnostic = sanitizeFeishuDiagnostic({ ...getFeishuTransportErrorDiagnostic(error), ...details, failedAt: new Date().toISOString() });
  readErrors.set(error, Object.freeze(diagnostic));
}

export function getFeishuReadDiagnostic(error) { return object(error) ? readErrors.get(error) : undefined; }

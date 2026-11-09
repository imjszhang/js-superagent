const HOST_TOOLS = new Set(['read', 'ack', 'handback', 'follow', 'unrelated', 'report', 'job_start', 'job_status', 'job_wait', 'job_cancel', 'job_preview', 'preview_close'].map(name => `js_superagent_${name}`));
export function recoveryInspection(input, reason) {
  return input?.diagnostics ? { version: 1, kind: 'inspection', safeToResume: false, reason,
    ...(input.session ? { session: input.session } : {}), ...(input.runId ? { runId: input.runId } : {}) } : null;
}
export function nativeJsonResult(blocks, type = 'text') {
  if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== type || typeof blocks[0].text !== 'string' || Buffer.byteLength(blocks[0].text) > 64000) throw new Error('Unknown native host-tool result');
  return JSON.parse(blocks[0].text);
}
/** Native settlement and host settlement are independent requirements. No Store access in an adapter. */
export function hostToolSettled(verify, query) {
  if (!HOST_TOOLS.has(query.name) || typeof verify !== 'function' || !query.arguments || typeof query.arguments !== 'object' || Array.isArray(query.arguments)) return false;
  try { return verify(structuredClone(query)) === true; } catch { return false; }
}

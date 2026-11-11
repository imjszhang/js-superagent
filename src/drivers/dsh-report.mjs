const STATES = ['ready', 'waiting', 'blocked', 'failed', 'dropped'];
function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${name} field: ${key}`);
}
// DeepSeek models sometimes put a sentence before the required JSON. Only a report that ends the
// message (optionally fenced) is accepted; it then passes the same validation as a bare report.
function trailingReport(text) {
  const body = text.trim().replace(/\n?```\s*$/, '');
  for (let index = body.lastIndexOf('{'), attempts = 0; index >= 0 && attempts < 200; index = body.lastIndexOf('{', index - 1), attempts++) {
    try {
      const value = JSON.parse(body.slice(index).trim());
      if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 2) return value;
    } catch { /* keep scanning outward */ }
  }
  throw new Error('DSH final response is not a JSON report');
}
export function parseDshReport(text) {
  let value; try { value = JSON.parse(text); } catch { value = trailingReport(text); }
  object(value, 'DSH report', ['version', 'state', 'summary', 'artifacts', 'attention', 'answers']);
  if (value.version !== 2 || !STATES.includes(value.state) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 32000 || !Array.isArray(value.artifacts) || value.artifacts.some(item => typeof item !== 'string')) throw new Error('Invalid DSH business report');
  if (value.attention != null) { object(value.attention, 'DSH attention', ['question', 'triggerId', 'decision']); if (value.state !== 'waiting' || typeof value.attention.question !== 'string' || !value.attention.question.trim()) throw new Error('Invalid DSH question'); }
  if (value.answers == null) delete value.answers;
  return value;
}

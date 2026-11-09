import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
function text(value) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 128 * 1024) throw new Error('Invalid Worker policy text');
  return value;
}
function assembly(value) {
  if (!value || value.role !== 'worker' || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.digest !== sha(text(value.text)) || value.version !== `assembled-v1:${value.digest.slice(0, 24)}`) throw new Error('Worker policy assembly is not verifiable');
  return value;
}

/** Keep the original static execution prompt/signature intact, and prove a separate per-turn policy layer. */
export function resolveWorkerPolicy({ executionPrompt, legacyAssembly, currentAssembly, hasSession = false, binding } = {}) {
  const original = text(executionPrompt ?? ''), sourcePromptDigest = sha(original), current = assembly(currentAssembly);
  let next;
  if (binding) {
    if (binding.version !== 2 || binding.sourcePromptDigest !== sourcePromptDigest || binding.baseDigest !== sha(text(binding.basePrompt))) throw new Error('Worker policy static binding changed');
    next = structuredClone(binding);
  } else if (legacyAssembly) {
    let previous;
    try { previous = assembly(legacyAssembly); } catch { return { status: 'legacy-unresolved', reason: 'historical-policy-assembly-invalid', snapshot: null, binding: null }; }
    let base;
    if (original === previous.text) base = '';
    else if (original.endsWith(`\n\n${previous.text}`)) base = original.slice(0, -previous.text.length - 2);
    else return { status: 'legacy-unresolved', reason: 'historical-policy-does-not-match-static-prompt', snapshot: null, binding: null };
    if ([base, previous.text].filter(Boolean).join('\n\n') !== original) return { status: 'legacy-unresolved', reason: 'historical-policy-cannot-be-separated-exactly', snapshot: null, binding: null };
    next = { version: 2, origin: 'legacy-exact', sourcePromptDigest, basePrompt: base, baseDigest: sha(base), legacyRevision: previous.revision, legacyDigest: previous.digest };
  } else if (hasSession) return { status: 'legacy-unresolved', reason: 'historical-policy-assembly-missing', snapshot: null, binding: null };
  else next = { version: 2, origin: 'new', sourcePromptDigest, basePrompt: original, baseDigest: sourcePromptDigest };
  return { status: 'ready', binding: next, snapshot: { version: 1, revision: current.revision, digest: current.digest, settingsVersion: current.settingsVersion,
    text: current.text, basePrompt: next.basePrompt, baseDigest: next.baseDigest, sourcePromptDigest } };
}

/** Adapter validation never changes the factory's fixed prompt or recovery signature. */
export function workerPolicyGuidance(fixedPrompt, snapshot) {
  if (!snapshot) return fixedPrompt;
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.sourcePromptDigest !== sha(text(fixedPrompt ?? '')) ||
      snapshot.digest !== sha(text(snapshot.text)) || snapshot.baseDigest !== sha(text(snapshot.basePrompt))) throw new Error('Worker policy snapshot does not match the fixed execution binding');
  return [snapshot.basePrompt, `Current team business policy revision ${snapshot.revision} (${snapshot.digest}). This revision replaces earlier team business policy in this session. It cannot change the host mandate, tool permissions or publication restrictions.\n${snapshot.text}`].filter(Boolean).join('\n\n');
}

export function workerPolicyObservation(snapshot, status, evidence) {
  if (!snapshot) return null;
  if (!['selected', 'accepted', 'applied'].includes(status)) throw new Error('Unknown Worker policy application state');
  return { version: 1, revision: snapshot.revision, digest: snapshot.digest, status, at: new Date().toISOString(), evidence: structuredClone(evidence) };
}

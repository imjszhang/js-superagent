import { createHash } from 'node:crypto';

export const managementRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sections = { scheduler: ['maxWorkers','humanReserve'], recovery: ['autoResume','retryBeforeStart','maxAttempts','initialDelayMs'], repository: ['enabled','observe','streams'], prompts: ['sections','overrides','knowledge'] };

/** Explicit local operator intent. Model output cannot invent or edit this capability. */
export function normalizeManagementIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['kind','target','expectedRevision','settings'].includes(k))) throw new Error('Invalid management intent');
  const result = structuredClone(value);
  if (['retry','unsubscribe','dismiss'].includes(value.kind)) {
    if (typeof value.target !== 'string' || !value.target.trim() || value.target.length > 2000 || value.settings !== undefined || !/^[a-f\d]{64}$/.test(value.expectedRevision ?? '')) throw new Error('Management action needs its target and current revision');
  } else if (value.kind === 'configure') {
    const fields = sections[value.target];
    if (!fields || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings) || Object.keys(value.settings).some(k => !fields.includes(k))) throw new Error('Unsupported management settings or revision');
  } else throw new Error('Unsupported management action');
  if (Buffer.byteLength(JSON.stringify(result)) > 24000) throw new Error('Management intent exceeds its bound');
  return result;
}

/** Optional explicit commands retain conversational receipts without model authority. */
export function managementCommand(text, revisionFor) {
  const match = /^\/(retry|unsubscribe|dismiss)\s+(\S+)\s*$/.exec(text);
  if (match) return normalizeManagementIntent({ kind: match[1], target: match[2], expectedRevision: revisionFor(match[1],match[2]) });
  const config = /^\/(settings|prompts)\s+([\s\S]+)$/.exec(text);
  if (config) {
    const input = JSON.parse(config[2]);
    return normalizeManagementIntent({ kind:'configure', ...(config[1] === 'prompts' ? {target:'prompts'} : {}), ...input });
  }
  if (/^\/(retry|unsubscribe|dismiss|settings|prompts)(?:\s|$)/.test(text)) throw new Error('Use /retry|unsubscribe|dismiss <id> or /settings {target,settings,expectedRevision}');
  return null;
}

import { createHash } from 'node:crypto';

function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${name} field: ${key}`);
}
function text(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${name} must be non-empty text of at most ${max} characters`);
  return value;
}
function strings(value, name) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${name} must be an array of at most 100 identities`);
  return [...new Set(value.map(item => text(item, name, 256)))].sort();
}
function explicitScope(source, scope) {
  return source === 'github' ? /^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/.test(scope.repository ?? '')
    : source === 'feishu' && typeof scope.tenantKey === 'string' && !!scope.tenantKey && /^oc_[A-Za-z\d_-]+$/.test(scope.chatId ?? '');
}
const admissionValue = value => value === true ? 'inferred' : value === false || value === undefined ? 'ignore' : value;

/** Trusted operator settings, never a structure accepted from source message bodies. */
export function validatePolicyConfig(value = {}) {
  object(value, 'policy', ['mode', 'rules', 'sourceRows', 'evalTimeoutMs']);
  const mode = value.mode ?? 'off';
  if (!['off', 'observe', 'auto'].includes(mode)) throw new Error('policy.mode must be off, observe, or auto');
  const evalTimeoutMs = value.evalTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(evalTimeoutMs) || evalTimeoutMs < 1000 || evalTimeoutMs > 3_600_000) throw new Error('policy.evalTimeoutMs must be between 1000 and 3600000');
  if (!Array.isArray(value.rules ?? []) || (value.rules ?? []).length > 100) throw new Error('policy.rules must contain at most 100 rules');
  const rules = (value.rules ?? []).map(rule => {
    object(rule, 'policy rule', ['id', 'enabled', 'instruction']);
    if (typeof rule.enabled !== 'boolean') throw new Error('policy rule enabled must be boolean');
    return { id: text(rule.id, 'policy rule id', 128), enabled: rule.enabled, instruction: text(rule.instruction, 'policy rule instruction') };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('policy rule IDs must be unique');
  if (!Array.isArray(value.sourceRows ?? []) || (value.sourceRows ?? []).length > 100) throw new Error('policy.sourceRows must contain at most 100 rows');
  const sourceRows = (value.sourceRows ?? []).map(row => {
    object(row, 'policy source row', ['id', 'source', 'scope', 'actors', 'bots', 'admission']);
    object(row.scope ?? {}, 'policy source scope', Object.keys(row.scope ?? {}));
    const scope = Object.fromEntries(Object.entries(row.scope ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => {
      text(key, 'scope key', 128);
      if (typeof val !== 'string' && !Number.isSafeInteger(val)) throw new Error('Scope values must be exact strings or integers');
      return [key, val];
    }));
    const keys = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'];
    object(row.admission ?? {}, 'policy admission', keys);
    const admission = Object.fromEntries(keys.map(key => {
      const value = admissionValue(row.admission?.[key]);
      if (!['ignore', 'inferred', ...(key === 'unlistedAddressed' ? ['explicit'] : [])].includes(value)) throw new Error('Invalid policy admission; only addressed unlisted people may be explicit');
      if (value === 'explicit' && !explicitScope(row.source, scope)) throw new Error('Explicit unlisted admission requires a configured GitHub repository or Feishu tenant and chat');
      return [key, value];
    }));
    return { id: text(row.id, 'policy row id', 128), source: text(row.source, 'policy source', 128), scope,
      actors: strings(row.actors ?? [], 'policy actors'), bots: strings(row.bots ?? [], 'policy bots'), admission };
  });
  if (new Set(sourceRows.map(row => row.id)).size !== sourceRows.length) throw new Error('policy row IDs must be unique');
  return { mode, rules, sourceRows, evalTimeoutMs };
}
export function policyVersion(settings) {
  return `policy-v1:${createHash('sha256').update(JSON.stringify(validatePolicyConfig(settings))).digest('hex').slice(0, 24)}`;
}
function matchingRow(config, input) {
  // Ambiguous rows fail closed rather than making array order an authority rule.
  const matches = config.sourceRows.filter(row => row.source === input.source && Object.entries(row.scope).every(([key, value]) => input.meta?.[key] === value));
  if (matches.length !== 1) return undefined;
  return matches[0];
}

const githubIdentity = value => String(value ?? '').toLowerCase();
const hasIdentity = (values, id, source) => values.some(value => source === 'github' ? githubIdentity(value) === githubIdentity(id) : value === id);

/** Source identity and trusted policy may remove human authority, never grant it. */
export function normalizeGitHubActorTrigger(policyOrConfig, trigger) {
  if (trigger?.source !== 'github') return trigger;
  const settings = policyOrConfig?.settings ?? policyOrConfig?.config ?? policyOrConfig ?? {};
  const event = trigger.meta?.pullEvent;
  const meta = { ...(event ? { repository: event.repository, pullNumber: event.pullNumber } : {}), ...trigger.meta };
  const matching = (settings.sourceRows ?? []).filter(row => row.source === 'github' &&
    Object.entries(row.scope ?? {}).every(([key, value]) => meta[key] === value));
  // Ambiguous rows must not restore human authority to an account one row marks automated.
  const configuredBot = matching.some(row => hasIdentity(row.bots ?? [], trigger.actor?.id, 'github'));
  const nativeType = meta.actorType ?? event?.actor?.type ?? trigger.meta?.githubActor?.nativeType ?? null;
  const nativeBot = !!event?.ci || nativeType !== null && nativeType !== 'User' || /\[bot\]$/i.test(trigger.actor?.id ?? '');
  const human = trigger.human === true && !nativeBot && !configuredBot;
  return { ...trigger, human, meta: { ...meta, githubActor: {
    nativeType, configuredBot, kind: human ? 'human' : 'bot',
  } } };
}

/** Retention only: a configured human's normalized topic reply grants no new work authority. */
export function retainedFeishuSupplementAllowed(policy, feishu, trigger) {
  const settings = policy?.settings;
  if (!settings || !feishu || feishu.enabled === false || trigger?.source !== 'feishu' ||
      trigger.actor?.source !== 'feishu' || trigger.human !== true || trigger.addressed ||
      trigger.meta?.operator || trigger.meta?.contextOnly || trigger.actor.id === feishu.botOpenId) return false;
  const meta = trigger.meta ?? {}, channel = trigger.channel, address = channel?.address;
  if (meta.tenantKey !== feishu.tenantKey || !/^ou_[A-Za-z0-9_-]{1,200}$/.test(trigger.actor.id) ||
      !/^om_[A-Za-z0-9_-]{1,200}$/.test(meta.messageId ?? '') || !/^om_[A-Za-z0-9_-]{1,200}$/.test(meta.rootId ?? '') ||
      meta.parentId !== undefined && !/^om_[A-Za-z0-9_-]{1,200}$/.test(meta.parentId) ||
      meta.threadId !== undefined && !/^omt?_[A-Za-z0-9_-]{1,200}$/.test(meta.threadId) ||
      meta.rootId === meta.messageId && !meta.parentId) return false;
  const chat = feishu.chats?.find(item => item.chatId === meta.chatId);
  if (!chat || !['group', 'topic_group'].includes(chat.type) || meta.chatType !== chat.type) return false;
  const thread = `${meta.tenantKey}:${meta.chatId}:${meta.rootId}`;
  if (trigger.id !== `feishu:${meta.tenantKey}:${meta.messageId}` || trigger.threads?.length !== 1 ||
      trigger.threads[0].source !== 'feishu' || trigger.threads[0].id !== thread || channel?.source !== 'feishu' ||
      channel.thread !== thread || address?.tenantKey !== meta.tenantKey || address.chatId !== meta.chatId ||
      address.messageId !== meta.rootId || address.sourceId !== 'feishu') return false;
  const row = matchingRow(settings, trigger);
  return !!row && hasIdentity(row.actors, trigger.actor.id, 'feishu') && !hasIdentity(row.bots, trigger.actor.id, 'feishu');
}

/** Existing explicit authorization remains authoritative; new observation is opt-in. */
export function createRuntimePolicy({ config = {}, version, paused = false, explicitGate = () => ({ admissible: false, reason: 'not-authorized' }), revalidateExplicit = () => false } = {}) {
  const settings = validatePolicyConfig(config);
  const gate = (input, thread, tickets) => {
    let trigger = normalizeGitHubActorTrigger(settings, input);
    // A locally listed automation identity never gains human authority through a
    // source's generic human flag (GitHub also uses its verified native type).
    const configuredBot = settings.sourceRows.some(row => row.source === trigger.source && Object.entries(row.scope).every(([key,value]) => trigger.meta?.[key] === value) && hasIdentity(row.bots, trigger.actor?.id, trigger.source));
    if (configuredBot) trigger = { ...trigger, human: false };
    if (trigger.actor?.source !== trigger.source) return { admissible: false, reason: 'actor-source-mismatch' };
    const explicit = configuredBot || trigger.source === 'github' && !trigger.human
      ? { admissible: false, reason: 'automated-actor-not-explicit' } : explicitGate(trigger, thread, tickets);
    if (explicit.admissible) return explicit;
    const row = matchingRow(settings, trigger);
    if (!row) return explicit;
    const received = { source: trigger.source, scope: row.scope, row: row.id, sender: trigger.actor.id };
    if (trigger.human && hasIdentity(row.actors, trigger.actor.id, trigger.source) && trigger.addressed) {
      return { admissible: true, strength: 'explicit', basis: { ...received, via: 'addressed', addressed: trigger.addressed } };
    }
    if (trigger.human && hasIdentity(row.actors, trigger.actor.id, trigger.source) && tickets?.some(ticket => ticket.ended?.by !== 'human' &&
        thread?.subscriptions?.includes(ticket.id) && !thread.context?.includes(ticket.id))) {
      return { admissible: true, strength: 'explicit', basis: { ...received, via: 'followup' } };
    }
    const cell = hasIdentity(row.actors, trigger.actor.id, trigger.source) ? 'listedUnaddressed' : trigger.addressed ? 'unlistedAddressed' : 'unlistedUnaddressed';
    if (trigger.human && cell === 'unlistedAddressed' && ['mention','direct'].includes(trigger.addressed) && row.admission[cell] === 'explicit' && explicitScope(row.source,row.scope)) {
      const nativeHuman = trigger.source !== 'github' || trigger.meta?.githubActor?.nativeType === 'User' && /^[1-9]\d*$/.test(String(trigger.meta.actorId ?? trigger.meta.pullEvent?.actor?.id ?? ''));
      if (nativeHuman) return { admissible: true, strength: 'explicit', basis: { ...received, via: 'admission', cell, addressed: trigger.addressed } };
      return { admissible: false, reason: 'human-identity-unverified' };
    }
    if (settings.mode === 'off' || !settings.rules.some(rule => rule.enabled)) return { admissible: false, reason: 'observation-disabled' };
    if (!trigger.human) return hasIdentity(row.bots, trigger.actor.id, trigger.source)
      ? { admissible: true, strength: 'inferred', basis: { ...received, via: 'bot', observation: { mode: settings.mode } } }
      : { admissible: false, reason: 'bot-not-authorized' };
    return row.admission[cell] === 'inferred'
      ? { admissible: true, strength: 'inferred', basis: { ...received, via: 'admission', cell, ...(trigger.addressed ? { addressed: trigger.addressed } : {}), observation: { mode: settings.mode } } }
      : { admissible: false, reason: 'admission-disabled' };
  };
  const admitsInferred = ids => settings.mode === 'auto' && ids.length > 0 && ids.every(id => settings.rules.some(rule => rule.id === id && rule.enabled));
  return { version: version ?? policyVersion(settings), paused: !!paused, evalTimeoutMs: settings.evalTimeoutMs, gate, admitsInferred,
    revalidate(mandate) {
      if (mandate.strength === 'explicit' && mandate.actor.source === 'github' && !normalizeGitHubActorTrigger(settings, {
        source: 'github', actor: mandate.actor, human: true, meta: mandate.basis?.scope ?? {},
      }).human) return false;
      if (!mandate.basis?.row) return revalidateExplicit(mandate);
      const row = settings.sourceRows.find(row => row.id === mandate.basis.row);
      if (!row || row.source !== mandate.actor.source || JSON.stringify(row.scope) !== JSON.stringify(mandate.basis.scope)) return false;
      if (mandate.strength === 'inferred') {
        if (!admitsInferred(mandate.basis.rules ?? [])) return false;
        return mandate.basis.via === 'bot' ? hasIdentity(row.bots, mandate.actor.id, mandate.actor.source)
          : ['inferred','explicit'].includes(row.admission[mandate.basis.cell]) && (mandate.basis.cell !== 'listedUnaddressed' || hasIdentity(row.actors, mandate.actor.id, mandate.actor.source));
      }
      if (hasIdentity(row.bots, mandate.actor.id, mandate.actor.source)) return false;
      if (mandate.basis.via === 'admission') return mandate.basis.cell === 'unlistedAddressed' && ['mention','direct'].includes(mandate.basis.addressed) &&
        row.admission.unlistedAddressed === 'explicit' && explicitScope(row.source,row.scope);
      return hasIdentity(row.actors, mandate.actor.id, mandate.actor.source) && ['addressed', 'followup'].includes(mandate.basis.via);
    },
    scope(input) { const row = matchingRow(settings, input); return row ? { listened: true, observed: settings.mode !== 'off', row: row.id } : { listened: false, reason: 'source-not-configured' }; },
    normalizeOutcome(candidate, outcome) {
      if (candidate.strength !== 'explicit' && outcome.kind === 'accept' && settings.mode === 'observe') {
        return { kind: 'ignore', reason: 'Observation only: proposed acceptance recorded without execution', audit: { ...outcome.audit, wouldAccept: outcome, policyMode: 'observe' } };
      }
      return outcome;
    }, settings,
  };
}

/** Uses the same transaction boundary as Engine so a settings write and policyChanged can be atomic. */
export class PolicyRegistry {
  constructor(store) { this.store = store; }
  current() { return this.store.getMeta('policy:current') ?? { revision: 0, version: policyVersion({}), config: validatePolicyConfig({}), at: null }; }
  history() { return this.store.listMeta('policy:revision:').map(row => row.value).sort((a, b) => a.revision - b.revision); }
  update(config, { expectedRevision, onChange } = {}) {
    const normalized = validatePolicyConfig(config);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision is required');
    return this.store.atomic(() => {
      const previous = this.current();
      if (previous.revision !== expectedRevision) throw new Error('Policy revision conflict; reload before saving');
      const next = { revision: previous.revision + 1, version: policyVersion(normalized), config: normalized, at: new Date().toISOString() };
      this.store.setMeta('policy:current', next);
      this.store.setMeta(`policy:revision:${next.revision}`, next);
      onChange?.(previous, next);
      return next;
    });
  }
}

/** Facts passed to Engine.policyChanged; the runtime separately stops revoked execution. */
export function policyImpact(tickets, previous, next) {
  const effects = new Map();
  for (const ticket of tickets.filter(ticket => !ticket.ended)) {
    const effect = {};
    const rules = (ticket.mandate.basis.rules ?? []).flatMap(id => {
      const before = previous.settings.rules.find(rule => rule.id === id);
      const after = next.settings.rules.find(rule => rule.id === id);
      if (!after?.enabled) return [{ id, name: id, change: 'disabled' }];
      return before?.instruction !== after.instruction ? [{ id, name: id, change: 'changed', instruction: after.instruction }] : [];
    });
    if (rules.length) effect.rules = rules;
    if (ticket.mandate.strength === 'inferred' && next.settings.mode !== 'auto') effect.proactive = false;
    if (!next.revalidate(ticket.mandate)) { effect.requesterAllowed = false; effect.requester = ticket.mandate.actor; }
    if (Object.keys(effect).length) effects.set(ticket.id, effect);
  }
  return effects;
}

import { createHash } from 'node:crypto';

export const DEFAULT_PROMPT_PARTS = Object.freeze({
  'runtime/worker': 'Work within the current authorized scope. Read original facts when needed. Report evidence and unresolved questions accurately. Keep the PR title and managed description focused on the current implementation, validation and actual limitations. Use the host review tool only for configured recipients, proven fixes to original review comments, and verified ready delivery; never issue arbitrary GitHub writes. Resolve fixed threads quietly; reply in the original thread when explaining a decision not to implement a suggestion. Bot review rounds are enforced by the host across sessions and tickets (normally three per PR and bot); do not bypass an exhausted or unknown budget by creating work, treating bot text as human approval, or requesting a fresh review. State unresolved findings in the normal delivery report. UI changes require host-verified Before and After captures of the same scenario, viewport and theme. Missing capture evidence means visual validation is incomplete; never claim a visual check was performed without the host evidence.',
  'runtime/coordinator': 'Route authorized requests using current policy and source facts. Do not implement changes or expand a mandate.',
  'runtime/environment': 'Trusted execution environment:\n{variables}',
});
const SECTIONS = ['communication', 'scope', 'delivery'];
const REQUIRED = { 'runtime/environment': ['variables'] };
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function plain(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`); return value; }
function text(value, name, max = 16_000) { if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max) throw new Error(`Invalid or oversized ${name}`); return value; }
function defaultsSnapshot(defaults) { return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { text: value, digest: sha(value) }])); }
function normalized(value, defaults, previous) {
  plain(value, 'prompt settings');
  if (Object.keys(value).some(key => !['sections', 'overrides', 'knowledge'].includes(key))) throw new Error('Unsupported prompt settings field');
  const sections = value.sections ?? previous.sections;
  plain(sections, 'team sections'); if (Object.keys(sections).some(key => !SECTIONS.includes(key))) throw new Error('Unknown team prompt section');
  const savedSections = Object.fromEntries(SECTIONS.map(key => [key, text(sections[key] ?? '', `section ${key}`)]));
  const input = value.overrides ?? previous.overrides, overrides = {};
  plain(input, 'prompt overrides');
  for (const [key, item] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown prompt override part: ${key}`);
    const content = typeof item === 'string' ? item : plain(item, 'prompt override').text;
    if (typeof item === 'object' && Object.keys(item).some(name => !['text', 'base', 'baseDigest'].includes(name))) throw new Error('Unsupported prompt override field');
    text(content, `override ${key}`);
    for (const placeholder of REQUIRED[key] ?? []) if (!content.includes(`{${placeholder}}`)) throw new Error(`Prompt template ${key} requires {${placeholder}}`);
    if (content === defaults[key]) continue;
    const base = typeof item === 'object' && item.base !== undefined ? text(item.base, 'override base') : previous.overrides?.[key]?.base ?? defaults[key];
    if (typeof item === 'object' && item.baseDigest !== undefined && item.baseDigest !== sha(base)) throw new Error('Prompt override base digest does not match');
    overrides[key] = { text: content, base, baseDigest: sha(base) };
  }
  const knowledge = value.knowledge ?? previous.knowledge ?? [];
  if (!Array.isArray(knowledge) || knowledge.length > 20) throw new Error('Team knowledge must be a bounded list');
  const ids = new Set();
  const savedKnowledge = knowledge.map(item => {
    plain(item, 'team knowledge');
    if (Object.keys(item).some(key => !['id', 'title', 'text'].includes(key)) || !/^[a-z][a-z\d_-]{0,63}$/.test(item.id ?? '') || ['github', 'feishu', 'worker', 'coordinator', 'runtime'].includes(item.id) || ids.has(item.id)) throw new Error('Invalid or reserved team knowledge identity');
    ids.add(item.id); return { id: item.id, title: text(item.title, 'knowledge title', 200), text: text(item.text, 'knowledge text', 8000) };
  });
  const settings = { sections: savedSections, overrides, knowledge: savedKnowledge };
  if (Buffer.byteLength(JSON.stringify(settings)) > 64 * 1024) throw new Error('Prompt settings exceed 64 KiB');
  return settings;
}
function assembleSettings(current, baseline, { role, variables = {} } = {}) {
  if (!['worker', 'coordinator'].includes(role)) throw new Error('Unknown prompt role');
  plain(variables, 'prompt environment');
  if (Object.keys(variables).length > 30 || Object.entries(variables).some(([key, value]) => !/^[A-Za-z][A-Za-z\d_]{0,63}$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 2000 || /secret|password|token|credential|private.?key/i.test(key))) throw new Error('Invalid or sensitive prompt environment');
  const part = key => current.overrides[key]?.text ?? baseline[key];
  const environment = Object.entries(variables).map(([key, value]) => `${key}: ${value}`).join('\n') || '(No extra environment variables)';
  const pieces = [part(`runtime/${role}`), ...SECTIONS.filter(key => current.sections[key]).map(key => `Team ${key}:\n${current.sections[key]}`), ...current.knowledge.map(item => `Team knowledge ${item.id} (${item.title}):\n${item.text}`), part('runtime/environment').replaceAll('{variables}', environment)];
  const assembled = pieces.join('\n\n'); if (Buffer.byteLength(assembled) > 96 * 1024) throw new Error('Assembled prompt exceeds 96 KiB');
  return { role, revision: current.revision, version: `assembled-v1:${sha(assembled).slice(0, 24)}`, settingsVersion: current.version, digest: sha(assembled), text: assembled, parts: [`runtime/${role}`, ...SECTIONS, 'runtime/environment'] };
}

/** Immutable team prompt revisions; defaults are versioned separately and never overwrite saved overrides. */
export class PromptRegistry {
  constructor(store, { defaults = DEFAULT_PROMPT_PARTS, now = () => new Date().toISOString(), initialize = true } = {}) {
    this.store = store; this.now = now;
    plain(defaults, 'prompt defaults');
    if (Object.keys(defaults).some(key => !Object.hasOwn(DEFAULT_PROMPT_PARTS, key)) || Object.keys(DEFAULT_PROMPT_PARTS).some(key => !Object.hasOwn(defaults, key))) throw new Error('Prompt default parts do not match the known contract');
    for (const [key, value] of Object.entries(defaults)) { text(value, 'default prompt'); for (const placeholder of REQUIRED[key] ?? []) if (!value.includes(`{${placeholder}}`)) throw new Error('Default prompt template is missing a placeholder'); }
    this.defaults = Object.freeze({ ...defaults });
    if (initialize) this.store.atomic(() => {
      if (!this.store.getMeta('prompts:revision:0')) this.store.setMeta('prompts:revision:0', { revision: 0, version: `prompts-v1:${sha(this.defaults).slice(0, 24)}`, predecessor: null, at: this.now(), origin: 'defaults', sections: { communication: '', scope: '', delivery: '' }, overrides: {}, knowledge: [], defaults: defaultsSnapshot(this.defaults) });
    });
  }
  current() { return this.store.getMeta('prompts:current') ?? { revision: 0, version: `prompts-v1:${sha(this.defaults).slice(0, 24)}`, predecessor: null, at: null, origin: 'defaults', sections: { communication: '', scope: '', delivery: '' }, overrides: {}, knowledge: [], defaults: defaultsSnapshot(this.defaults) }; }
  history() { return this.store.listMeta('prompts:revision:').map(row => row.value).sort((a, b) => a.revision - b.revision); }
  update(value, { expectedRevision, origin = 'sdk' } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !['sdk', 'cli', 'panel', 'migration'].includes(origin)) throw new Error('Prompt revision and origin are required');
    return this.store.atomic(() => {
      const previous = this.current(); if (previous.revision !== expectedRevision) throw new Error('Prompt revision conflict; reload before saving');
      const settings = normalized(value, this.defaults, previous);
      const next = { ...settings, defaults: defaultsSnapshot(this.defaults), revision: previous.revision + 1, predecessor: previous.revision, at: this.now(), origin, version: `prompts-v1:${sha({ settings, defaults: this.defaults }).slice(0, 24)}` };
      this.store.setMeta(`prompts:revision:${next.revision}`, next); this.store.setMeta('prompts:current', next); return next;
    });
  }
  diffDefaults() {
    const current = this.current();
    return Object.entries(this.defaults).map(([key, value]) => {
      const override = current.overrides[key], savedDefault = override?.base ?? current.defaults?.[key]?.text ?? value;
      return { key, overridden: !!override, changed: savedDefault !== value, oldDefault: savedDefault, newDefault: value, custom: override?.text ?? null, requiredPlaceholders: REQUIRED[key] ?? [] };
    });
  }
  preview(value, { expectedRevision } = {}) {
    const saved = this.current();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== saved.revision) throw new Error('Prompt revision conflict; reload before previewing');
    const settings = normalized(value, this.defaults, saved);
    const draft = { ...settings, revision: saved.revision, version: `prompts-preview-v1:${sha({ settings, defaults: this.defaults }).slice(0, 24)}` };
    const initial = { sections: { communication: '', scope: '', delivery: '' }, overrides: {}, knowledge: [], revision: 0, version: `prompts-v1:${sha(this.defaults).slice(0, 24)}` };
    const compose = current => Object.fromEntries(['worker','coordinator'].map(role => [role, assembleSettings(current, this.defaults, { role })]));
    const result = { revision: saved.revision, draft: compose(draft), saved: compose(saved), defaults: compose(initial) };
    if (Buffer.byteLength(result.draft.worker.text) > 30_000 || Buffer.byteLength(result.draft.coordinator.text) > 14_000) throw new Error('Assembled prompt exceeds the current Worker/coordinator adapter budget');
    return result;
  }
  assemble({ role, variables = {}, revision } = {}) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('Invalid prompt revision');
    const current = revision === undefined ? this.current() : this.store.getMeta(`prompts:revision:${revision}`);
    if (!current) throw new Error('Unknown prompt revision');
    // An explicit historical revision assembles from its saved defaults. New assembly follows unoverridden current defaults.
    const baseline = revision === undefined ? this.defaults : Object.fromEntries(Object.entries(current.defaults).map(([key, item]) => [key, item.text]));
    return assembleSettings(current, baseline, { role, variables });
  }
}

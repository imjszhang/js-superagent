import { webhookConfigurationKey } from '../github-webhook-inbox.mjs';

const keyOf = ref => `${ref.kind}:${ref.number}`;
const validRef = ref => ['issue', 'pull'].includes(ref?.kind) && Number.isSafeInteger(ref.number) && ref.number > 0;
const eventRef = event => ({ kind: event.pullNumber ? 'pull' : 'issue', number: event.pullNumber ?? event.issueNumber });
export function normalizeGitHubPoll(value, { repository, trackedIssues = [], trackedPullRequests = [], contextPullRequests = [], issues = [] } = {}) {
  if (Array.isArray(value)) {
    const refs = new Map([...issues, ...trackedIssues].map(number => [`issue:${number}`, { kind: 'issue', number }]));
    for (const pull of trackedPullRequests) refs.set(`pull:${pull.number}`, { kind: 'pull', number: pull.number });
    for (const number of contextPullRequests) refs.set(`pull:${number}`, { kind: 'pull', number });
    for (const event of value) if (event.repository === repository && validRef(eventRef(event))) refs.set(keyOf(eventRef(event)), eventRef(event));
    return { version: 1, legacy: true, repositoryVerified: true, repository, events: value, objects: [...refs.values()].map(ref => ({ ...ref, status: 'ok' })), errors: [], discovery: { complete: true } };
  }
  if (value?.version !== 1 || value.repository !== repository || !Array.isArray(value.events) || !Array.isArray(value.objects) || !Array.isArray(value.errors) ||
      typeof value.discovery?.complete !== 'boolean' || value.repositoryVerified !== undefined && typeof value.repositoryVerified !== 'boolean' || value.objects.length > 5000 || value.objects.some(ref => !validRef(ref) || !['ok', 'failed'].includes(ref.status))) throw new Error('GitHub returned an invalid poll result');
  if (new Set(value.objects.map(keyOf)).size !== value.objects.length) throw new Error('GitHub returned duplicate object observations');
  const successful = new Set(value.objects.filter(ref => ref.status === 'ok').map(keyOf));
  if (value.events.some(event => event.repository !== repository || !successful.has(keyOf(eventRef(event))))) throw new Error('GitHub event has no successful object observation');
  if (value.errors.some(item => !['repository', 'discovery'].includes(item.scope))) throw new Error('GitHub returned an invalid error scope');
  return value;
}

/** Object health is a scheduler gate; observations only advance with committed ingestion. */
export class GitHubSyncState {
  constructor(store, config, { now = () => Date.now() } = {}) { this.store = store; this.config = config; this.now = now; this.configurationKey = webhookConfigurationKey(config); }
  objects() { return this.store.listMeta('github:object:').map(row => row.value).filter(row => row.configurationKey === this.configurationKey); }
  object(ref) { return this.objects().find(row => row.kind === ref.kind && row.number === ref.number); }
  save(result) {
    const at = new Date(this.now()).toISOString();
    for (const object of result.objects) {
      const key = `github:object:${this.config.repository}:${keyOf(object)}`, old = this.store.getMeta(key);
      const attempts = object.status === 'failed' ? (old?.configurationKey === this.configurationKey ? old.attempts ?? 0 : 0) + 1 : 0;
      this.store.setMeta(key, { ...object, repository: this.config.repository, configurationKey: this.configurationKey, observedAt: at, attempts,
        lastSuccess: object.status === 'ok' ? at : old?.configurationKey === this.configurationKey ? old.lastSuccess ?? null : null,
        nextAt: object.status === 'failed' ? new Date(this.now() + Math.min(300000, (this.config.pollIntervalMs ?? 30000) * 2 ** Math.min(attempts - 1, 5))).toISOString() : null });
    }
    const previous = this.store.getMeta('github:sync-state');
    const verified = result.repositoryVerified === true || result.objects.some(object => object.status === 'ok');
    const errors = [...result.errors], priorError = this.store.getMeta('github:last-error');
    if (!verified && !errors.some(item => item.scope === 'repository') && (!previous || previous.configurationKey === this.configurationKey)) {
      const retained = previous?.errors.filter(item => item.scope === 'repository') ?? [];
      errors.push(...retained);
      if (!retained.length && priorError) errors.push({ scope: 'repository', error: { category: 'transport', message: priorError } });
    }
    const global = errors.filter(item => item.scope === 'repository');
    this.store.setMeta('github:sync-state', { configurationKey: this.configurationKey, observedAt: at, errors, discovery: result.discovery, legacy: !!result.legacy });
    if (global.length) this.store.setMeta('github:last-error', global.map(item => item.error?.message ?? 'Repository synchronization unavailable').join('; ').slice(0, 1000));
    else this.store.deleteMeta('github:last-error');
  }
  globalBlocked() {
    const state = this.store.getMeta('github:sync-state');
    return !!this.store.getMeta('github:last-error') || state?.configurationKey === this.configurationKey && state.errors.some(item => item.scope === 'repository');
  }
  blocked(refs, { notBefore } = {}) {
    if (this.globalBlocked()) return true;
    const staleAfter = Math.max(30000, (this.config.pollIntervalMs ?? 30000) * 3);
    return refs.some(ref => {
      const row = this.object(ref);
      return !row || row.status !== 'ok' || this.now() - Date.parse(row.lastSuccess) > staleAfter ||
        notBefore && Date.parse(row.lastSuccess) < Date.parse(notBefore);
    });
  }
  selectorRefs(selector, pulls) {
    if (validRef(selector)) return [selector];
    if (selector?.kind === 'head') return pulls.filter(pull => pull.headSha === selector.headSha || pull.headHistory?.includes(selector.headSha)).map(pull => ({ kind: 'pull', number: pull.number }));
    return null;
  }
  reconciled(entry, pulls) {
    if (entry.configurationKey !== this.configurationKey || this.globalBlocked()) return false;
    const refs = this.selectorRefs(entry.selector, pulls);
    if (refs) return refs.length > 0 && !this.blocked(refs, { notBefore: entry.receivedAt });
    const state = this.store.getMeta('github:sync-state');
    return state?.configurationKey === this.configurationKey && state.discovery.complete && !state.errors.length &&
      Date.parse(state.observedAt) >= Date.parse(entry.receivedAt) && this.objects().every(row => row.status === 'ok');
  }
  status() {
    const objects = this.objects(), state = this.store.getMeta('github:sync-state');
    return { state: this.globalBlocked() ? 'unavailable' : objects.some(row => row.status === 'failed') || state?.errors?.length ? 'degraded' : state?.configurationKey === this.configurationKey ? 'ready' : 'unobserved',
      objects: objects.map(({ configurationKey, ...row }) => row), errors: state?.configurationKey === this.configurationKey ? state.errors : [] };
  }
}

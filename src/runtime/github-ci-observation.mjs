import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA = /^[a-f\d]{40}$/;
const failure = new Set(['failure', 'error', 'timed_out', 'action_required', 'startup_failure']);
const successful = new Set(['success', 'neutral', 'skipped']);
const instant = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const positive = value => Number.isSafeInteger(value) && value > 0;

/** A snapshot describes only the explicitly selected observations, never branch protection requirements. */
export function summarizeGitHubCi({ repository, target, headSha, config = {}, checks = [], statuses = [], complete = true, observedAt = new Date().toISOString() }) {
  if (!/^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/.test(repository ?? '') || typeof target !== 'string' || !target || !SHA.test(headSha ?? '') ||
      !Array.isArray(checks) || !Array.isArray(statuses) || typeof complete !== 'boolean' || !instant(observedAt)) throw new Error('Invalid GitHub CI snapshot');
  const groups = new Map(), ambiguous = new Set();
  const insert = entry => {
    const before = groups.get(entry.key);
    if (!before) { groups.set(entry.key, entry); return; }
    if (before.id === entry.id) {
      if (before.updatedAt && entry.updatedAt && entry.updatedAt < before.updatedAt) return;
      if (before.updatedAt === entry.updatedAt && (before.status !== entry.status || before.conclusion !== entry.conclusion)) { ambiguous.add(entry.key); return; }
      groups.set(entry.key, entry); return;
    }
    // A newer native creation/attempt timestamp establishes a rerun. IDs alone
    // are not a clock, and conflicting same-time runs are left unresolved.
    if (!entry.startedAt || !before.startedAt || entry.startedAt === before.startedAt) { ambiguous.add(entry.key); return; }
    if (entry.startedAt > before.startedAt) groups.set(entry.key, entry);
  };
  for (const raw of checks) {
    const app = raw?.app?.slug?.toLowerCase();
    if (!config.checkApps?.includes(app)) continue;
    if (!positive(raw.id) || !positive(raw.app.id) || raw.head_sha?.toLowerCase() !== headSha || typeof raw.name !== 'string' || !raw.name ||
        !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(raw.status) ||
        raw.conclusion !== null && !['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(raw.conclusion)) throw new Error('Invalid selected GitHub check');
    const workflow = raw.check_suite?.workflow_id ?? raw.workflow_id ?? null;
    const key = JSON.stringify(['check', raw.app.id, raw.name, workflow]);
    insert({ key, kind: 'check_run', id: String(raw.id), app, appId: String(raw.app.id), name: raw.name,
      suiteId: positive(raw.check_suite?.id) ? String(raw.check_suite.id) : null, workflowId: workflow == null ? null : String(workflow),
      status: raw.status, conclusion: raw.conclusion, startedAt: instant(raw.started_at ?? raw.created_at ?? raw.completed_at),
      updatedAt: instant(raw.completed_at ?? raw.started_at ?? raw.created_at), headSha });
  }
  for (const raw of statuses) {
    const actor = raw?.creator?.login?.toLowerCase();
    if (!config.statusContexts?.includes(raw?.context) || !config.statusActors?.includes(actor)) continue;
    if (!positive(raw.id) || !positive(raw.creator.id) || !['error', 'failure', 'pending', 'success'].includes(raw.state) || !instant(raw.created_at)) throw new Error('Invalid selected GitHub status');
    insert({ key: JSON.stringify(['status', raw.context, actor]), kind: 'commit_status', id: String(raw.id), name: raw.context, actor,
      status: raw.state === 'pending' ? 'pending' : 'completed', conclusion: raw.state,
      startedAt: instant(raw.created_at), updatedAt: instant(raw.updated_at ?? raw.created_at), headSha });
  }
  const entries = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const missing = [
    ...(config.checkApps ?? []).filter(app => !entries.some(entry => entry.app === app)).map(app => `check-app:${app}`),
    ...(config.statusContexts ?? []).filter(context => !entries.some(entry => entry.kind === 'commit_status' && entry.name === context)).map(context => `status-context:${context}`),
  ];
  const failures = entries.filter(entry => failure.has(entry.conclusion)).map(entry => entry.key);
  const running = entries.filter(entry => entry.status !== 'completed').map(entry => entry.key);
  const uncertain = entries.filter(entry => entry.status === 'completed' && !failure.has(entry.conclusion) && !successful.has(entry.conclusion)).map(entry => entry.key);
  const state = failures.length ? 'failed' : !complete || missing.length || ambiguous.size || uncertain.length || !entries.length ? 'unknown' : running.length ? 'running' : 'passed';
  const configurationDigest = hash({ checkApps: [...(config.checkApps ?? [])].sort(), statusContexts: [...(config.statusContexts ?? [])].sort(), statusActors: [...(config.statusActors ?? [])].sort() });
  const snapshot = { version: 1, repository, target, headSha, observedAt: instant(observedAt), configurationDigest, complete, entries,
    failures, running, missing, ambiguous: [...ambiguous].sort(), uncertain, state, scope: 'selected-observations' };
  return { ...snapshot, digest: hash({ ...snapshot, observedAt: undefined }) };
}

/** Durable transition projection; a transient unknown/running observation retains the known fault. */
export function observeGitHubCi(previous, incoming) {
  if (incoming?.version !== 1 || !SHA.test(incoming.headSha ?? '') || !Array.isArray(incoming.entries) || !Array.isArray(incoming.failures) || typeof incoming.digest !== 'string') throw new Error('Invalid GitHub CI observation');
  const sameScope = previous?.version === 1 && previous.repository === incoming.repository && previous.target === incoming.target && previous.configurationDigest === incoming.configurationDigest;
  if (sameScope && Date.parse(incoming.observedAt) < Date.parse(previous.observedAt)) return { snapshot: previous, baseline: false, changed: false, recovered: false, ignored: 'older-observation' };
  const baseline = !sameScope;
  const priorFaults = sameScope ? previous.pendingFailureKeys ?? previous.failures : [];
  const covered = priorFaults.every(key => incoming.entries.some(entry => entry.key === key && entry.status === 'completed' && successful.has(entry.conclusion)));
  const recovered = !baseline && priorFaults.length > 0 && incoming.state === 'passed' && covered;
  const pendingFailureKeys = recovered ? [] : [...new Set([...priorFaults, ...incoming.failures])].sort();
  const missingPreviouslyObserved = priorFaults.filter(key => !incoming.entries.some(entry => entry.key === key));
  const state = incoming.state === 'passed' && missingPreviouslyObserved.length ? 'unknown' : incoming.state;
  const snapshot = { ...incoming, state, pendingFailureKeys, missingPreviouslyObserved,
    observationDigest: incoming.observationDigest ?? incoming.digest,
    digest: hash({ observation: incoming.observationDigest ?? incoming.digest, state, missingPreviouslyObserved }), ...(recovered ? { recoveredAt: incoming.observedAt } : {}) };
  return { snapshot, baseline, changed: !baseline && previous.digest !== snapshot.digest, recovered };
}

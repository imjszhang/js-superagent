import { randomUUID, createHash } from 'node:crypto';
import { createHarnessRegistry } from '../harness/registry.mjs';
import { DEFAULT_DRIVER } from '../harness/builtin.mjs';
import { hostname } from 'node:os';
import { relative, isAbsolute } from 'node:path';
import { normalizeVerificationProfile, runVerification, captureVerificationTree } from '../verification.mjs';
import { validateWorkspace, inspectWorkspace } from '../workspaces.mjs';
import { driverCapabilities, normalizeDriverReport } from './reports.mjs';
import { normalizePreviewProfile, previewTtl, verifyOwnedPreview } from './preview.mjs';
import { commandExecutionBinding } from './job-recovery.mjs';

const ACTIVE = new Set(['pending', 'running']);
const ID = /^[A-Za-z\d._:-]{1,160}$/;
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value, name) { if (typeof value !== 'string' || !value.trim() || value.length > 32_000 || value.includes('\0')) throw new Error(`Invalid ${name}`); return value; }
function integer(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`); return value; }
function synchronous(fn, ...args) { const value = fn(...args); if (value && typeof value.then === 'function') throw new Error('Job journal and wake callbacks must be synchronous'); return value; }
function paths(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(path => typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path !== '.' && path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Scope paths must be bounded project-relative paths');
  return [...new Set(value)];
}
const inPaths = (path, allowed) => allowed.some(prefix => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`));
const overlaps = (a, b) => { const rel = relative(a, b); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
function dead(owner) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
function normalizeProfile(id, profile) {
  if (!ID.test(id) || !profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid managed job profile');
  if (profile.id !== undefined && profile.id !== id) throw new Error('Managed job profile identity mismatch');
  if (profile.kind === 'command') {
    const { kind, preview, ...settings } = profile;
    return { kind, ...normalizeVerificationProfile({ ...settings, id, kind: 'prepare', timeoutMs: settings.timeoutMs ?? 30 * 60 * 1000 }), kind: 'command', ...(preview === undefined ? {} : { preview: normalizePreviewProfile(preview) }) };
  }
  if (profile.kind !== 'agent' || Object.keys(profile).some(key => !['id', 'kind', 'version', 'instruction', 'paths', 'timeoutMs', 'maxTurns'].includes(key))) throw new Error('Invalid child agent profile');
  return { kind: 'agent', id, version: text(profile.version, 'profile.version'), instruction: text(profile.instruction, 'profile.instruction'), paths: paths(profile.paths),
    maxTurns: integer(profile.maxTurns ?? 4, 'profile.maxTurns', 1, 20), timeoutMs: integer(profile.timeoutMs ?? 30 * 60 * 1000, 'profile.timeoutMs', 10, 60 * 60 * 1000) };
}

/** Trusted JSON configuration. Explicit paths prevent a missing field from silently granting whole-project delegation. */
export function normalizeManagedJobsSettings(value, { harnessRegistry = createHarnessRegistry() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['profiles', 'paths', 'limits', 'childExecution', 'lifecycle', 'childWorkspace'].includes(key))) throw new Error('Invalid managed job settings');
  if (!value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles) || !Object.keys(value.profiles).length || Object.keys(value.profiles).length > 100) throw new Error('Managed job settings require trusted profiles');
  const profiles = Object.fromEntries(Object.entries(value.profiles).map(([id, profile]) => [id, normalizeProfile(id, profile)]));
  const input = value.limits ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['maxJobs', 'maxActive', 'maxDepth', 'maxDurationMs'].includes(key))) throw new Error('Invalid managed job limits');
  const limits = { maxJobs: integer(input.maxJobs ?? 8, 'maxJobs', 1, 100), maxActive: integer(input.maxActive ?? 2, 'maxActive', 1, 16),
    maxDepth: integer(input.maxDepth ?? 2, 'maxDepth', 0, 8), maxDurationMs: integer(input.maxDurationMs ?? 30 * 60 * 1000, 'maxDurationMs', 10, 60 * 60 * 1000) };
  const rawChildExecution = value.childExecution ?? { driver: DEFAULT_DRIVER };
  if (rawChildExecution?.enableAgentTools === true) throw new Error('Child execution cannot receive root Worker business tools');
  const childExecution = harnessRegistry.validateExecution(rawChildExecution, { role: 'child' });
  if (childExecution.timeoutMs !== undefined) integer(childExecution.timeoutMs, 'child timeoutMs', 100, 3_600_000);
  const lifecycle = value.lifecycle ?? 'turn', childWorkspace = value.childWorkspace ?? 'project';
  if (!['turn', 'assignment'].includes(lifecycle)) throw new Error('Managed job lifecycle must be turn or assignment');
  if (!['project', 'parent-snapshot'].includes(childWorkspace)) throw new Error('Child workspace mode must be project or parent-snapshot');
  if (lifecycle !== 'assignment' && Object.values(profiles).some(profile => profile.preview)) throw new Error('Preview profiles require assignment job lifecycle');
  return { profiles, paths: paths(value.paths), limits, childExecution: structuredClone(childExecution), lifecycle, childWorkspace };
}

/**
 * One manager belongs to one active parent assignment. The trusted host supplies journal operations
 * fenced by that assignment's ownership. wakeParent must durably deduplicate event.id before enqueueing
 * its note; replay after a crash is at-least-once. No job launches automatically on construction/recovery.
 */
export function createManagedJobs(options, shared) {
  const { projectRoot, parent: parentInput, journal, wakeParent, slotChanged = () => {}, prepareChildWorkspace, createChildDriver, signal, redactedEnvironmentKeys = [], persistentMode = false, assertActive = () => {} } = options ?? {};
  const parent = structuredClone(parentInput);
  if (typeof persistentMode !== 'boolean') throw new Error('Invalid managed job persistent mode');
  let currentSlotChanged = slotChanged;
  if (!Array.isArray(redactedEnvironmentKeys) || redactedEnvironmentKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z\d_]{0,255}$/.test(key))) throw new Error('Invalid managed child environment redactions');
  if (!parent || !['ticketId', 'assignmentId', 'runId'].every(key => ID.test(parent[key] ?? ''))) throw new Error('A scoped parent ticket/assignment/run is required');
  if (!journal || typeof journal.list !== 'function' || typeof journal.save !== 'function' || typeof wakeParent !== 'function' || typeof slotChanged !== 'function') throw new Error('Managed jobs require a durable journal and lifecycle callbacks');
  const workspace = validateWorkspace({ projectRoot, workspace: parent.workspace });
  const scope = { instruction: text(parent.scope?.instruction, 'parent scope'), paths: paths(parent.scope?.paths) };
  const depth = integer(parent.depth ?? 0, 'parent depth', 0, 8);
  const settings = options.limits ?? {};
  const limits = { maxJobs: integer(settings.maxJobs ?? 8, 'maxJobs', 1, 100), maxActive: integer(settings.maxActive ?? 2, 'maxActive', 1, 16),
    maxDepth: integer(settings.maxDepth ?? 2, 'maxDepth', 0, 8), maxDurationMs: integer(settings.maxDurationMs ?? 30 * 60 * 1000, 'maxDurationMs', 10, 60 * 60 * 1000) };
  const profiles = shared?.profiles ?? Object.fromEntries(Object.entries(options.profiles ?? {}).map(([id, profile]) => [id, normalizeProfile(id, profile)]));
  const rootRunId = shared?.rootRunId ?? parent.runId;
  const ledger = shared ?? { rootRunId, profiles, limits, active: new Map(), children: new Map(), deadline: Date.now() + limits.maxDurationMs };
  const deadline = Math.min(ledger.deadline, parent.deadlineAt ? Date.parse(parent.deadlineAt) : Infinity);
  if (!Number.isFinite(deadline)) throw new Error('Invalid parent deadline');
  const local = new Set(); let closed = false, waitGroup;
  const belongs = item => item.parent.ticketId === parent.ticketId && item.parent.assignmentId === parent.assignmentId && (persistentMode ? (item.parent.jobId ?? null) === (parent.jobId ?? null) : item.parent.runId === parent.runId);
  function all() { const result = synchronous(journal.list); if (!Array.isArray(result)) throw new Error('Job journal list must return an array'); return result; }
  function get(id) {
    const record = all().find(item => item.id === id && belongs(item));
    if (!record) throw new Error('Unknown job for this parent assignment');
    return structuredClone(record);
  }
  function save(record) {
    const current = all().find(item => item.id === record.id);
    if (current && current.token !== record.token) throw new Error('Stale managed job callback rejected');
    synchronous(journal.save, structuredClone(record));
  }
  function wake(record) {
    if (!record.completion || record.completion.deliveredAt || record.completion.suppressed === 'human-preview') return;
    if (record.previewLease) { record.completion.suppressed = 'human-preview'; save(record); return; }
    try { synchronous(wakeParent, structuredClone(record.completion)); record.completion.deliveredAt = now(); delete record.wakeError; }
    catch { record.wakeError = 'Parent completion notification is pending retry'; }
    save(record);
  }
  function complete(record, status, detail = {}) {
    record.status = status; record.endedAt = now(); Object.assign(record, detail);
    if (record.previewLease?.status === 'active') { record.previewLease.status = status === 'preview-expired' ? 'expired' : 'ended'; record.previewLease.endedAt = record.endedAt; }
    record.completion = { id: `job-completed:${record.id}${record.kind === 'agent' ? `:${record.turn ?? 1}` : ''}`, jobId: record.id, parent: { ...record.parent }, status, at: record.endedAt, deliveredAt: null };
    save(record); wake(record); return structuredClone(record);
  }
  async function runChildTurns(state) {
    const { record, profile, controller, launchParent } = state;
    while (state.pending.length) {
      const message = state.pending.shift();
      if (controller.signal.aborted) return complete(record, state.reason ?? 'cancelled');
      synchronous(assertActive);
      if (Date.now() >= Date.parse(record.deadlineAt)) throw new Error('Child total time budget expired');
      if (record.turns.length >= profile.maxTurns) throw new Error('Child turn budget exhausted');
      if (!record.workspace) {
        const childWorkspace = await prepareChildWorkspace({ parent: structuredClone(launchParent), jobId: record.id, scope: structuredClone(record.scope), signal: controller.signal });
        const owned = validateWorkspace({ projectRoot, workspace: childWorkspace });
        if (owned.mode === 'in-place' || overlaps(workspace.path, owned.path) || overlaps(owned.path, workspace.path) ||
            all().some(other => other.id !== record.id && ACTIVE.has(other.status) && other.workspace?.path && (overlaps(other.workspace.path, owned.path) || overlaps(owned.path, other.workspace.path)))) throw new Error('Child agent requires its own non-overlapping workspace');
        record.workspace = owned; save(record);
      }
      const owned = validateWorkspace({ projectRoot, workspace: record.workspace });
      state.driver ??= await createChildDriver({ profileId: profile.id, parent: structuredClone(launchParent), scope: structuredClone(record.scope), signal: controller.signal });
      const driver = state.driver;
      if (!driver || typeof driver.run !== 'function') throw new Error('Child driver is unavailable');
      if (record.turns.length && (!record.session || !driverCapabilities(driver).sessionResume)) throw new Error('Child Harness cannot continue this saved session');
      synchronous(assertActive);
      const runId = `child-${record.id}-turn-${record.turns.length + 1}`, previousSession = record.session && structuredClone(record.session);
      const turn = { number: record.turns.length + 1, runId, messageId: message.id, status: 'running', startedAt: now(), session: previousSession ?? null };
      record.turn = turn.number; record.turns.push(turn); record.status = 'running'; delete record.endedAt; delete record.completion;
      message.status = 'accepted'; message.runId = runId; message.acceptedAt = now(); save(record);
      const children = createManagedJobs({ ...options, persistentMode: false, parent: { ticketId: parent.ticketId, assignmentId: parent.assignmentId, runId, jobId: record.id, workspace: owned, scope: record.scope, depth: record.depth, deadlineAt: record.deadlineAt }, signal: controller.signal }, ledger);
      state.children = children;
      const callback = fn => {
        if (controller.signal.aborted || !ACTIVE.has(record.status) || record.turns.at(-1)?.runId !== runId) throw new Error('Stopped child callback rejected');
        fn(); save(record);
      };
      let output;
      try {
        output = await driver.run({ projectRoot: owned.path, sourceProjectRoot: projectRoot, workspace: owned, runId, assignmentId: parent.assignmentId,
          session: previousSession, signal: controller.signal, redactedEnvironmentKeys,
          ticket: { id: record.id, text: state.childText, scope: `${scope.instruction}\nAllowed change paths: ${record.scope.paths.join(', ')}\nTrusted child instruction: ${profile.instruction}`,
            messages: record.messages.filter(item => item.status === 'consumed' || item.id === message.id).map(item => ({ id: item.id, text: item.text, at: item.createdAt })),
            reports: record.turns.filter(item => item.report).map(item => item.report) },
          checkpoint: session => callback(() => {
            const bound = previousSession ?? record.session;
            if (!session || typeof session.driver !== 'string' || typeof session.id !== 'string' || bound && (session.id !== bound.id || session.driver !== bound.driver)) throw new Error('Child session identity changed');
            record.session = { driver: session.driver, id: session.id }; turn.session = record.session;
          }),
          registerProcess: pid => callback(() => { if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid child process owner'); if (!record.guardians.some(owner => owner.pid === pid)) record.guardians.push({ pid, host: hostname() }); }),
          progress: progress => callback(() => { record.progress = normalizeDriverReport(progress, { version: 2 }); }), jobs: children,
          jobProfiles: Object.values(profiles).map(item => ({ id: item.id, kind: item.kind, description: (item.kind === 'agent' ? item.instruction : `Trusted command profile ${item.id}, version ${item.version}. Start it with only {"profileId":"${item.id}"}; text and paths are rejected.`).slice(0, 2000) })) });
      } finally { await children.close(); }
      if (record.guardians.some(owner => !dead(owner))) throw new Error('Child process ownership has not settled; inspect before continuing');
      if (controller.signal.aborted) return complete(record, state.reason ?? 'cancelled');
      const report = normalizeDriverReport(output, { version: driverCapabilities(driver).reportVersion });
      const changes = inspectWorkspace({ projectRoot, workspace: owned }).changes;
      turn.status = 'completed'; turn.endedAt = now(); turn.report = report; message.status = 'consumed'; message.consumedAt = now();
      if (changes.some(change => !inPaths(change.path, record.scope.paths))) throw new Error('Child changed files outside its delegated path scope; changes remain isolated for inspection');
      const status = ['ready', 'dropped'].includes(report.state) ? 'completed' : report.state === 'waiting' || report.state === 'blocked' ? 'handed-off' : 'failed';
      complete(record, status, { report, changes });
      if (status === 'failed' || !record.session || !driverCapabilities(driver).sessionResume) break;
    }
    if (state.pending.length) throw new Error('Child cannot continue queued messages after an uncertain or unsupported result');
    return structuredClone(record);
  }
  function childFailed(state, error) {
    const record = state.record, activeTurn = record.turns?.at(-1);
    if (activeTurn?.status === 'running') { activeTurn.status = 'inspection'; activeTurn.error = String(error.message ?? error).slice(0, 2000); }
    for (const item of record.messages ?? []) if (['queued','accepted'].includes(item.status)) item.status = 'inspection';
    state.pending.length = 0;
    return complete(record, state.reason ?? (state.controller.signal.aborted ? 'cancelled' : 'failed'), { error: String(error.message ?? error).slice(0, 2000) });
  }
  const manager = {
    persistent: persistentMode,
    list: () => all().filter(belongs).map(item => structuredClone(item)), get,
    beginTurn({ runId, slotChanged: nextSlotChanged } = {}) {
      if (!persistentMode || closed || signal?.aborted) throw new Error('Persistent parent assignment is unavailable');
      if (!ID.test(runId ?? '')) throw new Error('Invalid parent turn identity');
      if (nextSlotChanged !== undefined && typeof nextSlotChanged !== 'function') throw new Error('Invalid slot callback');
      parent.runId = runId; if (nextSlotChanged) currentSlotChanged = nextSlotChanged;
      return manager;
    },
    async endTurn({ handoff = false } = {}) {
      if (!persistentMode) { await manager.close(); return { pending: 0, previews: 0, holdsSlot: false }; }
      if (typeof handoff !== 'boolean') throw new Error('Invalid turn handoff');
      if (handoff) await Promise.all(manager.list().filter(record => ACTIVE.has(record.status) && record.previewLease?.status !== 'active').map(record => manager.cancel(record.id, 'handed-off')));
      const active = manager.list().filter(record => ACTIVE.has(record.status));
      const previews = active.filter(record => record.previewLease?.status === 'active').length;
      return { pending: active.length - previews, previews, holdsSlot: active.length > previews };
    },
    launch(request = {}, { requestId } = {}) {
      synchronous(assertActive);
      if (closed || signal?.aborted || Date.now() >= deadline) throw new Error('Parent assignment is stopped or its job budget expired');
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['profileId', 'text', 'paths'].includes(key))) throw new Error('Jobs accept a trusted profile ID, text and narrowed paths only');
      if (requestId !== undefined && !ID.test(requestId)) throw new Error('Invalid managed job request ID');
      if (requestId) {
        const previous = manager.list().find(record => record.requestId === requestId);
        if (previous) {
          if (previous.requestDigest !== hash(request)) throw new Error('Managed job request identity conflict');
          return { id: previous.id, done: ledger.active.get(previous.id)?.done ?? Promise.resolve(previous) };
        }
      }
      const profile = profiles[request.profileId];
      if (!profile) throw new Error('Unknown trusted job profile');
      const records = all().filter(record => record.rootRunId === rootRunId);
      if (records.length >= ledger.limits.maxJobs) throw new Error('Managed job count budget exhausted');
      if (records.filter(record => ACTIVE.has(record.status)).length >= ledger.limits.maxActive) throw new Error('Managed job active capacity exhausted');
      const childPaths = request.paths === undefined ? scope.paths : paths(request.paths);
      let childText;
      if (childPaths.some(path => !inPaths(path, scope.paths))) throw new Error('Child scope exceeds the parent path scope');
      if (profile.kind === 'agent') {
        if (depth >= ledger.limits.maxDepth) throw new Error('Nested child agent depth budget exhausted');
        if (!prepareChildWorkspace || !createChildDriver) throw new Error('Child agent workspace and driver capabilities are not configured');
        if (childPaths.some(path => !inPaths(path, profile.paths))) throw new Error('Child scope exceeds the trusted profile path scope');
        // Omitted text means execute the already-authorized profile instruction. Keep the
        // original request unchanged so a repeated tool call retains its exact identity.
        childText = text(Object.hasOwn(request, 'text') ? request.text : profile.instruction, 'child task');
      } else if (request.text !== undefined || request.paths !== undefined) throw new Error('Invalid command job arguments: send only profileId for a command profile; extra fields are rejected');
      const id = randomUUID(), controller = new AbortController();
      // A persistent manager may begin another turn while child preparation awaits.
      const launchParent = structuredClone(parent);
      const record = { version: 1, id, token: randomUUID(), rootRunId, parent: { ticketId: parent.ticketId, assignmentId: parent.assignmentId, runId: parent.runId, ...(parent.jobId ? { jobId: parent.jobId } : {}) },
        ...(requestId ? { requestId, requestDigest: hash(request) } : {}),
        kind: profile.kind, profileId: profile.id, profileVersion: profile.version, profileDigest: hash(profile), depth: depth + (profile.kind === 'agent' ? 1 : 0),
        scope: { instruction: scope.instruction, paths: childPaths }, status: 'pending', createdAt: now(),
        deadlineAt: new Date(Math.min(deadline, Date.now() + profile.timeoutMs)).toISOString(), owner: { pid: process.pid, host: hostname() }, guardians: [] };
      save(record); local.add(id);
      const state = { controller, record, children: null, done: undefined, reason: undefined, profile, launchParent, childText, pending: [] };
      ledger.active.set(id, state);
      if (profile.kind === 'agent') {
        ledger.children.set(id, state); record.turns = []; record.maxTurns = profile.maxTurns;
        const message = { id: requestId ?? `initial:${id}`, text: childText, status: 'queued', createdAt: now() };
        record.messages = [message]; state.pending.push(message); save(record);
      }
      state.timer = setTimeout(() => { state.reason = 'timed-out'; controller.abort(); }, Math.max(1, Date.parse(record.deadlineAt) - Date.now()));
      state.done = Promise.resolve().then(async () => {
        if (controller.signal.aborted) return complete(record, state.reason ?? 'cancelled');
        record.status = 'running'; record.startedAt = now(); save(record);
        try {
          if (profile.kind === 'command') {
            const { kind, preview, ...profileFields } = profile;
            const executionProfile = normalizeVerificationProfile({ ...profileFields, kind: 'prepare', timeoutMs: Math.max(10, Date.parse(record.deadlineAt) - Date.now()) });
            record.executionBinding = commandExecutionBinding(record, executionProfile, workspace); save(record);
            const result = await runVerification({ projectRoot, workspace, profile: executionProfile, signal: controller.signal,
              verificationId: `job-${id}`, onControl: control => { state.executionControl = control; }, persist(value) {
                if (!ACTIVE.has(record.status)) throw new Error('Job already ended');
                record.execution = value;
                for (const pid of [value.pid, value.childPid].filter(Number.isSafeInteger)) if (!record.guardians.some(owner => owner.pid === pid)) record.guardians.push({ pid, host: hostname() });
                save(record);
              } });
            return complete(record, state.reason ?? (result.status === 'passed' ? 'completed' : result.status), { result });
          }
          return await runChildTurns(state);
        } catch (error) {
          if (record.kind === 'agent') return childFailed(state, error);
          return complete(record, state.reason ?? (controller.signal.aborted ? 'cancelled' : 'failed'), { error: String(error.message ?? error).slice(0, 2000) });
        }
      }).finally(() => { clearTimeout(state.timer); clearTimeout(state.previewTimer); ledger.active.delete(id); });
      // Durable state remains authoritative even if a caller chooses not to await this handle.
      state.done.catch(() => {});
      return { id, done: state.done };
    },
    message(id, request = {}, { requestId = randomUUID() } = {}) {
      synchronous(assertActive);
      if (closed || signal?.aborted || !request || Object.keys(request).some(key => key !== 'text') || !ID.test(requestId)) throw new Error('Child message requires an active owner and a bounded request ID');
      const messageText = text(request.text, 'child message'), saved = get(id), state = ledger.children.get(id);
      if (saved.kind !== 'agent' || !state || state.record.token !== saved.token || saved.owner?.pid !== process.pid || saved.owner?.host !== hostname()) throw new Error('Child owner is unavailable; inspect instead of recreating its execution');
      const record = state.record, previous = record.messages.find(item => item.id === requestId);
      if (previous) {
        if (previous.text !== messageText) throw new Error('Child message identity conflict');
        return { id, messageId: previous.id, status: previous.status, done: state.done ?? Promise.resolve(structuredClone(record)) };
      }
      if (state.controller.signal.aborted || !['pending','running','completed','handed-off'].includes(saved.status) || saved.recoveryInspection ||
          record.messages.some(item => item.status === 'inspection') || Date.now() >= Date.parse(record.deadlineAt)) throw new Error('Child execution requires inspection or its total time budget expired');
      if (record.turns.length + state.pending.length >= state.profile.maxTurns) throw new Error('Child turn budget exhausted');
      if (!ledger.active.has(id) && all().filter(item => ACTIVE.has(item.status)).length >= ledger.limits.maxActive) throw new Error('Managed job active capacity exhausted');
      if (!ACTIVE.has(saved.status) && (!record.session || !driverCapabilities(state.driver).sessionResume || record.guardians.some(owner => !dead(owner)))) throw new Error('Child session cannot safely resume');
      const message = { id: requestId, text: messageText, status: 'queued', createdAt: now(), parentRunId: parent.runId };
      record.messages.push(message); state.pending.push(message); save(record);
      if (!ledger.active.has(id)) {
        record.status = 'pending'; delete record.endedAt; delete record.completion; save(record);
        ledger.active.set(id, state);
        state.timer = setTimeout(() => { state.reason = 'timed-out'; state.controller.abort(); }, Math.max(1, Date.parse(record.deadlineAt) - Date.now()));
        state.done = Promise.resolve().then(() => runChildTurns(state)).catch(error => childFailed(state, error))
          .finally(() => { clearTimeout(state.timer); ledger.active.delete(id); });
        state.done.catch(() => {});
      }
      return { id, messageId: message.id, status: 'queued', done: state.done };
    },
    resume(id, request, options) {
      const record = get(id);
      if (ACTIVE.has(record.status) && !record.messages?.some(item => item.id === options?.requestId)) throw new Error('Child is still running; queue a message instead');
      return manager.message(id, request, options);
    },
    async wait(id, { releaseSlot = true } = {}) {
      const record = get(id), state = ledger.active.get(id);
      if (!ACTIVE.has(record.status)) return record;
      if (!state) throw new Error('Job belongs to an interrupted manager; recover before waiting');
      options.assertWait?.({record:structuredClone(record),releaseSlot});
      let group;
      if (releaseSlot) {
        // Every concurrently waiting tool response remains blocked until capacity is reacquired.
        // Otherwise an earlier completed wait could resume the model while another wait still yielded its slot.
        while (waitGroup?.closing) await waitGroup.resumed;
        if (!waitGroup) {
          let resume, reject;
          const resumed = new Promise((resolve, fail) => { resume = resolve; reject = fail; }); resumed.catch(() => {});
          waitGroup = { count: 0, closing: false, resumed, resume, reject,
            released: Promise.resolve().then(() => currentSlotChanged({ parent: structuredClone(parent), held: false, reason: 'waiting-for-managed-job', jobId: id })) };
        }
        group = waitGroup; group.count++;
      }
      try { if (group) await group.released; return await state.done; }
      finally {
        if (group) {
          if (--group.count === 0) {
            group.closing = true;
            try {
              await group.released;
              if (!closed && !signal?.aborted) await currentSlotChanged({ parent: structuredClone(parent), held: true, reason: 'managed-job-settled', jobId: id });
              group.resume();
            } catch (error) { group.reject(error); }
            finally { if (waitGroup === group) waitGroup = undefined; }
          }
          await group.resumed;
        }
      }
    },
    async cancel(id, reason = 'cancelled') {
      if (!['cancelled', 'handed-off'].includes(reason)) throw new Error('Invalid managed job cancellation outcome');
      const record = get(id), state = ledger.active.get(id);
      if (!ACTIVE.has(record.status)) {
        const child = ledger.children.get(id);
        if (child && ['completed','handed-off'].includes(record.status)) { child.reason = reason; child.controller.abort(); return complete(child.record, reason); }
        return record;
      }
      if (!state) throw new Error('Cannot cancel an unverified old owner; recover or inspect it first');
      state.reason = reason; state.controller.abort(); await state.children?.close();
      return state.done;
    },
    async handoff(id, reason) {
      const record = get(id); record.handoff = { reason: text(reason, 'handoff reason'), at: now() }; save(record);
      const state = ledger.active.get(id); if (state) state.record.handoff = record.handoff;
      if (persistentMode && record.previewLease?.status === 'active') {
        await currentSlotChanged({ parent: structuredClone(parent), held: false, reason: 'human-preview', jobId: id });
        return get(id);
      }
      const result = await manager.cancel(id, 'handed-off');
      await currentSlotChanged({ parent: structuredClone(parent), held: false, reason: 'human-handoff', jobId: id }); return result;
    },
    async preview(id, { ttlMs } = {}) {
      synchronous(assertActive);
      if (!persistentMode || closed || signal?.aborted) throw new Error('Preview requires an active persistent assignment');
      const record = get(id), state = ledger.active.get(id), profile = profiles[record.profileId];
      if (!state || record.kind !== 'command' || !profile?.preview || !ACTIVE.has(record.status)) throw new Error('Preview requires a running command with a trusted preview profile');
      const ttl = previewTtl(ttlMs ?? Math.min(profile.preview.ttlMs, ledger.limits.maxDurationMs));
      if (ttl > ledger.limits.maxDurationMs) throw new Error('Preview TTL exceeds the configured duration limit');
      const checked = await verifyOwnedPreview({ url: profile.preview.url, commandPid: record.execution?.childPid, signal: state.controller.signal });
      if (closed || signal?.aborted || state.controller.signal.aborted || !ledger.active.has(id) || !ACTIVE.has(state.record.status)) throw new Error('Preview command ended during verification');
      synchronous(assertActive);
      if (!state.executionControl || Date.parse(state.record.deadlineAt) <= Date.now()) throw new Error('Preview command budget is exhausted');
      const expiresAt = new Date(Date.now() + ttl).toISOString();
      state.executionControl.setDeadline(Date.parse(expiresAt));
      clearTimeout(state.timer); state.record.deadlineAt = expiresAt;
      const previous = state.record.previewLease;
      state.record.previewLease = { id: previous?.id ?? randomUUID(), status: 'active', ticketId: parent.ticketId, assignmentId: parent.assignmentId,
        workspaceProvisionId: workspace.provisionId, jobId: id, url: checked.url, createdAt: previous?.createdAt ?? now(), renewedAt: previous ? now() : null,
        expiresAt, holder: 'human-review', endpoint: checked, tree: captureVerificationTree({ projectRoot, workspace, paths: scope.paths }) };
      save(state.record); clearTimeout(state.previewTimer);
      state.previewTimer = setTimeout(() => { state.reason = 'preview-expired'; state.controller.abort(); }, Math.max(1, Date.parse(expiresAt) - Date.now()));
      return structuredClone(state.record.previewLease);
    },
    async renewPreview(id, options = {}) {
      if (get(id).previewLease?.status !== 'active') throw new Error('Preview lease is not active');
      return manager.preview(id, options);
    },
    async closePreview(id) {
      const record = get(id), state = ledger.active.get(id);
      if (!record.previewLease) throw new Error('Job has no preview lease');
      if (!state) { if (!ACTIVE.has(record.status)) return record; throw new Error('Preview owner must be recovered before closing'); }
      state.record.previewLease.status = 'closed'; state.record.previewLease.endedAt = now(); save(state.record);
      return manager.cancel(id);
    },
    recover() {
      let interrupted = 0, pending = 0;
      for (const record of manager.list()) {
        if (ledger.active.has(record.id)) continue;
        if (ACTIVE.has(record.status)) {
          if (![record.owner, ...(record.guardians ?? [])].every(dead)) { pending++; continue; }
          complete(record, 'interrupted', { error: 'Job owner exited. Inspect external effects before explicitly starting new work.' }); interrupted++;
        } else wake(record);
      }
      return { interrupted, unverifiedOwners: pending };
    },
    async close() {
      closed = true;
      signal?.removeEventListener('abort', abortParent);
      const results = await Promise.allSettled([...local].map(id => ledger.active.has(id) ? manager.cancel(id) : undefined));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some managed jobs failed to settle');
    },
  };
  const abortParent = () => { void manager.close().catch(() => {}); };
  signal?.addEventListener('abort', abortParent, { once: true });
  return manager;
}

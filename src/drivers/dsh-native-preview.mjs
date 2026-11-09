// A trusted producer registered through the public DSH jobs API. Existing
// arbitrary bash jobs have no public pid and are deliberately not adopted.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { normalizeVerificationProfile } from '../verification.mjs';
import { normalizePreviewProfile, previewTtl } from '../runtime/preview.mjs';

const supervisor = fileURLToPath(new URL('./app-server-supervisor.mjs', import.meta.url));
export function nativePreviewProfiles(values = []) {
  if (!Array.isArray(values) || values.length > 8) throw new Error('Invalid native preview profiles');
  const ids = new Set();
  return values.map(value => {
    const { preview, kind, ...profile } = value;
    const normalized = normalizeVerificationProfile({ ...profile, kind: 'prepare' });
    if (ids.has(normalized.id)) throw new Error('Duplicate native preview profile');
    ids.add(normalized.id);
    return { ...normalized, preview: normalizePreviewProfile(preview) };
  });
}
export function nativePreviewLaunch(profile, root, redactions = []) {
  const cwd = realpathSync(resolve(root, profile.cwd)), rel = relative(realpathSync(root), cwd);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Preview directory escapes its workspace');
  const env = {};
  for (const key of ['PATH','SystemRoot','TMPDIR','TMP','TEMP','LANG','LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, profile.env);
  for (const key of [...redactions, 'JS_SUPERAGENT_DSH_API_KEY','JS_SUPERAGENT_DSH_BRIDGE']) delete env[key];
  return { profileId: profile.id, command: profile.command, args: profile.args, cwd, env,
    url: profile.preview.url, ttlMs: profile.preview.ttlMs, maxLogBytes: profile.maxLogBytes };
}

/** registerOwner must acknowledge the guardian before the command can start. */
export function createDshPreviewProducer(jobs, { sessionId, registerOwner, publish, killGraceMs = 1000 }) {
  const records = new Map();
  return {
    async start(launch, { callId, rootCallId = callId }) {
      let guardian, timer, outcome, cancelled = false, childPid, resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
      const send = message => { if (guardian?.connected) guardian.send(message, error => { if (error) rejectReady(error); }); };
      const stop = reason => { cancelled = true; send({ type: 'abort', reason }); };
      let record;
      const id = jobs.start({ kind: 'bash', owner: sessionId, label: `Registered preview: ${launch.profileId}`, toolCall: { callId, rootCallId },
        run(handle) {
          guardian = spawn(process.execPath, [supervisor], { env: launch.env, stdio: ['ignore','pipe','pipe','ipc'] });
          let bytes = 0;
          for (const [channel, stream] of [['stdout', guardian.stdout], ['stderr', guardian.stderr]]) stream.on('data', chunk => {
            const available = Math.max(0, launch.maxLogBytes - bytes); bytes += chunk.length;
            if (available) handle.append(chunk.subarray(0, available).toString('utf8'), { channel });
          });
          const done = new Promise(resolveDone => {
            guardian.on('message', message => {
              if (message.type === 'result') { outcome = message; return; }
              if (message.type === 'ready') void registerOwner({ callId, jobId: handle.id, guardianPid: guardian.pid }).then(() => {
                if (!cancelled) send({ type: 'start', executable: launch.command, args: launch.args, cwd: launch.cwd, killGraceMs });
              }).catch(error => { rejectReady(error); stop('preview-owner-registration-failed'); });
              if (message.type === 'child') {
                childPid = message.pid; send({ type: 'ack-child' });
                resolveReady({ jobId: handle.id, guardianPid: guardian.pid, commandPid: childPid });
              }
            });
            guardian.once('error', error => { rejectReady(error); resolveDone({ status: 'failed', detail: 'Preview guardian could not start' }); });
            guardian.once('close', () => { clearTimeout(timer); rejectReady(new Error('Preview ended before it became ready'));
              resolveDone({ status: outcome?.code === 0 && !cancelled ? 'completed' : cancelled ? 'killed' : 'failed', detail: outcome?.reason ?? 'Preview process ended' }); });
          });
          return { cancel: stop, done };
        } });
      record = { id, profileId: launch.profileId, stop, get guardianPid() { return guardian?.pid; }, get commandPid() { return childPid; }, deadlineAt: Date.now() + previewTtl(launch.ttlMs) };
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => stop('preview-expired'), Math.max(1, record.deadlineAt - Date.now())); };
      record.arm = arm; records.set(id, record); arm();
      try {
        const identity = await ready;
        return await publish({ ...identity, callId, profileId: launch.profileId, expiresAt: new Date(record.deadlineAt).toISOString() });
      } catch (error) { stop('preview-publication-failed'); throw error; }
    },
    renew(jobId, ttlMs) {
      const record = records.get(jobId), job = jobs.get(jobId, sessionId);
      if (!record || job.status !== 'running' || Date.now() >= record.deadlineAt) throw new Error('Native preview is no longer renewable');
      record.deadlineAt = Date.now() + previewTtl(ttlMs); record.arm();
      return { jobId, expiresAt: new Date(record.deadlineAt).toISOString() };
    },
    close() { for (const record of records.values()) record.stop('preview-owner-disposed'); },
  };
}

const ID = /^[A-Za-z\d._:-]{1,160}$/;
/** A DSH lease transfers live ownership; it is never permission to recreate a job. */
export function validateNativeHandoff(record) {
  if (record?.version !== 1 || record.driver !== 'dsh-sdk' || record.nativeVersion !== '0.2.2-alpha.2' ||
      !['id','ticketId','assignmentId','originRunId'].every(key => ID.test(record[key] ?? '')) ||
      record.session?.driver !== 'dsh-sdk' || !ID.test(record.session.id ?? '') ||
      typeof record.cwd !== 'string' || !record.cwd.startsWith('/') || !/^[a-f\d]{64}$/.test(record.configDigest ?? '') ||
      !Number.isFinite(Date.parse(record.deadlineAt)) || !Array.isArray(record.guardianPids) || !record.guardianPids.length ||
      record.guardianPids.some(pid => !Number.isSafeInteger(pid) || pid < 2) ||
      !Array.isArray(record.jobIds) || !record.jobIds.length || record.jobIds.length > 8 || record.jobIds.some(id => !ID.test(id)) ||
      !Number.isSafeInteger(record.reportBoundary?.terminalSequence) || !Number.isSafeInteger(record.reportBoundary?.assistantSequence) ||
      record.reportBoundary.terminalSequence <= record.reportBoundary.assistantSequence ||
      !['waiting','blocked','failed','ready'].includes(record.reportBoundary.state) ||
      record.reportBoundary.state === 'waiting' && (typeof record.reportBoundary.question !== 'string' || !record.reportBoundary.question.trim())) throw new Error('Invalid native handoff ownership record');
  if (record.previews !== undefined) {
    if (!Array.isArray(record.previews) || !record.previews.length || record.previews.length > 8 ||
      record.previews.some(preview => !record.jobIds.includes(preview.jobId) || !ID.test(preview.profileId??'') ||
        !record.guardianPids.includes(preview.guardianPid) || !Number.isSafeInteger(preview.commandPid) || preview.commandPid < 2 ||
        !Number.isFinite(Date.parse(preview.expiresAt)) || preview.endpoint?.url !== preview.url || !preview.endpoint?.listeners?.length ||
        !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\//.test(preview.url??''))) throw new Error('Invalid native preview evidence');
    if (new Set(record.previews.map(p=>p.jobId)).size!==record.previews.length) throw new Error('Duplicate native previews');
  }
  if(record.reportBoundary.state==='ready' && (!record.previews?.length || record.jobIds.some(id=>!record.previews.some(p=>p.jobId===id)&&!(record.settledJobIds??[]).includes(id))))throw new Error('Ready handoff requires exclusively verified previews and settled jobs');
  return structuredClone(record);
}

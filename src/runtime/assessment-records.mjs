import { createHash } from 'node:crypto';
import { AssessmentContextChanged } from './assessment-refresh.mjs';
export const ASSESSMENT_CONTEXT_UNAVAILABLE = 'assessment_context_unavailable';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function contextUnavailable() {
  return Object.assign(new Error('The requested context is not available in this assessment view'), {
    code: ASSESSMENT_CONTEXT_UNAVAILABLE, failureKind: 'context', retryable: false,
  });
}

/** One host projection supplies both discoverable references and actual reads.
 * The producer must project authority before returning rows; raw shared tables
 * are never a fallback. Rebuild on read/commit so a frozen view cannot hide drift.
 */
export function createAssessmentRecordView(rows, { exposed = [] } = {}) {
  const initial = structuredClone(rows()), byKey = values => new Map(values.map(row => [`${row.resource}:${row.id}`, row]));
  const snapshot = byKey(initial), readSet = new Map();
  if (snapshot.size !== initial.length) throw new Error('Duplicate assessment context reference');
  const references = initial.map(({resource,id}) => ({resource,id}));
  for (const {resource,id} of exposed) {
    const key = `${resource}:${id}`, row = snapshot.get(key);
    if (!row) throw contextUnavailable();
    readSet.set(key, digest(row));
  }
  const changed = (reason, key, previousVersion, currentVersion) => Object.assign(new AssessmentContextChanged(reason), {
    contextChange: { resource: snapshot.get(key).resource, id: snapshot.get(key).id,
      changeKind: 'exposed-record', previousVersion, currentVersion },
  });
  return {
    references,
    // Includes initial prompt cards as well as successful tool reads. These are
    // the original proofs, never regenerated from a newer live projection.
    provenances() { return [...readSet.keys()].flatMap(key => snapshot.get(key).provenance ? [structuredClone(snapshot.get(key).provenance)] : []); },
    read(resource, id, {offset=0,limit=8000,version}={}) {
      const key=`${resource}:${id}`, prior=snapshot.get(key);
      if (!prior) throw contextUnavailable();
      if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>8000) throw contextUnavailable();
      const current=byKey(rows()).get(key);
      if (!current) throw contextUnavailable();
      const currentVersion=digest(current);
      if (currentVersion!==digest(prior) || version && version!==currentVersion) throw changed('record-version', key, digest(prior), currentVersion);
      const full=JSON.stringify(current.value);readSet.set(key,currentVersion);
      return {resource,id,version:currentVersion,offset,text:full.slice(offset,offset+limit),
        nextOffset:offset+limit<full.length?offset+limit:null,length:full.length};
    },
    verify() {
      const current=byKey(rows());
      for(const [key,version] of readSet) {
        if(!current.has(key))throw contextUnavailable();
        if(digest(current.get(key))!==version)throw changed('read-set-version', key, version, digest(current.get(key)));
      }
      return true;
    },
  };
}

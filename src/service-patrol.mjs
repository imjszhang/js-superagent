import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quiet=new Set(['healthy','paused','stopped','not-installed','starting','retrying']);
export const PATROL_CONFIRMATION_MS=20_000;

/** A single external observation. The only writes are to this patrol's own bounded state. */
export function patrolService({recover=false}={},host) {
  if(typeof recover!=='boolean')throw new Error('Patrol recover must be boolean');
  const observed=host.observe(),observedAt=new Date(host.now()).toISOString();
  const base={changed:false,notify:false,action:'observed',health:observed.health,reason:observed.health.reason,observedAt};
  if(!host.path)return {...base,action:'not-installed'};
  let db;
  try {
    db=new DatabaseSync(host.path);db.exec('PRAGMA busy_timeout=0');
    db.exec('BEGIN IMMEDIATE');
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(version!==0&&version!==1)throw new Error('Unsupported patrol state version');
    db.exec("CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY CHECK(id='patrol'), data TEXT NOT NULL)");
    if(version===0)db.exec('PRAGMA user_version=1');
    const row=db.prepare("SELECT data FROM state WHERE id='patrol'").get(),previous=row?JSON.parse(row.data):{};
    const health=observed.health,now=host.now();
    const fingerprint=digest({state:health.state,reason:health.reason,business:health.business&&{
      paused:health.business.paused,available:health.business.available,machineReady:health.business.machineReady,
      activeIncidents:health.business.activeIncidents,modelWaits:health.business.modelWaits,
      sources:(health.business.sources??[]).map(source=>({id:source.id,state:source.state})).sort((a,b)=>a.id.localeCompare(b.id)),
    }});
    const same=observed.identity&&previous.confirmation?.identity===observed.identity;
    const elapsed=same?now-previous.confirmation.lastAt:0;
    const confirmation=health.state==='stalled'&&observed.identity?{identity:observed.identity,
      count:same?Math.min(2,previous.confirmation.count+(elapsed>=PATROL_CONFIRMATION_MS?1:0)):1,
      firstAt:same?previous.confirmation.firstAt:now,lastAt:!same||elapsed>=PATROL_CONFIRMATION_MS?now:previous.confirmation.lastAt}:null;
    const result={...base,changed:fingerprint!==previous.fingerprint,
      notify:fingerprint!==previous.fingerprint&&!quiet.has(health.state),confirmations:confirmation?.count??0};
    let attempt=previous.attempt??null;
    if(recover&&health.state==='stalled') {
      if(!observed.identity||!observed.allowed){result.action='inspection-required';result.reason=observed.blocked??'recovery-not-safe';}
      else if(confirmation.count<2){result.action='awaiting-confirmation';result.reason='second-spaced-observation-required';}
      else if(attempt?.identity===observed.identity){result.action='inspection-required';result.reason='recovery-already-attempted';}
      else {
        // Persist the intent before performing outside actions. A crash never replays this attempt.
        attempt={identity:observed.identity,at:now,status:'started'};
        db.prepare("INSERT INTO state(id,data) VALUES('patrol',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
          .run(JSON.stringify({schemaVersion:1,fingerprint,observedAt,confirmation,attempt,attention:true,decisionFingerprint:previous.decisionFingerprint??null}));
        // Commit the marker, then reacquire the write lock; a second patrol sees the marker and cannot repeat recovery.
        db.exec('COMMIT');db.exec('BEGIN IMMEDIATE');
        let recovery;
        try { recovery=host.recover(observed); }
        catch(error){recovery={action:'inspection-required',reason:error.code==='SERVICE_INTENT_CHANGED'?'operator-intent-changed':'recovery-failed'};}
        attempt.status=recovery.action;
        Object.assign(result,recovery);
      }
    }
    const decisionFingerprint=digest([result.action,result.reason]);
    result.changed ||= decisionFingerprint!==previous.decisionFingerprint;
    const attention=!quiet.has(result.health.state)||result.action==='inspection-required';
    result.notify=result.changed&&(attention||result.action==='restarted'||result.health.state==='healthy'&&previous.attention===true);
    // No task body, credentials, raw exception text, or unbounded history is retained.
    db.prepare("INSERT INTO state(id,data) VALUES('patrol',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(JSON.stringify({schemaVersion:1,fingerprint,decisionFingerprint,attention,observedAt,confirmation,attempt}));
    db.exec('COMMIT');return result;
  } catch(error) {
    try {db?.exec('ROLLBACK');}catch{}
    if(error.errcode===5||error.code==='SQLITE_BUSY'||/database is locked/.test(String(error.message)))return {...base,action:'busy',reason:'another-patrol-is-running'};
    throw error;
  } finally {db?.close();}
}

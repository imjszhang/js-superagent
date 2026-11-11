import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dshHostCallId } from './dsh-history.mjs';
import { nativePreviewProfiles, nativePreviewLaunch } from './dsh-native-preview.mjs';
import { verifyOwnedPreview, previewTtl } from '../runtime/preview.mjs';

const ID = /^[A-Za-z\d._:-]{1,160}$/;
const jobTools = [
  { name: 'js_superagent_job_start', description: 'Start a managed command or child task from a trusted profile. Command profiles take only profileId; text and paths are rejected for them. Child task text and paths can only narrow the trusted instruction. Never supply arbitrary commands or credentials.', inputSchema: { type:'object', additionalProperties:false, required:['profileId'], properties:{profileId:{type:'string'},text:{type:'string'},paths:{type:'array',items:{type:'string'}}} } },
  ...['status','wait','cancel'].map(action=>({name:`js_superagent_job_${action}`,description:`${action} a job owned by this assignment.`,inputSchema:{type:'object',additionalProperties:false,required:['jobId'],properties:{jobId:{type:'string'}}}})),
  ...['message','resume'].map(action=>({name:`js_superagent_job_${action}`,description:'Continue the same scoped child task/session/workspace. message queues after its current turn; resume requires a settled child. Never broaden its instruction or recreate uncertain work.',inputSchema:{type:'object',additionalProperties:false,required:['jobId','text'],properties:{jobId:{type:'string'},text:{type:'string'}}}})),
];
export function dshJobCatalog(input) {
  if (!input.jobs || !['launch','get','list','wait','cancel'].every(key=>typeof input.jobs[key]==='function') || !Array.isArray(input.jobProfiles) || !input.jobProfiles.length || input.jobProfiles.length>100) throw new Error('DSH managed jobs require a trusted runtime manager and profile catalog');
  if (input.jobProfiles.some(item=>item.preview) && !['preview','closePreview'].every(key=>typeof input.jobs[key]==='function')) throw new Error('DSH preview profiles require runtime preview lease support');
  return input.jobProfiles.map(item=>{
    if(!ID.test(item.id??'') || !['command','agent'].includes(item.kind) || typeof item.description!=='string'||item.description.length>2000)throw new Error('Invalid DSH job profile');
    return {id:item.id,kind:item.kind,description:item.description,...(item.preview?{preview:true}:{})};
  });
}
// Only a fixed category and hint cross back to the model; host error text stays private.
function rejection(error) {
  const typed = {
    MATERIAL_FORMAT: ['invalid-arguments', 'Use the current host reference and page fields from the tool schema.'],
    PREPARATION_ARGUMENTS: ['invalid-arguments', 'Use the materialId and provisionId from the current host context, with a concrete reason.'],
    MATERIAL_ACCESS_DENIED: ['scope', 'This material is outside the current grant. Do not substitute a different path or source.'],
    MATERIAL_DESTINATION_DENIED: ['scope', 'This destination is not authorized for the material. Ask the host to resolve the output constraint.'],
    MATERIAL_BINDING_CHANGED: ['authorization-changed', 'The material grant changed. Stop using old references and request host inspection.'],
    PREPARATION_DENIED: ['scope', 'The current authorization does not permit this workspace preparation. Report the constraint to the host.'],
    MATERIAL_IDENTITY: ['source-changed', 'The source project identity changed. Request host inspection before reading or preparing it.'],
    MATERIAL_CHANGED: ['source-changed', 'The material changed during observation. Use a new call and its current version; do not combine pages from different versions.'],
    MATERIAL_MISSING: ['source-changed', 'The material is no longer available. Refresh the directory reference with a new call or report the missing source.'],
    MATERIAL_SNAPSHOT: ['source-changed', 'The frozen material cannot be verified. Request host inspection; do not fall back to current files.'],
    PREPARATION_STALE: ['source-changed', 'This preparation belongs to an older workspace generation. Inspect the current host context before continuing.'],
    PREPARATION_CONFLICT: ['preparation-conflict', 'Another preparation owns this workspace generation. Inspect its saved result before requesting further preparation.'],
    MATERIAL_LIMIT: ['budget-or-capacity', 'The material exceeds its permitted bound. Report incomplete coverage instead of claiming the whole source was read.'],
    MATERIAL_ENCODING: ['unsupported-material', 'This content is not supported as text. Report the unsupported material or request a host-provided text representation.'],
  }[error?.code];
  if (typed) return { error: 'Host rejected this tool call; inspect scope, capabilities and current state.', category: typed[0], hint: typed[1] };
  const detail = String(error?.message ?? error);
  const category = /budget|capacity/i.test(detail) ? 'budget-or-capacity' : /scope|path|workspace/i.test(detail) ? 'scope' : /identity|unknown/i.test(detail) ? 'unknown-identity' : /invalid|must be|required/i.test(detail) ? 'invalid-arguments' : 'unavailable';
  const hint = category === 'invalid-arguments' ? 'Check required fields and types in the tool schema. Command profiles take only profileId; optional child text uses the trusted profile instruction.'
    : category === 'unknown-identity' ? 'Use only IDs from the current trusted profile catalog or scoped context.'
      : category === 'budget-or-capacity' ? 'Inspect or wait for existing work; do not start additional work beyond the configured budget.'
        : category === 'scope' ? 'Keep requested paths and actions within this assignment scope.' : 'Inspect available capabilities or report the blocker to the host.';
  return { error: 'Host rejected this tool call; inspect scope, capabilities and current state.', category, hint };
}
function jobView(record) {
  return {id:record.id,kind:record.kind,profileId:record.profileId,status:record.status,deadlineAt:record.deadlineAt,endedAt:record.endedAt,
    ...(record.kind==='agent'?{turn:record.turn,maxTurns:record.maxTurns,messages:record.messages?.map(item=>({id:item.id,status:item.status,runId:item.runId}))}:{}),
    ...(record.report?{report:record.report}:{}),...(record.result?{execution:{status:record.result.status,exitCode:record.result.exitCode,logTruncated:record.result.logTruncated}}:{}),
    ...(record.previewLease?{preview:{id:record.previewLease.id,status:record.previewLease.status,url:record.previewLease.url,expiresAt:record.previewLease.expiresAt}}:{}),
    ...(record.error?{error:'Managed job failed; inspect private local diagnostics.'}:{})};
}
export async function openDshToolBridge(input, {sessionId,options,redact}) {
  const nativeProfiles = options.nativeHandoff && options.permission !== 'read-only' ? nativePreviewProfiles(input.nativePreviewProfiles) : [];
  const nativePreviews = new Map(), nativeRequests = new Map();
  let business=options.enableAgentTools?input.agentTools:null;
  if(business && (business.version!==1||typeof business.call!=='function'||!Array.isArray(business.definitions)))throw new Error('DSH business tools require a versioned runtime host');
  if(options.enableAgentTools&&!business)throw new Error('DSH business tool host is missing');
  const catalog=options.enableManagedJobs?dshJobCatalog(input):[];
  const previews=catalog.some(item=>item.preview)?[
    {name:'js_superagent_job_preview',description:'Publish an owned preview job as a host-verified loopback preview lease.',inputSchema:{type:'object',additionalProperties:false,required:['jobId'],properties:{jobId:{type:'string'},ttlMs:{type:'integer'}}}},
    {name:'js_superagent_preview_close',description:'Close an owned preview lease.',inputSchema:{type:'object',additionalProperties:false,required:['jobId'],properties:{jobId:{type:'string'}}}},
  ]:[];
  const definitions=[...(business?.definitions??[]),...(options.enableManagedJobs?jobTools:[]),...previews,
    ...(nativeProfiles.length ? [{name:'js_superagent_native_preview_start',description:'Start a trusted profile as a DSH native preview. The host verifies its process and loopback endpoint before allowing a ready handoff. Profiles: '+nativeProfiles.map(p=>p.id).join(', '),inputSchema:{type:'object',additionalProperties:false,required:['profileId'],properties:{profileId:{type:'string'}}}}] : [])];
  const token=randomBytes(32).toString('hex'), calls=new Map(),pending=new Set(),waitingJobs=new Set();let active=true, suspended=false, nativeEndpoint, nativeEmit;
  const server=createServer(async(req,res)=>{
    try {
      if(!active||req.method!=='POST'||req.headers.authorization!==`Bearer ${token}`||req.headers.origin!==undefined)throw new Error('Unauthorized bridge call');
      req.setEncoding('utf8');
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>48000)throw new Error('Bridge request too large');}
      const request=JSON.parse(body);
      if (req.url?.startsWith('/native/preview-') && nativeProfiles.length) {
        if (suspended || input.signal?.aborted || request.sessionId !== sessionId || !ID.test(request.callId ?? '')) throw new Error('Native preview request is not active');
        let result;
        if (req.url === '/native/preview-authorize') {
          const profile = nativeProfiles.find(p => p.id === request.profileId);
          if (!profile) throw new Error('Unknown trusted preview profile');
          const currentProfile = nativePreviewProfiles(input.nativePreviewProfiles).find(p=>p.id===profile.id);
          if (JSON.stringify(profile)!==JSON.stringify(currentProfile)) throw new Error('Native preview profile changed; inspect before relaunching');
          const previous = nativeRequests.get(request.callId);
          if (previous && previous.profile.id !== profile.id || !previous && nativeRequests.size >= 8) throw new Error('Native preview budget or identity conflict');
          nativeRequests.set(request.callId, previous ?? {profile});
          result = nativePreviewLaunch(profile, input.projectRoot, input.redactedEnvironmentKeys);
        } else {
          const entry = nativeRequests.get(request.callId);
          if (!entry || !ID.test(request.jobId ?? '')) throw new Error('Unregistered native preview request');
          if (req.url === '/native/preview-owner') {
            if (!Number.isSafeInteger(request.guardianPid) || request.guardianPid < 2 || entry.jobId && entry.jobId !== request.jobId) throw new Error('Invalid native preview owner');
            if (!entry.jobId) { options.registerNativeProcess(request.guardianPid); entry.jobId = request.jobId; entry.guardianPid = request.guardianPid; }
            result = {registered:true};
          } else if (req.url === '/native/preview-publish') {
            if (entry.jobId !== request.jobId || entry.guardianPid !== request.guardianPid || !Number.isSafeInteger(request.commandPid) || request.commandPid < 2) throw new Error('Native preview owner mismatch');
            const expires = Date.parse(request.expiresAt);
            if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + previewTtl(entry.profile.preview.ttlMs) + 1000) throw new Error('Invalid preview expiry');
            let endpoint, failure;
            for (let attempt=0;attempt<20;attempt++) { try { endpoint = await verifyOwnedPreview({url:entry.profile.preview.url,commandPid:request.commandPid,signal:input.signal}); break; } catch(error) { failure=error; await new Promise(resolve=>setTimeout(resolve,50)); } }
            if (!endpoint) throw failure;
            if (suspended || input.signal?.aborted) throw new Error('Native preview authorization expired');
            result = {jobId:request.jobId,profileId:entry.profile.id,url:entry.profile.preview.url,commandPid:request.commandPid,guardianPid:entry.guardianPid,endpoint,expiresAt:request.expiresAt};
            nativePreviews.set(request.jobId,result);
            await input.recordHostTool?.({callId:dshHostCallId(sessionId,input.runId,request.callId),name:'js_superagent_native_preview_start',arguments:{profileId:entry.profile.id},result,sessionId,turnId:input.runId});
          } else throw new Error('Unknown native preview action');
        }
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
      }
      if (req.url === '/native/register' && options.nativeHandoff) {
        const endpoint = new URL(request.url);
        if (request.sessionId !== sessionId || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/collect' || nativeEndpoint) throw new Error('Invalid native collector');
        nativeEndpoint = endpoint; res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return;
      }
      if (req.url === '/native/event' && options.nativeHandoff) {
        if (request.sessionId !== sessionId || !['settled','failed'].includes(request.event?.type)) throw new Error('Invalid native evidence');
        await nativeEmit?.(JSON.parse(redact(JSON.stringify(request.event))));
        res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return;
      }
      if (req.url !== '/' || suspended || input.signal?.aborted) throw new Error('Host tool bridge is suspended');
      if(Object.keys(request).some(key=>!['sessionId','callId','name','arguments'].includes(key))||request.sessionId!==sessionId||!ID.test(request.callId??'')||!definitions.some(def=>def.name===request.name)||!request.arguments||typeof request.arguments!=='object'||Array.isArray(request.arguments))throw new Error('Invalid bridge identity');
      const signature=JSON.stringify([request.name,request.arguments]),previous=calls.get(request.callId);
      if(previous&&previous.signature!==signature||!previous&&calls.size>=128)throw new Error('Tool call identity conflict or budget exhausted');
      // Durable business receipts are idempotent, but their authorization can
      // change during a live turn. The HTTP cache must not bypass that check.
      if (previous?.completed && business?.definitions.some(def => def.name === request.name)) {
        const value = await business.call({callId:dshHostCallId(sessionId,input.runId,request.callId),name:request.name,arguments:request.arguments,sessionId,turnId:input.runId});
        const serialized = redact(JSON.stringify(value));
        if (Buffer.byteLength(serialized) > 60000) throw new Error('Tool result exceeds budget');
        res.writeHead(200, {'content-type':'application/json'}); res.end(serialized); return;
      }
      const task=previous?.task??Promise.resolve().then(async()=>{
        if(!active||input.signal?.aborted)throw new Error('Bridge is closed');
        const callId=dshHostCallId(sessionId,input.runId,request.callId);
        let result;
        if(business?.definitions.some(def=>def.name===request.name))result=await business.call({callId,name:request.name,arguments:request.arguments,sessionId,turnId:input.runId});
        else {
          const args=request.arguments;
          if(request.name==='js_superagent_job_start'){
            if(Object.keys(args).some(key=>!['profileId','text','paths'].includes(key))||!catalog.some(item=>item.id===args.profileId))throw new Error('Unknown trusted job profile');
            const handle=input.jobs.launch(args,{requestId:callId});result=input.jobs.get(handle.id);
          }else if(['js_superagent_job_message','js_superagent_job_resume'].includes(request.name)){
            const action=request.name.endsWith('_resume')?'resume':'message';
            if(Object.keys(args).some(key=>!['jobId','text'].includes(key))||!ID.test(args.jobId??'')||typeof input.jobs[action]!=='function')throw new Error('Child follow-up is unavailable');
            input.jobs[action](args.jobId,{text:args.text},{requestId:callId});result=input.jobs.get(args.jobId);
          }else{
            if(!ID.test(args.jobId??'')||Object.keys(args).some(key=>!(request.name==='js_superagent_job_preview'?['jobId','ttlMs']:['jobId']).includes(key)))throw new Error('Invalid job arguments');
            if(request.name==='js_superagent_job_status')result=input.jobs.get(args.jobId);
            else if(request.name==='js_superagent_job_wait'){
              waitingJobs.add(args.jobId);try{result=await input.jobs.wait(args.jobId);}finally{waitingJobs.delete(args.jobId);}
            }
            else if(request.name==='js_superagent_job_cancel')result=await input.jobs.cancel(args.jobId);
            else if(request.name==='js_superagent_job_preview'){
              if(!catalog.some(item=>item.id===input.jobs.get(args.jobId).profileId&&item.preview)||typeof input.jobs.preview!=='function')throw new Error('Preview unavailable');
              await input.jobs.preview(args.jobId,args.ttlMs===undefined?{}:{ttlMs:args.ttlMs});result=input.jobs.get(args.jobId);
            }else if(request.name==='js_superagent_preview_close'){await input.jobs.closePreview(args.jobId);result=input.jobs.get(args.jobId);}
            else throw new Error('Unknown managed job method');
          }
          result=jobView(result);
        }
        if(!active||input.signal?.aborted)throw new Error('Bridge was closed during call');
        const serialized=redact(JSON.stringify(result));if(Buffer.byteLength(serialized)>60000)throw new Error('Tool result exceeds budget');
        await input.recordHostTool?.({callId,name:request.name,arguments:request.arguments,result:JSON.parse(serialized),sessionId,turnId:input.runId});
        return serialized;
      });
      if(!previous){const entry={signature,task,completed:false};calls.set(request.callId,entry);pending.add(task);task.then(()=>{entry.completed=true;pending.delete(task);},()=>pending.delete(task));}
      const result=await task;res.writeHead(200,{'content-type':'application/json'});res.end(result);
    }catch(error){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify(rejection(error)));}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return { definitions,
    isRegisteredPreview(jobId) { return nativePreviews.has(jobId); },
    async verifyPreviews(jobIds) {
      if (!jobIds.length || jobIds.some(id => !nativePreviews.has(id))) return null;
      const results=[];
      for (const id of jobIds) { const value=nativePreviews.get(id); if(Date.parse(value.expiresAt)<=Date.now())return null;
        const endpoint=await verifyOwnedPreview({url:value.url,commandPid:value.commandPid,signal:input.signal}); results.push({...value,endpoint}); }
      return results;
    },
    async renewPreview(jobId, ttlMs) {
      const record=nativePreviews.get(jobId);if(!record||Date.parse(record.expiresAt)<=Date.now())throw new Error('Native preview lease expired');
      await verifyOwnedPreview({url:record.url,commandPid:record.commandPid});
      const response=await fetch(nativeEndpoint,{method:'POST',signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({sessionId,action:'renew-preview',jobId,ttlMs:previewTtl(ttlMs)})});
      const result=await response.json();if(!response.ok||result.jobId!==jobId||Date.parse(result.expiresAt)<=Date.now())throw new Error('Native preview renewal failed');
      record.expiresAt=result.expiresAt;return structuredClone(record);
    },
    suspend() { if (pending.size) throw new Error('Native tools still in flight'); suspended = true; },
    rebind(next) { if (pending.size || !suspended) throw new Error('Native bridge is not quiescent'); input = next; business = options.enableAgentTools ? next.agentTools : null; calls.clear(); suspended = false; },
    async collect(jobIds, emit) {
      if (!nativeEndpoint || !options.nativeHandoff) throw new Error('Native collector did not register');
      nativeEmit = emit;
      const response = await fetch(nativeEndpoint, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' }, body: JSON.stringify({sessionId,jobIds}) });
      const ack = await response.json(); if (!response.ok || ack.installed !== true || JSON.stringify(ack.jobIds) !== JSON.stringify(jobIds)) throw new Error('Native collector acknowledgement mismatch');
      return ack;
    },
    environment:JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,token}),async close(){active=false;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // An interrupted native tool must reach quiescence before the Driver settles.
    // Ordinary jobs with no in-flight wait remain owned by the runtime lifecycle.
    await Promise.allSettled([...waitingJobs].map(id=>input.jobs.cancel(id)));await Promise.allSettled([...pending]);} };
}

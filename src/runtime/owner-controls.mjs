import { createHash, randomUUID } from 'node:crypto';

export const ONLINE_SETTING_METHODS = Object.freeze(['configureScheduler', 'configureRecovery', 'configureRepositorySource']);
export const OWNER_CONTROL_METHODS = Object.freeze(['jobControl', 'controlNativePreview', 'verifyTicket', 'deliverTicket', 'runPRReview', 'adoptChild', 'recoverChildAdoption', 'replaceSession', 'linkGitHubPullRequest', ...ONLINE_SETTING_METHODS]);
const PREFIX = 'owner-control:';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const id = value => typeof value === 'string' && /^[A-Za-z\d._:-]{1,200}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function json(value, depth = 0) {
  if (depth > 12) fail('CONTROL_INVALID', 'Control arguments exceed nesting limits');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (!object(value) || Object.keys(value).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('CONTROL_INVALID', 'Control arguments must be plain JSON');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, json(value[key], depth + 1)]));
}
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('CONTROL_INVALID', 'Unsupported control arguments'); }
export function normalizeOwnerControl({ method, args } = {}) {
  const setting = ONLINE_SETTING_METHODS.includes(method);
  if (!OWNER_CONTROL_METHODS.includes(method) || !Array.isArray(args) || (setting ? !object(args[0]) : !id(args[0]))) fail('CONTROL_INVALID', 'Select a supported control method and target');
  const normalized = json(args);
  if (Buffer.byteLength(JSON.stringify(normalized)) > 32 * 1024) fail('CONTROL_INVALID', 'Control arguments exceed 32 KiB');
  const expected = setting ? 2 : {jobControl:3, controlNativePreview:2, verifyTicket:1, deliverTicket:1, runPRReview:1, adoptChild:3, recoverChildAdoption:3, replaceSession:2, linkGitHubPullRequest:2}[method];
  if (normalized.length !== expected) fail('CONTROL_INVALID', 'Control argument count does not match its method');
  if (['jobControl','adoptChild','recoverChildAdoption'].includes(method) && !id(normalized[1])) fail('CONTROL_INVALID', 'Invalid child job or adoption target');
  const options = normalized.at(-1);
  if (setting) {
    fields(options,['expectedRevision']);
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) fail('CONTROL_INVALID','Settings require their current revision');
    fields(normalized[0],{configureScheduler:['maxWorkers','humanReserve'],configureRecovery:['autoResume','retryBeforeStart','maxAttempts','initialDelayMs'],configureRepositorySource:['enabled','observe','fetchPullHead','streams']}[method]);
  }
  if (method === 'jobControl') {
    fields(options,['action','ttlMs','reason','text','requestId']);
    if (!['preview','renew','close','cancel','message','reply','resume'].includes(options.action)) fail('CONTROL_INVALID','Invalid managed job action');
    if (['message','reply','resume'].includes(options.action) && (!id(options.requestId) || typeof options.text !== 'string' || !options.text.trim() || options.text.length > 16000)) fail('CONTROL_INVALID','Child message requires text and a stable requestId');
  } else if (method === 'controlNativePreview') {
    fields(options,['leaseId','jobId','action','ttlMs']);
    if (!id(options.leaseId) || !id(options.jobId) || !['renew','close'].includes(options.action)) fail('CONTROL_INVALID','Invalid native preview control');
  } else if (method === 'replaceSession') {
    fields(options,['reason','expectedSessionId','adoptCurrentSettings']);
    if (typeof options.reason !== 'string' || !options.reason.trim() || !(options.expectedSessionId === null || typeof options.expectedSessionId === 'string') || options.adoptCurrentSettings !== undefined && typeof options.adoptCurrentSettings !== 'boolean') fail('CONTROL_INVALID','Session replacement requires a reason and expectedSessionId');
  } else if (method === 'adoptChild') {
    fields(options,['expectedPlanDigest']); if (typeof options.expectedPlanDigest !== 'string' || !options.expectedPlanDigest) fail('CONTROL_INVALID','Adoption requires its reviewed plan digest');
  } else if (method === 'recoverChildAdoption') {
    fields(options,['mode']); if (!['rollback','finish'].includes(options.mode)) fail('CONTROL_INVALID','Adoption recovery requires rollback or finish mode');
  }
  else if (method === 'linkGitHubPullRequest') {
    fields(options,['number']); if (!Number.isSafeInteger(options.number) || options.number < 1) fail('CONTROL_INVALID','Invalid PR number');
  }
  if (object(options) && options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1)) fail('CONTROL_INVALID','Invalid preview duration');
  return {method,args:normalized};
}

/** Local operator requests, tied to one loop incarnation. No automatic replay after owner loss. */
export class OwnerControls {
  constructor(store, { owner, binding, now = () => new Date().toISOString() }) { Object.assign(this,{store,owner,binding,now}); }
  enqueue(input) {
    fields(input,['requestId','method','args']);
    if (!id(input.requestId)) fail('CONTROL_INVALID','A bounded stable requestId is required');
    const request = normalizeOwnerControl(input), digest=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const key=PREFIX+createHash('sha256').update(input.requestId).digest('hex');
    return this.store.atomic(()=>{
      const old=this.store.getMeta(key);
      if(old){if(old.digest!==digest)fail('CONTROL_REQUEST_CONFLICT','requestId already names a different control');return this.view(old);}
      const owner=this.owner(); if(!owner)fail('CONTROL_OWNER_UNAVAILABLE','Start the owning runtime before submitting a control request');
      if(owner.controlProtocol!==1)fail('CONTROL_OWNER_UNSUPPORTED','The running owner does not support queued controls; stop it and explicitly deploy the updated package before restarting');
      if(ONLINE_SETTING_METHODS.includes(request.method)&&!owner.controlMethods?.includes(request.method))fail('CONTROL_OWNER_UNSUPPORTED','The running owner does not support online settings; explicitly deploy the updated package while stopped');
      if(this.store.listMeta(PREFIX).filter(row=>row.value.owner.loopToken===owner.loopToken&&['queued','running'].includes(row.value.status)).length>=128)fail('CONTROL_QUEUE_FULL','Inspect pending controls before adding more requests');
      const binding=this.binding(request.method,request.args);
      const value={operationId:key.slice(PREFIX.length),requestId:input.requestId,...request,digest,binding,owner,status:'queued',createdAt:this.now()};
      this.store.setMeta(key,value);return this.view(value);
    });
  }
  view(value) {
    const current=this.owner(), stale=!current || current.loopToken!==value.owner.loopToken || current.leaseToken!==value.owner.leaseToken;
    const result={...value};delete result.digest;delete result.owner;delete result.binding;delete result.claim;
    if(stale&&['queued','running'].includes(value.status)){result.status=value.status==='running'?'unknown':'cancelled';result.error={code:'CONTROL_OWNER_CHANGED',message:value.status==='running'?'Owner stopped before a receipt was recorded; inspect task effects before a new request':'Owning runtime stopped; this request will not execute on a replacement owner'};}
    return result;
  }
  get(operationId) { if(!/^[a-f\d]{64}$/.test(operationId??''))fail('CONTROL_INVALID','Invalid control operation ID');const value=this.store.getMeta(PREFIX+operationId);return value?this.view(value):null; }
  list({limit=50}={}) { if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('CONTROL_INVALID','Control list limit must be 1 to 200');return this.store.listMeta(PREFIX).map(row=>this.view(row.value)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit); }
  async drain(owner, execute, { canExecute = () => true, canClaim = () => true } = {}) {
    for(const row of this.store.listMeta(PREFIX)) {
      if(!canExecute())return;
      const value=row.value;
      if(value.status!=='queued'||value.owner.loopToken!==owner.loopToken||value.owner.leaseToken!==owner.leaseToken)continue;
      let claimed;
      this.store.atomic(()=>{
        const current=this.owner(), saved=this.store.getMeta(row.key);
        if(!canExecute()||!current||current.loopToken!==owner.loopToken||current.leaseToken!==owner.leaseToken||saved.status!=='queued'||!canClaim(value.method,value.args))return;
        try {if(JSON.stringify(this.binding(value.method,value.args))!==JSON.stringify(value.binding))fail('CONTROL_TARGET_CHANGED','Ticket/session/settings changed after the request; inspect before submitting another request');}
        catch(error){this.store.setMeta(row.key,{...saved,status:'failed',completedAt:this.now(),error:{code:error.code??'CONTROL_PRECONDITION',message:String(error.message).slice(0,1000)}});return;}
        claimed={...saved,status:'running',startedAt:this.now(),claim:randomUUID()};this.store.setMeta(row.key,claimed);
      });
      if(!claimed)continue;
      let completion;
      try {
        const result=await execute(claimed.method,claimed.args);
        const encoded=JSON.stringify(result??null);
        completion={status:'completed',result:Buffer.byteLength(encoded)>128*1024?{omitted:true,reason:'Result exceeds receipt limit; inspect the target task'}:JSON.parse(encoded)};
      } catch(error) {completion={status:'unknown',error:{code:error.code??'CONTROL_EXECUTION_FAILED',message:String(error.message??error).slice(0,1000)}};}
      this.store.atomic(()=>{const saved=this.store.getMeta(row.key);if(saved?.claim===claimed.claim&&saved.status==='running')this.store.setMeta(row.key,{...saved,...completion,completedAt:this.now()});});
    }
  }
}

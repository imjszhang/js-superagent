import { createHash } from 'node:crypto';
import { assessmentStatus, assessmentFailureMessage, publicAssessmentFailure } from './assessment-status.mjs';
import { key } from '../../dist/core/index.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const reason = value => typeof value === 'string' ? value : value?.reason ?? value?.code ?? value?.message ?? null;
const unique = values => [...new Set(values.filter(value => typeof value === 'string'))];
const short = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : value;
const threadKey = ref => typeof ref === 'string' ? ref : ref?.source && ref?.id ? `${ref.source}:${ref.id}` : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const add = (index, id, value) => { if(typeof id!=='string')return;const found=index.get(id)??[];found.push(value);index.set(id,found); };
const positive = value => Number.isSafeInteger(Number(value)) && Number(value)>0;

// Project the destination reconciliation that Outbox performs before ordering,
// without calling its migration helper or modifying the pending receipt.
function replyConversation(state, message) {
  const channel=message.channel??{},address=channel.address??{},publicId=state.publicId(message.ticketId);
  let root=address.reviewRootId??address.reviewCommentId??null;
  if(channel.source==='github'&&positive(address.pullNumber)&&!address.reviewRootId&&message.ticketId){
    const domain=state.tickets.get(state.meta.get(`ticket:${publicId}`)?.domainId??message.ticketId);
    const matches=[];
    if(domain)for(const id of unique([domain.origin?.triggerId,...list(domain.inputs).filter(input=>input.kind==='trigger').map(input=>input.triggerId)])){
      const trigger=state.triggers.get(id),event=trigger?.meta?.pullEvent;
      if(trigger?.source!=='github'||event?.kind!=='review_comment'||!positive(event.reviewRootId)||event.repository!==address.repository||String(event.pullNumber)!==address.pullNumber||event.headSha!==address.headSha)continue;
      if(message.sourceTriggerId===id||positive(address.reviewCommentId)&&Number(address.reviewCommentId)===event.reviewCommentId||message.kind==='acknowledgement'&&message.id===key('ack',id)||message.id===key('reply',id,message.text)||domain.origin?.triggerId===id&&message.id===key('reply',domain.id,message.text)||domain.attention?.triggerId===id&&message.id===key('attention-reply',domain.attention.id))matches.push(event.reviewRootId);
    }
    if(matches.length&&new Set(matches).size===1)root=String(matches[0]);
  }
  return JSON.stringify([publicId,channel.source,channel.thread,root]);
}

function optionsFor(store, kind, options = {}) {
  const {limit=20,cursor,query='',source,problemsOnly=false,projectForSearch}=options;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Diagnostics limit must be 1 to 100');
  if(typeof query!=='string'||query.length>200||Buffer.byteLength(query)>600||/[\u0000-\u001f\u007f]/.test(query))throw new Error('Invalid diagnostics query');
  if(source!==undefined&&(typeof source!=='string'||!source||source.length>100))throw new Error('Invalid diagnostics source');
  if(typeof problemsOnly!=='boolean'||projectForSearch!==undefined&&typeof projectForSearch!=='function')throw new Error('Invalid diagnostics options');
  const normalized=query.trim().toLowerCase(),scope=digest([store.path,kind,normalized,source??null,problemsOnly]);
  let after=null;
  if(cursor!==undefined){
    let parsed;try{if(typeof cursor!=='string'||cursor.length>4096)throw new Error();parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new Error('Invalid diagnostics cursor');}
    if(parsed?.v!==1||parsed.scope!==scope||typeof parsed.after!=='string'||parsed.after.length>2000)throw new Error('Diagnostics cursor does not match this project or query');
    after=parsed.after;
  }
  return {limit,query:normalized,source,problemsOnly,projectForSearch,scope,after};
}

/** Read existing tables only; no Engine calls, transactions, migration or delivery attempts. */
function snapshot(store) {
  const tables=new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  const rows=table=>tables.has(table)?store.db.prepare(`SELECT * FROM ${table}${table==='receipts'?' ORDER BY rowid':''}`).all():[];
  const domain=table=>new Map(rows(`domain_${table}`).map(row=>[row.id,JSON.parse(row.data)]));
  const meta=new Map(rows('kv').map(row=>[row.key,JSON.parse(row.data)]));
  const state={meta,triggers:domain('triggers'),dispositions:domain('dispositions'),threads:domain('threads'),tickets:domain('tickets'),decisions:domain('decisions'),
    receipts:rows('receipts').map(row=>({...JSON.parse(row.data),id:row.id,status:row.status})),effects:rows('effects').map(row=>({...row,payload:JSON.parse(row.payload)}))};
  state.store = store;
  state.ids=unique([...state.triggers.keys(),...[...meta.keys()].filter(id=>id.startsWith('github:event:')).map(id=>id.slice('github:event:'.length)),
    ...[...meta.keys()].filter(id=>id.startsWith('github:paused:')).map(id=>id.slice('github:paused:'.length))]);
  state.publicId=id=>id?(meta.get(`public:${id}`)??id):null;
  state.domainIds=new Map([...state.tickets.keys()].map(id=>[state.publicId(id),id]));
  state.info=new Map();state.eventsByThread=new Map();state.ackEvents=new Map();
  for(const id of state.ids){
    const trigger=state.triggers.get(id),receipt=meta.get(`github:event:${id}`),paused=meta.get(`github:paused:${id}`);
    const reference=trigger??receipt?.reference??paused?.event??{},source=reference.source??(id.startsWith('github:')?'github':'unknown');
    const keys=unique([...list(reference.threads).map(threadKey),reference.thread?`${source}:${reference.thread}`:null,
      trigger?.channel?`${trigger.channel.source}:${trigger.channel.thread}`:null]);
    state.info.set(id,{trigger,receipt,paused,reference,source,keys});state.ackEvents.set(key('ack',id),id);
    for(const thread of keys)add(state.eventsByThread,thread,id);
  }
  state.evalThreads=new Map();state.decisionsByEvent=new Map();state.ticketsByEvent=new Map();state.inputsByEvent=new Map();state.notesByEvent=new Map();
  for(const thread of state.threads.values())for(const id of unique([...list(thread.pending),...list(thread.evaluating?.triggerIds)]))add(state.evalThreads,id,thread);
  for(const decision of state.decisions.values())for(const id of list(decision.triggerIds)){add(state.decisionsByEvent,id,decision);add(state.ticketsByEvent,id,decision.ticketId);}
  const notesByInput=new Map();
  for(const [name,value] of meta)if(name.startsWith('context-notice:')){
    const note={...value,domainId:name.slice('context-notice:'.length).split(':')[0]};
    add(state.notesByEvent,note.triggerId,note);add(state.ticketsByEvent,note.triggerId,note.domainId);notesByInput.set(`${note.domainId}:${note.inputId}`,note);
  }
  for(const ticket of state.tickets.values()){
    for(const id of unique([ticket.origin?.triggerId,...list(ticket.origin?.triggerIds)]))add(state.ticketsByEvent,id,ticket.id);
    for(const input of list(ticket.inputs)){
      const id=input.triggerId??notesByInput.get(`${ticket.id}:${input.id}`)?.triggerId;
      if(id){add(state.ticketsByEvent,id,ticket.id);add(state.inputsByEvent,`${ticket.id}:${id}`,input);}
    }
  }
  for(const [id,disposition] of state.dispositions){
    for(const domainId of unique([...list(disposition.fanout),...list(disposition.context),...list(disposition.acked),...list(disposition.handbacks).map(item=>item.ticketId)]))add(state.ticketsByEvent,id,domainId);
    const decision=state.decisions.get(disposition.decisionId);if(decision){add(state.decisionsByEvent,id,decision);add(state.ticketsByEvent,id,decision.ticketId);}
  }
  for(const [id,{receipt}] of state.info)for(const ticketId of unique([receipt?.ticketId,...list(receipt?.outcomes).map(item=>item.ticketId)]))add(state.ticketsByEvent,id,state.domainIds.get(ticketId)??ticketId);
  state.replyEffects=new Map(state.effects.filter(effect=>['reply','coordinator-answer'].includes(effect.kind)&&!effect.cancelled).map(effect=>[effect.key,effect]));
  state.replyEvents=new Map();state.repliesByThread=new Map();state.repliesByTicket=new Map();state.directReplies=new Map();state.blockedReplies=new Map();
  const earlierReplies=new Map();
  for(const receipt of state.receipts){
    const channel=receipt.channel,thread=channel?`${channel.source}:${channel.thread}`:null;
    // Hash only plausible events in the same conversation, never every event in the project.
    const ack=state.ackEvents.get(receipt.id),direct=ack?[ack]:(state.eventsByThread.get(thread)??[]).filter(id=>receipt.id===key('reply',id,receipt.text??''));
    state.replyEvents.set(receipt.id,direct);for(const id of direct)add(state.directReplies,id,receipt);
    add(state.repliesByThread,thread,receipt);add(state.repliesByTicket,state.publicId(receipt.ticketId),receipt);
    if(receipt.status==='pending'){
      const conversation=replyConversation(state,receipt),earlier=earlierReplies.get(conversation);
      // Outbox stops at the first blocker; retain that fact without building a
      // quadratic chain when a paused conversation has many pending messages.
      if(earlier)state.blockedReplies.set(receipt.id,[earlier]);
      if(!earlier&&count(state.replyEffects.get(receipt.id)?.attempts)<3)earlierReplies.set(conversation,receipt.id);
    }
  }
  return state;
}

function replyView(state, receipt) {
  const effect=state.replyEffects.get(receipt.id),attempts=count(effect?.attempts);
  const terminal=state.meta.get(`receipt:terminal:${receipt.id}`),delivery=state.meta.get(`receipt:${receipt.id}`),ordering=state.meta.get(`receipt:ordering:${receipt.id}`);
  const status=receipt.status==='pending'&&attempts>0?'failed':receipt.status;
  const blockedBy=state.blockedReplies.get(receipt.id)??[];
  const pendingReason=receipt.status==='pending'?(state.meta.get('runtime:pause')?.paused?'runtime-paused':blockedBy.length?'waiting-for-earlier-reply':null):null;
  return {id:receipt.id,source:receipt.channel?.source??'unknown',thread:receipt.channel?.thread??null,ticketId:state.publicId(receipt.ticketId),kind:receipt.kind??null,
    status,text:receipt.text??'',textTruncated:false,attempts,nextRetryAt:receipt.status==='pending'&&Number.isFinite(effect?.due)?new Date(effect.due).toISOString():null,
    reason:pendingReason??reason(terminal)??reason(ordering)??(receipt.status==='dropped'?'withdrawn-or-unavailable':null),error:effect?.error||null,url:delivery?.url??null,
    eventIds:state.replyEvents.get(receipt.id)??[],...(blockedBy.length?{blockedBy}:{})};
}

function eventView(state, id) {
  const info=state.info.get(id);if(!info)return null;
  const {trigger,receipt,paused,reference,source,keys}=info,disposition=state.dispositions.get(id);
  const threadFacts=[...new Map([...keys.map(name=>state.threads.get(name)),...state.evalThreads.get(id)??[]].filter(Boolean).map(thread=>[thread.key,thread])).values()];
  const decisions=[...new Map((state.decisionsByEvent.get(id)??[]).map(decision=>[decision.id,decision])).values()].sort((a,b)=>String(b.at??'').localeCompare(String(a.at??'')));
  const evalThreads=threadFacts.map(thread=>({key:thread.key,status:list(thread.evaluating?.triggerIds).includes(id)?'evaluating':list(thread.pending).includes(id)?'pending':'none',evalId:list(thread.evaluating?.triggerIds).includes(id)?thread.evaluating.id:null}));
  const assessmentRef = state.meta.get(`assessment-trigger:${id}`)?.evalId ?? disposition?.evalId;
  const assessment = assessmentRef ? state.meta.get(`assessment:${assessmentRef}`) : null;
  const assessmentInfo = assessment ? { evalId: assessmentRef, status: assessment.status, ...(assessment.status==='failed'?publicAssessmentFailure(assessment):{failureKind:null,code:null,retryable:false}), attempts: assessment.attempts ?? null, corrections: assessment.corrections ?? 0, retries: assessment.retries ?? 0, message: assessment.status === 'failed' ? assessmentFailureMessage(assessment) : null } : null;
  const requests = [...state.meta.entries()].filter(([key, value]) => key.startsWith('coordination:event:') && value.references?.triggerId === id)
    .flatMap(([, value]) => (value.receipts ?? []).filter(receipt => receipt.kind === 'request' && receipt.result?.triggerId).map(receipt => assessmentStatus(state.store, receipt.result.triggerId)));
  const evaluationStatus=evalThreads.some(thread=>thread.status==='evaluating')?'evaluating':evalThreads.some(thread=>thread.status==='pending')?'pending':assessment?.status==='failed'?'failed':decisions.length?'decided':'none';
  const contextNotices=state.notesByEvent.get(id)??[];
  const tickets=[];
  for(const domainId of unique(state.ticketsByEvent.get(id)??[])){
    const ticket=state.tickets.get(domainId);if(!ticket)continue;
    const notes=contextNotices.filter(item=>item.domainId===ticket.id),inputs=state.inputsByEvent.get(`${ticket.id}:${id}`)??[];
    const origin=ticket.origin?.triggerId===id||list(ticket.origin?.triggerIds).includes(id);
    tickets.push({ticketId:state.publicId(ticket.id),domainId:ticket.id,origin,fanout:list(disposition?.fanout).includes(ticket.id),context:list(disposition?.context).includes(ticket.id)||notes.length>0||inputs.some(input=>input.context),
      acknowledged:list(disposition?.acked).includes(ticket.id),handback:list(disposition?.handbacks).filter(item=>item.ticketId===ticket.id).at(-1)?.reason??null,ended:ticket.ended??null,
      inputs:inputs.map(input=>({id:input.id,kind:input.kind,state:notes.find(note=>note.inputId===input.id)?.retired||state.meta.has(`github:retired:${ticket.id}:${id}`)||state.meta.has(`input:retired:${ticket.id}:${id}`)?'retired':input.readAt?'read':list(ticket.undelivered).includes(input.id)?'pending':input.deliveredAt||input.deliveredTo?'delivered':'unknown',at:input.at??null,readAt:input.readAt??null,deliveredAt:input.deliveredAt??null}))});
  }
  const relatedReplies=[...(state.directReplies.get(id)??[]),...keys.flatMap(name=>state.repliesByThread.get(name)??[]),...tickets.flatMap(ticket=>state.repliesByTicket.get(ticket.ticketId)??[])];
  const replies=[...new Map(relatedReplies.map(message=>[message.id,message])).values()].map(message=>({...replyView(state,message),relation:state.replyEvents.get(message.id)?.includes(id)?'direct':'related'}));
  const deferred=!!paused||receipt?.status==='deferred',filtered=!!disposition?.filtered||receipt?.status==='ignored'||receipt?.status==='filtered';
  const hold=state.meta.get(`pull-link-required:${id}`);
  const intake={status:deferred?'deferred':filtered?'filtered':trigger||receipt?.status==='received'?'received':receipt?.status??'unknown',reason:hold?.status==='pending'?'pull-link-required':reason(disposition?.filtered)??receipt?.reason??(deferred?'runtime-paused':null),
    outcomes:list(receipt?.outcomes).map(item=>({ticketId:state.publicId(item.ticketId),status:item.status,reason:reason(item.reason)}))};
  const problem=assessment?.status==='failed'||filtered||deferred||hold?.status==='pending'||decisions.some(item=>item.kind==='unavailable'&&!item.dismissed)||replies.some(item=>['failed','dropped'].includes(item.status));
  return {id,source,at:reference.at??reference.updatedAt??reference.createdAt??receipt?.at??paused?.at??null,url:reference.url??null,
    actor:reference.actor?{source:reference.actor.source??source,id:typeof reference.actor==='string'?reference.actor:reference.actor.id??reference.actor.login??null}:null,available:!!trigger,text:reference.text??'',textTruncated:!trigger&&!!receipt?.reference,
    intake,...(requests.length?{requests}:{}),evaluation:{status:evaluationStatus,...(assessmentInfo?{assessment:assessmentInfo}:{}),decisions:decisions.map(decision=>({id:decision.id,kind:decision.audit?.coordinatorAnswer?'answer':decision.kind,reason:decision.reason??[],at:decision.at??null,ticketId:state.publicId(decision.ticketId)})),threads:evalThreads},
    tickets,replies,problem,omitted:{threads:0,decisions:0,tickets:0,inputs:0,replies:0,outcomes:0}};
}

function boundFacts(value, omitted, depth=0) {
  if(typeof value==='string') {if(value.length>2000){omitted.textFields++;return value.slice(0,2000);}return value;}
  if(value&&typeof value==='object'){
    if(depth>8){omitted.nestedItems++;return '[omitted]';}
    if(Array.isArray(value)){omitted.nestedItems+=Math.max(0,value.length-50);return value.slice(0,50).map(item=>boundFacts(item,omitted,depth+1));}
    const entries=Object.entries(value);omitted.nestedItems+=Math.max(0,entries.length-50);
    return Object.fromEntries(entries.slice(0,50).map(([name,item])=>[name,boundFacts(item,omitted,depth+1)]));
  }
  return value;
}
function boundReply(value, textLimit) {
  const omitted={textFields:0,nestedItems:0},bounded=boundFacts({...value,text:short(value.text,textLimit),textTruncated:value.textTruncated||String(value.text??'').length>textLimit,
    eventIds:list(value.eventIds).slice(0,50),omittedEventIds:Math.max(0,list(value.eventIds).length-50)},omitted);
  return {...bounded,omitted};
}
function boundEvent(value, textLimit) {
  const result=structuredClone(value),omitted={...result.omitted,textFields:0,nestedItems:0};
  result.textTruncated ||= String(result.text??'').length>textLimit;result.text=short(result.text,textLimit);
  for(const [name,parent,property] of [['threads',result.evaluation,'threads'],['decisions',result.evaluation,'decisions'],['tickets',result,'tickets'],['replies',result,'replies'],['outcomes',result.intake,'outcomes']]){
    omitted[name]=Math.max(0,list(parent?.[property]).length-50);parent[property]=list(parent?.[property]).slice(0,50);
  }
  let remaining=50;omitted.inputs=list(value.tickets).reduce((sum,ticket)=>sum+list(ticket.inputs).length,0);
  for(const ticket of result.tickets){ticket.inputs=list(ticket.inputs).slice(0,remaining);remaining-=ticket.inputs.length;omitted.inputs-=ticket.inputs.length;}
  result.replies=result.replies.map(reply=>boundReply(reply,textLimit));
  const bounded=boundFacts(result,omitted);bounded.omitted=omitted;return bounded;
}
function page(store, kind, options, values, summary, bound) {
  const settings=optionsFor(store,kind,options),matched=[];
  for(const raw of values){
    if(settings.source!==undefined&&raw.source!==settings.source||settings.problemsOnly&&!(kind==='events'?raw.problem:['failed','dropped'].includes(raw.status)))continue;
    // Redact the complete projected record before matching, then bound the result.
    const projected=settings.projectForSearch?settings.projectForSearch(raw):raw;
    if(settings.query&&!JSON.stringify(projected).toLowerCase().includes(settings.query))continue;
    matched.push({raw,projected});
  }
  matched.sort((a,b)=>a.raw.id.localeCompare(b.raw.id));
  const available=matched.filter(item=>settings.after===null||item.raw.id.localeCompare(settings.after)>0),selected=available.slice(0,settings.limit);
  return {items:selected.map(item=>bound(item.projected,500)),total:matched.length,nextCursor:available.length>settings.limit?Buffer.from(JSON.stringify({v:1,scope:settings.scope,after:selected.at(-1).raw.id})).toString('base64url'):null,
    summary:summary(matched.map(item=>item.raw))};
}

export function readEventDiagnostics(store, options = {}) {
  optionsFor(store,'events',options);const state=snapshot(store),values=state.ids.map(id=>eventView(state,id));
  return page(store,'events',options,values,items=>({total:items.length,problems:items.filter(item=>item.problem).length,filtered:items.filter(item=>item.intake.status==='filtered').length,deferred:items.filter(item=>item.intake.status==='deferred').length,
    pending:items.filter(item=>item.evaluation.status==='pending').length,evaluating:items.filter(item=>item.evaluation.status==='evaluating').length,decided:items.filter(item=>item.evaluation.status==='decided').length,failed:items.filter(item=>item.evaluation.status==='failed').length}),boundEvent);
}
export function readEventDiagnostic(store, id, options = {}) {
  optionsFor(store,'events',options);
  if(typeof id!=='string'||!id||id.length>2000)throw new Error('Invalid event diagnostic ID');
  const value=eventView(snapshot(store),id);return value?boundEvent(options.projectForSearch?options.projectForSearch(value):value,2000):null;
}
export function readReplyDiagnostics(store, options = {}) {
  optionsFor(store,'replies',options);const state=snapshot(store),values=state.receipts.map(receipt=>replyView(state,receipt));
  return page(store,'replies',options,values,items=>Object.fromEntries([['total',items.length],...['pending','failed','sent','dropped'].map(status=>[status,items.filter(item=>item.status===status).length])]),boundReply);
}

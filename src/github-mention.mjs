import { createHash } from 'node:crypto';
const LOGIN = /^[a-z\d-]{1,39}(?:\[bot\])?$/i;

/** Identity must come from a trusted authenticated transport, never event prose. */
export async function verifiedGitHubMentionIdentity(request, { app = false, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof request !== 'function') throw new Error('GitHub mention identity requires an authenticated transport');
  if (app && typeof request.identity !== 'function') throw new Error('GitHub App mention identity is unavailable');
  const raw = typeof request.identity === 'function' ? await request.identity() : await request('/user', { method: 'GET', signal });
  signal?.throwIfAborted();
  if (!LOGIN.test(raw?.login ?? '') || !/^[1-9]\d*$/.test(String(raw?.id ?? '')) || !['User', 'Bot'].includes(raw?.type) || app && raw.type !== 'Bot') throw new Error('GitHub mention identity could not be verified');
  return { login: raw.login.toLowerCase(), id: String(raw.id), type: raw.type };
}

function addressingText(text) {
  let fence;
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence=marker[1]; else if (marker[1][0]===fence[0] && marker[1].length>=fence.length) fence=null;
      return '';
    }
    if (fence || /^\s*>|^(?: {4}|\t)/.test(line)) return '';
    return line;
  }).join('\n').replace(/(`+)[\s\S]*?\1/g, '').replace(/`[^\n]*/g, '').replace(/https?:\/\/[^\s<>]+/gi, '').replace(/\\@/g, '');
}
/** Conservative Markdown addressing: quoted/code/URL text cannot create authority. */
export function githubMention(text, identity) {
  if (typeof text !== 'string' || !LOGIN.test(identity?.login ?? '') || !/^[1-9]\d*$/.test(String(identity?.id ?? '')) || !['User', 'Bot'].includes(identity?.type)) return false;
  const login=identity.login.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?:^|[^a-z\\d_@/\\\\-])@${login}(?![a-z\\d_\\[\\]-])`, 'i').test(addressingText(text));
}
/** Bare addressing is a candidate for clarification, never a directly executable scope. */
export function isBareGitHubMention(text, identity) {
  return githubMention(text,identity) && !/[\p{L}\p{N}]/u.test(addressingText(text).replace(/@[a-z\d-]+(?:\[bot\])?/gi,''));
}

/** Canonical body revision shared by explicit intake and repository discovery. */
export function versionGitHubMentionBody(event, identity) {
  if (!['issue','pull'].includes(event?.kind) || !githubMention(event.text,identity)) return event;
  const prefix=`github:${event.repository}:${event.kind==='pull'?'new_pull':'issue'}:`;
  const match=typeof event.id==='string'&&event.id.startsWith(prefix)&&/^(\d+)(?::v:[a-f\d]{24})?$/.exec(event.id.slice(prefix.length));
  const updatedAt=event.updatedAt??event.at??event.createdAt;
  if(!match||!Number.isFinite(Date.parse(updatedAt)))throw new Error('Invalid GitHub mention body identity');
  const baseId=prefix+match[1],digest=createHash('sha256').update(event.text).digest('hex');
  const at=new Date(updatedAt).toISOString(),revision=createHash('sha256').update(JSON.stringify([at,digest])).digest('hex').slice(0,24);
  // REST's user is the original author, not a body editor. Without independently
  // verified editor provenance only an unchanged creation timestamp can delegate.
  const initialAuthorVerified=Date.parse(event.createdAt??event.at)===Date.parse(at);
  return {...event,id:`${baseId}:v:${revision}`,bodyVersion:{baseId,digest,revision,updatedAt:at,actorId:String(event.actor.id),location:event.number??event.issueNumber,initialAuthorVerified}};
}

/** Call only after current scope/identity checks, in the existing intake transaction. */
export function observeGitHubMentionBody(store,event,{baselineLegacy=true,now=new Date().toISOString()}={}) {
  const version=event.bodyVersion;if(!version)return {event};
  const key=`github:body-version:${version.baseId}`,previous=store.getMeta(key);
  if(previous){
    if(previous.actorId!==version.actorId||previous.location!==version.location)return {skip:'body-identity-conflict'};
    if(Date.parse(version.updatedAt)<Date.parse(previous.updatedAt))return {skip:'stale-body-version'};
    if(previous.digest===version.digest)return {skip:'duplicate-body-content'};
    if(version.updatedAt===previous.updatedAt)return {skip:'ambiguous-body-version'};
  }else if(baselineLegacy&&(store.getMeta(`github:event:${version.baseId}`)||store.triggers.get(version.baseId))){
    store.setMeta(key,{...version,eventId:version.baseId,baseline:true,at:now});return {skip:'legacy-body-baseline'};
  }
  store.setMeta(key,{...version,eventId:event.id,at:now});return {event,...(previous?{supersedes:previous.eventId}:{})};
}

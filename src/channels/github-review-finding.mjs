import { createHash } from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function findingReplyBody(intent) {
  const key=hash(JSON.stringify([intent.repository,intent.pullNumber,intent.commentId,intent.evidence?.commentDigest,intent.reason]));
  return `This is by an automated agent, not a human.\n\n${intent.reason}\n\n<!-- js-superagent:finding:${key} -->`;
}
/** An explanation is restricted to the verified original review root. It never
 * falls back to a top-level PR comment when that root is unavailable. */
export function createFindingReplyTransport({repository,request,allowWrite}) {
  const prefix=`/repos/${repository}`;
  const actor=async signal=>{
    const raw=typeof request.identity==='function'?await request.identity():await request('/user',{method:'GET',signal});
    if(!/^[1-9]\d*$/.test(String(raw?.id??''))||!['User','Bot'].includes(raw?.type))throw new Error('Finding reply identity is unavailable');
    return String(raw.id);
  };
  async function original(intent,signal){
    if(intent.repository!==repository||!positive(intent.pullNumber)||!positive(intent.commentId)||!positive(intent.evidence?.rootId))throw new Error('Invalid finding reply scope');
    let comment=await request(`${prefix}/pulls/comments/${intent.commentId}`,{method:'GET',signal});
    if(comment?.id!==intent.commentId||String(comment.user?.id)!==intent.evidence.actorId||hash(comment.body??'')!==intent.evidence.commentDigest)throw new Error('Original finding changed before explanation');
    const seen=new Set();
    for(let depth=0;depth<32;depth++){
      if(!positive(comment.id)||seen.has(comment.id)||comment.pull_request_url!==`https://api.github.com${prefix}/pulls/${intent.pullNumber}`)throw new Error('Finding thread identity changed');
      seen.add(comment.id);
      if(comment.in_reply_to_id==null){if(comment.id!==intent.evidence.rootId)throw new Error('Finding root changed');return comment.id;}
      if(!positive(comment.in_reply_to_id))throw new Error('Invalid finding parent');
      comment=await request(`${prefix}/pulls/comments/${comment.in_reply_to_id}`,{method:'GET',signal});
    }
    throw new Error('Finding ancestry exceeds reconciliation bound');
  }
  return {
    verifyFinding:original,
    async findingReplySnapshot(intent,{signal,expectedAuthorId}={}){
      const rootId=await original(intent,signal),authorId=await actor(signal),body=findingReplyBody(intent);
      if(expectedAuthorId!==undefined&&authorId!==expectedAuthorId)throw new Error('Finding reply account changed; inspect before continuing');
      for(let page=1;page<=20;page++){
        const rows=await request(`${prefix}/pulls/${intent.pullNumber}/comments?per_page=100&page=${page}`,{method:'GET',signal});
        if(!Array.isArray(rows)||rows.length>100)throw new Error('Invalid finding explanation listing');
        for(const row of rows)if(row.body===body&&String(row.user?.id)===authorId&&row.in_reply_to_id===rootId){
          if(!positive(row.id)||row.pull_request_url!==`https://api.github.com${prefix}/pulls/${intent.pullNumber}`)throw new Error('Invalid finding explanation receipt');
          return {authorId,receipt:{id:String(row.id),authorId,rootId,bodyDigest:hash(body)}};
        }
        if(rows.length<100)return {authorId,receipt:null};
      }
      throw new Error('Finding explanation listing exceeds reconciliation bound');
    },
    async replyFinding(intent,{signal,beforeWrite,expectedAuthorId}={}){
      let writing=false;
      try{
        if(!allowWrite)throw new Error('GitHub App pullRequestReviews write permission is not configured');
        const rootId=await original(intent,signal);
        if(await actor(signal)!==expectedAuthorId)throw new Error('Finding reply account changed before write');
        await beforeWrite?.();signal?.throwIfAborted();writing=true;
        return await request(`${prefix}/pulls/${intent.pullNumber}/comments/${rootId}/replies`,{method:'POST',body:{body:findingReplyBody(intent)},signal});
      }catch(error){error.reviewWriteSent=writing;throw error;}
    },
  };
}

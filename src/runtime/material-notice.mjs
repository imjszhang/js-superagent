import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LEGACY_MATERIAL_NOTICE_TEXT = '材料或权限已变化，原结果未发送。请重新调查，或由项目维护者检查配置。';
export const MATERIAL_NOTICE_TEXT = '一条消息未通过材料或权限校验，已停止继续发送。此提示不表示工单执行失败。';
const TEMPLATE = 'material-output-withdrawn-v1';
export function materialWithdrawalNotice(original, ticketIds, route) {
  const message = {id:`material-notice:${digest(original.id)}`,kind:'notice',...(original.ticketId?{ticketId:original.ticketId}:{}),channel:structuredClone(original.channel),text:MATERIAL_NOTICE_TEXT};
  return {message,proof:{version:1,template:TEMPLATE,originalId:original.id,originalDigest:digest(original),messageDigest:digest(message),
    ticketIds:[...new Set(ticketIds)].sort(),route:structuredClone(route)}};
}
export function verifyMaterialWithdrawalNotice(message, proof) {
  return proof?.version===1 && proof.template===TEMPLATE && typeof proof.originalId==='string' && /^[a-f\d]{64}$/.test(proof.originalDigest??'') &&
    Array.isArray(proof.ticketIds) && proof.ticketIds.every(id=>typeof id==='string') &&
    message.id===`material-notice:${digest(proof.originalId)}` && [MATERIAL_NOTICE_TEXT,LEGACY_MATERIAL_NOTICE_TEXT].includes(message.text) && message.kind==='notice' && proof.messageDigest===digest(message);
}

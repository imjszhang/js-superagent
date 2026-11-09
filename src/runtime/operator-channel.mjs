/** The operator conversation's Feishu side: addresses, card bodies and card submissions. Delivery and authority stay in the runtime. */
import { decisionChoiceLines, renderDecisionText } from './decisions.mjs';

export const OPERATOR_CHAT_KEY = 'feishu:operator-chat';
export const operatorAttentionKey = publicId => `operator-attention:${publicId}`;

/** Work the operator started locally (submit, or the coordinator's request); it has no remote conversation of its own. */
export function isOperatorTicket(meta, domain) {
  return meta.operatorNotifications !== false && !!domain && !meta.github && !meta.githubPull && domain.mandate?.actor?.source === 'local' && domain.mandate.actor.id === 'operator';
}
export function operatorDirectChannel(feishu) {
  return { source: 'feishu', thread: `${feishu.tenantKey}:operator`, address: { sourceId: 'feishu', tenantKey: feishu.tenantKey, operator: 'true', openId: feishu.operator.openId } };
}
export function operatorReplyChannel(feishu, chatId, messageId) {
  return { source: 'feishu', thread: `${feishu.tenantKey}:${chatId}:operator`, address: { sourceId: 'feishu', tenantKey: feishu.tenantKey, chatId, messageId, operator: 'true' } };
}
export function operatorCardUpdateChannel(feishu, chatId, messageId) {
  return { source: 'feishu', thread: `${feishu.tenantKey}:${chatId}:card:${messageId}`, address: { sourceId: 'feishu', tenantKey: feishu.tenantKey, chatId, updateMessageId: messageId, operator: 'true' } };
}

export function operatorQuestionText(publicId, question, decision) {
  return `需要你回复（工单 ${publicId}）\n\n${decision ? renderDecisionText(question, decision) : question}`;
}

const plain = content => ({ tag: 'plain_text', content });
const text = (content, size) => ({ tag: 'div', text: { ...plain(content), ...(size ? { text_size: size } : {}) } });
const link = url => ({ tag: 'markdown', content: `[打开链接](${url.replace(/[()\s]/g, character => encodeURIComponent(character))})` });
const STATES = {
  open: { title: '需要你决定', template: 'blue' },
  answered: { title: '已提交', template: 'green' },
  elsewhere: { title: '已在别处回答', template: 'grey' },
  superseded: { title: '已失效：有新的问题', template: 'grey' },
  cancelled: { title: '工单已结束', template: 'grey' },
};
// Titles and summaries are untrusted Worker text: plain text only, so they cannot inject card markup.
const itemElements = (item, index) => [text(`${index + 1}. ${item.title}`), ...(item.summary ? [text(item.summary, 'notation')] : []), ...(item.url ? [link(item.url)] : [])];

/** Card JSON 2.0. Field names are positional so business ids never become form names. */
export function decisionCard({ publicId, attentionId, nonce, question, decision }) {
  const fields = decision.items.flatMap((item, index) => [
    ...itemElements(item, index),
    { tag: 'select_static', name: `o${index}`, required: true, placeholder: plain('选择'),
      options: decision.options.map(option => ({ text: plain(option.label), value: option.id })) },
    ...(decision.reason === 'none' ? [] : [{ tag: 'input', name: `r${index}`, required: decision.reason === 'required', max_length: 500,
      placeholder: plain(decision.reason === 'required' ? '理由（必填）' : '理由（可选）') }]),
  ]);
  return { schema: '2.0', config: { update_multi: true }, header: { title: plain(STATES.open.title), template: STATES.open.template },
    body: { elements: [
      text(question),
      { tag: 'form', name: 'decision', elements: [...fields,
        { tag: 'button', name: 'submit', type: 'primary', text: plain('提交'), form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { attention: attentionId, nonce } }] }] },
      text(`工单 ${publicId}`, 'notation'),
    ] } };
}

/** Read-only card for a question that no longer takes answers. */
export function closedDecisionCard({ publicId, question, decision, state, answers }) {
  const look = STATES[state] ?? STATES.cancelled;
  const lines = answers && decision
    ? decisionChoiceLines(decision, answers).map((line, index) => `${index + 1}. ${line.title}：${line.option}${line.reason ? `。${line.reason}` : ''}`)
    : decision ? decision.items.map((item, index) => `${index + 1}. ${item.title}`) : [];
  return { schema: '2.0', config: { update_multi: true }, header: { title: plain(look.title), template: look.template },
    body: { elements: [text(question), ...(lines.length ? [text(lines.join('\n'))] : []), text(`工单 ${publicId}`, 'notation')] } };
}

/** Extracts the facts of a card.action.trigger callback; the runtime decides whether they are authorized. */
export function parseCardAction(data) {
  const event = data?.event ?? data ?? {};
  let value = event.action?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = undefined; } }
  let form = event.action?.form_value;
  if (typeof form === 'string') { try { form = JSON.parse(form); } catch { form = undefined; } }
  return {
    type: data?.header?.event_type ?? data?.event_type ?? data?.type,
    tenantKey: data?.header?.tenant_key ?? data?.tenant_key ?? event.operator?.tenant_key ?? event.tenant_key,
    operatorId: event.operator?.open_id ?? event.open_id,
    messageId: event.context?.open_message_id ?? event.open_message_id,
    chatId: event.context?.open_chat_id ?? event.open_chat_id,
    attentionId: typeof value?.attention === 'string' ? value.attention : undefined,
    nonce: typeof value?.nonce === 'string' ? value.nonce : undefined,
    form: form && typeof form === 'object' && !Array.isArray(form) ? form : undefined,
  };
}

/** Maps positional form fields back to item ids; answer validation happens in normalizeAnswers. */
export function cardAnswers(decision, form) {
  return Object.fromEntries(decision.items.map((item, index) => {
    const option = form?.[`o${index}`], reason = form?.[`r${index}`];
    return [item.id, { option: Array.isArray(option) ? option[0] : option, ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}) }];
  }));
}

export const cardResponse = (type, content, card) => ({ toast: { type, content }, ...(card ? { card: { type: 'raw', data: card } } : {}) });

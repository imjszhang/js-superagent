/** Structured choices a Worker attaches to its question, and the person's answer to them. Business-neutral. */
const REASONS = ['required', 'optional', 'none'];
const LIMITS = Object.freeze({ items: 10, options: 4, id: 64, title: 200, summary: 500, url: 2000, label: 40, reason: 500 });

function plain(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object`);
}
function only(value, name, keys) {
  plain(value, name);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
}
function text(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw new Error(`${name} must be non-empty text of at most ${max} characters`);
  return value.trim();
}
function identifier(value, name) {
  const id = text(value, name, LIMITS.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new Error(`${name} must use letters, digits, '.', ':', '_' or '-'`);
  return id;
}
function link(value) {
  const url = text(value, 'decision item url', LIMITS.url, { optional: true });
  if (url === undefined) return undefined;
  let parsed; try { parsed = new URL(url); } catch { throw new Error('decision item url must be an absolute https URL'); }
  if (parsed.protocol !== 'https:') throw new Error('decision item url must be an absolute https URL');
  return parsed.href;
}
function unique(list, name) {
  if (new Set(list.map(item => item.id)).size !== list.length) throw new Error(`Duplicate ${name} id`);
  return list;
}

export function normalizeDecision(value) {
  only(value, 'decision', ['items', 'options', 'reason']);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > LIMITS.items) throw new Error(`decision.items must list 1 to ${LIMITS.items} items`);
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > LIMITS.options) throw new Error(`decision.options must list 2 to ${LIMITS.options} options`);
  const reason = value.reason ?? 'none';
  if (!REASONS.includes(reason)) throw new Error('decision.reason must be required, optional or none');
  const items = unique(value.items.map(item => {
    only(item, 'decision item', ['id', 'title', 'summary', 'url']);
    const summary = text(item.summary, 'decision item summary', LIMITS.summary, { optional: true }), url = link(item.url);
    return { id: identifier(item.id, 'decision item id'), title: text(item.title, 'decision item title', LIMITS.title),
      ...(summary === undefined ? {} : { summary }), ...(url === undefined ? {} : { url }) };
  }), 'decision item');
  const options = unique(value.options.map(option => {
    only(option, 'decision option', ['id', 'label']);
    return { id: identifier(option.id, 'decision option id'), label: text(option.label, 'decision option label', LIMITS.label) };
  }), 'decision option');
  return { items, options, reason };
}

/** Every item gets one allowed option; reasons follow the decision's rule. */
export function normalizeAnswers(decision, value) {
  plain(value, 'answers');
  const ids = decision.items.map(item => item.id), options = new Set(decision.options.map(option => option.id));
  const extra = Object.keys(value).filter(key => !ids.includes(key));
  if (extra.length) throw new Error(`answers name unknown items: ${extra.join(', ')}`);
  const missing = ids.filter(id => value[id] === undefined);
  if (missing.length) throw new Error(`answers are missing items: ${missing.join(', ')}`);
  return Object.fromEntries(ids.map(id => {
    const answer = value[id];
    only(answer, `answer ${id}`, ['option', 'reason']);
    if (!options.has(answer.option)) throw new Error(`answer ${id} must choose one of: ${[...options].join(', ')}`);
    const blank = answer.reason === undefined || answer.reason === null || answer.reason === '';
    if (decision.reason === 'none' && !blank) throw new Error(`answer ${id} must not carry a reason`);
    if (decision.reason === 'required' && blank) throw new Error(`answer ${id} needs a reason`);
    const reason = blank ? undefined : text(answer.reason, `answer ${id} reason`, LIMITS.reason);
    return [id, { option: answer.option, ...(reason === undefined ? {} : { reason }) }];
  }));
}

const label = (decision, id) => decision.options.find(option => option.id === id)?.label ?? id;
const reasonNote = { required: '每项都需要理由。', optional: '理由可选。', none: '' };

/** Numbered list for text channels: local, GitHub and Feishu text. */
export function renderDecisionText(question, decision) {
  const lines = [question, ''];
  decision.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.id}：${item.title}${item.url ? ` ${item.url}` : ''}`);
    if (item.summary) lines.push(`   ${item.summary}`);
  });
  lines.push('', `可选：${decision.options.map(option => `${option.label}（${option.id}）`).join('、')}。${reasonNote[decision.reason]}`);
  return lines.join('\n').trim();
}

/** Readable lines followed by the same answer as JSON, so the Worker can rely on either. */
export function renderAnswerText(attentionId, decision, answers) {
  const lines = decision.items.map(item => {
    const answer = answers[item.id];
    return `- ${item.id} ${item.title}：${label(decision, answer.option)}${answer.reason ? `。理由：${answer.reason}` : ''}`;
  });
  return `对问题的结构化回答：\n${lines.join('\n')}\n\n\`\`\`json\n${JSON.stringify({ attentionId, answers })}\n\`\`\``;
}

export function decisionChoiceLines(decision, answers) {
  return decision.items.map(item => ({ id: item.id, title: item.title, option: label(decision, answers[item.id].option), reason: answers[item.id].reason }));
}

/** JSON schema fragment for adapters with strict structured output (all keys required, nullable where optional). */
export const decisionOutputSchema = {
  anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['items', 'options', 'reason'], properties: {
    items: { type: 'array', minItems: 1, maxItems: LIMITS.items, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'summary', 'url'], properties: {
      id: { type: 'string' }, title: { type: 'string' }, summary: { type: ['string', 'null'] }, url: { type: ['string', 'null'] } } } },
    options: { type: 'array', minItems: 2, maxItems: LIMITS.options, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: {
      id: { type: 'string' }, label: { type: 'string' } } } },
    reason: { type: 'string', enum: REASONS },
  } }],
};

/** Prompt text shared by Worker adapters. */
export const DECISION_PROMPT = 'When the person must choose among fixed options for several items, also set attention.decision to ' +
  '{"items":[{"id":"short id","title":"text","summary":"optional text","url":"optional https URL"}],"options":[{"id":"short id","label":"text"}],"reason":"required|optional|none"} ' +
  `(1 to ${LIMITS.items} items, 2 to ${LIMITS.options} options). Keep attention.question as one sentence. The structured answer arrives as text with a JSON block; record exactly what it says.`;

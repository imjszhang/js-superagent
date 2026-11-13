import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFeishuTransport, FEISHU_HANDSHAKE_TIMEOUT_MS } from './feishu-transport.mjs';
import { getFeishuReadDiagnostic, getFeishuTransportErrorDiagnostic } from './feishu-diagnostics.mjs';

const require = createRequire(import.meta.url);
// Only errors created by this adapter can supply a validation message. SDK errors may contain secrets.
const historyValidation = new WeakMap(), apiFailures = new WeakSet();
export function feishuSdkAvailable() {
  try { require.resolve('@larksuiteoapi/node-sdk'); return true; }
  catch { return false; }
}
/** Background installation keeps the app secret in a private file and needs the optional SDK. */
export function assertFeishuServiceConfig(config) {
  if (!config?.feishu || config.feishu.enabled === false) return;
  if (!config.feishu.appSecretPath) throw new Error('Background service requires feishu.appSecretPath; environment secrets are not persisted');
  readFeishuAppSecret(config.feishu);
  if (!feishuSdkAvailable()) throw new Error('Install @larksuiteoapi/node-sdk before installing a service that receives Feishu');
}

function identifier(value, prefix, name) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[A-Za-z0-9_-]{1,200}$`).test(value)) throw invalidHistory(`Invalid ${name}`);
  return value;
}
function requireSuccess(response, label) {
  if (!response || response.code !== 0) {
    const error = new Error(`${label} failed with code ${Number.isInteger(response?.code) ? response.code : 'unknown'}`);
    if (Number.isInteger(response?.code)) error.code = response.code;
    apiFailures.add(error);
    throw error;
  }
  return response.data ?? {};
}
function checkSignal(signal) { if (signal?.aborted) throw new Error('Feishu operation cancelled'); }
// Match the prototype's bounded retention of quiet topics; live subscriptions may retain them longer.
export const FEISHU_TOPIC_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const TOPIC_BUFFER_EVENTS = 500, TOPIC_BUFFER_BYTES = 1024 * 1024;
function historyError(error, container, startedAt, stage) {
  let code;
  try { code = error?.response?.data?.code ?? error?.code; } catch { /* Untrusted error accessors cannot bypass diagnostic redaction. */ }
  const permission = [230027, 99991672, 99991679].includes(code);
  const validation = historyValidation.get(error);
  const diagnostic = getFeishuReadDiagnostic(error) ?? getFeishuTransportErrorDiagnostic(error);
  const reason = validation ? 'validation' : Number.isInteger(code) ? 'api' : apiFailures.has(error) ? 'response' : diagnostic.reason;
  const phase = validation ? 'validation' : diagnostic.phase === 'auth' ? 'auth' : stage;
  const elapsedMs = diagnostic.elapsedMs ?? Math.min(86_400_000, Math.max(0, Math.floor(performance.now() - startedAt)));
  const failedAt = diagnostic.failedAt ?? new Date().toISOString();
  return { scope: container.chatId, operation: 'history', container,
    category: permission ? 'permission' : validation ? 'validation' : 'transport',
    ...(Number.isInteger(code) ? { code } : {}),
    ...diagnostic, reason, phase, elapsedMs, failedAt,
    // Never retain arbitrary SDK messages, response bodies, request objects or claimed validation details.
    error: permission ? `Feishu history permission denied (code ${code}); check the application's im:message.group_msg permission`
      : Number.isInteger(code) ? `Feishu history failed with code ${code}`
        : validation ?? (reason === 'response' ? 'Invalid Feishu history response'
          : phase === 'validation' ? 'Feishu history message processing failed'
            : reason === 'unknown' ? 'Feishu history transport failed' : `Feishu history ${reason} failure`) };
}
function invalidHistory(message) {
  const error = new Error(message); error.validation = true; historyValidation.set(error, message); return error;
}
function parseContent(type, raw) {
  let content;
  try { content = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw invalidHistory('Malformed Feishu message content'); }
  if (!content || typeof content !== 'object') throw invalidHistory('Malformed Feishu message content');
  if (type === 'text') return { text: typeof content.text === 'string' ? content.text : '', attachments: [] };
  if (type === 'image') return { text: '[Image attachment]', attachments: [{ type: 'image', key: identifier(content.image_key, 'img_', 'image key') }] };
  if (type === 'file') return { text: `[File attachment: ${String(content.file_name ?? 'file').slice(0, 256)}]`, attachments: [{ type: 'file', key: identifier(content.file_key, 'file_', 'file key'), name: String(content.file_name ?? '').slice(0, 256) }] };
  if (type === 'post') {
    const post = content.content ? content : content.en_us ?? content.zh_cn ?? Object.values(content)[0];
    const parts = [post?.title ?? ''], attachments = [];
    for (const row of post?.content ?? []) for (const item of row) {
      if (item.tag === 'text' || item.tag === 'a') parts.push(String(item.text ?? ''));
      if (item.tag === 'img') attachments.push({ type: 'image', key: identifier(item.image_key, 'img_', 'image key') });
    }
    return { text: parts.join('\n') || '[Rich text attachment]', attachments };
  }
  return { text: `[Unsupported Feishu message type: ${String(type).slice(0, 64)}]`, attachments: [], unsupported: true };
}

/** Read a configured app secret without echoing it. A file must be private to the current user. */
export function readFeishuAppSecret(config = {}) {
  if (config.appSecretEnv) {
    const value = process.env[config.appSecretEnv];
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Feishu app secret environment variable is missing');
    return value;
  }
  const path = config.appSecretPath;
  if (typeof path !== 'string' || !path) throw new Error('Feishu app secret is not configured');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error('rejected');
    const bytes = Buffer.alloc(info.size);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length))) length += count;
    const value = bytes.subarray(0, length).toString('utf8').trim();
    if (!value || value.includes('\0') || value.includes('\n')) throw new Error('rejected');
    return value;
  } catch (error) {
    if (error.message === 'Feishu app secret is not configured') throw error;
    throw new Error('Feishu app secret file must be a private regular file owned by the current user');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Uses an authenticated official SDK client. normalize() accepts only verified SDK events or API results. */
export function createFeishuSource({ id = 'feishu', client, botOpenId, botAppId, tenantKey, scopes, operator, operatorChatId = () => undefined,
  trackedThreads = () => [], now = () => Date.now(), maxPages = 10, pollIntervalMs = 60_000, transport } = {}) {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new Error('Invalid Feishu source id');
  identifier(botOpenId, 'ou_', 'bot open ID');
  if (botAppId !== undefined) identifier(botAppId, 'cli_', 'bot app ID');
  const operatorOpenId = operator?.openId === undefined ? undefined : identifier(operator.openId, 'ou_', 'operator open ID');
  if (typeof tenantKey !== 'string' || !tenantKey || tenantKey.length > 256) throw new Error('Feishu tenantKey is required');
  const api = client?.im?.message ?? client?.im?.v1?.message;
  if (!api || !['list', 'get', 'reply'].every(key => typeof api[key] === 'function')) throw new Error('Feishu source requires an authenticated message API client');
  const read = (method, payload, signal) => transport ? transport.read(() => api[method](payload), { signal }) : api[method](payload);
  const write = (method, payload) => transport ? transport.write(() => api[method](payload)) : api[method](payload);
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 100) throw new Error('Feishu scopes must list 1 to 100 chats');
  const allowed = new Map(scopes.map(scope => {
    identifier(scope.chatId, 'oc_', 'chat ID');
    if (!['p2p', 'group', 'topic_group'].includes(scope.type) || !['mentions', 'all'].includes(scope.mode)) throw new Error('Feishu scope requires type and mentions/all mode');
    return [scope.chatId, { chatId: scope.chatId, type: scope.type, mode: scope.mode }];
  }));
  if (allowed.size !== scopes.length) throw new Error('Duplicate Feishu chat scope');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Feishu maxPages must be 1 to 100');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000) throw new Error('Feishu pollIntervalMs must be at least 1000');
  if (typeof trackedThreads !== 'function') throw new Error('Feishu trackedThreads must be a callback');
  // The operator's direct messages are the operator conversation, not a listed chat: the host hands them to the coordinator.
  const operatorMessage = (event, message) => {
    if (!operatorOpenId || message.chat_type !== 'p2p') return undefined;
    const sender = event.sender ?? message.sender;
    if ((sender?.sender_id?.open_id ?? (sender?.id_type === 'open_id' ? sender.id : null)) !== operatorOpenId) return undefined;
    if (event.sender?.tenant_key && event.sender.tenant_key !== tenantKey) return null;
    if ((sender.sender_type ?? sender.type) !== 'user') return null;
    const chatId = identifier(message.chat_id, 'oc_', 'chat ID'), messageId = identifier(message.message_id, 'om_', 'message ID');
    const timestamp = Number(message.create_time); if (!Number.isFinite(timestamp) || timestamp < 1) throw invalidHistory('Invalid Feishu message timestamp');
    const parsed = parseContent(message.message_type ?? message.msg_type, message.content ?? message.body?.content);
    if (parsed.text.length > 128 * 1024) throw invalidHistory('Feishu message text exceeds 128 KiB');
    const thread = `${tenantKey}:${chatId}:operator`;
    const replyTo = message.parent_id || message.root_id;
    return { id: `feishu:${tenantKey}:${messageId}`, source: 'feishu', threads: [{ source: 'feishu', id: thread }],
      actor: { source: 'feishu', id: operatorOpenId }, human: true, addressed: 'direct', at: new Date(timestamp).toISOString(), text: parsed.text,
      channel: { source: 'feishu', thread, address: { sourceId: id, chatId, messageId, tenantKey, operator: 'true' } },
      meta: { tenantKey, chatId, chatType: 'p2p', messageId, operator: true, attachments: parsed.attachments,
        ...(replyTo ? { replyTo: identifier(replyTo, 'om_', 'reply target ID') } : {}), ...(parsed.unsupported ? { unsupported: true } : {}) } };
  };
  const normalize = raw => {
    const event = raw?.event ?? raw;
    const message = event?.message;
    if (!message || raw?.header?.event_type && raw.header.event_type !== 'im.message.receive_v1') return null;
    if (raw?.header?.tenant_key && raw.header.tenant_key !== tenantKey) return null;
    const direct = operatorMessage(event, message);
    if (direct !== undefined) return direct;
    const scope = allowed.get(message.chat_id); if (!scope) return null;
    if (message.chat_type && message.chat_type !== scope.type) return null;
    if (event.sender?.tenant_key && event.sender.tenant_key !== tenantKey || raw?.header?.tenant_key && raw.header.tenant_key !== tenantKey) return null;
    const sender = event.sender ?? message.sender;
    const senderId = sender?.sender_id?.open_id ?? (['open_id', 'app_id'].includes(sender?.id_type) ? sender.id : null);
    if (!senderId || senderId === botOpenId || senderId === botAppId) return null;
    identifier(senderId, sender?.id_type === 'app_id' ? 'cli_' : 'ou_', 'sender stable ID');
    const mentions = message.mentions ?? [];
    // A group @ of the bot arrives as the app id (cli_…); an open id (ou_…) is the other form.
    const mentionTarget = mention => {
      const id = mention?.id;
      if (typeof id === 'string') return id;
      return id?.open_id ?? id?.app_id ?? (mention?.id_type === 'open_id' || mention?.id_type === 'app_id' ? id : null);
    };
    const addressed = scope.type === 'p2p' ? 'direct' : mentions.some(mention => { const target = mentionTarget(mention); return target === botOpenId || botAppId && target === botAppId; }) ? 'mention' : undefined;
    // Replies to an already admitted thread are retained as context; policy controls authorization.
    if (scope.mode === 'mentions' && !addressed && !message.root_id && !message.parent_id) return null;
    const messageId = identifier(message.message_id, 'om_', 'message ID');
    const rootId = identifier(message.root_id || message.parent_id || messageId, 'om_', 'root message ID');
    const timestamp = Number(message.create_time); if (!Number.isFinite(timestamp) || timestamp < 1) throw invalidHistory('Invalid Feishu message timestamp');
    const parsed = parseContent(message.message_type ?? message.msg_type, message.content ?? message.body?.content);
    if (parsed.text.length > 128 * 1024) throw invalidHistory('Feishu message text exceeds 128 KiB');
    const thread = `${tenantKey}:${message.chat_id}:${rootId}`;
    return { id: `feishu:${tenantKey}:${messageId}`, source: 'feishu', threads: [{ source: 'feishu', id: thread }],
      actor: { source: 'feishu', id: senderId }, human: (sender.sender_type ?? sender.type) === 'user', ...(addressed ? { addressed } : {}),
      at: new Date(timestamp).toISOString(), text: parsed.text,
      channel: { source: 'feishu', thread, address: { sourceId: id, chatId: message.chat_id, messageId: rootId, tenantKey } },
      meta: { tenantKey, chatId: message.chat_id, chatType: scope.type, messageId, rootId,
        ...(message.parent_id ? { parentId: identifier(message.parent_id, 'om_', 'parent message ID') } : {}),
        ...(message.thread_id ? { threadId: identifier(message.thread_id, 'omt?_', 'thread ID') } : {}),
        attachments: parsed.attachments, ...(parsed.unsupported ? { unsupported: true } : {}) } };
  };
  const body = message => {
    if (message.card !== undefined) {
      const content = JSON.stringify(message.card);
      if (Buffer.byteLength(content) > 30 * 1024) throw new Error('Feishu card exceeds 30 KiB');
      return { msg_type: 'interactive', content };
    }
    if (typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text) > 100 * 1024) throw new Error('Invalid Feishu reply text');
    return { msg_type: 'text', content: JSON.stringify({ text: message.text }) };
  };
  /** Messages to the operator: a reply to the operator's own message, a new direct message, or an update of a card already sent. */
  const deliverOperator = async message => {
    const address = message.channel.address, uuid = createHash('sha256').update(`${id}:${message.id}`).digest('hex').slice(0, 32);
    if (!operatorOpenId) throw new Error('Feishu operator is not configured');
    const knownChat = operatorChatId();
    if (address.updateMessageId) {
      identifier(address.updateMessageId, 'om_', 'card message ID');
      if (!knownChat || address.chatId !== knownChat || typeof api.patch !== 'function') throw new Error('Feishu card update is outside the operator conversation');
      const target = requireSuccess(await read('get', { path: { message_id: address.updateMessageId } }), 'Feishu card target');
      if (!target.items?.some(item => item.message_id === address.updateMessageId && item.chat_id === knownChat)) throw new Error('Feishu card does not belong to the operator conversation');
      requireSuccess(await write('patch', { path: { message_id: address.updateMessageId }, data: { content: body(message).content } }), 'Feishu card update');
      return { id: address.updateMessageId, url: '', source: 'feishu', messageId: address.updateMessageId, chatId: knownChat, uuid };
    }
    if (address.messageId) {
      identifier(address.messageId, 'om_', 'reply message ID');
      if (!knownChat || address.chatId !== knownChat) throw new Error('Feishu reply is outside the operator conversation');
      const target = requireSuccess(await read('get', { path: { message_id: address.messageId } }), 'Feishu reply target');
      if (!target.items?.some(item => item.message_id === address.messageId && item.chat_id === knownChat)) throw new Error('Feishu reply target does not belong to the operator conversation');
      const data = requireSuccess(await write('reply', { path: { message_id: address.messageId }, data: { ...body(message), reply_in_thread: false, uuid } }), 'Feishu reply');
      const messageId = identifier(data.message_id, 'om_', 'receipt message ID');
      return { id: messageId, url: '', source: 'feishu', messageId, chatId: knownChat, uuid };
    }
    if (address.openId !== operatorOpenId || typeof api.create !== 'function') throw new Error('Feishu direct message is outside the operator conversation');
    const data = requireSuccess(await write('create', { params: { receive_id_type: 'open_id' }, data: { receive_id: operatorOpenId, ...body(message), uuid } }), 'Feishu direct message');
    const messageId = identifier(data.message_id, 'om_', 'receipt message ID'), chatId = identifier(data.chat_id, 'oc_', 'receipt chat ID');
    if (knownChat && knownChat !== chatId) throw new Error('Feishu returned a different operator conversation');
    return { id: messageId, url: '', source: 'feishu', messageId, chatId, uuid };
  };
  return { id, source: 'feishu', pollIntervalMs, normalize, operatorOpenId,
    async poll({ cursor, signal } = {}) {
      if (cursor && ![1, 2].includes(cursor.schemaVersion)) throw new Error('Unsupported Feishu history cursor version');
      // Preserve v1's unfinished windows on upgrade. Topics and scheduling are internal state, not user configuration.
      const current = { ...(cursor ? structuredClone(cursor) : {}), schemaVersion: 2,
        scopes: structuredClone(cursor?.scopes ?? {}), topics: structuredClone(cursor?.topics ?? {}),
        discovery: structuredClone(cursor?.discovery ?? {}), failures: structuredClone(cursor?.failures ?? {}) };
      const events = [], cutoff = Math.floor(now() / 1000), queue = [], queued = new Set(), followed = new Set();
      const topicKey = (chatId, threadId) => `${chatId}:${threadId}`;
      const enqueue = task => { if (!queued.has(task.key)) { queue.push(task); queued.add(task.key); } };
      const topic = (chatId, threadId, rootId, since, lastSeen, minimumAt) => {
        identifier(threadId, 'omt?_', 'thread ID'); identifier(rootId, 'om_', 'root message ID');
        const key = topicKey(chatId, threadId), previous = current.topics[key];
        if (previous && (previous.chatId !== chatId || previous.rootId !== rootId)) throw invalidHistory('Feishu topic identity changed');
        const value = previous ?? { chatId, threadId, rootId, since, ...(minimumAt === undefined ? {} : { minimumAt }) };
        value.lastSeen = Math.max(value.lastSeen ?? 0, lastSeen);
        current.topics[key] = value;
        enqueue({ key: `thread:${key}`, type: 'thread', id: threadId, chatId, state: value });
        return value;
      };
      const associate = (ref, threadId) => {
        const value = topic(ref.chatId, threadId, ref.rootId, Math.floor(ref.since / 1000), ref.lastAt ?? ref.since, ref.since);
        followed.add(topicKey(ref.chatId, threadId));
        // A delayed live replay can establish authority earlier than discovery's receiving baseline.
        // Revisit that accepted interval once, not on every subsequent poll of the subscription.
        if (value.associatedSince === undefined || ref.since < value.associatedSince) {
          const previousLower = Math.max(Math.max(0, value.since - 2) * 1000, value.minimumAt ?? 0);
          value.associatedSince = ref.since;
          if (value.minimumAt !== undefined) value.minimumAt = Math.min(value.minimumAt, ref.since);
          value.since = Math.min(value.since, Math.floor(ref.since / 1000));
          const nextLower = Math.max(Math.max(0, value.since - 2) * 1000, value.minimumAt ?? 0);
          if (nextLower < previousLower) {
            // Millisecond authority can move within the same second. Earlier pages must be revisited even then.
            // Keep an unfinished window's original upper bound; stable message IDs deduplicate any replay.
            for (const key of ['pageToken', 'seenTokens', 'pendingEvents', 'ready', 'order']) delete value[key];
          }
        }
        return value;
      };
      for (const chatId of Object.keys(current.scopes)) if (!allowed.has(chatId)) delete current.scopes[chatId];
      for (const chatId of Object.keys(current.discovery)) if (!allowed.has(chatId)) delete current.discovery[chatId];
      const tracked = await trackedThreads();
      if (!Array.isArray(tracked)) throw new Error('Invalid Feishu tracked thread list');
      for (const ref of tracked) {
        // The host supplies eligible subscriptions, but the adapter still enforces its configured platform scope.
        if (!allowed.has(ref.chatId) || allowed.get(ref.chatId).type === 'p2p') continue;
        identifier(ref.rootId, 'om_', 'root message ID');
        if (!Number.isFinite(ref.since) || ref.since < 0) throw new Error('Invalid Feishu tracked thread baseline');
        const known = Object.values(current.topics).find(value => value.chatId === ref.chatId && value.rootId === ref.rootId);
        const threadId = ref.threadId ?? known?.threadId;
        if (threadId) {
          associate(ref, threadId);
        } else enqueue({ key: `resolve:${ref.chatId}:${ref.rootId}`, type: 'resolve', id: ref.rootId, chatId: ref.chatId, ref });
      }
      for (const [key, value] of Object.entries(current.topics)) {
        if (!allowed.has(value.chatId) || !followed.has(key) && value.initialized && cutoff * 1000 - value.lastSeen >= FEISHU_TOPIC_HORIZON_MS && !value.until) {
          delete current.topics[key]; continue;
        }
        enqueue({ key: `thread:${key}`, type: 'thread', id: value.threadId, chatId: value.chatId, state: value });
      }
      for (const scope of allowed.values()) {
        const previous = current.scopes[scope.chatId];
        // New chats still start now; existing chat and associated topic recovery never reset to now.
        if (!previous) current.scopes[scope.chatId] = { since: cutoff };
        else enqueue({ key: `chat:${scope.chatId}`, type: 'chat', id: scope.chatId, chatId: scope.chatId, state: previous });
        if (scope.type !== 'p2p') {
          // Discover recent roots once on upgrade/enable, without replaying old main messages or lowering admission's baseline.
          const discovery = current.discovery[scope.chatId] ??= { since: Math.max(0, cutoff - FEISHU_TOPIC_HORIZON_MS / 1000), until: cutoff,
            topicSince: current.scopes[scope.chatId].since };
          if (!discovery.complete) enqueue({ key: `discover:${scope.chatId}`, type: 'discover', id: scope.chatId, chatId: scope.chatId, state: discovery });
        }
      }
      for (const key of Object.keys(current.failures)) if (!queued.has(key)) delete current.failures[key];
      // One page per turn, round-robin across containers. Persist where to resume so large groups cannot starve later chats/topics.
      queue.sort((a, b) => a.key.localeCompare(b.key));
      if (current.next) {
        let at = queue.findIndex(task => task.key === current.next);
        if (at < 0) at = queue.findIndex(task => task.key.localeCompare(current.next) >= 0);
        if (at > 0) queue.push(...queue.splice(0, at));
      }
      const budget = Math.min(200, maxPages * allowed.size), pageCounts = new Map();
      let requests = 0;
      while (queue.length && requests < budget && events.length <= 9900) {
        checkSignal(signal);
        const task = queue.shift(), scope = allowed.get(task.chatId);
        const container = { type: ['resolve', 'thread'].includes(task.type) ? 'thread' : 'chat', id: task.id, chatId: task.chatId };
        const startedAt = performance.now();
        let stage = 'history';
        requests++;
        try {
          if (task.type === 'resolve') {
            const data = requireSuccess(await read('get', { path: { message_id: task.id } }, signal), 'Feishu topic reference');
            checkSignal(signal);
            stage = 'validation';
            if (!Array.isArray(data.items) || !data.items.length || data.items.some(item => item.chat_id !== task.chatId || item.message_id !== task.id)) throw invalidHistory('Feishu topic reference is outside the requested chat or message');
            const message = data.items[0];
            if (message.root_id && message.root_id !== task.id) throw invalidHistory('Feishu topic reference returned a different root');
            if (message.thread_id && !message.deleted) {
              associate(task.ref, message.thread_id);
            }
            delete current.failures[task.key];
            continue;
          }
          const previous = task.state, since = previous.since, until = previous.until ?? cutoff, pageToken = previous.pageToken;
          const isThread = task.type === 'thread', ascending = !isThread || previous.order === 'asc';
          if (previous.ready) {
            if (events.length + previous.pendingEvents.length > 9950) { queue.unshift(task); break; }
            events.push(...previous.pendingEvents); previous.since = until; previous.initialized = true;
            for (const key of ['ready', 'pendingEvents', 'until', 'pageToken', 'seenTokens', 'order']) delete previous[key];
            delete current.failures[task.key]; continue;
          }
          const response = await read('list', { params: { container_id_type: isThread ? 'thread' : 'chat', container_id: task.id,
            ...(!isThread ? { start_time: String(Math.max(0, since - 2)), end_time: String(until) } : {}),
            sort_type: ascending ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc', page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}) } }, signal);
          checkSignal(signal);
          const data = requireSuccess(response, 'Feishu history');
          stage = 'validation';
          if (!Array.isArray(data.items) || data.items.length > 50 || typeof data.has_more !== 'boolean') throw invalidHistory('Invalid Feishu history page');
          const pageEvents = [], discoveries = [];
          const lower = Math.max(Math.max(0, since - 2) * 1000, previous.minimumAt ?? 0);
          let reachedBoundary = false, lastTime = ascending ? -Infinity : Infinity;
          for (const message of data.items) {
            if (message.chat_id !== task.chatId || task.type === 'thread' && message.thread_id !== task.id) throw invalidHistory('Feishu history returned a message outside the requested chat or thread');
            identifier(message.message_id, 'om_', 'message ID');
            if (message.deleted) continue;
            const at = Number(message.create_time);
            if (!Number.isFinite(at) || at < 1) throw invalidHistory('Invalid Feishu message timestamp');
            if (isThread) {
              // Feishu ignores time filters on thread containers. Descending pages and a local boundary avoid full rescans.
              if (ascending ? at < lastTime : at > lastTime) throw invalidHistory('Feishu topic messages were not returned in the requested order');
              lastTime = at;
              if (ascending ? at >= until * 1000 : at < lower) reachedBoundary = true;
            }
            const rootId = message.root_id || (task.type === 'thread' ? previous.rootId : message.parent_id || message.message_id);
            if (task.type === 'thread' && rootId !== previous.rootId) throw invalidHistory('Feishu history returned a different topic root');
            if (message.thread_id && scope.type !== 'p2p') {
              identifier(message.thread_id, 'omt?_', 'thread ID'); identifier(rootId, 'om_', 'root message ID');
              const known = current.topics[topicKey(task.chatId, message.thread_id)];
              if (known && known.rootId !== rootId) throw invalidHistory('Feishu topic identity changed');
              discoveries.push({ threadId: message.thread_id, rootId, at });
            }
            // Platform topic pages may omit root_id. Use only the root established by a verified topic reference.
            const event = { sender: message.sender, message: { ...message, chat_type: scope.type,
              ...(task.type === 'thread' && message.message_id !== rootId && !message.root_id ? { root_id: rootId } : {}) } };
            if (task.type !== 'discover' && (!isThread || at >= lower && at < until * 1000) && normalize(event)) pageEvents.push(event);
          }
          const seenTokens = new Set(previous.seenTokens ?? []);
          if (pageToken) seenTokens.add(createHash('sha256').update(pageToken).digest('hex'));
          const nextHash = typeof data.page_token === 'string' ? createHash('sha256').update(data.page_token).digest('hex') : undefined;
          const hasMore = data.has_more && !reachedBoundary;
          if (hasMore && (!data.page_token || typeof data.page_token !== 'string' || seenTokens.has(nextHash))) {
            // Retry this fixed window from its start; never get permanently stuck on a cyclic server token.
            delete previous.pageToken; delete previous.seenTokens; previous.until = until;
            delete previous.pendingEvents;
            throw invalidHistory('Feishu history pagination did not advance');
          }
          for (const found of discoveries) topic(task.chatId, found.threadId, found.rootId,
            task.type === 'discover' ? previous.topicSince : since, found.at,
            task.type === 'discover' ? previous.topicSince * 1000 : undefined);
          if (isThread && !ascending) {
            // Do not hand newer follow-ups to the domain before an older first @ on a later page.
            const pending = [...new Map([...(previous.pendingEvents ?? []), ...pageEvents].map(event => [event.message.message_id, event])).values()];
            if (pending.length > TOPIC_BUFFER_EVENTS || Buffer.byteLength(JSON.stringify(pending)) > TOPIC_BUFFER_BYTES) {
              // Very large windows stream oldest-first instead; each round and the persisted buffer stay bounded.
              Object.assign(previous, { until, order: 'asc' });
              for (const key of ['pendingEvents', 'pageToken', 'seenTokens']) delete previous[key];
              continue;
            }
            previous.pendingEvents = pending;
            if (!hasMore) {
              if (events.length + pending.length > 9950) { previous.ready = true; previous.until = until; continue; }
              events.push(...pending); delete previous.pendingEvents;
            }
          } else events.push(...pageEvents);
          if (hasMore) {
            Object.assign(previous, { since, until, pageToken: data.page_token, seenTokens: [...seenTokens, nextHash] });
            const count = (pageCounts.get(task.key) ?? 0) + 1; pageCounts.set(task.key, count);
            if (count < maxPages) queue.push(task);
          } else {
            previous.since = until; delete previous.until; delete previous.pageToken; delete previous.seenTokens;
            if (isThread) { previous.initialized = true; delete previous.order; }
            if (task.type === 'discover') { previous.complete = true; delete previous.topicSince; }
            delete current.failures[task.key];
          }
        } catch (error) { checkSignal(signal); current.failures[task.key] = historyError(error, container, startedAt, stage); }
      }
      if (queue.length) current.next = queue[0].key; else delete current.next;
      // Topic pages run newest-first on the platform; intake still sees each committed batch in chronological order.
      events.sort((a, b) => Number(a.message.create_time) - Number(b.message.create_time));
      return { events, cursor: current, errors: Object.values(current.failures) };
    },
    async deliver(message) {
      transport?.assertOpen();
      const address = message?.channel?.address;
      if (message.channel.source === 'feishu' && address?.sourceId === id && address.tenantKey === tenantKey && address.operator === 'true') return deliverOperator(message);
      if (message.channel.source !== 'feishu' || address?.sourceId !== id || address.tenantKey !== tenantKey || !allowed.has(address.chatId)) throw new Error('Feishu delivery is outside configured scope');
      identifier(address.messageId, 'om_', 'reply message ID');
      if (typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text) > 100 * 1024) throw new Error('Invalid Feishu reply text');
      // Recheck the destination against the server so a mismatched address cannot redirect a reply.
      const target = requireSuccess(await read('get', { path: { message_id: address.messageId } }), 'Feishu reply target');
      if (!target.items?.some(item => item.message_id === address.messageId && item.chat_id === address.chatId)) throw new Error('Feishu reply target does not belong to configured chat');
      const uuid = createHash('sha256').update(`${id}:${message.id}`).digest('hex').slice(0, 32);
      const data = requireSuccess(await write('reply', { path: { message_id: address.messageId }, data: { msg_type: 'text', content: JSON.stringify({ text: message.text }), reply_in_thread: true, uuid } }), 'Feishu reply');
      const messageId = identifier(data.message_id, 'om_', 'receipt message ID');
      // Feishu does not return a browser permalink from this API; do not invent one.
      return { id: messageId, url: '', source: 'feishu', messageId, chatId: address.chatId, uuid };
    },
    async readContext({ messageId, chatId }) {
      identifier(messageId, 'om_', 'message ID');
      if (!allowed.has(chatId)) throw new Error('Feishu context is outside configured chat scope');
      const data = requireSuccess(await read('get', { path: { message_id: messageId } }), 'Feishu context');
      const items = (data.items ?? []).filter(message => message.chat_id === chatId);
      if (!items.length) throw new Error('Feishu context message is outside configured chat scope');
      return { source: 'feishu', chatId, messageId, items };
    },
  };
}

/** Optional official SDK transport. Importing js-superagent itself never connects. */
export async function createFeishuConnection({ appId, appSecretEnv, appSecret, botOpenId, tenantKey, scopes, operator, operatorChatId, trackedThreads, id, sdk: suppliedSDK, pollIntervalMs } = {}) {
  identifier(appId, 'cli_', 'Feishu app ID');
  const secret = typeof appSecret === 'string' && appSecret ? appSecret : undefined;
  if (!secret && (typeof appSecretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(appSecretEnv) || !process.env[appSecretEnv])) throw new Error('A configured Feishu app-secret environment variable is required');
  if (secret && (secret.includes('\0') || secret.includes('\n'))) throw new Error('Invalid Feishu app secret');
  let sdk = suppliedSDK;
  if (!sdk) try { sdk = await import('@larksuiteoapi/node-sdk'); } catch { throw new Error('Install @larksuiteoapi/node-sdk to use the optional Feishu connection, or inject an authenticated SDK client'); }
  const credentials = { appId, appSecret: secret ?? process.env[appSecretEnv] };
  const quietLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const transport = createFeishuTransport(sdk.defaultHttpInstance);
  const client = new sdk.Client({ ...credentials, logger: quietLogger, httpInstance: transport.httpInstance });
  const source = createFeishuSource({ id, client, botOpenId, botAppId: appId, tenantKey, scopes, operator, operatorChatId, trackedThreads, pollIntervalMs, transport });
  let ws, started = false, generation = 0, startPromise, stopPromise, stopped = false, stoppedCleanly = false;
  return { source,
    start({ receive, cardAction, onError = () => {}, onState = () => {} } = {}) {
      if (typeof receive !== 'function') throw new Error('Feishu connection requires a durable receive callback');
      if (started) throw new Error('Feishu connection is already started');
      if (stopped) {
        if (!stoppedCleanly) throw new Error('Feishu connection stop has not completed');
        transport.restart(); stopPromise = undefined; stopped = false;
      }
      transport.assertOpen();
      started = true;
      const current = ++generation, live = () => started && current === generation;
      const assertLive = () => { if (!live()) throw new Error('Feishu connection is stopped'); };
      const safeError = error => { if (live()) onError(new Error(`Feishu connection error: ${error?.code ?? 'transport-failed'}`)); };
      const state = value => { if (live()) onState(value); };
      ws = new sdk.WSClient({ ...credentials, logger: quietLogger, onError: safeError,
        httpInstance: transport.httpInstance, handshakeTimeoutMs: FEISHU_HANDSHAKE_TIMEOUT_MS,
        onReady: () => state('ready'), onReconnecting: () => state('reconnecting'), onReconnected: () => state('ready') });
      const socket = ws;
      startPromise = (async () => { try {
        await socket.start({ eventDispatcher: new sdk.EventDispatcher({}).register({ 'im.message.receive_v1': async data => {
          // Commit reception before acknowledging; Worker execution must happen outside this callback.
          assertLive();
          await receive(data);
        }, ...(typeof cardAction === 'function' ? {
          // Feishu waits about 3 s; the host records the submission synchronously and returns the toast and card.
          'card.action.trigger': async data => { assertLive(); return cardAction(data); },
        } : {}) }) });
        if (!live()) socket.close({ force: true });
      } catch (error) { socket.close({ force: true }); if (current === generation) { ws = undefined; started = false; } throw error; }
      return this; })();
      return startPromise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      started = false; stopped = true; stoppedCleanly = false; generation++;
      const socket = ws;
      const draining = transport.stop();
      let closeError;
      try { socket?.close({ force: true }); if (ws === socket) ws = undefined; } catch (error) { closeError = error; }
      stopPromise = (async () => {
        await Promise.allSettled([startPromise, draining]);
        if (closeError) throw closeError;
        stoppedCleanly = true;
      })().catch(error => { stopPromise = undefined; throw error; });
      return stopPromise;
    },
  };
}

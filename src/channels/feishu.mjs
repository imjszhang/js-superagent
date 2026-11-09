import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[A-Za-z0-9_-]{1,200}$`).test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function requireSuccess(response, label) {
  if (!response || response.code !== 0) throw new Error(`${label} failed with code ${Number.isInteger(response?.code) ? response.code : 'unknown'}`);
  return response.data ?? {};
}
function checkSignal(signal) { if (signal?.aborted) throw new Error('Feishu operation cancelled'); }
function parseContent(type, raw) {
  let content;
  try { content = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('Malformed Feishu message content'); }
  if (!content || typeof content !== 'object') throw new Error('Malformed Feishu message content');
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
export function createFeishuSource({ id = 'feishu', client, botOpenId, botAppId, tenantKey, scopes, operator, operatorChatId = () => undefined, now = () => Date.now(), maxPages = 10, pollIntervalMs = 60_000 } = {}) {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new Error('Invalid Feishu source id');
  identifier(botOpenId, 'ou_', 'bot open ID');
  if (botAppId !== undefined) identifier(botAppId, 'cli_', 'bot app ID');
  const operatorOpenId = operator?.openId === undefined ? undefined : identifier(operator.openId, 'ou_', 'operator open ID');
  if (typeof tenantKey !== 'string' || !tenantKey || tenantKey.length > 256) throw new Error('Feishu tenantKey is required');
  const api = client?.im?.message ?? client?.im?.v1?.message;
  if (!api || !['list', 'get', 'reply'].every(key => typeof api[key] === 'function')) throw new Error('Feishu source requires an authenticated message API client');
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 100) throw new Error('Feishu scopes must list 1 to 100 chats');
  const allowed = new Map(scopes.map(scope => {
    identifier(scope.chatId, 'oc_', 'chat ID');
    if (!['p2p', 'group', 'topic_group'].includes(scope.type) || !['mentions', 'all'].includes(scope.mode)) throw new Error('Feishu scope requires type and mentions/all mode');
    return [scope.chatId, { chatId: scope.chatId, type: scope.type, mode: scope.mode }];
  }));
  if (allowed.size !== scopes.length) throw new Error('Duplicate Feishu chat scope');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Feishu maxPages must be 1 to 100');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000) throw new Error('Feishu pollIntervalMs must be at least 1000');
  // The operator's direct messages are the operator conversation, not a listed chat: the host hands them to the coordinator.
  const operatorMessage = (event, message) => {
    if (!operatorOpenId || message.chat_type !== 'p2p') return undefined;
    const sender = event.sender ?? message.sender;
    if ((sender?.sender_id?.open_id ?? (sender?.id_type === 'open_id' ? sender.id : null)) !== operatorOpenId) return undefined;
    if (event.sender?.tenant_key && event.sender.tenant_key !== tenantKey) return null;
    if ((sender.sender_type ?? sender.type) !== 'user') return null;
    const chatId = identifier(message.chat_id, 'oc_', 'chat ID'), messageId = identifier(message.message_id, 'om_', 'message ID');
    const timestamp = Number(message.create_time); if (!Number.isFinite(timestamp) || timestamp < 1) throw new Error('Invalid Feishu message timestamp');
    const parsed = parseContent(message.message_type ?? message.msg_type, message.content ?? message.body?.content);
    if (parsed.text.length > 128 * 1024) throw new Error('Feishu message text exceeds 128 KiB');
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
    const timestamp = Number(message.create_time); if (!Number.isFinite(timestamp) || timestamp < 1) throw new Error('Invalid Feishu message timestamp');
    const parsed = parseContent(message.message_type ?? message.msg_type, message.content ?? message.body?.content);
    if (parsed.text.length > 128 * 1024) throw new Error('Feishu message text exceeds 128 KiB');
    const thread = `${tenantKey}:${message.chat_id}:${rootId}`;
    return { id: `feishu:${tenantKey}:${messageId}`, source: 'feishu', threads: [{ source: 'feishu', id: thread }],
      actor: { source: 'feishu', id: senderId }, human: (sender.sender_type ?? sender.type) === 'user', ...(addressed ? { addressed } : {}),
      at: new Date(timestamp).toISOString(), text: parsed.text,
      channel: { source: 'feishu', thread, address: { sourceId: id, chatId: message.chat_id, messageId: rootId, tenantKey } },
      meta: { tenantKey, chatId: message.chat_id, chatType: scope.type, messageId, rootId, attachments: parsed.attachments, ...(parsed.unsupported ? { unsupported: true } : {}) } };
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
      const target = requireSuccess(await api.get({ path: { message_id: address.updateMessageId } }), 'Feishu card target');
      if (!target.items?.some(item => item.message_id === address.updateMessageId && item.chat_id === knownChat)) throw new Error('Feishu card does not belong to the operator conversation');
      requireSuccess(await api.patch({ path: { message_id: address.updateMessageId }, data: { content: body(message).content } }), 'Feishu card update');
      return { id: address.updateMessageId, url: '', source: 'feishu', messageId: address.updateMessageId, chatId: knownChat, uuid };
    }
    if (address.messageId) {
      identifier(address.messageId, 'om_', 'reply message ID');
      if (!knownChat || address.chatId !== knownChat) throw new Error('Feishu reply is outside the operator conversation');
      const target = requireSuccess(await api.get({ path: { message_id: address.messageId } }), 'Feishu reply target');
      if (!target.items?.some(item => item.message_id === address.messageId && item.chat_id === knownChat)) throw new Error('Feishu reply target does not belong to the operator conversation');
      const data = requireSuccess(await api.reply({ path: { message_id: address.messageId }, data: { ...body(message), reply_in_thread: false, uuid } }), 'Feishu reply');
      const messageId = identifier(data.message_id, 'om_', 'receipt message ID');
      return { id: messageId, url: '', source: 'feishu', messageId, chatId: knownChat, uuid };
    }
    if (address.openId !== operatorOpenId || typeof api.create !== 'function') throw new Error('Feishu direct message is outside the operator conversation');
    const data = requireSuccess(await api.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: operatorOpenId, ...body(message), uuid } }), 'Feishu direct message');
    const messageId = identifier(data.message_id, 'om_', 'receipt message ID'), chatId = identifier(data.chat_id, 'oc_', 'receipt chat ID');
    if (knownChat && knownChat !== chatId) throw new Error('Feishu returned a different operator conversation');
    return { id: messageId, url: '', source: 'feishu', messageId, chatId, uuid };
  };
  return { id, source: 'feishu', pollIntervalMs, normalize, operatorOpenId,
    async poll({ cursor, signal } = {}) {
      const current = cursor?.schemaVersion === 1 ? structuredClone(cursor) : { schemaVersion: 1, scopes: {} };
      const events = [], errors = [], cutoff = Math.floor(now() / 1000);
      for (const scope of allowed.values()) {
        if (events.length >= 9950) break;
        checkSignal(signal);
        const previous = current.scopes[scope.chatId];
        // Establish a receiving baseline. Historical backfill is an explicit cursor operation.
        if (!previous) { current.scopes[scope.chatId] = { since: cutoff }; continue; }
        let pageToken = previous.pageToken, since = previous.since, until = previous.until ?? cutoff;
        try {
          let finished = false;
          for (let page = 0; page < maxPages; page++) {
            if (events.length >= 9950) break;
            const response = await api.list({ params: { container_id_type: 'chat', container_id: scope.chatId,
              start_time: String(Math.max(0, since - 2)), end_time: String(until), sort_type: 'ByCreateTimeAsc', page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) } });
            checkSignal(signal);
            const data = requireSuccess(response, 'Feishu history');
            if (!Array.isArray(data.items ?? [])) throw new Error('Invalid Feishu history items');
            for (const message of data.items ?? []) {
              const event = { sender: message.sender, message: { ...message, chat_id: scope.chatId, chat_type: scope.type } };
              if (normalize(event)) events.push(event);
            }
            if (!data.has_more) { current.scopes[scope.chatId] = { since: until }; finished = true; break; }
            if (typeof data.page_token !== 'string' || !data.page_token || data.page_token === pageToken) throw new Error('Invalid Feishu pagination cursor');
            pageToken = data.page_token;
          }
          if (!finished) current.scopes[scope.chatId] = { since, until, pageToken };
        } catch (error) { checkSignal(signal); errors.push({ scope: scope.chatId, error: String(error.message ?? error) }); }
      }
      return { events, cursor: current, errors };
    },
    async deliver(message) {
      const address = message?.channel?.address;
      if (message.channel.source === 'feishu' && address?.sourceId === id && address.tenantKey === tenantKey && address.operator === 'true') return deliverOperator(message);
      if (message.channel.source !== 'feishu' || address?.sourceId !== id || address.tenantKey !== tenantKey || !allowed.has(address.chatId)) throw new Error('Feishu delivery is outside configured scope');
      identifier(address.messageId, 'om_', 'reply message ID');
      if (typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text) > 100 * 1024) throw new Error('Invalid Feishu reply text');
      // Recheck the destination against the server so a mismatched address cannot redirect a reply.
      const target = requireSuccess(await api.get({ path: { message_id: address.messageId } }), 'Feishu reply target');
      if (!target.items?.some(item => item.message_id === address.messageId && item.chat_id === address.chatId)) throw new Error('Feishu reply target does not belong to configured chat');
      const uuid = createHash('sha256').update(`${id}:${message.id}`).digest('hex').slice(0, 32);
      const data = requireSuccess(await api.reply({ path: { message_id: address.messageId }, data: { msg_type: 'text', content: JSON.stringify({ text: message.text }), reply_in_thread: true, uuid } }), 'Feishu reply');
      const messageId = identifier(data.message_id, 'om_', 'receipt message ID');
      // Feishu does not return a browser permalink from this API; do not invent one.
      return { id: messageId, url: '', source: 'feishu', messageId, chatId: address.chatId, uuid };
    },
    async readContext({ messageId, chatId }) {
      identifier(messageId, 'om_', 'message ID');
      if (!allowed.has(chatId)) throw new Error('Feishu context is outside configured chat scope');
      const data = requireSuccess(await api.get({ path: { message_id: messageId } }), 'Feishu context');
      const items = (data.items ?? []).filter(message => message.chat_id === chatId);
      if (!items.length) throw new Error('Feishu context message is outside configured chat scope');
      return { source: 'feishu', chatId, messageId, items };
    },
  };
}

/** Optional official SDK transport. Importing js-superagent itself never connects. */
export async function createFeishuConnection({ appId, appSecretEnv, appSecret, botOpenId, tenantKey, scopes, operator, operatorChatId, id, sdk: suppliedSDK, pollIntervalMs } = {}) {
  identifier(appId, 'cli_', 'Feishu app ID');
  const secret = typeof appSecret === 'string' && appSecret ? appSecret : undefined;
  if (!secret && (typeof appSecretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(appSecretEnv) || !process.env[appSecretEnv])) throw new Error('A configured Feishu app-secret environment variable is required');
  if (secret && (secret.includes('\0') || secret.includes('\n'))) throw new Error('Invalid Feishu app secret');
  let sdk = suppliedSDK;
  if (!sdk) try { sdk = await import('@larksuiteoapi/node-sdk'); } catch { throw new Error('Install @larksuiteoapi/node-sdk to use the optional Feishu connection, or inject an authenticated SDK client'); }
  const credentials = { appId, appSecret: secret ?? process.env[appSecretEnv] };
  const quietLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const client = new sdk.Client({ ...credentials, logger: quietLogger });
  const source = createFeishuSource({ id, client, botOpenId, botAppId: appId, tenantKey, scopes, operator, operatorChatId, pollIntervalMs });
  let ws, started = false;
  return { source,
    async start({ receive, cardAction, onError = () => {}, onState = () => {} } = {}) {
      if (typeof receive !== 'function') throw new Error('Feishu connection requires a durable receive callback');
      if (started) throw new Error('Feishu connection is already started');
      started = true;
      const safeError = error => onError(new Error(`Feishu connection error: ${error?.code ?? 'transport-failed'}`));
      ws = new sdk.WSClient({ ...credentials, logger: quietLogger, onError: safeError, onReady: () => onState('ready'),
        onReconnecting: () => onState('reconnecting'), onReconnected: () => onState('ready') });
      try {
        await ws.start({ eventDispatcher: new sdk.EventDispatcher({}).register({ 'im.message.receive_v1': async data => {
          // Commit reception before acknowledging; Worker execution must happen outside this callback.
          await receive(data);
        }, ...(typeof cardAction === 'function' ? {
          // Feishu waits about 3 s; the host records the submission synchronously and returns the toast and card.
          'card.action.trigger': async data => cardAction(data),
        } : {}) }) });
      } catch (error) { ws.close({ force: true }); ws = undefined; started = false; throw error; }
      return this;
    },
    async stop() { ws?.close({ force: true }); ws = undefined; started = false; },
  };
}

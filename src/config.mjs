import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { assertDatabaseAvailable } from './database-maintenance.mjs';
import { DEFAULT_DRIVER, PROJECT_EXECUTION_DRIVERS, RETIRED_DRIVERS } from './harness/builtin.mjs';
import { assertStateMigrated, ensureProjectStateDirectory, projectStateDirectory } from './state-paths.mjs';

const workspaceKeys = ['mode', 'baseRef', 'exclude'];
const executionKeys = ['driver', 'executable', 'model', 'timeoutMs', 'killGraceMs'];
const githubKeys = ['repository', 'allowedActors', 'issues', 'command', 'executable', 'pollIntervalMs', 'ci', 'app', 'account', 'webhook'];
const feishuKeys = ['enabled', 'appId', 'appSecretEnv', 'appSecretPath', 'botOpenId', 'tenantKey', 'chats', 'operator'];
const MAX_CONFIG_BYTES = 64 * 1024;
export const DEFAULT_EXECUTION_DRIVER = DEFAULT_DRIVER;
function object(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty single-line string`);
  return value;
}
function integer(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer between 1 and ${max}`);
  return value;
}
function workspace(value, partial = false) {
  if (typeof value === 'string') value = { mode: value };
  object(value, 'workspace', workspaceKeys);
  const result = {};
  if (!partial || value.mode !== undefined) {
    if (!['in-place', 'auto', 'worktree', 'copy'].includes(value.mode)) throw new Error('workspace.mode must be in-place, auto, worktree, or copy');
    result.mode = value.mode;
  }
  if (value.baseRef !== undefined) {
    const ref = text(value.baseRef, 'workspace.baseRef');
    if (ref.startsWith('-')) throw new Error('workspace.baseRef cannot begin with -');
    result.baseRef = ref;
  }
  if (value.exclude !== undefined) {
    if (!Array.isArray(value.exclude)) throw new Error('workspace.exclude must be an array');
    result.exclude = [...new Set(value.exclude.map(item => {
      text(item, 'workspace.exclude entry');
      if (isAbsolute(item) || item.includes('\\') || /^[A-Za-z]:/.test(item) || /[*?\[\]{}]/.test(item)) throw new Error('workspace.exclude entries must be relative paths, not patterns');
      const path = item.replace(/\/+$/, '');
      if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('workspace.exclude entries cannot escape the project');
      return path;
    }))];
  }
  return result;
}
function execution(value, partial = false) {
  object(value, 'execution', executionKeys);
  const result = {};
  if (!partial || value.driver !== undefined) {
    if (!PROJECT_EXECUTION_DRIVERS.includes(value.driver)) throw new Error('Select a registered Harness using executor set');
    result.driver = value.driver;
  }
  if (value.executable !== undefined) result.executable = text(value.executable, 'execution.executable');
  if (value.model !== undefined) result.model = text(value.model, 'execution.model');
  if (value.timeoutMs !== undefined) result.timeoutMs = integer(value.timeoutMs, 'execution.timeoutMs', 86_400_000);
  if (value.killGraceMs !== undefined) result.killGraceMs = integer(value.killGraceMs, 'execution.killGraceMs', 30_000);
  return result;
}
function githubCI(value) {
  object(value, 'github.ci', ['checkApps', 'statusContexts', 'statusActors']);
  if (value.checkApps === undefined && value.statusContexts === undefined && value.statusActors === undefined) throw new Error('github.ci must configure checkApps or statusContexts and statusActors');
  if ((value.statusContexts === undefined) !== (value.statusActors === undefined)) throw new Error('github.ci.statusContexts and github.ci.statusActors must be configured together');
  const result = {};
  for (const key of ['checkApps', 'statusContexts', 'statusActors']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || !value[key].length) throw new Error(`github.ci.${key} must be a non-empty array`);
    result[key] = [...new Set(value[key].map(item => {
      text(item, `github.ci.${key} entry`);
      if (key === 'checkApps' && !/^[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i.test(item)) throw new Error('github.ci.checkApps must contain explicit GitHub App slugs');
      if (key === 'statusActors' && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i.test(item)) throw new Error('github.ci.statusActors must contain explicit GitHub user or bot logins');
      if (key === 'statusContexts' && (item.length > 255 || /[\x00-\x1f\x7f]/.test(item))) throw new Error('github.ci.statusContexts entries must contain at most 255 printable characters');
      return key === 'statusContexts' ? item : item.toLowerCase();
    }))];
  }
  return result;
}
function secretReference(value, envKey, pathKey, label) {
  if ((value[envKey] === undefined) === (value[pathKey] === undefined)) throw new Error(`${label} requires exactly one of ${envKey} or ${pathKey}`);
  if (value[envKey] !== undefined) {
    if (typeof value[envKey] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value[envKey])) throw new Error(`${label}.${envKey} must name an environment variable`);
    return { [envKey]: value[envKey] };
  }
  const path = text(value[pathKey], `${label}.${pathKey}`);
  if (path.length > 4096) throw new Error(`${label}.${pathKey} exceeds 4096 characters`);
  return { [pathKey]: path };
}
function githubApp(value) {
  object(value, 'github.app', ['appId', 'installationId', 'privateKeyEnv', 'privateKeyPath', 'pullRequestComments', 'pullRequestReviews']);
  if (typeof value.appId !== 'string' || !/^[1-9]\d*$/.test(value.appId) || !Number.isSafeInteger(Number(value.appId))) throw new Error('github.app.appId must be a positive numeric string');
  if (value.pullRequestReviews !== undefined && typeof value.pullRequestReviews !== 'boolean') throw new Error('github.app.pullRequestReviews must be boolean');
  if (value.pullRequestComments !== undefined && typeof value.pullRequestComments !== 'boolean') throw new Error('github.app.pullRequestComments must be boolean');
  return { ...(value.pullRequestReviews === undefined ? {} : { pullRequestReviews: value.pullRequestReviews }), ...(value.pullRequestComments === undefined ? {} : { pullRequestComments: value.pullRequestComments }), appId: value.appId, installationId: integer(value.installationId, 'github.app.installationId', Number.MAX_SAFE_INTEGER),
    ...secretReference(value, 'privateKeyEnv', 'privateKeyPath', 'github.app') };
}
function githubWebhook(value) {
  object(value, 'github.webhook', ['secretEnv', 'secretPath', 'host', 'port', 'path', 'maxBodyBytes']);
  const result = secretReference(value, 'secretEnv', 'secretPath', 'github.webhook');
  const host = value.host ?? '127.0.0.1';
  if (typeof host !== 'string' || (!isIP(host) && host !== 'localhost')) throw new Error('github.webhook.host must be an IP address or localhost');
  const port = value.port ?? 8787;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('github.webhook.port must be an integer between 0 and 65535');
  const path = value.path ?? '/github/webhook';
  if (typeof path !== 'string' || path.length > 256 || !/^\/[A-Za-z0-9_/-]*$/.test(path) || path.includes('//')) throw new Error('github.webhook.path must be an absolute URL path without a query');
  return { ...result, host, port, path, maxBodyBytes: integer(value.maxBodyBytes ?? 1024 * 1024, 'github.webhook.maxBodyBytes', 25 * 1024 * 1024) };
}
function github(value, partial = false) {
  object(value, 'github', githubKeys);
  const result = {};
  if (!partial || value.repository !== undefined) {
    const repository = text(value.repository, 'github.repository');
    const [owner, repo, extra] = repository.split('/');
    if (extra !== undefined || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) ||
        !repo || !/^[a-z\d_.-]{1,100}$/i.test(repo) || ['.', '..'].includes(repo)) throw new Error('github.repository must be a github.com owner/repository name');
    result.repository = repository.toLowerCase();
  }
  if (!partial || value.allowedActors !== undefined) {
    if (!Array.isArray(value.allowedActors) || !value.allowedActors.length || value.allowedActors.some(actor =>
      typeof actor !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(actor))) throw new Error('github.allowedActors must contain explicit GitHub user logins');
    result.allowedActors = [...new Set(value.allowedActors.map(actor => actor.toLowerCase()))];
  }
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues) || !value.issues.length) throw new Error('github.issues must be a non-empty issue-number array when provided');
    result.issues = [...new Set(value.issues.map(issue => integer(issue, 'github.issues entry', 2_147_483_647)))];
  }
  if (!partial || value.command !== undefined) {
    const command = value.command ?? '/js-superagent';
    if (typeof command !== 'string' || !/^\/[a-z][a-z\d_-]{0,63}$/i.test(command)) throw new Error('github.command must be a single slash command such as /js-superagent');
    result.command = command;
  }
  if (value.executable !== undefined) result.executable = text(value.executable, 'github.executable');
  if (!partial || value.pollIntervalMs !== undefined) {
    const poll = value.pollIntervalMs ?? 30_000;
    integer(poll, 'github.pollIntervalMs', 86_400_000);
    if (poll < 1000) throw new Error('github.pollIntervalMs must be at least 1000');
    result.pollIntervalMs = poll;
  }
  if (value.ci !== undefined) result.ci = partial && value.ci === null ? null : githubCI(value.ci);
  if (value.account !== undefined) {
    if (partial && value.account === null) result.account = null;
    else {
      object(value.account, 'github.account', ['login']);
      if (typeof value.account.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.account.login)) throw new Error('github.account.login must be a GitHub user login');
      result.account = { login: value.account.login.toLowerCase() };
    }
  }
  if (value.app !== undefined) result.app = partial && value.app === null ? null : githubApp(value.app);
  if (value.webhook !== undefined) result.webhook = partial && value.webhook === null ? null : githubWebhook(value.webhook);
  if (!partial && result.account) {
    if (result.app) throw new Error('GitHub account and App authentication are mutually exclusive');
    if (!result.executable) throw new Error('GitHub account requires an explicit dedicated CLI executable');
    if (result.allowedActors.includes(result.account.login)) throw new Error('GitHub agent account must differ from allowed human actors');
    result.pollIntervalMs = Math.max(60_000, result.pollIntervalMs);
  }
  return result;
}
function feishuChat(value) {
  object(value, 'feishu.chats entry', ['chatId', 'type', 'mode']);
  const chatId = text(value.chatId, 'feishu.chats.chatId');
  if (!/^oc_[A-Za-z0-9_-]{1,200}$/.test(chatId)) throw new Error('feishu.chats.chatId must be a Feishu chat id');
  if (!['group', 'p2p', 'topic_group'].includes(value.type)) throw new Error('feishu.chats.type must be group, p2p, or topic_group');
  if (!['mentions', 'all'].includes(value.mode)) throw new Error('feishu.chats.mode must be mentions or all');
  return { chatId, type: value.type, mode: value.mode };
}
function feishu(value, partial = false) {
  object(value, 'feishu', feishuKeys);
  let result = {};
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('feishu.enabled must be boolean');
  if (value.enabled !== undefined) result.enabled = value.enabled;
  else if (!partial || value.appId !== undefined) result.enabled = true;
  if (!partial || value.appId !== undefined) {
    const appId = text(value.appId, 'feishu.appId');
    if (!/^cli_[A-Za-z0-9_-]{1,200}$/.test(appId)) throw new Error('feishu.appId must be a Feishu app id');
    result.appId = appId;
  }
  if (!partial || value.botOpenId !== undefined) {
    const botOpenId = text(value.botOpenId, 'feishu.botOpenId');
    if (!/^ou_[A-Za-z0-9_-]{1,200}$/.test(botOpenId)) throw new Error('feishu.botOpenId must be a Feishu open id');
    result.botOpenId = botOpenId;
  }
  if (!partial || value.tenantKey !== undefined) {
    const tenantKey = text(value.tenantKey, 'feishu.tenantKey');
    if (tenantKey.length > 256) throw new Error('feishu.tenantKey exceeds 256 characters');
    result.tenantKey = tenantKey;
  }
  if (!partial || value.appSecretEnv !== undefined || value.appSecretPath !== undefined) result = { ...result, ...secretReference(value, 'appSecretEnv', 'appSecretPath', 'feishu') };
  if (!partial || value.chats !== undefined) {
    if (!Array.isArray(value.chats) || !value.chats.length || value.chats.length > 100) throw new Error('feishu.chats must list 1 to 100 chats');
    const chats = value.chats.map(feishuChat);
    if (new Set(chats.map(chat => chat.chatId)).size !== chats.length) throw new Error('Duplicate Feishu chat id');
    result.chats = chats;
  }
  if (value.operator !== undefined) {
    if (partial && value.operator === null) result.operator = null;
    else {
      object(value.operator, 'feishu.operator', ['openId']);
      const openId = text(value.operator.openId, 'feishu.operator.openId');
      if (!/^ou_[A-Za-z0-9_-]{1,200}$/.test(openId)) throw new Error('feishu.operator.openId must be a Feishu open id');
      result.operator = { openId };
    }
  }
  return result;
}
/** Validate only mutable public settings; secrets and arbitrary process options are not accepted. */
export function validateProjectOptions(patch = {}) {
  object(patch, 'configuration patch', ['workspace', 'execution', 'github', 'feishu']);
  const result = {};
  if (patch.workspace !== undefined) result.workspace = workspace(patch.workspace, true);
  if (patch.execution !== undefined) {
    if (Object.hasOwn(RETIRED_DRIVERS, patch.execution?.driver ?? '')) throw new Error(`Retired execution mode; use executor status and explicitly select ${Object.values(RETIRED_DRIVERS).join(' or ')}`);
    result.execution = execution(patch.execution, true);
  }
  if (patch.github !== undefined) result.github = patch.github === null ? null : github(patch.github, true);
  if (patch.feishu !== undefined) result.feishu = patch.feishu === null ? null : feishu(patch.feishu, true);
  return result;
}
/** Normalize legacy configuration in memory without rewriting it. */
export function normalizeProjectConfig(value) {
  object(value, 'configuration', ['schemaVersion', 'projectId', 'concurrency', 'workspace', 'execution', 'github', 'feishu']);
  if (![1, 2].includes(value.schemaVersion) || value.concurrency !== 1) throw new Error('Unsupported project configuration');
  if (value.schemaVersion === 1 && (value.workspace !== 'in-place' || value.execution !== undefined || value.github !== undefined)) throw new Error('Unsupported legacy project configuration');
  if (value.schemaVersion === 2 && (!value.workspace || typeof value.workspace !== 'object')) throw new Error('workspace must be an object in configuration version 2');
  const result = { schemaVersion: 2, projectId: text(value.projectId, 'projectId'), concurrency: 1,
    workspace: workspace(value.schemaVersion === 1 ? { mode: 'in-place' } : value.workspace) };
  if (value.execution !== undefined) result.execution = execution(value.execution);
  if (value.github !== undefined) result.github = github(value.github);
  if (value.feishu !== undefined) result.feishu = feishu(value.feishu);
  return result;
}
export function mergeProjectConfig(config, patch = {}) {
  const current = normalizeProjectConfig(config);
  const valid = validateProjectOptions(patch);
  const next = { ...current,
    ...(valid.workspace ? { workspace: { ...current.workspace, ...valid.workspace } } : {}),
    ...(valid.execution ? { execution: { driver: DEFAULT_EXECUTION_DRIVER, ...current.execution, ...valid.execution } } : {}),
  };
  if (valid.github === null) delete next.github;
  else if (valid.github) {
    next.github = { ...current.github, ...valid.github };
    for (const key of ['ci', 'app', 'account', 'webhook']) if (valid.github[key] === null) delete next.github[key];
  }
  if (valid.feishu === null) delete next.feishu;
  else if (valid.feishu) {
    next.feishu = { ...current.feishu, ...valid.feishu };
    if (valid.feishu.appSecretPath) delete next.feishu.appSecretEnv;
    if (valid.feishu.appSecretEnv) delete next.feishu.appSecretPath;
    if (valid.feishu.operator === null) delete next.feishu.operator;
  }
  return normalizeProjectConfig(next);
}
function paths(projectRoot, create = false) {
  const root = realpathSync(projectRoot), directory = projectStateDirectory(root);
  assertStateMigrated(root);
  const statOrNull = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const directoryStat = statOrNull(directory);
  if (directoryStat) {
    const stat = directoryStat;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project state directory must be a real directory');
  } else if (create) ensureProjectStateDirectory(root);
  const file = join(directory, 'config.json');
  const fileStat = statOrNull(file);
  if (fileStat) {
    const stat = fileStat;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('Project configuration must be a regular file no larger than 64 KiB');
  }
  return { root, directory, file };
}
function resolved(config, root) {
  if (config.execution?.executable?.includes('/')) config.execution.executable = resolve(root, config.execution.executable);
  if (config.github?.executable?.includes('/')) config.github.executable = resolve(root, config.github.executable);
  if (config.github?.app?.privateKeyPath) config.github.app.privateKeyPath = resolve(root, config.github.app.privateKeyPath);
  if (config.github?.webhook?.secretPath) config.github.webhook.secretPath = resolve(root, config.github.webhook.secretPath);
  if (config.feishu?.appSecretPath) config.feishu.appSecretPath = resolve(root, config.feishu.appSecretPath);
  return config;
}
export function readProjectConfig(projectRoot) {
  const { root, file } = paths(projectRoot);
  return resolved(normalizeProjectConfig(JSON.parse(readFileSync(file, 'utf8'))), root);
}
function encode(config) {
  const content = JSON.stringify(config, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw new Error('Project configuration must be no larger than 64 KiB');
  return content;
}
function put(file, config, exclusive) {
  assertDatabaseAvailable(join(dirname(file), 'state.sqlite'));
  const content = encode(config);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    if (exclusive) linkSync(temporary, file);
    else renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
/** Existing configuration is preserved; use configure() for intentional updates. */
export function initializeProjectConfig(projectRoot, options = {}) {
  const patch = validateProjectOptions(options);
  const { root, file } = paths(projectRoot);
  if (existsSync(file)) {
    const current = readProjectConfig(root);
    const desired = resolved(mergeProjectConfig(current, patch), root);
    if (JSON.stringify(current) !== JSON.stringify(desired)) throw new Error('Project already has different configuration; use config set to update it');
    return current;
  }
  assertDatabaseAvailable(join(projectStateDirectory(root), 'state.sqlite'));
  const config = resolved(mergeProjectConfig({ schemaVersion: 2, projectId: randomUUID(), concurrency: 1, workspace: { mode: 'in-place' } }, patch), root);
  encode(config); // Reject oversized options before creating any state directory.
  paths(root, true);
  try { put(file, config, true); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return initializeProjectConfig(root, options); }
  return config;
}
/** Call under the runtime's project mutation guard, so active execution cannot be reconfigured. */
export function writeProjectConfig(projectRoot, patch) {
  const { root, file } = paths(projectRoot);
  assertDatabaseAvailable(join(projectStateDirectory(root), 'state.sqlite'));
  const next = resolved(mergeProjectConfig(readProjectConfig(root), patch), root);
  put(file, next, false);
  return next;
}

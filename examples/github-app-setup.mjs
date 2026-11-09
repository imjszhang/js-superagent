#!/usr/bin/env node
import { createServer } from 'node:http';
import { createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://api.github.com';
const PERMISSIONS = { metadata: 'read', issues: 'write', pull_requests: 'read', checks: 'read', statuses: 'read' };
// Installation events are automatic; GitHub does not allow subscribing to them manually.
const EVENTS = ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'check_run', 'status'];
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const same = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

/** Local, human-confirmed GitHub App manifest registration. No credentials are returned to the browser. */
export async function startGitHubAppSetup(options, { fetch: fetcher = globalThis.fetch, onProgress = () => {} } = {}) {
  const repository = options.repository?.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(repository ?? '') || ['.', '..'].includes(repository.split('/')[1])) throw new Error('An explicit owner/repository is required');
  const ownerType = options.ownerType ?? 'user';
  if (!['user', 'organization'].includes(ownerType)) throw new Error('App owner type must be user or organization');
  const settingsBase = ownerType === 'organization' ? `https://github.com/organizations/${repository.split('/')[0]}/settings/apps` : 'https://github.com/settings/apps';
  let webhook;
  try { webhook = new URL(options.webhookUrl); } catch { throw new Error('A public HTTPS webhook URL is required'); }
  if (webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.hash || webhook.search) throw new Error('A public HTTPS webhook URL without credentials or query parameters is required');
  const port = options.port ?? 18377;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local setup port');
  if (typeof options.output !== 'string' || !options.output.trim()) throw new Error('An output directory is required');
  const output = resolve(options.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (!(await lstat(output)).isDirectory()) throw new Error('Output must be a regular directory');
  const privateKeyPath = resolve(output, '.env.github-app-key.pem');
  const secretPath = resolve(output, '.env.webhook-secret');
  const metadataPath = resolve(output, 'app.json');
  for (const path of [privateKeyPath, secretPath, metadataPath]) {
    try { await lstat(path); throw new Error('Setup output already exists; use a new directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const state = randomBytes(32).toString('hex');
  const setupNonce = randomBytes(32).toString('hex');
  const installState = randomBytes(32).toString('hex');
  let base, manifest, metadata, signingKey, exchanging = false, attempted = false, installing = false;

  async function api(endpoint, { method = 'GET', authorization } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetcher(`${API}${endpoint}`, { method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'js-superagent-setup',
          ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) } });
      if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== API) {
        await response.body?.cancel(); throw new Error('GitHub rejected the setup request');
      }
      if (Number(response.headers.get('content-length')) > 1024 * 1024) { await response.body?.cancel(); throw new Error('Setup response too large'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing setup response');
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Setup response too large'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('GitHub setup request failed; no credentials have been displayed'); }
    finally { clearTimeout(timeout); }
  }
  function jwt() {
    const seconds = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(metadata.id) })).toString('base64url');
    const data = `${head}.${claims}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), signingKey).toString('base64url')}`;
  }
  function page(res, status, title, body) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:18px/1.7 system-ui;max-width:760px;margin:60px auto;padding:0 24px;color:#222}button,a{font:inherit}button{padding:12px 24px;cursor:pointer}code{overflow-wrap:anywhere}li{margin:6px 0}</style><h1>${escape(title)}</h1>${body}</html>`);
  }
  function installPage(res) {
    page(res, 200, 'GitHub App 已创建', `<p>凭据已保存在本机。下一步安装到 <strong>${escape(repository)}</strong>。</p><p>在 GitHub 选择 <strong>Only select repositories</strong>，仅勾选 <strong>${escape(repository.split('/')[1])}</strong>，然后点击 Install。</p><p><a href="https://github.com/apps/${escape(metadata.slug)}/installations/new">打开 GitHub 安装页面</a></p><p>安装完成后会回到本页，核对仓库和安装编号。</p>`);
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(base).host || req.method !== 'GET') { page(res, 403, '请求被拒绝', '<p>请使用终端显示的本机设置链接。</p>'); return; }
      const url = new URL(req.url, base);
      if (url.origin !== base) { page(res, 403, '请求被拒绝', ''); return; }
      if (url.pathname === `/setup/${setupNonce}`) {
        if (metadata) { installPage(res); return; }
        page(res, 200, '为 js-superagent 创建 GitHub App', `<p>目标仓库：<strong>${escape(repository)}</strong>。此 App 为私有，仅所属${ownerType === 'organization' ? '组织' : '个人账号'}可安装。</p><ul><li>Issues：读写，用于接单与回传评论。</li><li>Pull requests、Checks、Commit statuses、Metadata：只读，用于接收审阅与 CI 反馈。</li></ul><p>Webhook：<code>${escape(webhook.href)}</code></p><p>点击后将前往 GitHub，由你确认创建；然后回来选择安装仓库。</p><form method="post" action="${settingsBase}/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button type="submit">前往 GitHub 创建私有 App</button></form>`);
        return;
      }
      if (url.pathname === '/callback') {
        if (!same(url.searchParams.get('state'), state)) { page(res, 403, '注册回调未通过校验', '<p>请从原设置链接开始。</p>'); return; }
        if (metadata) { installPage(res); return; }
        if (exchanging || attempted) { page(res, 409, '注册回调已处理', '<p>请查看本机设置进程的结果。</p>'); return; }
        const code = url.searchParams.get('code');
        if (!code || !/^[a-zA-Z0-9_-]{1,256}$/.test(code)) { page(res, 400, '缺少有效注册凭证', ''); return; }
        attempted = true; exchanging = true;
        try {
          const app = await api(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
          if (!Number.isSafeInteger(app.id) || app.id <= 0 || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(app.slug ?? '') ||
              typeof app.pem !== 'string' || Buffer.byteLength(app.pem) > 65536 || typeof app.webhook_secret !== 'string' ||
              app.webhook_secret.length < 16 || app.webhook_secret.length > 4096 || /[\r\n\0]/.test(app.webhook_secret)) throw new Error('Invalid registration response');
          signingKey = createPrivateKey(app.pem);
          if (signingKey.asymmetricKeyType !== 'rsa' || signingKey.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('Invalid registration key');
          const saved = { id: app.id, slug: app.slug, privateKeyPath, secretPath, settingsUrl: `${settingsBase}/${app.slug}` };
          await writeFile(privateKeyPath, app.pem, { flag: 'wx', mode: 0o600 });
          await writeFile(secretPath, app.webhook_secret, { flag: 'wx', mode: 0o600 });
          await writeFile(metadataPath, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
          metadata = saved;
          onProgress({ event: 'registered', id: metadata.id, slug: metadata.slug, metadataPath });
          installPage(res);
        } catch { page(res, 502, '注册回调未完成', '<p>无法完成凭据交换或本机保存。为避免覆盖凭据，本次回调不会自动重试。请检查本机输出目录及 GitHub App 设置。</p>'); }
        finally { exchanging = false; }
        return;
      }
      if (url.pathname === '/installed') {
        if (!same(url.searchParams.get('state'), installState) || !metadata) { page(res, 403, '安装回调未通过校验', ''); return; }
        const rawId = url.searchParams.get('installation_id');
        const installationId = Number(rawId);
        if (!/^[1-9]\d*$/.test(rawId ?? '') || !Number.isSafeInteger(installationId)) { page(res, 400, '缺少有效安装编号', '<p>请完成安装后再返回。</p>'); return; }
        if (installing) { page(res, 409, '正在核对安装', '<p>请稍后刷新。</p>'); return; }
        installing = true;
        try {
          const installation = await api(`/repos/${repository}/installation`, { authorization: jwt() });
          if (installation.id !== installationId || installation.app_id !== metadata.id ||
              installation.account?.login?.toLowerCase() !== repository.split('/')[0] || installation.suspended_at) throw new Error('Installation does not match this repository and App');
          if (installation.repository_selection !== 'selected') { page(res, 409, '请选择指定仓库', `<p>请在 <a href="${escape(installation.html_url?.startsWith('https://github.com/') ? installation.html_url : metadata.settingsUrl)}">GitHub 安装设置</a>中选择 Only select repositories，并勾选 ${escape(repository)}，然后刷新本页。</p>`); return; }
          const saved = { ...metadata, installationId };
          const temporary = `${metadataPath}.${randomBytes(8).toString('hex')}.tmp`;
          await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
          await rename(temporary, metadataPath);
          metadata = saved;
          onProgress({ event: 'installed', id: metadata.id, slug: metadata.slug, installationId, repository, metadataPath });
          page(res, 200, 'GitHub App 安装已核对', `<p>仓库：<strong>${escape(repository)}</strong></p><p>App：${escape(metadata.slug)} · 安装编号：${installationId}</p><p>配置已安全保存在本机。现在可以返回 Codex 继续接通和验收。</p>`);
        } catch { page(res, 502, '未能核对安装', `<p>请确认该 App 已安装到 ${escape(repository)}，然后刷新本页重试。</p>`); }
        finally { installing = false; }
        return;
      }
      page(res, 404, '页面不存在', '');
    } catch { if (!res.headersSent) page(res, 500, '设置服务暂时不可用', '<p>请检查本机设置进程。</p>'); else res.end(); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  base = `http://127.0.0.1:${server.address().port}`;
  // GitHub App names have a 34-character limit; retain a random suffix for uniqueness.
  const nameOwner = repository.split('/')[0].slice(0, 13).replace(/-+$/, '');
  manifest = { name: `js-superagent-${nameOwner}-${randomBytes(3).toString('hex')}`, url: `https://github.com/${repository}`,
    description: `Project-local js-superagent for ${repository}`, public: false, hook_attributes: { url: webhook.href, active: true },
    redirect_url: `${base}/callback`, setup_url: `${base}/installed?state=${installState}`, setup_on_update: false,
    request_oauth_on_install: false, default_permissions: PERMISSIONS, default_events: EVENTS };
  return { setupUrl: `${base}/setup/${setupNonce}`, server, close: () => new Promise((yes, no) => server.close(error => error ? no(error) : yes())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { repository: { type: 'string' }, 'owner-type': { type: 'string', default: 'user' }, 'webhook-url': { type: 'string' }, output: { type: 'string' }, port: { type: 'string', default: '18377' } } });
    const setup = await startGitHubAppSetup({ repository: values.repository, ownerType: values['owner-type'], webhookUrl: values['webhook-url'], output: values.output, port: Number(values.port) },
      { onProgress: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
    process.stdout.write(`${JSON.stringify({ event: 'ready', setupUrl: setup.setupUrl })}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { setup.close().catch(() => {}); });
  } catch { process.stderr.write('GitHub App setup could not start. Check arguments, output directory, and local port.\n'); process.exitCode = 1; }
}

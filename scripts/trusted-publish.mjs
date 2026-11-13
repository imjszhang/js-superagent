import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkRelease } from './check-release.mjs';

const repository = 'imjszhang/js-superagent';
const registry = 'https://registry.npmjs.org/';
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function verifyRelease({ root = defaultRoot, env = process.env, execFile = execFileSync } = {}) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Release must run from imjszhang/js-superagent main');
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Missing or invalid source commit');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (env.EXPECTED_VERSION !== pkg.version) throw new Error('Expected version does not match package version');
  const checked = checkRelease(pkg, lock, `v${env.EXPECTED_VERSION}`);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  const git = args => execFile('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', 'HEAD']) !== env.GITHUB_SHA) throw new Error('Checkout does not match workflow source commit');
  if (git(['status', '--porcelain'])) throw new Error('Release checkout must be clean');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/manifest.json'), 'utf8'));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  if (manifest.name !== pkg.name || manifest.version !== pkg.version || manifest.filename !== filename) {
    throw new Error('Artifact package, version or filename does not match source');
  }
  if (manifest.sourceCommit !== env.GITHUB_SHA || manifest.sourceDirty !== false) {
    throw new Error('Artifact must come from the clean workflow source commit');
  }
  const archive = path.join(root, 'release', filename);
  if (!fs.lstatSync(archive).isFile()) throw new Error('Artifact must be a regular file');
  const bytes = fs.readFileSync(archive);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== manifest.integrity || bytes.length !== manifest.size) {
    throw new Error('Artifact integrity or size does not match manifest');
  }
  const packedPackage = JSON.parse(execFile('tar', ['-xOf', archive, 'package/package.json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (JSON.stringify(packedPackage) !== JSON.stringify(pkg)) throw new Error('Packed package metadata does not match source');
  return { filename, archive, version: pkg.version, channel: checked.tag, integrity, name: pkg.name };
}

async function registryJSON(url, fetch) {
  const response = await fetch(url, {
    cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry verification returned HTTP ${response.status}`);
  return response.json();
}

function assertVersion(metadata, release) {
  if (metadata.name !== release.name || metadata.version !== release.version || metadata.dist?.integrity !== release.integrity) {
    throw new Error('Published version differs from the verified release artifact');
  }
}

export async function publishRelease({
  root = defaultRoot, env = process.env, execFile = execFileSync,
  fetch = globalThis.fetch, spawn = spawnSync, sleep = delay, attempts = 30, intervalMs = 10_000,
} = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('Publishing requires GitHub Actions OIDC');
  }
  if (env.NODE_AUTH_TOKEN || env.NPM_TOKEN) throw new Error('Publishing must use OIDC without npm token environment variables');
  const release = verifyRelease({ root, env, execFile });
  const versionURL = new URL(`${encodeURIComponent(release.name)}/${encodeURIComponent(release.version)}`, registry);
  const readVersion = () => {
    versionURL.searchParams.set('verification', `${Date.now()}`);
    return registryJSON(versionURL.href, fetch);
  };
  const existing = await readVersion();
  if (existing) {
    assertVersion(existing, release);
    return { status: 'already-published', version: release.version, integrity: release.integrity };
  }
  // Never retry the mutation: even a nonzero exit may follow a successful registry write.
  let command;
  try {
    command = spawn('npm', ['publish', release.archive, '--ignore-scripts', '--access', 'public',
      '--tag', release.channel, '--registry', registry], { cwd: root, env, stdio: 'inherit', timeout: 120_000 });
  } catch {
    command = { status: null };
  }
  let observation = `npm publish exited ${command?.status ?? 'without a confirmed status'}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(intervalMs);
    let metadata;
    try {
      metadata = await readVersion();
    } catch (error) {
      observation = error.message;
      continue;
    }
    if (!metadata) {
      observation = 'exact version is not visible yet';
      continue;
    }
    assertVersion(metadata, release);
    try {
      const tagsURL = new URL(`-/package/${encodeURIComponent(release.name)}/dist-tags`, registry);
      tagsURL.searchParams.set('verification', `${Date.now()}`);
      const tags = await registryJSON(tagsURL.href, fetch);
      if (tags?.[release.channel] === release.version) {
        return { status: 'published', version: release.version, integrity: release.integrity };
      }
      observation = `version is visible but ${release.channel} does not point to it yet`;
    } catch (error) {
      observation = error.message;
    }
  }
  throw new Error(`Publication attempted once; verification remains incomplete (${observation}). Check the registry before any retry; do not republish blindly.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'verify') {
      const result = verifyRelease();
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `filename=${result.filename}\nversion=${result.version}\nchannel=${result.channel}\n`);
      }
      console.log(JSON.stringify(result));
    } else if (command === 'publish') {
      console.log(JSON.stringify(await publishRelease()));
    } else {
      throw new Error('Usage: node scripts/trusted-publish.mjs verify|publish');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

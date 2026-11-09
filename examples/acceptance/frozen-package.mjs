import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha256 = data => createHash('sha256').update(data).digest('hex');
export function verifyFrozenPackage(tarball, expectedSha256) {
  if (typeof tarball !== 'string' || !tarball || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error('Real acceptance requires --tarball <frozen.tgz> --expected-sha256 <64 hex characters>; prepare the package separately.');
  }
  const file = resolve(tarball), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024) throw new Error('Acceptance tarball must be a regular file no larger than 100 MiB');
  const digest = sha256(readFileSync(file));
  if (digest !== expectedSha256.toLowerCase()) throw new Error('Frozen acceptance package SHA-256 does not match; no installation or external action was attempted');
  return { filename: basename(file), path: file, sha256: digest, bytes: stat.size };
}
export function installedManifest(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'js-superagent') throw new Error('Installed acceptance package has the wrong identity');
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Acceptance installation contains a symbolic link');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({ path: relative(root, file).split('\\').join('/'), bytes: stat.size, sha256: sha256(readFileSync(file)) });
    }
  }
  for (const part of ['src', 'bin', 'dist']) { const dir = join(root, part); if (existsSync(dir)) walk(dir); }
  if (!files.some(file => file.path === 'dist/core/index.js')) throw new Error('Frozen package is missing its compiled core');
  return { name: pkg.name, version: pkg.version, files, manifestSha256: sha256(JSON.stringify(files)) };
}
export function parseAcceptanceArgs(options = {}) {
  const result = nodeParseArgs({ ...options, options: { ...(options.options ?? {}), tarball: { type: 'string' }, 'expected-sha256': { type: 'string' }, output: { type: 'string' }, 'package-commit': { type: 'string' } } });
  const artifact = verifyFrozenPackage(result.values.tarball, result.values['expected-sha256']);
  if (!result.values.output) throw new Error('Real acceptance requires --output <new-directory> to retain evidence');
  result.values.tarball = artifact.path;
  if (result.values['package-commit'] !== undefined && !/^[a-f0-9]{40}$/.test(result.values['package-commit'])) throw new Error('--package-commit must be a full commit SHA');
  const output = resolve(result.values.output);
  const evidence = { schemaVersion: 1, kind: 'frozen-package-attestation', startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, packageCommit: result.values['package-commit'] ?? null, packageCommitSource: result.values['package-commit'] ? 'explicit-caller-manifest' : 'not-supplied', tarball: { name: artifact.filename, sha256: artifact.sha256, bytes: artifact.bytes }, status: 'prepared', installations: [] };
  const installationRoots = new Set([join(output, 'consumer/node_modules/js-superagent')]);
  const record = root => {
    const manifest = installedManifest(root); installationRoots.add(root);
    evidence.installations = [...installationRoots].filter(existsSync).map(installedManifest);
    evidence.status = 'installed';
    if (existsSync(output)) writeFileSync(join(output, 'artifact-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    return manifest;
  };
  process.once('exit', code => {
    if (!existsSync(output)) return;
    try {
      evidence.installations = [...installationRoots].filter(existsSync).map(installedManifest);
      evidence.completedAt = new Date().toISOString(); evidence.processExitCode = code;
      evidence.status = code === 0 && evidence.installations.length ? 'installed-run-exited-successfully' : 'failed-or-incomplete';
      // This attests the artifact and process only; scenario assertions live in acceptance.json.
      writeFileSync(join(output, 'artifact-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    } catch { process.exitCode = 1; }
  });
  result.artifact = Object.assign(artifact, { recordInstallation: record, registerInstallation: root => installationRoots.add(root), evidence,
    files: [], output });
  return result;
}
export function installFrozenPackage(artifact) {
  if (artifact.installed) return artifact.installed;
  // Install beside, not inside, the fixture: fixture creation can still reject an existing output path.
  mkdirSync(dirname(artifact.output), { recursive: true, mode: 0o700 });
  const consumer = mkdtempSync(join(dirname(artifact.output), '.js-superagent-acceptance-package-'));
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  verifyFrozenPackage(artifact.path, artifact.sha256);
  const result = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact.path], { cwd: consumer, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error('Frozen acceptance package installation failed');
  const root = join(consumer, 'node_modules/js-superagent');
  artifact.installed = root; artifact.consumer = consumer; artifact.files = artifact.recordInstallation(root).files;
  return root;
}
export async function importFrozenModule(artifact, path) {
  if (!/^(?:src|dist)\/[A-Za-z0-9_.\/-]+\.(?:mjs|js)$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid installed acceptance module');
  return import(pathToFileURL(join(installFrozenPackage(artifact), path)));
}

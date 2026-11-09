import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyFrozenPackage, installedManifest } from '../examples/acceptance/frozen-package.mjs';
const root = () => mkdtempSync(join(tmpdir(), 'superagent-artifact-test-'));
test('artifact mismatch fails before installation or real acceptance side effects', () => {
  const dir = root();
  try {
    const tarball = join(dir, 'fixture.tgz'), output = join(dir, 'result'); writeFileSync(tarball, 'fixture');
    const result = spawnSync(process.execPath, ['examples/real-repository-intake-smoke.mjs', '--write', '--tarball', tarball, '--expected-sha256', '0'.repeat(64), '--output', output, '--repository', 'owner/repo', '--actor', 'user', '--source', dir], { cwd: resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /does not match/); assert.equal(existsSync(output), false);
    assert.deepEqual(readdirSync(dir), ['fixture.tgz']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('artifact validates exact bytes and rejects linked inputs', () => {
  const dir = root();
  try {
    const path = join(dir, 'fixture.tgz'); writeFileSync(path, 'abc');
    const sha = createHash('sha256').update('abc').digest('hex');
    assert.equal(verifyFrozenPackage(path, sha).sha256, sha);
    writeFileSync(path, 'abcd'); assert.throws(() => verifyFrozenPackage(path, sha), /does not match/);
    symlinkSync(path, join(dir, 'linked.tgz')); assert.throws(() => verifyFrozenPackage(join(dir, 'linked.tgz'), sha), /regular file/);
    assert.throws(() => verifyFrozenPackage(path, undefined), /requires/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('manifest identifies runtime bytes, not merely the npm version', () => {
  const dir = root();
  try {
    mkdirSync(join(dir, 'dist/core'), { recursive: true }); mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'package.json'), '{"name":"js-superagent","version":"fixture"}');
    writeFileSync(join(dir, 'dist/core/index.js'), 'export {};'); writeFileSync(join(dir, 'src/index.mjs'), 'export const n=1;');
    const first = installedManifest(dir); writeFileSync(join(dir, 'src/index.mjs'), 'export const n=2;');
    assert.notEqual(installedManifest(dir).manifestSha256, first.manifestSha256);
    symlinkSync(join(dir, 'src/index.mjs'), join(dir, 'src/link.mjs')); assert.throws(() => installedManifest(dir), /symbolic link/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('every real acceptance loads the frozen contract and never repacks or imports worktree runtime source', () => {
  for (const name of readdirSync('examples').filter(name => /^real-.*-smoke\.mjs$/.test(name))) {
    const code = readFileSync(join('examples', name), 'utf8');
    assert.match(code, /acceptance\/frozen-package\.mjs/, name);
    assert.doesNotMatch(code, /\['pack'|from ['"]\.\.\/(?:src|dist)\//, name);
  }
});

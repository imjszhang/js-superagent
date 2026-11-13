import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifyRelease, publishRelease } from '../scripts/trusted-publish.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: 'js-superagent', version: '1.2.3-alpha.1', license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/imjszhang/js-superagent.git' },
    publishConfig: { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' },
  };
  const commit = 'a'.repeat(40);
  const env = {
    GITHUB_REPOSITORY: 'imjszhang/js-superagent', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit,
    EXPECTED_VERSION: pkg.version, GITHUB_ACTIONS: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-oidc',
  };
  const write = (name, data) => fs.writeFileSync(path.join(root, name), JSON.stringify(data));
  write('package.json', pkg);
  write('package-lock.json', { name: pkg.name, version: pkg.version, packages: { '': { version: pkg.version, license: 'MIT' } } });
  fs.mkdirSync(path.join(root, 'release'));
  fs.mkdirSync(path.join(root, 'package'));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  const archive = path.join(root, 'release', filename);
  function pack(packedPackage = pkg) {
    write('package/package.json', packedPackage);
    execFileSync('tar', ['-czf', archive, '-C', root, 'package'], { stdio: 'pipe' });
    const bytes = fs.readFileSync(archive);
    const manifest = {
      name: pkg.name, version: pkg.version, filename, sourceCommit: commit, sourceDirty: false,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, size: bytes.length,
    };
    write('release/manifest.json', manifest);
    return manifest;
  }
  const manifest = pack();
  const execFile = (file, args, options) => {
    if (file === 'git') return args[0] === 'rev-parse' ? `${commit}\n` : '';
    return execFileSync(file, args, options);
  };
  const published = { name: pkg.name, version: pkg.version, dist: { integrity: manifest.integrity } };
  return { root, env, execFile, pkg, manifest, archive, write, pack, published };
}

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function fetchSequence(items, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.ok(items.length, 'Unexpected extra registry read');
    const item = items.shift();
    if (item instanceof Error) throw item;
    return item;
  };
}
const publishOptions = f => ({ ...f, sleep: async () => {}, attempts: 2, intervalMs: 0 });

test('verifies the same clean source and actual packed package with safe output values', t => {
  const f = fixture(t);
  const release = verifyRelease(f);
  assert.equal(release.version, f.pkg.version);
  assert.equal(release.channel, 'alpha');
  assert.equal(release.filename, f.manifest.filename);
  assert.equal(release.integrity, f.manifest.integrity);
  assert.ok(!/[\r\n]/.test(`${release.filename}${release.version}${release.channel}`));
});

for (const [name, change, pattern] of [
  ['another repository', f => { f.env.GITHUB_REPOSITORY = 'other/js-superagent'; }, /must run/],
  ['a non-main ref', f => { f.env.GITHUB_REF = 'refs/heads/feature'; }, /must run/],
  ['a missing commit', f => { delete f.env.GITHUB_SHA; }, /invalid source commit/],
  ['an unexpected version', f => { f.env.EXPECTED_VERSION = '1.2.3-alpha.2'; }, /Expected version/],
  ['a different checkout', f => { f.env.GITHUB_SHA = 'b'.repeat(40); }, /Checkout does not match/],
  ['a dirty checkout', f => { const exec = f.execFile; f.execFile = (file, args, opts) => file === 'git' && args[0] === 'status' ? ' M README.md\n' : exec(file, args, opts); }, /checkout must be clean/],
  ['an artifact from another source', f => { f.write('release/manifest.json', { ...f.manifest, sourceCommit: 'b'.repeat(40) }); }, /clean workflow source/],
  ['a dirty artifact', f => { f.write('release/manifest.json', { ...f.manifest, sourceDirty: true }); }, /clean workflow source/],
  ['a traversing filename', f => { f.write('release/manifest.json', { ...f.manifest, filename: '../elsewhere.tgz' }); }, /filename/],
  ['an altered archive', f => { fs.appendFileSync(f.archive, 'tampering'); }, /integrity or size/],
  ['a different packed version with a matching manifest digest', f => { f.pack({ ...f.pkg, version: '1.2.3-alpha.0' }); }, /Packed package metadata/],
  ['an alpha package aimed at latest', f => { f.write('package.json', { ...f.pkg, publishConfig: { ...f.pkg.publishConfig, tag: 'latest' } }); }, /dist-tag/],
  ['a mismatched lockfile', f => { f.write('package-lock.json', { name: f.pkg.name, version: '1.2.3-alpha.0', packages: { '': { license: 'MIT', version: f.pkg.version } } }); }, /lock version/],
]) {
  test(`refuses ${name} before any publication`, t => {
    const f = fixture(t);
    change(f);
    assert.throws(() => verifyRelease(f), pattern);
  });
}

for (const [name, change] of [
  ['local execution', env => { env.GITHUB_ACTIONS = 'false'; }],
  ['missing OIDC', env => { delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; }],
  ['NODE_AUTH_TOKEN', env => { env.NODE_AUTH_TOKEN = 'traditional-token'; }],
  ['NPM_TOKEN', env => { env.NPM_TOKEN = 'traditional-token'; }],
]) {
  test(`refuses ${name} before registry access`, async t => {
    const f = fixture(t);
    change(f.env);
    await assert.rejects(publishRelease({ ...publishOptions(f), fetch: () => assert.fail('Registry must not be called'), spawn: () => assert.fail('Must not publish') }), /OIDC/);
  });
}

test('an already-published identical version is idempotent and does not read or move its old dist-tag', async t => {
  const f = fixture(t), calls = [];
  const result = await publishRelease({ ...publishOptions(f), fetch: fetchSequence([response(200, f.published)], calls), spawn: () => assert.fail('Must not publish twice') });
  assert.equal(result.status, 'already-published');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, `/js-superagent/${f.pkg.version}`);
});

test('refuses an existing version with different bytes', async t => {
  const f = fixture(t);
  await assert.rejects(publishRelease({ ...publishOptions(f), fetch: fetchSequence([response(200, { ...f.published, dist: { integrity: 'sha512-other' } })]), spawn: () => assert.fail('Must not overwrite') }), /differs/);
});

for (const [name, item] of [['registry HTTP 500', response(500)], ['registry transport failure', new Error('offline')], ['invalid registry JSON', { status: 200, ok: true, json: async () => { throw new Error('invalid JSON'); } }]]) {
  test(`${name} is not treated as version absence`, async t => {
    const f = fixture(t);
    await assert.rejects(publishRelease({ ...publishOptions(f), fetch: fetchSequence([item]), spawn: () => assert.fail('Unknown registry state must not publish') }));
  });
}

test('publishes only the verified tarball once, then waits for the exact version and channel', async t => {
  const f = fixture(t), mutations = [], reads = [];
  const result = await publishRelease({
    ...publishOptions(f), attempts: 3,
    fetch: fetchSequence([response(404), response(404), response(200, f.published), response(200, { alpha: '1.2.3-alpha.0' }), response(200, f.published), response(200, { alpha: f.pkg.version })], reads),
    spawn: (...args) => { mutations.push(args); return { status: 0 }; },
  });
  assert.equal(result.status, 'published');
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].slice(0, 2), ['npm', ['publish', f.archive, '--ignore-scripts', '--provenance', '--access', 'public', '--tag', 'alpha', '--registry', 'https://registry.npmjs.org/']]);
  assert.equal(mutations[0][2].env, f.env);
  assert.equal(reads[0].options.cache, 'no-store');
});

test('a client failure after registry acceptance is verified without repeating the mutation', async t => {
  const f = fixture(t);
  let mutations = 0;
  const result = await publishRelease({ ...publishOptions(f), fetch: fetchSequence([response(404), new Error('temporary read error'), response(200, f.published), response(200, { alpha: f.pkg.version })]), spawn: () => { mutations++; return { status: 1 }; } });
  assert.equal(result.status, 'published');
  assert.equal(mutations, 1);
});

test('registry processing timeout leaves an explicit uncertain outcome and never republishes', async t => {
  const f = fixture(t);
  let mutations = 0;
  await assert.rejects(publishRelease({ ...publishOptions(f), fetch: fetchSequence([response(404), response(404), response(404)]), spawn: () => { mutations++; return { status: 0 }; } }), /attempted once.*verification remains incomplete.*do not republish blindly/);
  assert.equal(mutations, 1);
});

test('publication verification rejects unexpected bytes immediately', async t => {
  const f = fixture(t);
  let mutations = 0;
  await assert.rejects(publishRelease({ ...publishOptions(f), fetch: fetchSequence([response(404), response(200, { ...f.published, dist: { integrity: 'sha512-wrong' } })]), spawn: () => { mutations++; return { status: 0 }; } }), /differs/);
  assert.equal(mutations, 1);
});

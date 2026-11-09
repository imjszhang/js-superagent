import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureGitHubPullHead } from '../src/runtime/github-head.mjs';
const sha = 'a'.repeat(40), repository = 'owner/repo';
function fixture({ present = false, origin = 'https://github.com/owner/repo.git', rewrite = '', changed = false, fetchFailure = false, revoked = false } = {}) {
  const calls = []; let reads = 0, fetches = 0;
  const channel = { async getPullRequest() { reads++; return { repository, number: 3, headRepository: repository, headSha: changed && reads > 1 ? 'b'.repeat(40) : sha, state: 'open', merged: false }; } };
  const git = async args => { calls.push(args); if (args[0] === 'cat-file') return { code: present ? 0 : 1, stdout: '' }; if (args[0] === 'remote') return { code: 0, stdout: origin }; if (args[0] === 'config') return { code: rewrite ? 0 : 1, stdout: rewrite }; if (args.includes('fetch')) { fetches++; return { code: fetchFailure ? 1 : 0, stdout: '' }; } if (args[0] === 'show-ref') return { code: fetchFailure ? 1 : 0, stdout: fetchFailure ? '' : sha }; if (args[0] === 'rev-parse') return { code: 0, stdout: sha }; return { code: 0, stdout: '' }; };
  return { calls, run: (enabled = true) => ensureGitHubPullHead({ projectRoot: '.', repository, pullNumber: 3, headSha: sha, channel, enabled, assertCurrent() { if (revoked && fetches) throw new Error('authorization revoked'); } }, { git, id: () => 'test-unique-owner' }) };
}
test('missing heads require explicit opt-in and only exact SHA is fetched to a private ref', async () => {
  const disabled = fixture(); await assert.rejects(disabled.run(false), /trusted operator must fetch/); assert.equal(disabled.calls.some(args => args.includes('fetch')), false);
  const f = fixture(); assert.equal((await f.run()).fetched, true);
  const fetch = f.calls.find(args => args.includes('fetch')); assert.ok(fetch.includes(`${sha}:refs/js-superagent/fetch/3/test-unique-owner`)); assert.ok(fetch.includes('--no-write-fetch-head'));
  assert.deepEqual(f.calls.at(-1), ['update-ref', '-d', 'refs/js-superagent/fetch/3/test-unique-owner', sha]);
  assert.equal(f.calls.some(args => args.includes('checkout') || args.includes('push')), false);
});
test('existing exact object avoids network fetch but still rechecks remote head', async () => {
  const f = fixture({ present: true }); assert.equal((await f.run()).fetched, false); assert.equal(f.calls.some(args => args.includes('fetch')), false);
  await assert.rejects(fixture({ present: true, changed: true }).run(), /changed/);
});
test('untrusted origin and URL rewrite cannot redirect a trusted fetch', async () => {
  await assert.rejects(fixture({ origin: 'https://example.test/repo.git' }).run(), /origin/);
  await assert.rejects(fixture({ rewrite: 'url.file:///tmp/attacker.insteadof https://github.com/' }).run(), /rewrite/);
});
test('head change, fetch failure and revoked ownership stop preparation and remove only owned reference', async () => {
  for (const setting of [{ changed: true }, { fetchFailure: true }, { revoked: true }]) {
    const f = fixture(setting); await assert.rejects(f.run()); assert.equal(f.calls.at(-1)[0], setting.fetchFailure ? 'show-ref' : 'update-ref'); if(!setting.fetchFailure)assert.equal(f.calls.at(-1).at(-1), sha);
  }
});

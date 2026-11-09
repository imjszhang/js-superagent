import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
function sameRepositoryOrigin(value, repository) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  return raw.toLowerCase() === `https://github.com/${repository}.git` || raw.toLowerCase() === `https://github.com/${repository}` ||
    raw.toLowerCase() === `git@github.com:${repository}.git` || raw.toLowerCase() === `ssh://git@github.com/${repository}.git`;
}
async function defaultGit(args, { projectRoot, signal }) {
  try { const result = await exec('git', ['-C', projectRoot, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, signal }); return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr }; }
  catch (error) { if (error.name === 'AbortError' || error.killed || !Number.isInteger(error.code)) throw new Error('PR head preparation was cancelled or exceeded its time budget'); return { code: error.code, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? '') }; }
}
/** Host-only opt-in preparation. No model supplied remote, ref, executable, or credential is accepted. */
export async function ensureGitHubPullHead({ projectRoot, repository, pullNumber, headSha, channel, enabled = false, signal, assertCurrent = () => {} }, { git = defaultGit, id = randomUUID } = {}) {
  if (typeof repository !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repository) || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || !SHA.test(headSha ?? '') || typeof channel?.getPullRequest !== 'function' || typeof enabled !== 'boolean') throw new Error('Invalid trusted PR head preparation request');
  repository = repository.toLowerCase(); projectRoot = resolve(projectRoot);
  const checkOwner = async () => { if (signal?.aborted) throw new Error('PR head preparation cancelled'); await assertCurrent(); };
  const command = async args => { await checkOwner(); return git(args, { projectRoot, signal }); };
  const requireSuccess = async args => { const r = await command(args); if (r.code !== 0) throw new Error('Trusted Git PR head preparation failed; inspect repository access'); return r.stdout; };
  const checkRemoteHead = async () => {
    await checkOwner(); const pull = await channel.getPullRequest(pullNumber); await checkOwner();
    if (pull.repository?.toLowerCase() !== repository || pull.headRepository?.toLowerCase() !== repository || pull.number !== pullNumber || pull.headSha !== headSha || pull.state !== 'open' || pull.merged) throw new Error('PR head or repository changed; review and rebind before execution');
  };
  await checkRemoteHead();
  const existing = await command(['cat-file', '-e', `${headSha}^{commit}`]);
  if (existing.code === 0) { await checkRemoteHead(); return { fetched: false, headSha, repository, pullNumber }; }
  if (!enabled) throw new Error('The PR head commit is unavailable locally. A trusted operator must fetch that commit before retrying, or enable trusted PR head preparation; the runtime will not fall back to HEAD');
  const origin = await requireSuccess(['remote', 'get-url', 'origin']);
  if (!sameRepositoryOrigin(origin, repository)) throw new Error('Configured Git origin does not match the allowed GitHub repository');
  const rewrites = await command(['config', '--get-regexp', '^url\\..*\\.insteadof$']);
  if (rewrites.code !== 0 && rewrites.code !== 1) throw new Error('Cannot verify Git URL rewrite configuration');
  const url = `https://github.com/${repository}.git`;
  for (const line of rewrites.stdout.split('\n').filter(Boolean)) {
    const at = line.search(/\s/); if (at < 0 || url.startsWith(line.slice(at).trim())) throw new Error('Git URL rewrite prevents trusted PR head preparation; fetch explicitly');
  }
  const nonce = id(); if (!/^[a-z0-9-]{8,80}$/i.test(nonce)) throw new Error('Invalid private PR preparation reference');
  const ref = `refs/js-superagent/fetch/${pullNumber}/${nonce}`;
  try {
    await requireSuccess(['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', url, `${headSha}:${ref}`]);
    if (await requireSuccess(['rev-parse', '--verify', `${ref}^{commit}`]) !== headSha) throw new Error('Fetched PR object does not match the authorized head');
    await checkRemoteHead();
    return { fetched: true, headSha, repository, pullNumber };
  } finally {
    // Delete only the private ref if it still points at this invocation's expected object.
    const current = await git(['show-ref', '--verify', '--hash', ref], { projectRoot });
    if (current.code === 1 && !current.stdout) { /* Fetch may fail before creating the owned ref. */ }
    else {
      if (current.code !== 0 || current.stdout !== headSha) throw new Error('Private PR preparation reference changed; manual inspection required');
      const cleanup = await git(['update-ref', '-d', ref, headSha], { projectRoot });
      if (cleanup.code !== 0) throw new Error('Private PR preparation reference changed; manual inspection required');
    }
  }
}

/** Resolve only a host-verified closed PR target; source text never supplies a git ref. */
export async function ensureGitHubContinuationBase({ projectRoot, source, strategy, channel, enabled = false, signal, assertCurrent = () => {} }, { git = defaultGit } = {}) {
  if (!source || !['target', 'previous-head'].includes(strategy) || source.state !== 'closed' ||
      source.merged && strategy !== 'target' || !sameRepositoryOrigin(`https://github.com/${source.repository}.git`, source.repository) ||
      !/^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/.test(source.repository)) throw new Error('Invalid continuation source');
  const sha = strategy === 'target' ? source.baseSha : source.headSha;
  const base = source.baseRef;
  if (!SHA.test(sha ?? '') || typeof base !== 'string' || !base || base.startsWith('-') || /[\s\0~^:?*\[\\]/.test(base)) throw new Error('Closed PR target branch is not verified');
  const check = async () => {
    signal?.throwIfAborted(); await assertCurrent();
    const fresh = await channel.getPullRequest(source.number);
    if (fresh.repository !== source.repository || fresh.number !== source.number || fresh.state !== 'closed' ||
        fresh.merged !== source.merged || fresh.headSha !== source.headSha || fresh.baseRef !== base ||
        strategy === 'target' && fresh.baseSha !== sha) throw new Error('Continuation source or target changed during preparation');
  };
  await check();
  const run = args => git(args, { projectRoot, signal });
  if ((await run(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
    if (!enabled) throw new Error('Continuation base is unavailable locally; fetch the verified commit or enable trusted head preparation');
    const origin = await run(['remote', 'get-url', 'origin']);
    if (origin.code !== 0 || !sameRepositoryOrigin(origin.stdout, source.repository)) throw new Error('Continuation Git origin does not match the configured repository');
    const rewrites = await run(['config', '--get-regexp', '^url\\..*\\.insteadof$']);
    if (rewrites.code !== 1 || rewrites.stdout) throw new Error('Continuation fetch requires an origin without URL rewrites; fetch explicitly');
    const ref = `refs/js-superagent/continuation/${randomUUID()}`;
    try {
      await check();
      const fetched = await run(['-c','protocol.file.allow=never','-c','protocol.ext.allow=never','fetch','--no-tags','--no-recurse-submodules','--no-write-fetch-head',`https://github.com/${source.repository}.git`,`${sha}:${ref}`]);
      if (fetched.code !== 0 || (await run(['rev-parse','--verify',`${ref}^{commit}`])).stdout !== sha) throw new Error('Continuation base fetch could not be verified');
    } finally {
      const saved = await git(['show-ref','--verify','--hash',ref], { projectRoot });
      if (saved.code === 0 && saved.stdout === sha) {
        if ((await git(['update-ref','-d',ref,sha], { projectRoot })).code !== 0) throw new Error('Continuation fetch ref cleanup requires inspection');
      } else if (saved.code !== 1 || saved.stdout) throw new Error('Continuation fetch ref changed; inspection required');
    }
  }
  await check();
  return { repository: source.repository, base, baseCommit: sha, strategy: strategy === 'target' ? 'target-branch' : 'previous-head' };
}

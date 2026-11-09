import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSessionHome } from '../src/drivers/codex-home.mjs';

const threadId = '019a3ade-2bd7-7001-a1a4-cdc82e4bf6ea';

test('a new Codex thread gets a project home and only a symlink to the account login', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-')));
  const accountHome = join(root, 'account-home');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(accountHome);
  writeFileSync(join(accountHome, 'auth.json'), 'do-not-copy-this-secret\n', { mode: 0o600 });
  writeFileSync(join(accountHome, 'config.toml'), 'model = "account-default"\n');
  const created = codexSessionHome({ sourceRoot: root, env: { CODEX_HOME: accountHome } });
  assert.equal(created.path.startsWith(join(stateDir(root), 'harness', 'codex-app-server', 'homes')), true);
  const link = join(created.path, 'auth.json');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), join(accountHome, 'auth.json'));
  assert.equal(readlinkSync(join(created.path, 'config.toml')), join(accountHome, 'config.toml'));
  created.bind(threadId);
  const resumed = codexSessionHome({ sourceRoot: root, sessionId: threadId, env: { CODEX_HOME: accountHome } });
  assert.equal(resumed.path, created.path);
  assert.equal(codexSessionHome({ sourceRoot: root, sessionId: '019a3ade-2bd7-7001-a1a4-cdc82e4bf6eb', env: { CODEX_HOME: accountHome } }), null);
});

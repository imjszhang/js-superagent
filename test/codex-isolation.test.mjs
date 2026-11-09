import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareCodexIsolation, recheckCodexIsolation, BLOCKED_CODEX_FEATURES } from '../src/drivers/codex-isolation.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

function fixture(t, { invalidName = false, unsupported = false, missingRole = false, ignoredRole = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'superagent-isolation-'));t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const executable = join(cwd, 'codex.mjs'), revision = join(cwd, 'revision');writeFileSync(revision, '1');
  let source = fakeCodexIsolationPrelude().replace('mcp_servers: {}', `mcp_servers: {
    ${JSON.stringify(invalidName ? 'not.a.safe.override.key' : 'user_fixture')}: {command:'/not-executed',env:{TOKEN:'fixture-secret-value'},enabled:!__isolationArgs.includes('mcp_servers.user_fixture.enabled=false')},
    project_fixture: {url:'https://fixture.invalid/?secret=fixture-secret-value',enabled:!__isolationArgs.includes('mcp_servers.project_fixture.enabled=false')}
  }`).replace("version:'fixture-v1'", `version:readFileSync(${JSON.stringify(revision)},'utf8')`);
  if (unsupported) source = source.replace('Object.entries(__isolationFeatureValues()).map', 'Object.entries(__isolationFeatureValues()).slice(1).map');
  if (missingRole) source = source.replace('Object.entries(__isolationFeatureValues()).map', "Object.entries(__isolationFeatureValues()).filter(([name])=>name!=='shell_tool').map");
  if (ignoredRole) source = source.replace('features: __isolationFeatureValues()', 'features: {...__isolationFeatureValues(),skip_host_skill_discovery:false}');
  writeFileSync(executable, `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';\n${source}\nwriteFileSync('unexpected-execution','bad');\n`, { mode: 0o700 });
  return { executable, cwd, env: { PATH: process.env.PATH }, revision };
}

test('isolation preserves model configuration in memory and only emits disabled safe MCP identities', async t => {
  const f = fixture(t);const policy = await prepareCodexIsolation(f);
  assert.deepEqual(policy.servers, ['project_fixture', 'user_fixture']);
  for (const feature of BLOCKED_CODEX_FEATURES) assert.ok(policy.args.some((value, index) => value === '--disable' && policy.args[index + 1] === feature));
  assert.ok(policy.args.includes('mcp_servers.project_fixture.enabled=false'));assert.ok(policy.args.includes('mcp_servers.user_fixture.enabled=false'));
  assert.doesNotMatch(JSON.stringify(policy), /fixture-secret-value|fixture\.invalid|TOKEN|not-executed/);
  await recheckCodexIsolation(f, policy);assert.equal(existsSync(join(f.cwd, 'unexpected-execution')), false);
});

test('changed configuration fingerprints reject execution and never reveal private configuration', async t => {
  const f = fixture(t), policy = await prepareCodexIsolation(f);writeFileSync(f.revision, '2');
  await assert.rejects(recheckCodexIsolation(f, policy), error => {
    assert.equal(error.code, 'JS_SUPERAGENT_CODEX_ISOLATION');assert.doesNotMatch(error.message, /fixture-secret-value|TOKEN/);return true;
  });
  assert.equal(existsSync(join(f.cwd, 'unexpected-execution')), false);
});

test('unsupported feature versions and unsafe override names fail closed before any execution', async t => {
  for (const input of [{unsupported:true},{invalidName:true}]) {
    const f=fixture(t,input);await assert.rejects(prepareCodexIsolation(f),/capability isolation is unsupported/);
    assert.equal(existsSync(join(f.cwd,'unexpected-execution')),false);
  }
});

test('coordinator role flags require explicit support and effective values rather than permissive argument parsing', async t => {
  const role={extraArgs:['--disable','shell_tool','--disable','skill_search','--enable','skip_host_skill_discovery'],requiredFeatures:{shell_tool:false,skill_search:false,skip_host_skill_discovery:true}};
  const good=fixture(t);const policy=await prepareCodexIsolation({...good,...role});assert.deepEqual(policy.requiredFeatures,role.requiredFeatures);await recheckCodexIsolation(good,policy);
  for(const options of [{missingRole:true},{ignoredRole:true}]){
    const bad=fixture(t,options);await assert.rejects(prepareCodexIsolation({...bad,...role}),/capability isolation/);
    assert.equal(existsSync(join(bad.cwd,'unexpected-execution')),false);
  }
  const worker=await prepareCodexIsolation(good);assert.deepEqual(worker.requiredFeatures,{});
});

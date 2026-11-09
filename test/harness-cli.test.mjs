import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli=fileURLToPath(new URL('../bin/js-superagent.mjs',import.meta.url));
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'js-superagent-harness-cli-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,run:(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',timeout:10_000})};
}

test('harness list and static doctor do not create project state or run a program',t=>{
  const {root,run}=fixture(t);
  const listed=run('harness','list');assert.equal(listed.status,0,listed.stderr);
  const entries=JSON.parse(listed.stdout);
  assert.deepEqual(entries.map(item=>item.id),['codex-app-server','dsh-sdk','cursor-agent']);
  const path=join(root,'target.json');writeFileSync(path,JSON.stringify({driver:'codex-app-server',executable:join(root,'does-not-exist')}));
  const checked=run('harness','doctor',path);assert.equal(checked.status,0,checked.stderr);
  const report=JSON.parse(checked.stdout);assert.equal(report.ok,true);assert.deepEqual(report.checks.map(item=>item.name),['configuration']);
  assert.equal(existsSync(stateDir(root)),false);
  const failed=run('harness','doctor',path,'--check-executable');assert.equal(failed.status,1,failed.stderr);
  assert.equal(JSON.parse(failed.stdout).ok,false);assert.equal(existsSync(stateDir(root)),false);
  for (const driver of ['codex', 'dsh-headless']) {
    writeFileSync(path, JSON.stringify({ driver }));
    assert.equal(run('harness', 'doctor', path).status, 1, driver);
  }
});

test('explicit metadata probe only runs the version command and does not expose its output',t=>{
  const {root,run}=fixture(t),executable=join(root,'fake-cli.mjs'),path=join(root,'target.json');
  writeFileSync(executable,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync('arguments.json',JSON.stringify(process.argv.slice(2)));console.log('private-version-output');\n`,{mode:0o700});
  writeFileSync(path,JSON.stringify({driver:'codex-app-server',executable}));
  const checked=run('harness','doctor',path,'--check-executable');assert.equal(checked.status,0,checked.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'arguments.json'),'utf8')),['--version']);
  assert.doesNotMatch(checked.stdout+checked.stderr,/private-version-output/);
  assert.equal(existsSync(stateDir(root)),false);
});

test('harness command rejects unknown drivers and misplaced probe options before initialization',t=>{
  const {root,run}=fixture(t),path=join(root,'target.json');writeFileSync(path,JSON.stringify({driver:'unknown-harness'}));
  for(const args of [['harness','doctor',path],['harness','doctor'],['harness','list','extra'],['harness','list','--check-executable'],['init','--check-executable']])assert.equal(run(...args).status,1,args.join(' '));
  assert.equal(existsSync(stateDir(root)),false);
});

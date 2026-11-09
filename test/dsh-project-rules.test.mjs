import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDshProjectRules } from '../src/drivers/dsh-project-rules.mjs';

function fixture(t) {
  const outer=mkdtempSync(join(tmpdir(),'js-dsh-rules-')),root=join(outer,'workspace');mkdirSync(root);
  writeFileSync(join(outer,'AGENTS.md'),'OUTSIDE_MUST_NOT_APPEAR');
  t.after(()=>rmSync(outer,{recursive:true,force:true}));
  const rule=(path,text)=>{mkdirSync(join(root,path),{recursive:true});writeFileSync(join(root,path,'AGENTS.md'),text);};
  return {root,outer,rule};
}

test('default loads only workspace root, not oversized or linked unrelated descendants',t=>{
  const {root,outer,rule}=fixture(t);rule('.','ROOT_INSTRUCTION');
  rule('research/archived-project','UNRELATED_TOO_LARGE'.repeat(5000));
  rule('packages/another','UNRELATED_PACKAGE');symlinkSync(outer,join(root,'outside-link'));
  // A scope that would reject immediately must not even be traversed at startup.
  mkdirSync(join(root,'research/unsafe'));symlinkSync(join(outer,'AGENTS.md'),join(root,'research/unsafe/AGENTS.md'));
  const rules=loadDshProjectRules(root);
  assert.deepEqual(rules.manifest.files.map(r=>[r.path,r.scope]),[['AGENTS.md','.']]);
  assert.equal(rules.manifest.version,2);assert.equal(rules.manifest.mode,'directory-chain');
  assert.equal(rules.manifest.loadedDirectory,'.');assert.equal(rules.manifest.descendantInstructions,'read-before-access');
  assert.match(rules.prompt,/ROOT_INSTRUCTION/);assert.doesNotMatch(rules.prompt,/OUTSIDE_MUST_NOT_APPEAR|UNRELATED_TOO_LARGE|UNRELATED_PACKAGE/);
  assert.match(rules.prompt,/Before reading, changing, or running work/);assert.match(rules.prompt,/not a recursive inventory/);
});

test('explicit directory loads root and each applicable ancestor in order, including future descendants',t=>{
  const {root,rule}=fixture(t);rule('.','ROOT');rule('packages','PACKAGES');rule('packages/agent','AGENT');rule('packages/agent/other','DEEPER_UNRELATED');
  const rules=loadDshProjectRules(root,{directory:'packages/agent/new/future'});
  assert.deepEqual(rules.manifest.files.map(r=>[r.path,r.scope]),[['AGENTS.md','.'],['packages/AGENTS.md','packages'],['packages/agent/AGENTS.md','packages/agent']]);
  assert.equal(rules.manifest.requestedDirectory,'packages/agent/new/future');assert.equal(rules.manifest.loadedDirectory,'packages/agent');
  assert.doesNotMatch(rules.prompt,/DEEPER_UNRELATED/);
  assert.ok(rules.manifest.files.every(file=>/^[a-f\d]{64}$/.test(file.sha256)&&!('text' in file)));
  assert.match(rules.prompt,/cannot expand host authorization/);
});

test('directory selection cannot escape the workspace or follow linked instruction scopes',t=>{
  const {root,outer,rule}=fixture(t);rule('.','ROOT');
  for(const directory of ['../outside','pkg/../../outside','/tmp','pkg//child','pkg/./child','pkg\\child','.git','node_modules/package','\0'])assert.throws(()=>loadDshProjectRules(root,{directory}),/workspace-relative/);
  symlinkSync(outer,join(root,'linked'));assert.throws(()=>loadDshProjectRules(root,{directory:'linked/new'}),/Unsafe project instruction directory/);
  writeFileSync(join(root,'file'),'not a directory');assert.throws(()=>loadDshProjectRules(root,{directory:'file'}),/Unsafe project instruction directory/);
  mkdirSync(join(root,'unsafe'));symlinkSync(join(outer,'AGENTS.md'),join(root,'unsafe/AGENTS.md'));
  assert.throws(()=>loadDshProjectRules(root,{directory:'unsafe'}),/Unsafe or oversized project instruction/);
});

test('the actual applicable instruction chain retains byte and file bounds',t=>{
  const {root,rule}=fixture(t);rule('.','x'.repeat(65537));assert.throws(()=>loadDshProjectRules(root),/oversized/);
  rule('.','x'.repeat(40000));rule('child','y'.repeat(30000));assert.throws(()=>loadDshProjectRules(root,{directory:'child'}),/64 KiB/);
  rule('.','ROOT');let path='';for(let i=0;i<128;i++){path+=`${path?'/':''}x`;rule(path,'rule');}
  assert.throws(()=>loadDshProjectRules(root,{directory:path}),/128 files/);
});

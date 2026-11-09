import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { normalizeUIEvidence, readUIEvidencePNG, uiTree, uiEvidenceRequired } from '../src/runtime/ui-evidence.mjs';

function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data){const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);result.write(type,4);data.copy(result,8);result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;}
function png(){const header=Buffer.alloc(13);header.writeUInt32BE(100);header.writeUInt32BE(100,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(40100))),chunk('IEND',Buffer.alloc(0))]);}

test('UI evidence reads real bounded PNGs and rejects damaged data or linked paths',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-ui-safety-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(stateDir(root),'ui-evidence');mkdirSync(directory,{recursive:true});const path=join(directory,'capture.png'),bytes=png(),options={projectRoot:root,path,viewport:{width:100,height:100}};
  writeFileSync(path,bytes);assert.deepEqual(readUIEvidencePNG(options),bytes);
  const damaged=Buffer.from(bytes);damaged[damaged.length-1]^=1;writeFileSync(path,damaged);assert.throws(()=>readUIEvidencePNG(options),/checksum/);
  writeFileSync(path,bytes);assert.throws(()=>readUIEvidencePNG({...options,viewport:{width:200,height:100}}),/viewport/);
  const external=join(root,'outside');mkdirSync(external);writeFileSync(join(external,'capture.png'),bytes);symlinkSync(external,join(directory,'linked'));
  assert.throws(()=>readUIEvidencePNG({...options,path:join(directory,'linked','capture.png')}),/symlink/);
  assert.throws(()=>readUIEvidencePNG({...options,path:join(external,'capture.png')}),/escapes/);
});

test('an untrusted legacy baseline cannot exempt existing UI from evidence; empty UI files remain valid source',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'js-ui-baseline-')));t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'view.css'),'');
  const workspace={path:root},settings=normalizeUIEvidence(),beforeTree=uiTree(workspace,settings);
  assert.equal(uiEvidenceRequired({beforeTree,baselineTrusted:true},workspace,settings),false);
  assert.equal(uiEvidenceRequired({beforeTree,baselineTrusted:false},workspace,settings),true);
  writeFileSync(join(root,'server.txt'),'backend');assert.equal(uiEvidenceRequired({beforeTree,baselineTrusted:true},workspace,settings),false);
});

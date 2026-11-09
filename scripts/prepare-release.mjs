import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const destination=path.join(root,'release');fs.mkdirSync(destination,{recursive:true});
// Run validation explicitly: npm lifecycle stdout can contaminate --json output.
execFileSync('npm',['run','prepack'],{cwd:root,stdio:'inherit'});
const [packed]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',destination],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','inherit']}));
const files=new Set(packed.files.map(x=>x.path));
for(const name of ['package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','THIRD_PARTY_LICENSES/dsh-superagent-prototype-LICENSE','src/index.mjs','src/index.d.ts','bin/js-superagent.mjs','dist/core/index.js','dist/core/index.d.ts'])if(!files.has(name))throw new Error(`Tarball missing ${name}`);
for(const name of files)if(/(^|\/)(?:node_modules|\.git|release|test|tests)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key|sqlite3?)(?:-|$)/.test(name))throw new Error(`Unexpected tarball member ${name}`);
const archive=path.join(destination,packed.filename),digest='sha512-'+createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
if(digest!==packed.integrity)throw new Error('Tarball integrity mismatch');
const manifest={name:packed.name,version:packed.version,filename:packed.filename,integrity:packed.integrity,shasum:packed.shasum,size:packed.size,unpackedSize:packed.unpackedSize,files:files.size,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),published:false};
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));

import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, relative, isAbsolute, dirname, resolve } from 'node:path';
import { normalizeVerificationProfile, runVerification, captureVerificationTree } from '../verification.mjs';
import { ensureProjectStateDirectory, projectStateDirectory } from '../state-paths.mjs';

const MAX_PNG_BYTES = 4 * 1024 * 1024, MAX_PIXELS_BYTES = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['.git','.js-superagent','node_modules','.venv','venv','dist','build','.cache','coverage']);
export function normalizeUIEvidence(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['mode','paths','capture','scenario','viewport','theme'].includes(k))) throw new Error('Invalid UI evidence settings');
  const next={mode:value.mode??'auto',scenario:value.scenario??'default',viewport:value.viewport??{width:1280,height:800},theme:value.theme??'light',paths:value.paths??[]};
  if(!['auto','required','off'].includes(next.mode)||typeof next.scenario!=='string'||!next.scenario.trim()||next.scenario.length>1000||!['light','dark','system'].includes(next.theme))throw new Error('Invalid UI evidence conditions');
  if(!next.viewport||Object.keys(next.viewport).some(k=>!['width','height'].includes(k))||!['width','height'].every(k=>Number.isSafeInteger(next.viewport[k])&&next.viewport[k]>=100&&next.viewport[k]<=8192))throw new Error('Invalid capture viewport');
  if(!Array.isArray(next.paths)||next.paths.length>100||next.paths.some(p=>typeof p!=='string'||!p||isAbsolute(p)||/[\\\0]/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..')))throw new Error('UI paths must be project-relative');
  if(value.capture)next.capture=normalizeVerificationProfile(value.capture);
  return next;
}
export function uiTree(workspace, settings) {
  if (realpathSync(workspace.path) !== workspace.path || !lstatSync(workspace.path).isDirectory()) throw new Error('UI workspace is not an owned real directory');
  const files=[];let count=0,bytes=0;
  function visit(path) {
    if(++count>50000)throw new Error('UI evidence tree exceeds its bound');
    const absolute=join(workspace.path,path),stat=lstatSync(absolute);
    if(stat.isDirectory()){if(realpathSync(absolute)!==absolute)throw new Error('UI directory became a symlink');for(const name of readdirSync(absolute).sort())if(!excluded.has(name))visit(path?`${path}/${name}`:name);return;}
    const selected=settings.paths.length?settings.paths.some(p=>path===p||path.startsWith(`${p}/`)):/\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i.test(path)||/(?:^|\/)(?:ui|views|components|pages)\//.test(path);
    if(!selected)return;
    if(stat.isSymbolicLink()||!stat.isFile())throw new Error('UI evidence requires regular files');
    bytes+=stat.size;if(bytes>64*1024*1024)throw new Error('UI evidence source exceeds its bound');
    files.push([path,hash(readRegular(absolute,64*1024*1024-bytes+stat.size,true))]);
  }
  visit('');return {digest:hash(JSON.stringify(files)),files:files.map(([path])=>path)};
}
export function uiEvidenceRequired(record, workspace, settings) {
  if(settings.mode==='off')return false;
  const current=uiTree(workspace,settings);
  return settings.mode==='required'||(record?.beforeTree && record.baselineTrusted!==false ? record.beforeTree.digest!==current.digest : current.files.length>0);
}
function readRegular(path, limit, allowEmpty = false) {
  if(realpathSync(dirname(path))!==dirname(path))throw new Error('Evidence parent became a symlink');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < (allowEmpty ? 0 : 1) || before.size > limit) throw new Error('Evidence must be a bounded regular file');
    const data = Buffer.alloc(before.size + 1); let offset = 0, count;
    while (offset < data.length && (count = readSync(fd, data, offset, data.length - offset, null))) offset += count;
    const after = fstatSync(fd);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Evidence changed while being read');
    return data.subarray(0, offset);
  } finally { closeSync(fd); }
}
function evidenceDirectory(projectRoot, create = false) {
  const root = realpathSync(projectRoot); let directory = create ? ensureProjectStateDirectory(root) : projectStateDirectory(root);
  for (const part of ['ui-evidence']) {
    directory = join(directory,part);
    if (create) try { mkdirSync(directory,{mode:0o700}); } catch(error) { if(error.code!=='EEXIST')throw error; }
    const stat=lstatSync(directory);
    if(!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory)!==directory)throw new Error('UI evidence directory must not contain symlinks');
  }
  return directory;
}
function evidencePath(projectRoot, path) {
  const base=evidenceDirectory(projectRoot), target=resolve(path), rel=relative(base,target);
  if(!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('../'))throw new Error('Capture escapes its evidence directory');
  let parent=dirname(target);
  while(parent!==base){const stat=lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(parent)!==parent)throw new Error('UI capture parent must not be a symlink');parent=dirname(parent);}
  const stat=lstatSync(target);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Capture must be a regular PNG');
  return target;
}
function crc32(buffer) {let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function png(path,viewport,expectedHash) {
  const data=readRegular(path,MAX_PNG_BYTES);
  if(expectedHash!==undefined&&hash(data)!==expectedHash)throw new Error('UI capture changed after its receipt');
  if(data.length<57||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Capture must produce a valid bounded PNG');
  let offset=8,header,ended=false,seenData=false,dataEnded=false,palette=false;const compressed=[];
  while(offset<data.length){
    if(offset+12>data.length)throw new Error('Truncated PNG chunk');
    const length=data.readUInt32BE(offset),end=offset+12+length;
    if(end>data.length)throw new Error('Truncated PNG data');
    const type=data.toString('ascii',offset+4,offset+8),body=data.subarray(offset+8,offset+8+length);
    if(!/^[A-Za-z]{4}$/.test(type)||crc32(data.subarray(offset+4,offset+8+length))!==data.readUInt32BE(offset+8+length))throw new Error('Invalid PNG chunk checksum');
    if(!header && type!=='IHDR')throw new Error('PNG header must be first');
    if(type==='IHDR'){
      if(header||length!==13)throw new Error('Invalid PNG header');
      header={width:body.readUInt32BE(0),height:body.readUInt32BE(4),depth:body[8],color:body[9]};
      const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(header.width!==viewport.width||header.height!==viewport.height||!depths[header.color]?.includes(header.depth)||body[10]!==0||body[11]!==0||body[12]!==0)throw new Error('Capture must match the configured non-interlaced PNG viewport');
    }else if(type==='PLTE'){if(palette||seenData||[0,4].includes(header.color)||!length||length%3||length>768||header.color===3&&length/3>2**header.depth)throw new Error('Invalid PNG palette');palette=true;}
    else if(type==='IDAT'){if(dataEnded||header.color===3&&!palette)throw new Error('Invalid PNG image data order');seenData=true;compressed.push(body);}
    else if(type==='IEND'){if(length||!seenData||end!==data.length)throw new Error('Invalid PNG ending');ended=true;}
    else {if(type[0]===type[0].toUpperCase())throw new Error('Unsupported critical PNG chunk');if(seenData)dataEnded=true;}
    offset=end;
  }
  if(!ended)throw new Error('PNG has no complete image');
  const channels={0:1,2:3,3:1,4:2,6:4}[header.color],rowBytes=Math.ceil(header.width*channels*header.depth/8),expected=(rowBytes+1)*header.height;
  if(expected>MAX_PIXELS_BYTES)throw new Error('PNG decoded image exceeds its bound');
  const decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected+1});
  if(decoded.length!==expected)throw new Error('PNG decoded data does not match its viewport');
  for(let y=0;y<header.height;y++)if(decoded[y*(rowBytes+1)]>4)throw new Error('Invalid PNG row filter');
  return {path,sha256:hash(data),bytes:data.length,data};
}
/** Shared capture/management read contract, including the same image byte budget. */
export function readUIEvidencePNG({projectRoot,path,viewport,sha256}) {
  const checked=png(evidencePath(projectRoot,path),viewport,sha256);
  return checked.data;
}
/** Only a trusted host capture profile can create a receipt; reports cannot assert one. */
export async function captureUIEvidence({projectRoot,workspace,settings,phase,signal,persistProcess}) {
  settings=normalizeUIEvidence(settings);
  if(!settings.capture)throw new Error('Configure delivery.uiEvidence.capture before starting UI work');
  if(!['before','after'].includes(phase))throw new Error('Invalid UI capture phase');
  const directory=join(evidenceDirectory(projectRoot,true),randomUUID());mkdirSync(directory,{mode:0o700});
  const output=join(directory,`${phase}.png`);
  const conditions={scenario:settings.scenario,viewport:settings.viewport,theme:settings.theme};
  const profile={...settings.capture,kind:'verify',env:{...settings.capture.env,JS_SUPERAGENT_CAPTURE_PATH:output,JS_SUPERAGENT_CAPTURE_PHASE:phase,JS_SUPERAGENT_CAPTURE_CONDITIONS:JSON.stringify(conditions)}};
  const treeBefore=captureVerificationTree({projectRoot,workspace,paths:profile.paths}),uiBefore=uiTree(workspace,settings);
  const result=await runVerification({projectRoot,workspace,profile,signal,persist:value=>persistProcess?.(value)});
  if(result.status!=='passed'||result.treeAfter.digest!==treeBefore.digest||uiTree(workspace,settings).digest!==uiBefore.digest)throw new Error(`UI capture ${result.status}; source must remain unchanged during capture`);
  const {data:_bytes,...image}=png(evidencePath(projectRoot,output),settings.viewport);
  return {phase,...image,uiTreeDigest:uiBefore.digest,conditions,conditionsDigest:hash(JSON.stringify(conditions)),profileDigest:hash(JSON.stringify(settings.capture)),
    treeDigest:treeBefore.digest,paths:profile.paths,verificationId:result.id,at:new Date().toISOString(),workspaceProvisionId:workspace.provisionId,baseCommit:workspace.baseCommit??null};
}
export function validateUIEvidence(record,{projectRoot,workspace,settings}) {
  settings=normalizeUIEvidence(settings);
  if(!uiEvidenceRequired(record,workspace,settings))return {status:'not-required'};
  const before=record?.before,after=record?.after;
  if(!before||!after)throw new Error('UI delivery incomplete: both Before and After host captures are required');
  const conditions=hash(JSON.stringify({scenario:settings.scenario,viewport:settings.viewport,theme:settings.theme}));
  if(before.conditionsDigest!==conditions||after.conditionsDigest!==conditions||before.profileDigest!==after.profileDigest||after.profileDigest!==hash(JSON.stringify(settings.capture))||before.workspaceProvisionId!==workspace.provisionId||after.workspaceProvisionId!==workspace.provisionId)throw new Error('UI capture conditions or workspace changed');
  if(before.phase!=='before'||after.phase!=='after'||before.uiTreeDigest!==record.beforeTree?.digest||record.baselineTrusted===false)throw new Error('UI Before baseline has no trusted pre-work source binding');
  if(JSON.stringify(record.settings?.paths??[])!==JSON.stringify(settings.paths)||uiTree(workspace,settings).digest!==after.uiTreeDigest)throw new Error('UI After capture is stale for the current UI source');
  for(const image of [before,after])readUIEvidencePNG({projectRoot,path:image.path,viewport:settings.viewport,sha256:image.sha256});
  if(captureVerificationTree({projectRoot,workspace,paths:after.paths}).digest!==after.treeDigest)throw new Error('UI After capture is stale for the current source');
  return {status:'complete',before,after};
}

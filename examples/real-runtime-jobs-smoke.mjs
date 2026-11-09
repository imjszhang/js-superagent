// Installed full runtime + real model-owned managed command and child delegation.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import { parseAcceptanceArgs as parseArgs } from './acceptance/frozen-package.mjs';
import {createHash} from 'node:crypto';
const { values, artifact } = parseArgs({options:{write:{type:'boolean'},tarball:{type:'string'},output:{type:'string'}}});
if(!values.write||!values.tarball||!values.output)throw new Error('Requires --write --tarball --output');
const output=resolve(values.output);if(existsSync(output))throw new Error('Use a new directory');mkdirSync(output,{recursive:true,mode:0o700});
const consumer=join(output,'consumer');mkdirSync(consumer);writeFileSync(join(consumer,'package.json'),'{"private":true,"type":"module"}');
const install=spawnSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',resolve(values.tarball)],{cwd:consumer,encoding:'utf8'});assert.equal(install.status,0,install.stderr);
const {createProjectAgent}=await import(pathToFileURL(join(consumer,'node_modules/js-superagent/src/index.mjs')));
const project=join(output,'project');mkdirSync(join(project,'src'),{recursive:true});writeFileSync(join(project,'src/example.txt'),'baseline\n');
writeFileSync(join(project,'AGENTS.md'),'Only change files inside src. No network, Git commits, external messages or credentials.\n');
const runtime=createProjectAgent({projectRoot:project,workspace:'copy'}).init();
runtime.configureExecutor({driver:'codex-app-server',enableManagedJobs:true,timeoutMs:240000},{expectedRevision:0});
runtime.configureJobs({paths:['src'],profiles:{
 check:{kind:'command',id:'check',version:'1',command:process.execPath,args:['-e',"const f=require('node:fs');if(f.readFileSync('src/example.txt','utf8')!=='baseline\\n')process.exit(1);console.log('Trusted command passed')"],environment:'host',allowHostExecution:true},
 helper:{kind:'agent',version:'1',instruction:'Replace src/example.txt with exactly child-runtime-verified followed by a newline, assert the content, and report ready.',paths:['src']}},childExecution:{driver:'codex-app-server'},limits:{maxJobs:4,maxActive:2,maxDepth:1,maxDurationMs:240000}},{expectedRevision:0});
const task=runtime.submit({text:'Use the managed job tools to start profile check and profile helper. For helper supply task text asking it to replace src/example.txt with child-runtime-verified followed by newline and verify it; narrow its paths to src. Wait for both jobs with job_wait and inspect their completion. Do not change the parent src/example.txt. Write src/parent.txt containing parent-runtime-verified after both succeed, then report ready. Do not perform either delegated job yourself.'});
const evidence={status:'running',startedAt:new Date().toISOString(),packageSha256:createHash('sha256').update(readFileSync(resolve(values.tarball))).digest('hex'),ticketId:task.id};
const save=()=>writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2));save();
try{
 const result=await runtime.runNext(); assert.equal(result.status,'completed',result.reports.at(-1)?.summary);
 const jobs=runtime.listJobs(task.id);assert.ok(jobs.length>=2&&jobs.length<=4);assert.ok(jobs.every(j=>['completed','handed-off'].includes(j.status)));assert.ok(jobs.some(j=>j.kind==='command'&&j.status==='completed'));assert.ok(jobs.some(j=>j.kind==='agent'&&j.status==='completed'));
 const parent=runtime.getWorkspace(task.id),child=jobs.find(j=>j.kind==='agent'&&j.status==='completed').workspace;
 assert.equal(readFileSync(join(parent.path,'src/example.txt'),'utf8'),'baseline\n');assert.equal(readFileSync(join(child.path,'src/example.txt'),'utf8'),'child-runtime-verified\n');
 assert.equal(readFileSync(join(parent.path,'src/parent.txt'),'utf8').trim(),'parent-runtime-verified');assert.equal(readFileSync(join(project,'src/example.txt'),'utf8'),'baseline\n');
 assert.equal(runtime.status().active,false);assert.equal(await runtime.runNext(),null);assert.equal(runtime.get(task.id).reports.length,1);
 evidence.status='passed';evidence.handedOffJobs=jobs.filter(j=>j.status==='handed-off').length;evidence.session=runtime.getSession(task.id);evidence.jobs=jobs.map(j=>({id:j.id,kind:j.kind,status:j.status,completion:j.completion}));evidence.checks=['real-native-tool-calls','host-command-completion','isolated-real-codex-child','parent-woken-once','no-extra-worker-turn','source-unchanged'];evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(evidence));
}catch(error){evidence.status='failed';evidence.error=String(error);evidence.jobs=runtime.listJobs(task.id);save();throw error;}finally{await runtime.stop();runtime.close();}

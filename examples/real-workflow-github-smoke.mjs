// Explicitly authorized small GitHub acceptance: one Issue, one draft PR, one follow-up.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseAcceptanceArgs,importFrozenModule} from './acceptance/frozen-package.mjs';
const {values,artifact}=parseAcceptanceArgs({options:{write:{type:'boolean'},close:{type:'boolean'},repository:{type:'string'},'app-config':{type:'string'},output:{type:'string'}}});
const {createProjectAgent}=await importFrozenModule(artifact,'src/index.mjs');
if(!values.write||!values.close||values.repository!=='imjszhang/js-superagent-acceptance'||!values['app-config']||!values.output)throw new Error('Pass --write --close --repository imjszhang/js-superagent-acceptance --app-config <file> --output <directory>');
if(!process.env.DEEPSEEK_API_KEY)throw new Error('Provide DEEPSEEK_API_KEY explicitly for this real DSH check');
const repository=values.repository,prefix=`repos/${repository}`,output=resolve(values.output),packageRoot=fileURLToPath(new URL('..',import.meta.url));
mkdirSync(output,{recursive:true});
const project=join(mkdtempSync(join(tmpdir(),'js-superagent-w6-github-')),'repository');
function run(command,args,cwd=packageRoot,input){const result=spawnSync(command,args,{cwd,input,encoding:'utf8',timeout:60000});if(result.error||result.status!==0)throw new Error(`${command} failed (${result.status}): ${result.stderr}`);return result.stdout;}
function api(endpoint,method='GET',body){return JSON.parse(run('gh',['api',endpoint,'--method',method,...(body?['--input','-']:[])],packageRoot,body?JSON.stringify(body):undefined)||'null');}
const actor=api('user').login,tag=`workflow-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,6)}`;
const app={...JSON.parse(readFileSync(resolve(values['app-config']),'utf8')).github.app,pullRequestComments:true};
const target='packages/js-superagent/examples/acceptance-target/diagnostic.mjs';
const evidence={version:1,tag,repository,actor,projectRoot:project,startedAt:new Date().toISOString(),source:{base:run('git',['rev-parse','HEAD']).trim(),hashes:{}},status:'running'};
for(const file of ['src/index.mjs','src/drivers/dsh.mjs','src/harness/registry.mjs','src/runtime/recovery.mjs'])evidence.source.hashes[file]=createHash('sha256').update(readFileSync(join(packageRoot,file))).digest('hex');
const save=()=>writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
const log=text=>console.log(`${new Date().toISOString()} ${text}`);
let runtime,issue,pull;save();
try{
 run('gh',['repo','clone',repository,project]);
 issue=api(`${prefix}/issues`,'POST',{title:`[js-superagent ${tag}] Small workflow acceptance`,body:`/js-superagent Update only ${target}. formatDiagnostic(input) must return an object with text equal to String(input).trim(). Preserve case. Keep all existing fields if any, and do not add new fields yet. Read back and verify the change. Do not modify scripts, workflow or AGENTS.md. Do not commit, push, open PRs or send messages; host verification and delivery owns those operations. Later feedback on this same formatting function stays within this task.`});
 evidence.issue={number:issue.number,url:issue.html_url};save();
 runtime=createProjectAgent({projectRoot:project}).init();
 runtime.configureV2({workspace:{mode:'worktree'},github:{repository,app,allowedActors:[actor],issues:[issue.number],pollIntervalMs:1000}});
 runtime.configureExecutor({driver:'dsh-sdk',model:process.env.JS_SUPERAGENT_DSH_MODEL??'deepseek-flash',timeoutMs:180000,backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://api.deepseek.com/anthropic',apiKeyEnv:'DEEPSEEK_API_KEY'}},{expectedRevision:0});
 runtime.configureDelivery({mode:'draft-pr',automatic:true,credentialMode:'native-gh',repository,base:'main',allowedPaths:[target],verify:{id:'host-fixture',version:'1',command:process.execPath,args:['scripts/host-verify.mjs'],paths:[target],environment:'host',allowHostExecution:true,timeoutMs:30000}},{expectedRevision:0});
 await runtime.syncGitHub();assert.equal(runtime.list().length,1);const ticketId=runtime.list()[0].id;evidence.ticketId=ticketId;save();
 log('Running DSH Issue task and host-owned draft delivery.');await runtime.runNext();
 let detail=runtime.getDetailed(ticketId);assert.equal(detail.verification?.status,'passed');assert.equal(detail.delivery?.state,'delivered');
 pull=detail.delivery.pullRequest;evidence.pull={number:pull.number,url:pull.url};evidence.session=runtime.getSession(ticketId);evidence.firstRun=runtime.get(ticketId).runId;save();
 assert.equal(api(`${prefix}/pulls/${pull.number}`).draft,true);
 const feedback=api(`${prefix}/issues/${pull.number}/comments`,'POST',{body:`Within the same authorized formatting task, add level: 'info' to the returned object in ${target}, preserving the trimmed text and exact case. Read the result back and verify. The host will update this same draft PR.`});
 evidence.feedback={id:feedback.id,url:feedback.html_url};save();
 await runtime.syncGitHub();assert.equal(runtime.list().length,1);
 log('Running related PR feedback on the original DSH session.');await runtime.runNext();detail=runtime.getDetailed(ticketId);
 assert.deepEqual(runtime.getSession(ticketId),evidence.session);assert.equal(detail.delivery?.state,'delivered');assert.equal(detail.delivery.pullRequest.number,pull.number);
 const workspace=runtime.getWorkspace(ticketId),module=await import(pathToFileURL(join(workspace.path,target)).href+'?'+Date.now());
 assert.deepEqual(module.formatDiagnostic('  Ready  '),{text:'Ready',level:'info'});
 evidence.secondRun=runtime.get(ticketId).runId;assert.notEqual(evidence.secondRun,evidence.firstRun);
 await runtime.flushNotifications();
 const receipts=runtime.notifications().filter(n=>n.channel.source==='github');
 assert.equal(new Set(receipts.map(n=>n.id)).size,receipts.length);evidence.receipts=receipts.map(n=>({id:n.id,status:n.status,kind:n.kind}));
 const comments=api(`${prefix}/issues/${pull.number}/comments?per_page=100`);evidence.resultComments=comments.filter(c=>c.user.type==='Bot').map(c=>({id:c.id,url:c.html_url}));assert.ok(evidence.resultComments.length>=1);
 const before=runtime.get(ticketId).reports.length;await runtime.syncGitHub();await runtime.runNext();assert.equal(runtime.get(ticketId).reports.length,before,'unchanged feedback must not rerun');
 evidence.status='passed';log('GitHub same-ticket continuation and result return passed.');
}catch(error){evidence.status='failed';evidence.error=String(error.stack??error);process.exitCode=1;console.error(error.message);}
finally{
 if(runtime){const own=runtime.list().flatMap(t=>t.pullRequests??[]).find(p=>p.own);if(!pull&&own){pull=own;evidence.pull={number:own.number,url:own.url};}await runtime.stop();runtime.close();}
 try{if(pull)api(`${prefix}/pulls/${pull.number}`,'PATCH',{state:'closed'});if(issue)api(`${prefix}/issues/${issue.number}`,'PATCH',{state:'closed'});evidence.cleanup={issueClosed:!!issue,pullClosed:!!pull,merged:false};}catch(error){evidence.cleanupError=String(error.message);process.exitCode=1;}
 evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:evidence.status,evidence:join(output,'acceptance.json'),issue:evidence.issue,pull:evidence.pull}));
}

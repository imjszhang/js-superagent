// Explicit W6 acceptance: one real Codex ticket and one real coordinator query.
// Foreground only; never starts/installs a service or writes to GitHub.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs({ options: { output: { type: 'string' }, project: { type: 'string' }, 'codex-path': { type: 'string' }, model: { type: 'string' } } });
const { createProjectAgent } = await importFrozenModule(artifact, 'src/index.mjs');
const { projectStateDirectory: stateDir } = await importFrozenModule(artifact, 'src/state-paths.mjs');
if(!values.output)throw new Error('Pass --output <new evidence directory>; this invokes the real Codex model.');
const output=resolve(values.output);if(existsSync(output))throw new Error('Preserve old evidence: choose a new output directory.');mkdirSync(output,{recursive:true,mode:0o700});
const packageRoot=fileURLToPath(new URL('..',import.meta.url));
const project=values.project?realpathSync(resolve(values.project)):realpathSync(mkdtempSync(join(tmpdir(),'js-superagent-w6-local-')));
const executable=values['codex-path']??'codex';
const paths=['src/index.mjs','src/coordinator.mjs','src/runtime/coordination.mjs','src/drivers/codex-app-server.mjs','src/runtime/reports.mjs','src/harness/registry.mjs'];
const hashes=()=>Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(join(packageRoot,path))).digest('hex')]));
const evidence={schemaVersion:1,status:'running',startedAt:new Date().toISOString(),projectRoot:project,source:{kind:'working-tree',baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:packageRoot,encoding:'utf8'}).trim(),sha256:hashes()},node:process.version,codex:execFileSync(executable,['--version'],{encoding:'utf8'}).trim(),model:values.model??'native configured default',realModel:true,serviceStarted:false,remoteOperations:false,steps:[]};
const save=()=>writeFileSync(join(output,'acceptance.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
const log=message=>console.log(`[workflow-local] ${message}`);
writeFileSync(join(project,'AGENTS.md'),'This is an isolated acceptance project. Follow only the authorized task. Do not modify .js-superagent or parent directories; do not commit, push, send messages, or start background services. The only requested result file is greeting.txt.\n');
const open=()=>createProjectAgent({projectRoot:project}).init();let runtime;
save();
try{
 runtime=open();assert.equal(runtime.list().length,0,'Acceptance project already has work; inspect it instead of creating another ticket.');runtime.configureV2({workspace:{mode:'copy'}});
 runtime.configureExecutor({driver:'codex-app-server',executable,timeoutMs:180000,...(values.model?{model:values.model}:{})},{expectedRevision:runtime.getExecutorSettings().revision});
 runtime.configureDelivery({mode:'local',automatic:true,verify:{id:'exact-greeting',version:'1',command:process.execPath,args:['-e',"const fs=require('node:fs');if(fs.readFileSync('greeting.txt','utf8')!=='Hello workflow\\n')throw Error('Unexpected greeting');console.log('Host exact-content assertion passed')"],paths:['greeting.txt'],timeoutMs:10000,environment:'host',allowHostExecution:true}},{expectedRevision:0});
 runtime.configureCoordinator({assessor:{driver:'codex-app-server',executable,timeoutMs:120000,...(values.model?{model:values.model}:{})},workflowMode:'continuous',policy:{mode:'off',rules:[],sourceRows:[]}},{expectedRevision:0});
 const ticket=runtime.submit({text:'Create greeting.txt containing exactly the greeting I choose, followed by one newline. First ask me which greeting to use; do not choose a greeting or create the file before I reply. After my reply write only that file, read it back to verify, and report ready. Do no other work.',scope:'Only greeting.txt in the isolated task workspace; ask for the missing greeting before writing and verify exact content after reply.'});
 evidence.ticketId=ticket.id;save();log('One Worker is asking for the missing greeting.');
 await runtime.runNext();const waiting=runtime.get(ticket.id),session=runtime.getSession(ticket.id),workspace=runtime.getWorkspace(ticket.id);
 assert.equal(waiting.status,'waiting');assert.ok(runtime.getDomainTicket(ticket.id).attention?.question);assert.equal(existsSync(join(workspace.path,'greeting.txt')),false);assert.equal(session.driver,'codex-app-server');
 evidence.steps.push({name:'real-worker-question',status:'passed',session,question:runtime.getDomainTicket(ticket.id).attention.question});save();
 const event=runtime.coordinate({id:'w6-status-query',text:'Report the current greeting task status and its unanswered question. Reply to this message only; do not create work, answer the question for me, add notes, request more worker status, stop anything, or change any ticket.'});
 log('One real coordinator query while the Worker waits.');await runtime.runNext();
 const coordinated=runtime.coordinationStatus().events.find(item=>item.id===event.id);assert.equal(coordinated.status,'completed',JSON.stringify(coordinated));assert.ok(coordinated.result.summary);assert.ok(coordinated.result.actions.every(action=>action.kind==='reply'));assert.equal(runtime.list().length,1);assert.equal(runtime.get(ticket.id).status,'waiting');assert.deepEqual(runtime.getSession(ticket.id),session);
 const db=new DatabaseSync(join(stateDir(project), 'state.sqlite'),{readOnly:true});let coordinatorSessions;try{coordinatorSessions=db.prepare("SELECT key,data FROM kv WHERE key LIKE 'coordinator:session:%'").all().map(row=>({key:row.key,session:JSON.parse(row.data)}));}finally{db.close();}
 assert.equal(coordinatorSessions.length,1);assert.equal(coordinatorSessions[0].session.driver,'codex-app-server-assessor');
 evidence.steps.push({name:'real-coordinator-query',status:'passed',eventId:event.id,result:coordinated.result,receipts:coordinated.receipts,sessions:coordinatorSessions});save();
 const notificationCount=runtime.notifications().length;await runtime.stop();runtime.close();runtime=undefined;
 runtime=open();assert.equal(runtime.coordinationStatus().events.find(item=>item.id===event.id).status,'completed');assert.equal(runtime.notifications().length,notificationCount);
 runtime.reply(ticket.id,'Use exactly: Hello workflow');log('Reopened host resumes the same Worker session, writes and verifies.');await runtime.runNext();
 const completed=runtime.get(ticket.id),detail=runtime.getDetailed(ticket.id);assert.equal(completed.status,'completed',JSON.stringify(completed));assert.deepEqual(runtime.getSession(ticket.id),session);assert.equal(readFileSync(join(runtime.getWorkspace(ticket.id).path,'greeting.txt'),'utf8'),'Hello workflow\n');assert.equal(detail.verification.status,'passed');assert.equal(runtime.list().length,1);
 evidence.steps.push({name:'real-reopen-reply-write-host-verify',status:'passed',session,workspace:runtime.getWorkspace(ticket.id).path,file:'greeting.txt',contentSha256:createHash('sha256').update('Hello workflow\n').digest('hex'),verification:detail.verification,reports:completed.reports});
 assert.equal(await runtime.runNext(),null);assert.equal(runtime.coordinationStatus().events.find(item=>item.id===event.id).attempts,1);
 evidence.status='passed';log('Local continuous workflow passed.');
}catch(error){evidence.status='failed';evidence.error=String(error.stack??error);process.exitCode=1;console.error(error.message);}
finally{if(runtime){await runtime.stop();runtime.close();}evidence.finishedAt=new Date().toISOString();evidence.source.sha256AtFinish=hashes();evidence.projectPreserved=true;save();console.log(JSON.stringify({status:evidence.status,evidence:join(output,'acceptance.json'),projectRoot:project}));}

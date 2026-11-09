// Run against one prebuilt artifact. Uses native Codex authentication and disposable local files only.
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const { values, artifact } = parseAcceptanceArgs({ options: { 'codex-path': { type:'string',default:'codex' }, model:{type:'string'}, 'hold-ms':{type:'string',default:'0'} } });
const holdMs=Number(values['hold-ms']);
if(!Number.isSafeInteger(holdMs)||holdMs<0||holdMs>600_000)throw new Error('--hold-ms must be 0..600000');
const root=resolve(values.output);
if(existsSync(root))throw new Error('Use a new output directory');
mkdirSync(root,{recursive:true,mode:0o700});
const projectRoot=join(root,'project');mkdirSync(projectRoot,{mode:0o700});
writeFileSync(join(projectRoot,'example.txt'),'source-original\n');
const {createProjectAgent,createCodexAppServerDriver}=await importFrozenModule(artifact,'src/index.mjs');
const {createManagementServer}=await importFrozenModule(artifact,'src/management.mjs');
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const url=`http://127.0.0.1:${port}/`;
const executable=values['codex-path'],model=values.model;
const evidence={version:1,startedAt:new Date().toISOString(),executableVersion:execFileSync(executable,['--version'],{encoding:'utf8'}).trim(),scenarios:[]};
const save=()=>writeFileSync(join(root,'acceptance.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
const events=[];
const driver=createCodexAppServerDriver({executable,...(model?{model}:{}),enableManagedJobs:true,timeoutMs:240_000,onEvent:event=>{if(event.method==='item/tool/call')events.push({tool:event.params?.tool,at:new Date().toISOString()});}});
const runtime=createProjectAgent({projectRoot,workspace:'copy',driver}).init();
let panel;
try {
  runtime.configureJobs({lifecycle:'assignment',childWorkspace:'parent-snapshot',paths:['example.txt'],profiles:{
    'child-change':{kind:'agent',version:'1',paths:['example.txt'],instruction:'Read example.txt. It must contain exactly parent-uncommitted followed by a newline. Append child-verified followed by a newline. Run an assertion on the exact two-line result. Only modify example.txt. Do not commit or publish.',timeoutMs:180_000},
    preview:{kind:'command',version:'1',command:process.execPath,args:['-e',`require('http').createServer((q,r)=>{r.setHeader('Content-Type','text/plain; charset=utf-8');r.end(require('fs').readFileSync('example.txt'))}).listen(${port},'127.0.0.1')`],environment:'host',allowHostExecution:true,timeoutMs:600_000,preview:{url,ttlMs:300_000}},
  },childExecution:{driver:'codex-app-server',executable,...(model?{model}:{}),timeoutMs:180_000}},{expectedRevision:0});
  runtime.configureDelivery({mode:'local',automatic:false,verify:{id:'exact-parent-file',version:'1',command:process.execPath,args:['-e',"const a=require('node:assert/strict');const s=require('node:fs').readFileSync('example.txt','utf8');a.ok(s.startsWith('parent-uncommitted\\n'));console.log('parent file verified')"],environment:'host',allowHostExecution:true}},{expectedRevision:0});
  const ticket=runtime.submit({text:'In this parent workspace write example.txt to exactly parent-uncommitted followed by a newline. Use js_superagent_job_start with child-change and paths ["example.txt"] to delegate the append to a child. Use js_superagent_job_wait to inspect completion. Do not copy the child output into the parent. Then return state waiting and ask "Adopt the isolated child diff?". Do not start the preview yet.',scope:'Only example.txt in isolated owned workspaces. Use the configured child-change and preview profiles only. No external writes or Git operations.'});
  evidence.ticketId=ticket.id;await runtime.runNext();
  const child=runtime.listJobs(ticket.id).find(job=>job.kind==='agent');assert.ok(child?.session,'Native child session must be persisted');assert.equal(child.status,'completed');
  const workspace=runtime.getWorkspace(ticket.id);assert.equal(readFileSync(join(workspace.path,'example.txt'),'utf8'),'parent-uncommitted\n');
  assert.equal(readFileSync(join(child.workspace.path,'example.txt'),'utf8'),'parent-uncommitted\nchild-verified\n');
  assert.equal(readFileSync(join(projectRoot,'example.txt'),'utf8'),'source-original\n');
  assert.ok(runtime.getDetailed(ticket.id).attention);assert.equal(runtime.getDomainTicket(ticket.id).ended,undefined);
  // A completion observed by the active parent must not trigger an unsolicited extra turn.
  assert.equal(await runtime.runNext(),null);
  const session=runtime.getSession(ticket.id);assert.ok(session?.id);
  assert.equal((await runtime.verifyTicket(ticket.id)).status,'passed');
  const plan=runtime.planChildAdoption(ticket.id,child.id);
  const adopted=await runtime.adoptChild(ticket.id,child.id,{expectedPlanDigest:plan.digest});assert.equal(adopted.status,'applied');
  assert.equal(runtime.getDetailed(ticket.id).verification.status,'invalidated');
  evidence.scenarios.push({name:'native-parent-snapshot-child-adoption',ticketId:ticket.id,session,childSession:child.session,childId:child.id,planDigest:plan.digest,adoptionId:adopted.id,parentUncommittedInherited:true,explicitAdoption:true,verificationInvalidated:true});save();

  runtime.reply(ticket.id,'The host explicitly adopted the reviewed child diff. Read example.txt and confirm both lines. Start the trusted preview profile using js_superagent_job_start, briefly wait for its endpoint to become ready, then call js_superagent_job_preview with that jobId and ttlMs 300000. Return waiting with the question "Does this preview look correct?". Keep the preview running for human review; do not wait for it to exit. Do not change files.');
  await runtime.runNext();
  assert.deepEqual(runtime.getSession(ticket.id),session);
  const preview=runtime.listJobs(ticket.id).find(job=>job.previewLease?.status==='active');assert.ok(preview,'Model must hand off a verified preview lease');
  assert.equal(await(await fetch(url)).text(),'parent-uncommitted\nchild-verified\n');
  assert.equal(runtime.get(ticket.id).status,'waiting');assert.equal(runtime.getDomainTicket(ticket.id).ended,undefined);assert.equal(runtime.schedulerStatus().active.length,0);
  const renewed=await runtime.jobControl(ticket.id,preview.id,{action:'renew',ttlMs:300_000});assert.equal(renewed.id,preview.previewLease.id);
  evidence.scenarios.push({name:'native-human-preview-no-pr',jobId:preview.id,url,leaseId:preview.previewLease.id,sameSession:true,assignmentRetained:true,workerSlotReleased:true,httpBodyMatched:true});save();
  if(holdMs){panel=await createManagementServer(runtime);writeFileSync(join(root,'browser-handoff.json'),JSON.stringify({url:panel.bootstrapUrl,previewUrl:url,ticketId:ticket.id,holdUntil:new Date(Date.now()+holdMs).toISOString()},null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify({phase:'browser-review',handoffFile:join(root,'browser-handoff.json'),holdMs})+'\n');await delay(holdMs);}
  const closed=await runtime.jobControl(ticket.id,preview.id,{action:'close'});assert.equal(closed.previewLease.status,'closed');
  await assert.rejects(fetch(url));
  for(const owner of closed.guardians)assert.throws(()=>process.kill(owner.pid,0),error=>error.code==='ESRCH');
  runtime.reply(ticket.id,'Preview accepted. The host has closed the preview process. Read and verify example.txt is exactly parent-uncommitted newline child-verified newline; report ready. Do not launch more jobs or change files.');
  await runtime.runNext();assert.equal(runtime.get(ticket.id).status,'completed');assert.deepEqual(runtime.getSession(ticket.id),session);
  assert.equal((await runtime.verifyTicket(ticket.id)).status,'passed');
  evidence.scenarios.push({name:'human-review-reply-cleanup-and-reverify',previewClosed:true,allOwnersExited:true,sameSession:true,completed:true});
  evidence.events=events;evidence.jobs=runtime.listJobs(ticket.id).map(job=>({id:job.id,status:job.status,profileId:job.profileId,session:job.session,completion:job.completion,previewLease:job.previewLease}));
  evidence.status='passed';evidence.completedAt=new Date().toISOString();save();
  process.stdout.write(JSON.stringify({status:'passed',evidencePath:join(root,'acceptance.json'),scenarios:evidence.scenarios.map(item=>item.name)})+'\n');
} catch(error){evidence.status='failed';evidence.error=String(error.message??error);evidence.tickets=runtime.list();evidence.events=events;save();throw error;}
finally{await panel?.close();await runtime.stop();runtime.close();}

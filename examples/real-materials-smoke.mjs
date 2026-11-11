// Explicit real-provider acceptance in disposable fictional projects. No service or publishing.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';

const args = parseAcceptanceArgs(), {createProjectAgent,inspectProjectIdentity} = await importFrozenModule(args.artifact,'src/index.mjs');
const principal={source:'local',id:'operator'}, root=realpathSync(mkdtempSync(join(tmpdir(),'material-acceptance-')));
const evidence={version:1,artifact:args.artifact.sha256,startedAt:new Date().toISOString(),root,scenarios:[],status:'running'};
mkdirSync(args.values.output,{recursive:true});
const save=()=>writeFileSync(join(args.values.output,'materials-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
const credential=process.env.JS_SUPERAGENT_API_KEY_ENV??'DEEPSEEK_API_KEY';
if(!process.env[credential])throw new Error('Configure the explicit real-provider credential before acceptance');
const executor={driver:'dsh-sdk',executable:process.env.JS_SUPERAGENT_DSH_EXECUTABLE??'dsh',model:process.env.JS_SUPERAGENT_DSH_MODEL??'deepseek-flash',
  backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://api.deepseek.com/anthropic',apiKeyEnv:credential},
  enableAgentTools:true,permission:'workspace-write',timeoutMs:180000,contextLimits:{maxReads:40,readBytes:128000}};
const agents=[];
function project(name, content='committed apple') {
  const path=join(root,name);mkdirSync(path);writeFileSync(join(path,'notes.md'),content);
  const git=(...a)=>execFileSync('git',['-C',path,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-m','fixture');
  const agent=createProjectAgent({projectRoot:path,workspace:{mode:'worktree'}}).init();agents.push(agent);
  agent.configureExecutor(executor,{expectedRevision:0});
  const entry=(id='project',project='self')=>({id,project,include:['notes.md'],exclude:[],views:['current','commit','snapshot'],readers:[principal],destinations:[principal]});
  agent.configureMaterials({entries:[entry()]},{expectedRevision:0});
  return {path,git,agent,entry};
}
async function run(f,text,materials) {
  const ticket=f.agent.submit({text,scope:text,materials,operatorNotifications:false,managedJobs:false});
  await f.agent.runNext();
  const result=f.agent.get(ticket.id);assert.equal(result.status,'completed',JSON.stringify(result));
  return {ticket,result,detail:f.agent.getDetailed(ticket.id)};
}
const prefix='Read the original task using js_superagent_read. Read authorized materials using its materials resource and host-minted directory/file references. Do not use native file or shell tools. ';
try {
  const current=project('current'),directory='notes',entryCount=320,targetPath='notes/plot-0317.md';
  mkdirSync(join(current.path,directory));
  for(let index=0;index<entryCount;index++) {
    const plot=String(index).padStart(4,'0');
    writeFileSync(join(current.path,directory,`plot-${plot}.md`),`Fictional orchard plot ${plot}: archived observation.\n`);
  }
  current.git('add','--',directory);current.git('commit','-m','fictional paginated material fixture');
  const committedTarget=readFileSync(join(current.path,targetPath),'utf8');
  // A per-run fictional value prevents a guessed or prompt-copied answer from passing.
  const dirtyTarget=`Fictional current observation ${randomUUID()}: uncommitted lime.\n`;
  writeFileSync(join(current.path,targetPath),dirtyTarget);
  current.agent.configureMaterials({entries:[{...current.entry(),include:[directory]}]},{expectedRevision:1});
  evidence.currentDirectoryFixture={directory,entries:entryCount,targetPath,targetSha256:createHash('sha256').update(dirtyTarget).digest('hex')};save();
  const a=await run(current,prefix+`The authorized ${directory}/ directory contains ${entryCount} fictional material files. Locate ${targetPath} by reading the host directory references. Continue directory pages using their returned nextOffset and the same version until this file's host-minted reference appears; do not guess record IDs. Read that file through its host reference, then report its relative path and exact current text.`,
    {sources:[{id:'project',view:{kind:'current'}}]});
  const currentReport=a.result.reports.at(-1).summary,observations=a.detail.materialObservations;
  assert.ok(currentReport.includes(targetPath),'Report must identify the requested relative material file');
  assert.ok(currentReport.includes(dirtyTarget.trim()),'Report must contain the actual per-run uncommitted file text');
  assert.equal(readFileSync(join(current.agent.getWorkspace(a.ticket.id).path,targetPath),'utf8'),committedTarget);
  const directoryReads=observations.filter(item=>item.descriptor?.sourceId==='project'&&item.descriptor.kind==='directory'&&item.descriptor.path===directory);
  const fileRead=observations.find(item=>item.descriptor?.sourceId==='project'&&item.descriptor.kind==='file'&&item.descriptor.path===targetPath);
  assert.ok(directoryReads.some(item=>item.page?.offset===0&&Number.isSafeInteger(item.page.nextOffset)),'Host observations must prove the directory exceeds its first page');
  assert.ok(directoryReads.some(item=>item.page?.offset>0),'Host observations must prove a later directory page was read');
  assert.ok(directoryReads.some(item=>item.page?.offset>0&&item.references?.some(ref=>ref.kind==='file'&&ref.path===targetPath)),
    'The requested file reference must have been minted by a later directory page');
  assert.equal(new Set(directoryReads.map(item=>item.valueVersion)).size,1,'Directory pagination must retain one fixed observed version');
  assert.ok(fileRead,'Host observations must include the requested file read');
  evidence.scenarios.push({name:'current-dirty-host-read',ticketId:a.ticket.id,observations:observations.length,
    ...evidence.currentDirectoryFixture,report:currentReport,directoryPages:directoryReads.map(({id,valueVersion,page})=>({id,valueVersion,page})),
    fileRead:{id:fileRead.id,valueVersion:fileRead.valueVersion,page:fileRead.page},status:'passed'});save();

  const fixed=project('fixed'), sha=fixed.git('rev-parse','HEAD');writeFileSync(join(fixed.path,'notes.md'),'frozen pear 842');
  fixed.agent.configureMaterials({entries:[fixed.entry('committed'),fixed.entry('frozen')]},{expectedRevision:1});
  // Snapshot identity includes its entry, so mint it after establishing the frozen entry.
  const frozen=fixed.agent.createMaterialSnapshot({sourceId:'frozen'});writeFileSync(join(fixed.path,'notes.md'),'later unrelated input');
  const b=await run(fixed,prefix+'Report notes.md separately from committed and frozen sources.',{sources:[{id:'committed',view:{kind:'commit',sha}},{id:'frozen',view:{kind:'snapshot',snapshotId:frozen.id}}]});
  assert.match(b.result.reports.at(-1).summary,/committed apple/);assert.match(b.result.reports.at(-1).summary,/frozen pear 842/);
  evidence.scenarios.push({name:'fixed-commit-and-snapshot',ticketId:b.ticket.id,snapshotId:frozen.id,status:'passed'});save();

  const edit=project('edit');writeFileSync(join(edit.path,'notes.md'),'dirty peach 953');
  // Include the output explicitly in the operator's source and application scope.
  edit.agent.configureMaterials({entries:[{...edit.entry(),include:['notes.md','result.md']}]},{expectedRevision:1});
  const request=edit.agent.submit({text:'Read the original task using js_superagent_read. First request js_superagent_prepare_workspace for materialId project and the current provisionId, reason: use current authorized input. Return waiting after the accepted request. After the host continues in the prepared workspace, read notes.md and create result.md containing exactly "Result: dirty peach 953" followed by a newline. Do not change notes.md or any other files. Return ready only after result.md exists.',
    scope:'Prepare the authorized current input, then write only result.md in the isolated copy.',materials:{access:'native',sources:[{id:'project',view:{kind:'current'}}],allowPreparation:true,allowApply:true},operatorNotifications:false,managedJobs:false});
  await edit.agent.runNext();assert.equal(edit.agent.workspacePreparationStatus(request.id)?.status,'queued');
  await edit.agent.runNext();assert.equal(edit.agent.get(request.id).status,'completed',JSON.stringify(edit.agent.get(request.id)));
  const detail=edit.agent.getDetailed(request.id),workspace=edit.agent.getWorkspace(request.id);
  assert.equal(workspace.generation,1);assert.equal(detail.workspaceHistory.length,1);
  assert.equal(readFileSync(join(workspace.path,'result.md'),'utf8'),'Result: dirty peach 953\n');
  assert.equal(existsSync(join(edit.path,'result.md')),false);
  evidence.scenarios.push({name:'same-ticket-preparation-and-worker-delta',ticketId:request.id,workspaceGeneration:workspace.generation,status:'passed'});save();

  edit.agent.configureDelivery({mode:'local',verify:{id:'fixture-verify',version:'fixture-verify-1',command:process.execPath,args:['-e',"if(require('node:fs').readFileSync('result.md','utf8')!=='Result: dirty peach 953\\n')process.exit(1)"],environment:'host',allowHostExecution:true,timeoutMs:10000}},{expectedRevision:0});
  const verification=await edit.agent.verifyTicket(request.id);assert.equal(verification.status,'passed');
  const plan=edit.agent.previewMaterialApplication(request.id,{paths:['result.md']});assert.deepEqual(plan.changes.map(change=>change.path),['result.md']);
  await edit.agent.applyMaterialChanges(request.id,{plan,operationId:'acceptance-apply'});
  assert.equal(readFileSync(join(edit.path,'notes.md'),'utf8'),'dirty peach 953');assert.equal(readFileSync(join(edit.path,'result.md'),'utf8'),'Result: dirty peach 953\n');
  evidence.scenarios.push({name:'host-verification-and-controlled-local-application',ticketId:request.id,verification:verification.status,status:'passed'});save();

  const one=project('joint-one','orchard north 164'),two=project('joint-two','orchard south 275');
  const identity=inspectProjectIdentity(two.path,two.agent.projectId);
  one.agent.configureMaterials({entries:[one.entry('north'),one.entry('south',{root:two.path,projectId:two.agent.projectId,instanceId:identity.instanceId})]},{expectedRevision:1});
  const e=await run(one,prefix+'Report the exact notes.md text from both north and south sources, labelled separately.',{sources:[{id:'north',view:{kind:'current'}},{id:'south',view:{kind:'current'}}]});
  assert.match(e.result.reports.at(-1).summary,/orchard north 164/);assert.match(e.result.reports.at(-1).summary,/orchard south 275/);
  evidence.scenarios.push({name:'authorized-cross-project-investigation',ticketId:e.ticket.id,status:'passed'});
  evidence.status='passed';
} catch(error) {evidence.status='failed';evidence.error=String(error.message);process.exitCode=1;}
finally {for(const agent of agents){await agent.stop();agent.close();}evidence.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:evidence.status,scenarios:evidence.scenarios,evidence:join(args.values.output,'materials-evidence.json'),...(evidence.error?{error:evidence.error}:{})}));}

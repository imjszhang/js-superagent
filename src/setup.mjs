import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readProjectConfig } from './config.mjs';
import { inspectProjectIdentity } from './project-identity.mjs';
import { createMachineCoordinator } from './machine-coordination.mjs';
import { createHarnessRegistry } from './harness/registry.mjs';
import { createGitHubChannel } from './channels/github.mjs';
import { createServiceManager } from './service.mjs';
import { feishuSdkAvailable } from './channels/feishu.mjs';
import { execFileSync } from 'node:child_process';
import { hasLegacyState, projectStateDirectory } from './state-paths.mjs';

function available(executable, root) {
  const candidates = executable.includes('/') ? [resolve(root, executable)] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, executable));
  return candidates.some(path => { try { accessSync(path, constants.X_OK); return lstatSync(realpathSync(path)).isFile(); } catch { return false; } });
}
function readable(path, root) {
  try { const file=resolve(root,path); if(!lstatSync(file).isFile())return false; accessSync(file,constants.R_OK); return true; } catch { return false; }
}

/** Read-only setup facts. Never initializes state, acquires execution, starts services or calls a model. */
export async function checkProjectSetup({ projectRoot, checkConnections = false } = {}, dependencies = {}) {
  if(typeof projectRoot!=='string'||typeof checkConnections!=='boolean')throw new Error('Setup requires projectRoot and a boolean checkConnections');
  const root=realpathSync(projectRoot),checks=[];
  const add=(id,scope,status,message,nextAction)=>checks.push({id,scope,status,message,...(nextAction?{nextAction}:{})});
  const finish=()=>{
    const readiness=Object.fromEntries(['local','github','service'].map(scope=>{
      const items=checks.filter(item=>item.scope===scope);
      return [scope,items.some(item=>item.status==='blocked')?'blocked':items.some(item=>item.status==='unchecked')?'needs-check':items.every(item=>item.status==='not-applicable')?'not-configured':'ready'];
    }));
    return {projectRoot:root,checkedAt:new Date().toISOString(),checkConnections,status:checks.some(item=>item.status==='blocked')?'blocked':checks.some(item=>item.status==='unchecked')?'needs-check':'ready',readiness,checks};
  };
  const [major,minor]=process.versions.node.split('.').map(Number);
  add('node','local',major>22||major===22&&minor>=13?'passed':'blocked','Requires Node.js 22.13 or newer.',major<22||major===22&&minor<13?'Install a supported Node.js before opening project state.':undefined);
  if(hasLegacyState(root)){
    add('project','local','blocked','Project state is still inside the project directory.','Stop the project and run project migrate-state --plan, then --apply.');return finish();
  }
  const state=projectStateDirectory(root);
  if(!existsSync(join(state,'config.json'))){
    add('project','local','blocked','Project is not initialized.','Run init in this project; initialization does not start a service.');return finish();
  }
  let config;
  try {config=readProjectConfig(root);add('configuration','local','passed','Project configuration is readable.');}
  catch {add('configuration','local','blocked','Project configuration is invalid or unreadable.','Inspect config.json and use config set with supported settings.');return finish();}
  const path=join(state,'state.sqlite');let schema=0;
  if(existsSync(path)){
    let db;
    try {
      if(!lstatSync(path).isFile())throw new Error('Unsafe state');
      db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');
      schema=Number(db.prepare('PRAGMA user_version').get().user_version);
      if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get()){
        const meta=key=>{const row=db.prepare('SELECT data FROM kv WHERE key=?').get(key);return row?JSON.parse(row.data):null;};
        config.execution=meta('executor:settings')?.execution??config.execution;
      }
      add('database','local',schema===14?'passed':'blocked',`Project database schema: ${schema}.`,schema===14?undefined:'Stop this project and use upgrade; do not bypass an unsupported schema.');
    }catch {add('database','local','blocked','Project database cannot be inspected safely.','Inspect project state and maintenance records before continuing.');}
    finally{db?.close();}
  }else add('database','local','blocked','Project database is missing.','Run init to prepare local state without starting work.');
  const machine=createMachineCoordinator({projectRoot:root,projectId:config.projectId},dependencies);
  try {
    const identity=inspectProjectIdentity(root,config.projectId);machine.assertWritable();
    add('identity','local',identity.initialized&&identity.matches?'passed':'blocked',identity.matches===false?'Project state belongs to a different location or identity.':identity.initialized?'Project identity matches.':'Local instance identity is missing.',identity.initialized&&identity.matches?undefined:'Use project inspect; copied state requires reinitialize or relocate, legacy state requires upgrade.');
    const overlaps=machine.overlapStatus().overlaps.filter(item=>item.active);
    add('directory-overlap','local',overlaps.length?'blocked':'passed',overlaps.length?'An overlapping project has live or unverified execution.':'No active overlapping project was found.',overlaps.length?'Use doctor to identify the owner; stop its work before executing here.':undefined);
    if(config.github){const owned=machine.repositoryBinding({repository:config.github.repository}).some(item=>item.projectRoot!==root);add('repository-ownership','github',owned?'blocked':'passed',owned?'Another local project owns this repository.':'No conflicting local repository ownership.',owned?'Inspect github binding status and explicitly release the old binding after settling its work.':undefined);}
  }catch {add('coordination','local','blocked','Project identity, maintenance or machine registration requires inspection.','Run project inspect and machine status; do not delete coordination records.');}
  finally{machine.close();}
  const registry=dependencies.harnessRegistry??createHarnessRegistry();
  let execution;
  if(!config.execution)add('executor-settings','local','blocked','No execution adapter is configured.','Use executor set to select a registered harness before submitting work.');
  else try{execution=registry.validateExecution(config.execution);add('executor-settings','local','passed',`Selected adapter: ${execution.driver}.`);}
  catch{add('executor-settings','local','blocked','Execution settings are invalid or require explicit migration.','Use executor status and executor set with a registered harness.');}
  if(execution){
    const launch=typeof registry.serviceLaunch==='function'?registry.serviceLaunch(execution,process.env):{executable:execution.executable,credentialEnvNames:[]};
    const executable=launch.executable??execution.executable;
    const present=(dependencies.executableAvailable??available)(executable,root);
    add('executor-program','local',present?'passed':'blocked',present?'Selected executable is available.':'Selected executable was not found.',present?undefined:'Install the executable or select its project-specific path with executor set.');
    if(launch.credentialEnvNames?.length){
      const ready=launch.credentialEnvNames.every(name=>process.env[name]);
      add('model-credential','local',ready?'passed':'unchecked','Model credential is referenced by environment variable; its value is never displayed.','For foreground use provide the configured variable; for background use configure the private service environment file.');
    }
    if(checkConnections&&present){
      try{
        const selected={...execution,executable:executable.includes('/')?resolve(root,executable):executable};
        const result=await registry.probeExecution(selected,{checkExecutable:true,timeoutMs:5000});
        add('executor-probe','local',result.ok?'passed':'blocked',result.ok?'Executable metadata checks passed; no model request was made.':'Executable metadata checks failed.','Use harness doctor for details; model/provider availability is not tested.');
        if(typeof registry.loginProbe==='function'){
          const login=await registry.loginProbe(selected,{execFileSync:dependencies.execFileSync??execFileSync,timeoutMs:5000});
          if(login)add(login.id,'local',login.status,login.message,login.nextAction);
        }
      }catch{add('executor-probe','local','blocked','Executable check failed or timed out.','Check the selected executable and login locally.');}
    }else add('executor-probe','local','unchecked','Executable compatibility/login has not been probed.','Run setup check --check-connections for metadata and read-only account checks.');
  }
  add('workspace','local',config.workspace.mode==='in-place'?'warning':'passed',`Workspace mode: ${config.workspace.mode}.`,config.workspace.mode==='in-place'?'Use config set --workspace auto for per-ticket isolation.':undefined);
  if(config.workspace.mode==='worktree'&&!existsSync(join(root,'.git')))add('workspace-git','local','blocked','Explicit worktree mode requires a Git checkout root.','Use a Git checkout root or choose copy/auto mode.');
  if(config.github){
    for(const [id,reference] of [['app-key',config.github.app],['webhook-secret',config.github.webhook]])if(reference){
      const file=reference.privateKeyPath??reference.secretPath,env=reference.privateKeyEnv??reference.secretEnv;
      add(id,'github',file?readable(file,root)?'passed':'blocked':process.env[env]?'passed':'unchecked',file?'Credential file readability checked; content not displayed.':'Credential uses an environment reference.',file?'Keep the credential file private and readable by the project service.':'Provide the configured variable locally; background Webhook/App configuration uses file references.');
    }
    if(checkConnections){try{const facts=await (dependencies.githubChannel??createGitHubChannel(config.github)).probe();add('github-access','github','passed',`Repository/account read checks passed for ${config.github.repository}.`);add('github-write-permissions','github',config.github.account?'passed':'unchecked',config.github.account?'Dedicated account repository write access was checked.':'Write permissions were not proven by read-only checks.','Verify App installation permissions for configured delivery/review actions; this check never posts a test message.');void facts;}catch{add('github-access','github','blocked','GitHub account/repository read checks failed.','Check the configured dedicated account or App installation, repository access and network.');}}
    else add('github-access','github','unchecked','Repository and account access have not been contacted.','Run setup check --check-connections for read-only GitHub checks.');
  }else add('github','github','not-applicable','GitHub is optional and not configured.');
  if(!config.feishu)add('feishu','local','not-applicable','Feishu is optional and not configured.');
  else {
    const secretFile=config.feishu.appSecretPath;
    add('feishu-secret','local',secretFile?readable(secretFile,root)?'passed':'blocked':process.env[config.feishu.appSecretEnv]?'passed':'unchecked',secretFile?'Feishu app secret file is readable; content is not displayed.':'Feishu app secret uses an environment reference.','Background service requires feishu.appSecretPath. Keep that file private to the service user.');
    add('feishu-sdk','local',feishuSdkAvailable()?'passed':'blocked',feishuSdkAvailable()?'Optional Feishu SDK is installed.':'@larksuiteoapi/node-sdk is not installed.','Install @larksuiteoapi/node-sdk before starting Feishu reception.');
    let rows=[];
    if(existsSync(path)){
      let db;
      try { db=new DatabaseSync(path,{readOnly:true}); const row=db.prepare('SELECT data FROM kv WHERE key=?').get('policy:current'); rows=row?JSON.parse(row.data).config?.sourceRows??[]:[]; }
      catch { rows=[]; }
      finally { db?.close(); }
    }
    const missing=config.feishu.chats.filter(chat=>!rows.some(row=>row.source==='feishu'&&row.scope?.tenantKey===config.feishu.tenantKey&&row.scope?.chatId===chat.chatId));
    add('feishu-policy','local',missing.length?'warning':'passed',missing.length?`These Feishu chats have no admission row and will not open tickets: ${missing.map(chat=>chat.chatId).join(', ')}.`:'Each configured Feishu chat has an admission row.','Add a policy source row with this tenantKey and chatId before expecting messages to become work.');
  }
  if((dependencies.platform??process.platform)==='darwin'){
    try{const manager=dependencies.serviceManager??createServiceManager({projectRoot:root});const status=manager.status();
      add('service-installation','service',status.installed?'passed':'not-applicable',status.installed?'Project service is installed.':'No background service is installed.','Use service install only when background operation is wanted; installation stays disabled.');
      if(status.installed){const health=manager.health();add('service-health','service',['setup-blocked','stalled','degraded'].includes(health.state)?'blocked':health.state==='unobserved'?'unchecked':'passed',`Service state: ${health.state}.`,'Use service health for current diagnostics; a manually stopped service stays stopped.');add('service-deployment','service','unchecked','An installed service may use a separately pinned package and credential environment.','Check service status installation paths and private environment references before an explicit deployment; source updates do not replace the installed package.');}
    }catch{add('service-installation','service','blocked','Service definition could not be inspected.','Use service status to inspect its ownership and installed files.');}
  }else add('service-installation','service','not-applicable','Built-in background installation currently supports macOS; foreground CLI/SDK remains available.');
  return finish();
}

import { createProjectAgent, checkProjectSetup, type OwnerControlReceipt, type ProjectSetupReport, createHarnessRegistry, createCodexAppServerDriver, createMachineCoordinator, createServiceManager, inspectProject, reinitializeProject, relocateProject, type ProjectConfig, type TicketStatus, type AgentDriver, type ManagedJobsSettings, type AgentDriverV2, type DriverCapabilities, type GitHubAppConfig, type PreviewLease, type PRReviewRequestRecord, type BotReviewBudgetRecord, type NativeHandoffRecord } from 'js-superagent';
// Freeze the old literal contracts: adding a new runtime capability must not widen these enums.
function legacyConfig(value: ProjectConfig): 1 { return value.concurrency; }
function legacyStatus(value: TicketStatus): string {
  switch (value) {
    case 'queued': case 'running': case 'waiting': case 'completed': case 'failed': case 'cancelled': case 'interrupted': return value;
    default: { const exhaustive: never = value; return exhaustive; }
  }
}
const modernDriver: AgentDriver = { reportVersion:2, async run() { return {version:2,state:'ready',summary:'done'}; } };
// @ts-expect-error Direct Driver injection has been retired; use the Harness registry.
const old = createProjectAgent({projectRoot:'/example',driver:modernDriver});
const registry=createHarnessRegistry({adapters:[{id:'example',version:'1',roles:['worker'],validate:options=>options,createDriver:()=>modernDriver}]});
const current = createProjectAgent({projectRoot:'/example',harnessRegistry:registry});
const onlineRecovery = current.configureRecovery({autoResume:false},{expectedRevision:0});
if ('operationId' in onlineRecovery) { const receipt:OwnerControlReceipt=onlineRecovery;void receipt; }
else { const revision:number=onlineRecovery.revision;void revision; }
const onlineSource=current.configureRepositorySource({streams:{issues:true}},{expectedRevision:0});
if ('operationId' in onlineSource) current.controlStatus(onlineSource.operationId);
const diagnosticPage = current.eventDiagnostics({source:'github',problemsOnly:true,limit:20});
const eventProblem:boolean|undefined = current.eventDiagnostic('event-id')?.problem;
current.replyDiagnostics({query:'locked',cursor:undefined}).items.map(reply=>reply.status);
void [diagnosticPage,eventProblem];
const settings: ManagedJobsSettings = {paths:['src'],profiles:{check:{kind:'command',id:'check',version:'1',command:'node',args:['--version'],environment:'host',allowHostExecution:true}}};
const revision: number = current.getJobsSettings().revision;
// The shared contract uses v2 reports; runtime capabilities stay explicit.
const legacyCapabilities:DriverCapabilities={reportVersion:2,structuredProgress:false,sessionResume:false,realtimeInput:false,inputAcknowledgements:false,backgroundTasks:false,subagents:false};
const app:GitHubAppConfig={appId:'123',installationId:456,privateKeyEnv:'APP_KEY',pullRequestComments:true,pullRequestReviews:true};
const scopedDriver:AgentDriverV2={reportVersion:2,capabilities:{agentTools:true,boundedContextVersion:1},async run(input){
  const records=input.agentTools?.contextResources()??[];
  const consumed=input.agentTools?.consumedRecords()??[];
  input.contextDelivered?.({records:consumed});
  if(input.agentTools&&input.session)await input.agentTools.call({callId:'read-1',name:'js_superagent_read',arguments:{resource:records[0]?.resource},sessionId:input.session.id,turnId:'turn-1'});
  if(input.session)input.observeExecutionState?.({version:1,driver:'codex-app-server',runId:input.runId,sessionId:input.session.id,sequence:0,state:'waiting',reason:'unknown',evidence:'codex-error-willRetry'});
  if(input.policySnapshot)input.checkpointNative?.({policy:{version:1,revision:input.policySnapshot.revision,digest:input.policySnapshot.digest,status:'selected'}});
  return {version:2,state:'waiting',summary:'Review the current scope',attention:{question:'Proceed?'}};
}};
const enhanced=createProjectAgent({projectRoot:'/example'});
enhanced.configureExecutor({driver:'codex-app-server',enableAgentTools:true,enableManagedJobs:true,contextLimits:{initialBytes:32768,pageBytes:8192,maxReads:16,readBytes:131072}},{expectedRevision:0});
createCodexAppServerDriver({enableAgentTools:true});
const persistentSettings:ManagedJobsSettings={...settings,lifecycle:'assignment',childWorkspace:'parent-snapshot',profiles:{preview:{kind:'command',id:'preview',version:'1',command:'node',args:['server.mjs'],environment:'host',allowHostExecution:true,preview:{url:'http://127.0.0.1:3000',ttlMs:1800000}}}};
const schema:14=enhanced.upgradeRuntime().schemaVersion;
const configSchema:3=enhanced.getConfigV2().schemaVersion;
// These consumer examples are typechecked only; they never execute a runtime.
function workflowActions() {
  enhanced.configureDelivery({mode:'draft-pr',review:{ready:true,requestReviewers:true,resolveThreads:true,reviewers:['alice'],teams:['maintainers']}},{expectedRevision:0});
  enhanced.configureRepositorySource({streams:{mentions:true,reviewComments:true}},{expectedRevision:0});
  const request:PRReviewRequestRecord=enhanced.requestPRReview('ticket',{kind:'requestReviewers',pullNumber:12,reviewers:['alice']});
  enhanced.requestPRReview('ticket',{kind:'finding',disposition:'declined',commentId:42,triggerId:'review-comment:42',reason:'Existing code already handles this case'});
  enhanced.requestPRReview('ticket',{kind:'resolveThread',commentId:42,triggerId:'review-comment:42',reason:'Fixed the reported condition'});
  const review:Promise<PRReviewRequestRecord|OwnerControlReceipt>=enhanced.runPRReview(request.id);
  const statuses:PRReviewRequestRecord[]=enhanced.reviewActionStatus('ticket');
  const budgets:BotReviewBudgetRecord[]=enhanced.botReviewStatus();
  const budget:BotReviewBudgetRecord=enhanced.setBotReviewBudget(12,'456',{remaining:1,reason:'Reviewed earlier rounds',expectedRevision:0});
  const associated:number=enhanced.associateBotReviewRun(12,'456',{eventIds:['original-event'],runId:'review-run',reason:'Confirmed original run'}).associated;
  const preview:Promise<NativeHandoffRecord|OwnerControlReceipt>=enhanced.controlNativePreview('ticket',{leaseId:'lease',jobId:'job',action:'renew',ttlMs:60000});
  // @ts-expect-error Resolving a thread requires its original trigger and repair reason.
  enhanced.requestPRReview('ticket',{kind:'resolveThread',commentId:42});
  // @ts-expect-error Native preview control cannot restart a missing process.
  enhanced.controlNativePreview('ticket',{leaseId:'lease',jobId:'job',action:'restart'});
  return {review,statuses,budgets,budget,associated,preview};
}
void workflowActions;

function multiProjectActions() {
  const machine = createMachineCoordinator();
  machine.setLimits({maxActiveExecutions:2});
  const limit:number|null = machine.status().limits.maxActiveExecutions;
  const projects = machine.listProjects();
  machine.overlapStatus().overlaps.map(project => [project.active, project.leases.map(lease => lease.guardianStates)]);
  const service = createServiceManager({projectRoot:'/example',mode:'webhook',port:'auto'});
  const ready:boolean = service.status().ready;
  const healthy:boolean = service.health().healthy;
  const patrol=service.patrol({recover:false});const notify:boolean=patrol.notify;void notify;
  const setup:Promise<ProjectSetupReport> = checkProjectSetup({projectRoot:'/example',checkConnections:false});
  const control:OwnerControlReceipt = enhanced.requestControl({requestId:'verify-once',method:'verifyTicket',args:['ticket']});
  const receipt:OwnerControlReceipt|null = enhanced.controlStatus(control.operationId);
  // @ts-expect-error Controls cannot run arbitrary SDK methods.
  enhanced.requestControl({requestId:'bad',method:'configureExecutor',args:[]});
  void [healthy,setup,receipt];
  const blocked:string|undefined = service.status().blocked?.code;
  enhanced.prepareExecution();
  enhanced.githubBindingStatus();
  enhanced.releaseGitHubBinding({apply:false,repository:'owner/repository'});
  inspectProject('/example');
  reinitializeProject({projectRoot:'/example',apply:false});
  relocateProject({projectRoot:'/new-path',fromRoot:'/example',mode:'rollback',apply:false});
  // @ts-expect-error Ports use auto or a numeric value.
  createServiceManager({port:'random'});
  // @ts-expect-error A relocation always identifies its original path.
  relocateProject({projectRoot:'/new-path'});
  return {limit,projects,ready,blocked};
}
void multiProjectActions;

const trace=enhanced.ticketTrace('ticket',{limit:25});
enhanced.ticketTrace('ticket',{cursor:trace.nextCursor??undefined});
enhanced.configureRecovery({retryBeforeStart:true,maxAttempts:2},{expectedRevision:enhanced.getRecoverySettings().revision});
enhanced.configurePrompts({sections:{communication:'Brief updates'},overrides:{'runtime/environment':'Environment: {variables}'},knowledge:[{id:'testing',title:'Checks',text:'Run project checks'}]},{expectedRevision:enhanced.promptStatus().settings.revision});
enhanced.configureRepositorySource({fetchPullHead:true},{expectedRevision:0});
enhanced.replaceSession('ticket',{reason:'Adopt current tools',expectedSessionId:enhanced.sessionStatus('ticket').session?.id??null,adoptCurrentSettings:true});
for(const incident of enhanced.getIncidents({includeResolved:false}))enhanced.acknowledgeIncident(incident.id,{expectedRevision:incident.revision});
enhanced.businessHealth().sources.map(source=>source.state);
enhanced.businessHealth().models.map(model=>[model.reason,model.provider,model.nextAt]);
enhanced.getDetailed('ticket').policyStatus?.desiredRevision;
enhanced.getDetailed('ticket').executionObservation?.state;
modernDriver.inspectRecovery?.({session:{driver:'codex-app-server',id:'native'},runId:'run',projectRoot:'/example',sourceProjectRoot:'/example',signal:new AbortController().signal,diagnostics:true,verifyHostTool:query=>query.name==='js_superagent_read'}).then(result=>{
  if(result?.safeToResume===false)result.pendingInputs?.pending.map(input=>input.inputId);
  else if(result?.outcome==='completed')result.report?.state;
});
enhanced.reevaluate('trigger');enhanced.requestStatus('ticket');
enhanced.jobControl('ticket','job',{action:'renew',ttlMs:60000});
enhanced.adoptChild('ticket','job',{expectedPlanDigest:enhanced.planChildAdoption('ticket','job').digest});
const lease:PreviewLease|undefined=enhanced.listJobs('ticket')[0]?.previewLease;
// @ts-expect-error A mutation cannot omit the reviewed adoption identity.
enhanced.adoptChild('ticket','job',{});
// @ts-expect-error Session replacement must explicitly identify the old native session.
enhanced.replaceSession('ticket',{reason:'replace'});
void [legacyConfig,legacyStatus,old,current,settings,revision,legacyCapabilities,app,scopedDriver,persistentSettings,schema,configSchema,lease];

// Current workflow management remains explicit and adapter-independent.
const managed=enhanced.managementStatus();
for(const thread of managed.threads)enhanced.unsubscribeThread(thread.thread,{expectedRevision:thread.revision});
for(const decision of managed.decisions)enhanced.dismissDecision(decision.decisionId,{expectedRevision:decision.revision});
enhanced.coordinate({text:'Apply this prompt change',management:{kind:'configure',target:'prompts',settings:{sections:{delivery:'Evidence'}},expectedRevision:0}});
enhanced.previewPrompts({sections:{delivery:'Draft'}},{expectedRevision:0}).draft.worker.text;
enhanced.jobControl('ticket','child',{action:'reply',text:'Use the existing interface',requestId:'reply-1'});
enhanced.configureDelivery({uiEvidence:{mode:'auto',paths:['src/ui'],viewport:{width:1280,height:800}}},{expectedRevision:0});
enhanced.getDetailed('ticket').uiEvidence?.after?.uiTreeDigest;
enhanced.readUIEvidenceImage('ticket','before');
// @ts-expect-error Coordinator management cannot configure an arbitrary execution command.
enhanced.coordinate({text:'Change it',management:{kind:'configure',target:'executor',settings:{},expectedRevision:0}});
// @ts-expect-error Explicit unlisted admission must use an actual enum value.
const invalidAdmission:import('js-superagent').AdmissionMatrix={unlistedAddressed:'automatic'};
void invalidAdmission;

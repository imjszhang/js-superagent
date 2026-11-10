import type { Ticket as DomainTicket, OutboundMessage } from '../dist/core/index.js';
export type ServiceMode = 'poll' | 'webhook';
export interface ServiceOptions {
  projectRoot?: string;
  /** poll runs serve; webhook runs github listen and retains polling. */
  mode?: ServiceMode;
  /** Webhook installation only: choose once and persist, or use an explicit stable port. */
  port?: number | 'auto';
  nodeExecutable?: string;
  cliPath?: string;
  homeDirectory?: string;
  /** Absolute private dotenv file; only required executor credential variables are loaded. */
  environmentFile?: string;
  /** Per log limit, with one rotated copy; 1024..104857600 bytes. */
  logMaxBytes?: number;
}
export interface ServiceStatus {
  installed: boolean;
  label: string;
  projectRoot: string;
  mode: ServiceMode;
  plistPath: string;
  manifestPath: string;
  environmentFile: string | null;
  logs: { stdout: string; stderr: string };
  logMaxBytes: number;
  loaded: boolean;
  running: boolean;
  /** Receipt from the current live CLI after listener and runtime startup. */
  ready: boolean;
  startupState: 'starting' | 'ready' | 'retrying' | 'blocked' | 'stopped';
  blocked: { code: string; message: string } | null;
  retryCount: number;
  webhookEndpoint: { host: string; port: number } | null;
  /** launchd wrapper PID. This is process state, not application health. */
  pid: number | null;
  childPid: number | null;
  lastExitCode: number | null;
}
export interface ServiceManager {
  /** Install only; a later start explicitly enables background execution. */
  install(): ServiceStatus;
  start(): ServiceStatus;
  /** Keep disabled across logins until start/restart. */
  stop(): ServiceStatus;
  restart(): ServiceStatus;
  status(): ServiceStatus;
  /** Read-only heartbeat and business health; never enables or restarts execution. */
  health(): ServiceHealth;
  /** One external check; persists only patrol diagnostics. Recovery is opt-in and never enables a stopped service. */
  patrol(options?:{recover?:boolean}):ServicePatrolResult;
  /** Remove the owned service while retaining project work and diagnostic logs. */
  uninstall(): ServiceStatus;
}
/** Explicit macOS user service management. Importing this module starts nothing. */
export function createServiceManager(options?: ServiceOptions): ServiceManager;
export interface ServiceHealth {
  state: 'not-installed'|'stopped'|'starting'|'retrying'|'setup-blocked'|'unobserved'|'stalled'|'degraded'|'paused'|'healthy';
  healthy: boolean;
  observedAt: string;
  lastHeartbeatAt: string|null;
  heartbeatAgeMs: number|null;
  staleAfterMs: number;
  reason: string|null;
  process: {pid:number|null;childPid:number|null;wrapperState:string|null;childState:string|null};
  business: {available:boolean;paused:boolean;machineReady:boolean;active:boolean;activeIncidents:number;modelWaits:number;sources:Array<{id:string;state:string;lastSuccess:string|null}>}|null;
}
export interface ServicePatrolResult {
  changed:boolean;notify:boolean;action:'observed'|'not-installed'|'busy'|'awaiting-confirmation'|'inspection-required'|'restarted';reason:string|null;observedAt:string;
  health:ServiceHealth;confirmations?:number;
}
export interface ProjectSetupReport {
  projectRoot:string;checkedAt:string;checkConnections:boolean;
  status:'blocked'|'needs-check'|'ready';
  readiness:Record<'local'|'github'|'service','blocked'|'needs-check'|'not-configured'|'ready'>;
  checks:Array<{id:string;scope:'local'|'github'|'service';status:'passed'|'blocked'|'unchecked'|'not-applicable'|'warning';message:string;nextAction?:string}>;
}
/** Inspects an existing project without initialization, execution or service changes. Optional connection checks call no model. */
export function checkProjectSetup(options:{projectRoot:string;checkConnections?:boolean}):Promise<ProjectSetupReport>;
export type OwnerControlMethod = 'jobControl'|'controlNativePreview'|'verifyTicket'|'deliverTicket'|'runPRReview'|'adoptChild'|'recoverChildAdoption'|'replaceSession'|'linkGitHubPullRequest'|'configureScheduler'|'configureRecovery'|'configureRepositorySource';
export interface OwnerControlRequest {requestId:string;method:OwnerControlMethod;args:unknown[]}
export interface OwnerControlReceipt {
  operationId:string;requestId:string;method:OwnerControlMethod;args:unknown[];
  status:'queued'|'running'|'completed'|'failed'|'unknown'|'cancelled';
  createdAt:string;startedAt?:string;completedAt?:string;result?:unknown;error?:{code:string;message:string};
}
export interface DiagnosticOptions {limit?:number;cursor?:string;query?:string;source?:string;problemsOnly?:boolean}
export interface ReplyDiagnostic {
  id:string;source:string;thread:string|null;ticketId:string|null;kind:string|null;
  status:'pending'|'failed'|'sent'|'dropped';text:string;textTruncated:boolean;
  attempts:number;nextRetryAt:string|null;reason:string|null;error:string|null;url:string|null;
  relation?:'direct'|'related';eventIds:string[];omittedEventIds:number;blockedBy?:string[];
}
export interface EventDiagnostic {
  id:string;source:string;at:string|null;url:string|null;actor:{source:string;id:string|null}|null;available:boolean;text:string;textTruncated:boolean;
  intake:{status:string;reason:string|null;outcomes:Array<{ticketId:string;status:string;reason:string|null}>};
  requests?:Array<{triggerId:string;evalId?:string|null;status:string;ticketId:string|null;failureKind?:string;code?:string;retryable?:boolean;attempts?:number;corrections?:number;retries?:number;message?:string;reason?:string}>;
  evaluation:{status:'decided'|'evaluating'|'pending'|'none'|'failed';assessment?:{evalId:string;status:string;failureKind:string|null;code:string|null;retryable:boolean;attempts:number|null;corrections:number;retries:number;message:string|null};decisions:Array<{id:string;kind:string;reason:unknown;at:string|null;ticketId:string|null}>;threads:Array<{key:string;status:string;evalId:string|null}>};
  tickets:Array<{ticketId:string;domainId:string;origin:boolean;fanout:boolean;context:boolean;acknowledged:boolean;handback:unknown;ended:unknown;inputs:Array<{id:string;kind:string;state:'pending'|'delivered'|'read'|'retired'|'unknown';at:string|null;readAt:string|null;deliveredAt:string|null}>}>;
  replies:ReplyDiagnostic[];problem:boolean;omitted:Record<'threads'|'decisions'|'tickets'|'inputs'|'replies'|'outcomes',number>;
}
export interface DiagnosticPage<T> {items:T[];total:number;nextCursor:string|null;summary:Record<string,number>}
export interface ProjectInstanceIdentity {
  schemaVersion: 1;
  projectId: string;
  instanceId: string;
  stateId: string;
  registryId?: string;
  projectRoot: string;
  createdAt: string;
  relocatedAt?: string;
}
export interface ProjectIdentityInspection {
  initialized: boolean;
  projectRoot: string;
  projectId: string;
  instanceId?: string;
  stateId?: string;
  registryId?: string;
  currentRoot?: string;
  matches?: boolean;
  legacyState?: boolean;
}
export interface MachineLimits { maxActiveExecutions: number | null }
export interface ProjectDirectoryOverlap {
  instanceId: string;
  projectId: string;
  projectRoot: string;
  active: boolean;
  leases: Array<{ kind: string; ownerState: string; guardianStates: string[] }>;
  slots: Array<{ key: string; kind: string; ownerState: string; guardianStates: string[] }>;
}
export interface MachineStatus {
  initialized: boolean;
  protocolVersion: number | null;
  directory: string;
  limits: MachineLimits;
  leases: Array<Record<string, unknown> & { instanceId: string; kind: string; epoch: number; ownerState: string }>;
  slots: Array<Record<string, unknown> & { instanceId: string; key: string; kind: string; active: boolean; ownerState: string }>;
}
export interface GitHubRepositoryOwnership {
  host: string;
  repository: string;
  repositoryId: number | string | null;
  instanceId: string;
  projectRoot: string;
}
export interface RegisteredProject extends ProjectInstanceIdentity {
  registeredAt: number;
  repositories: Array<{ host: string; repository: string; repositoryId: number | string | null }>;
  ports: Array<{ host: string; port: number }>;
}
/** Per-user metadata only; construction/status do not initialize the machine store. */
export interface MachineCoordinator {
  status(): MachineStatus;
  inspect(): MachineStatus & { identity: ProjectIdentityInspection | null };
  listProjects(): RegisteredProject[];
  /** Read-only registered directory overlaps; active includes unverified owners. */
  overlapStatus(): { projectRoot: string | null; overlaps: ProjectDirectoryOverlap[] };
  setLimits(settings: Partial<MachineLimits>): MachineLimits;
  repositoryBinding(options?: { repository?: string; repositoryId?: number; host?: string }): GitHubRepositoryOwnership[];
  close(): void;
}
export function createMachineCoordinator(options?: { projectRoot?: string; projectId?: string }): MachineCoordinator;
export function inspectProjectIdentity(projectRoot: string, projectId: string): ProjectIdentityInspection;
export interface RuntimeMachineStatus extends MachineStatus {
  readOnly: boolean;
  ready: boolean;
  identity: ProjectIdentityInspection | null;
  waiting: Array<{ key: string; kind: string; since: string }>;
  failure: string | null;
  githubIdentity: { verified: boolean; checkedAt: number | null; expiresAt: number | null } | null;
}
export interface ProjectMaintenanceResult {
  operation: string;
  applied: boolean;
  projectRoot: string;
  fromRoot?: string;
  phase: string;
  blockers: unknown[];
  actions: unknown[];
  identity?: ProjectInstanceIdentity | ProjectIdentityInspection | null;
  backup?: string | Record<string, unknown>;
  requiresInspection?: unknown;
  service?: Record<string, unknown> | null;
  [key: string]: unknown;
}
/** Inspect identity/database/maintenance facts without initializing or upgrading. */
export function inspectProject(projectRoot: string): Record<string, unknown>;
/** Explicitly archive state and establish a new project; default is a read-only plan. */
export function reinitializeProject(options: { projectRoot: string; apply?: boolean }): Promise<ProjectMaintenanceResult>;
/** Preserve the original identity; unsupported native sessions require explicit replacement. */
export function relocateProject(options: { projectRoot: string; fromRoot: string; apply?: boolean; mode?: 'resume' | 'rollback' }): Promise<ProjectMaintenanceResult>;
export type TicketStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Report {
  status: 'completed' | 'waiting' | 'failed' | 'interrupted';
  summary: string;
  artifacts?: string[];
  runId: string;
  at: string;
}
export interface TicketMessage {
  text: string;
  at: string;
  triggerId?: string;
  /** Preserved in public history, excluded from later Driver snapshots. */
  superseded?: { reason: string; at: string; eventId: string };
}
export interface Ticket {
  id: string;
  projectId: string;
  text: string;
  /** Original authorized scope; follow-up messages do not amend this field. */
  scope: string;
  status: TicketStatus;
  /** Ready work with an open current PR; legacy status remains compatible. */
  awaitingReview?:boolean;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  cancelRequested: boolean;
  owner?: { pid: number; host: string };
  messages: TicketMessage[];
  reports: Report[];
  source?: { type: 'github'; repository: string; issueNumber: number; pullNumber?:number; url: string };
  pullRequests: GitHubPullRequestBinding[];
}
export interface DriverSession {
  driver: string;
  id: string;
}
/** Shared input for registered adapters; direct Driver injection is not supported. */
/** Optional host ownership contract; supported only by verified native versions. */
export interface NativeHandoffRecord {
  version:1;id:string;driver:string;nativeVersion:string;ticketId:string;assignmentId:string;originRunId:string;
  session:DriverSession;cwd:string;configDigest:string;deadlineAt:string;guardianPids:number[];jobIds:string[];
  reportBoundary:{state:'waiting'|'blocked'|'failed'|'ready';assistantSequence:number;terminalSequence:number;question?:string|null};
  status?:'holding'|'resuming'|'closing'|'completed'|'interrupted'|'transferred';
  previews?:NativePreviewRecord[];settledJobIds?:string[];owner?:{pid:number;host:string;token:string};
  results?:NativeHandoffEvent[];consumedJobIds?:string[];consumedRunId?:string;consumedAt?:string;reason?:string|null;updatedAt?:string;
}
export interface NativePreviewRecord {
  jobId:string;profileId:string;url:string;commandPid:number;guardianPid:number;expiresAt:string;
  endpoint:{url:string;checkedAt:string;status:number;listeners:Array<{pid:number;birth?:string}>};
}
export type NativeHandoffEvent = {type:'settled';job:{id:string;[key:string]:unknown};output:{chunks:Array<{at:number;channel:string;text:string;gapBefore?:boolean}>;total:number;earliest:number;truncated:boolean}} | {type:'failed';jobId:string;reason:string};
export interface NativeHandoffControl {
  renewPreview?(input:{jobId:string;ttlMs?:number}):Promise<NativeHandoffRecord>;
  resume(input:DriverRunInput):Promise<unknown>;close(reason?:string):Promise<void>;closed:Promise<unknown>;snapshot():unknown;
}
export interface NativeHandoffHost {
  current?:{record:NativeHandoffRecord;control:NativeHandoffControl};
  hold(record:NativeHandoffRecord,control:NativeHandoffControl):boolean|Promise<boolean>;
  update(id:string,event:NativeHandoffEvent):void|Promise<void>;
}
export interface DriverRunInput {
    nativeHandoff?:NativeHandoffHost;nativeHandoffResults?:NativeHandoffRecord[];
    /** Actual execution directory; equals sourceProjectRoot for in-place tasks. */
    projectRoot: string;
    sourceProjectRoot?: string;
    workspace?: Workspace;
    /** Host credential names to remove from subprocess environments. Custom drivers are trusted to honor this boundary. */
    redactedEnvironmentKeys?: string[];
    ticket: Ticket; runId: string; assignmentId: string; domainTicket: DomainTicket; signal: AbortSignal;
    /** Saved before cancellation or process loss; resumption still requires an authorized turn. */
    session?: DriverSession;
    /** Persist a native session immediately. Rejects callbacks from stopped or superseded turns. */
    checkpoint(session: DriverSession): void;
    /** Register each owner before it starts external work. Cumulative and idempotent; every registered process must exit before settling. */
    registerProcess(pid: number): void;
    /** Persist bounded, non-secret native facts such as scoped project-rule hashes. */
    checkpointNative?(facts:Record<string,unknown>):void;
    /** Host-selected per-run business policy; never changes the fixed adapter binding or permissions. */
    policySnapshot?:WorkerPolicySnapshot|null;
    /** Trusted native protocol facts only. Heartbeats and model prose are not wait evidence. */
    observeExecutionState?(event:ExecutionStateEvent):void;
    /** Save a host tool result before returning it to the native harness. */
    recordHostTool?(receipt:HostToolReceipt):void|Promise<void>;
    /** Synchronous, read-only comparison against durable host receipts. */
    verifyHostTool?(query:HostToolVerification):boolean;
    /** Only a verified recovery proof may supply this; supported DSH rc.5/alpha.2 releases refuse pending-queue adoption. */
    adoption?:NativeInputAdoption;
}
export type WorkspaceMode = 'in-place' | 'auto' | 'worktree' | 'copy';
export interface WorkspaceConfig { mode: WorkspaceMode; baseRef?: string; exclude?: string[] }
export interface ExecutionConfig {
  driver: 'codex-app-server'; executable?: string; model?: string; timeoutMs?: number; killGraceMs?: number;
}
export interface GitHubCIConfig {
  /** Only check runs produced by one of these GitHub App slugs can queue work. */
  checkApps?: string[];
  /** Commit statuses require both an allowed context and an allowed creator. */
  statusContexts?: string[];
  statusActors?: string[];
}
export type GitHubAppConfig = {
  appId: string;
  installationId: number;
  /** Explicitly request write access for App PR comment delivery; defaults to false. */
  pullRequestComments?: boolean;
  /** Separately opt in to ready/reviewer/thread writes; defaults to false. */
  pullRequestReviews?: boolean;
} & ({ privateKeyEnv: string; privateKeyPath?: never } | { privateKeyPath: string; privateKeyEnv?: never });
export type GitHubWebhookConfig = {
  host?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
} & ({ secretEnv: string; secretPath?: never } | { secretPath: string; secretEnv?: never });
export interface GitHubConfig {
  repository: string; allowedActors: string[]; issues?: number[]; command?: string; executable?: string; pollIntervalMs?: number;
  /** Dedicated user identity and notifications intake; requires executable, excludes app. */
  account?: { login: string };
  /** CI events are disabled when absent. */
  ci?: GitHubCIConfig;
  /** Explicit App installation credentials by reference; absent uses native gh login. */
  app?: GitHubAppConfig;
  /** Explicit receiver settings and secret reference; does not automatically start an HTTP server. */
  webhook?: GitHubWebhookConfig;
}
export interface GitHubActor { login: string; id: string | number; type: string }
export interface GitHubIssueEventBase {
  id: string; repository: string; issueNumber: number; issueId: string | number;
  text: string; title?: string; actor: GitHubActor; createdAt: string; url: string; issueState: 'open' | 'closed';
  updatedAt?:string;observedAt?:string;
}
export type GitHubIssueEvent = GitHubIssueEventBase & ({ kind: 'issue' } | { kind: 'comment' });
export interface GitHubPullRequest {
  repository: string; number: number; id: number; headSha: string; headRef: string; headRepository: string;
  state: 'open' | 'closed'; merged: boolean; url: string; title: string;
  /** Remote target metadata; the host verifies the ref and commit before preparing code work. */
  baseRef?:string;baseSha?:string;
}
export interface GitHubCIObservation {
  id: string; kind: 'check_run' | 'commit_status'; name: string; app?: string; status: string; conclusion: string | null; headSha: string; at: string; url: string;
}
/** Only configured observations on one commit; never a branch-protection or merge-readiness result. */
export interface GitHubCISnapshot {
  version:1;repository:string;target:string;headSha:string;observedAt:string;
  configurationDigest:string;digest:string;complete:boolean;scope:'selected-observations';
  state:'failed'|'unknown'|'running'|'passed';
  entries:Array<{key:string;kind:'check_run'|'commit_status';id:string;name:string;headSha:string;
    status:string;conclusion:string|null;startedAt:string|null;updatedAt:string|null;
    app?:string;appId?:string;suiteId?:string|null;workflowId?:string|null;actor?:string}>;
  failures:string[];running:string[];missing:string[];ambiguous:string[];uncertain:string[];
  pendingFailureKeys?:string[];missingPreviouslyObserved?:string[];observationDigest?:string;recoveredAt?:string;
}
export interface GitHubPullRequestBinding extends Omit<GitHubPullRequest, 'id'> {
  ticketId: string; linkedAt: string;
  /** Heads explicitly authorized by local linking, including earlier heads with queued results. */
  headHistory: string[];
  lastObservedHeadSha?: string; lastObservedState?: 'open' | 'closed'; blockedReason?: string; ci?: GitHubCIObservation[];
  associationId?:string;generation?:number;continuationId?:string;lastObservedMerged?:boolean;ciSnapshot?:GitHubCISnapshot;
  reviews?:Array<{id:string;reviewId:string;state:string;actor:string;headSha:string;at:string;text:string;url:string}>;
}
export interface GitHubPullRequestEventBase {
  id: string; repository: string; pullNumber: number; headSha: string; pullState: 'open' | 'closed';
  actor: GitHubActor; createdAt: string; text: string; url: string;
  updatedAt?:string;observedAt?:string;
  ciSnapshot?:GitHubCISnapshot;
  /** Original remote identity when a CI event is scoped to a particular PR. */
  remoteEventId?: string;
  reviewRootId?:number;reviewCommentId?:number;inReplyToId?:number;
  originalLine?:number|null;originalSide?:'LEFT'|'RIGHT';diffHunk?:string;
  reviewContext?:Array<{commentId:number;text:string;url:string;actor?:GitHubActor;commitId?:string}>;
}
export type GitHubPullRequestEvent = GitHubPullRequestEventBase & (
  | { kind: 'pull_request_state'; merged: boolean }
  | { kind: 'pr_comment' }
  | { kind: 'review'; state: string; commitId: string }
  | { kind: 'review_comment'; path: string; line: number | null; side: 'LEFT' | 'RIGHT' | null; commitId: string }
  | { kind: 'check_run'; ci: { name: string; app: string; status: string; conclusion: string | null; headSha: string } }
  | { kind: 'commit_status'; ci: { name: string; status: 'completed'; conclusion: string; headSha: string } }
);
export type GitHubEvent = GitHubIssueEvent | GitHubPullRequestEvent;
export interface GitHubTrackedPullRequest { number: number; headSha: string; ticketId?: string }
export interface GitHubErrorFact {
  category:'auth'|'gone'|'locked'|'forbidden'|'not-found'|'rate-limit'|'server'|'transport'|'identity'|'invalid'|'configuration';
  statusCode?:number;message:string;
}
export interface GitHubObjectObservation {
  kind:'issue'|'pull';number:number;status:'ok'|'failed';observedAt:string;
  headSha?:string;state?:'open'|'closed';merged?:boolean;ignored?:boolean;error?:GitHubErrorFact;
  ciSnapshot?:GitHubCISnapshot;
}
export interface GitHubPollResult {
  version:1;repository:string;observedAt:string;events:GitHubEvent[];objects:GitHubObjectObservation[];
  errors:Array<{scope:'repository'|'discovery';error:GitHubErrorFact}>;discovery:{complete:boolean};repositoryVerified?:boolean;
}
export interface GitHubDeliveryDestination {kind:'review-thread'|'conversation';reviewRootId?:string;fallbackReason?:'review-target-missing'}
export interface DeliveryReceipt {id:string;url:string;destination?:GitHubDeliveryDestination;sourceTriggerId?:string}
export interface GoneDelivery {status:'gone';reason:'deleted'|'locked'}
export interface GitHubChannel {
  /** Optional legacy readiness probe; stable repositoryId enables identity binding. */
  probe?(): Promise<{ repository?: string; repositoryId?: number; [key: string]: unknown }>;
  /** Fresh read on each call; used before host-managed remote writes. */
  repositoryIdentity?(): Promise<{ repository: string; repositoryId: number }>;
  /** Legacy arrays remain accepted; object results retain independent resource failures. */
  poll(options?: { trackedIssues?: number[]; trackedPullRequests?: GitHubTrackedPullRequest[];contextPullRequests?:number[];skipObjects?:Array<{kind:'issue'|'pull';number:number}> }): Promise<GitHubEvent[]|GitHubPollResult>;
  /** Required only for explicit local linking; existing Issue-only adapters remain valid. */
  getPullRequest?(number: number): Promise<GitHubPullRequest>;
  reviewRecipientIdentity?(login:string,options?:{signal?:AbortSignal}):Promise<{id:string;login:string;type:'User'|'Bot'}>;
  findingReplySnapshot?(intent:PRReviewActionRecord['intent'],options?:{signal?:AbortSignal;expectedAuthorId?:string}):Promise<{authorId:string;receipt:FindingReplyReceipt|null}>;
  reviewSnapshot?(number:number,options?:{threadId?:string;commentId?:number;signal?:AbortSignal}):Promise<GitHubPRReviewSnapshot>;
  applyReviewAction?(intent:PRReviewActionRecord['intent'],options?:{signal?:AbortSignal;beforeWrite?():void|Promise<void>}):Promise<unknown>;
  deliver(message: OutboundMessage, context: { projectId: string; sourceProjectRoot?: string; pullRequests?: GitHubTrackedPullRequest[]; coordinatorAnswer?:{triggerId:string;channel:OutboundMessage['channel']};workerAnswer?:{triggerId:string;ticketId:string;channel:OutboundMessage['channel']};authorizeSend?(destination:GitHubDeliveryDestination):void|Promise<void> }): Promise<DeliveryReceipt|GoneDelivery>;
}
export interface Notification extends OutboundMessage { status:'pending'|'sent'|'dropped';delivery?:DeliveryReceipt;terminal?:GoneDelivery;ordering?:{reason:'earlier-delivery-failed-three-times';skipped:string[]} }
export interface GitHubSyncResult { received: number; duplicates: number; ignored: number; tickets: string[]; delivered: number; busy?: boolean }
export interface GitHubStatus {
  configured: boolean; repository: string | null;
  intake: 'account-notifications' | 'repository-poll';
  account: { login: string } | null;
  trackedIssues: Array<{ repository: string; issueNumber: number; thread: string; url: string; ticketId: string; status: TicketStatus }>;
  trackedPullRequests: GitHubPullRequestBinding[];
  webhook: GitHubWebhookStatus;
  synchronization:{state:'unavailable'|'degraded'|'ready'|'unobserved';objects:Array<GitHubObjectObservation&{repository:string;attempts:number;lastSuccess:string|null;nextAt:string|null}>;errors:GitHubPollResult['errors']}|null;
  notifications: Notification[]; lastSync: { at: string; repository: string; received: number } | null; lastError: string | null;
}
export interface GitHubConfigurationPatch extends Omit<Partial<GitHubConfig>, 'ci' | 'app' | 'account' | 'webhook'> {
  account?: { login: string } | null;
  /** Replaces the complete CI policy; null removes it. */
  ci?: GitHubCIConfig | null;
  /** Replaces all App settings; null restores native gh authentication. */
  app?: GitHubAppConfig | null;
  /** Replaces all Webhook settings; null disables the receiver. */
  webhook?: GitHubWebhookConfig | null;
}
export interface ConfigurationPatch { workspace?: WorkspaceMode | Partial<WorkspaceConfig>; execution?: Partial<ExecutionConfig>; github?: GitHubConfigurationPatch | null }
export interface ProjectConfig { schemaVersion: 2; projectId: string; concurrency: 1; workspace: WorkspaceConfig; execution?: ExecutionConfig; github?: GitHubConfig }
export interface Workspace {
  mode: Exclude<WorkspaceMode, 'auto'>;
  state: 'preparing' | 'ready';
  path: string;
  projectRoot: string;
  ticketId: string;
  createdAt: string;
  provisionId?:string;
  /** Legacy workspaces without this field are generation zero. */
  generation?:number;
  continuationId?:string;
  previousProvisionId?:string;
  baseCommit?: string;
  branch?: string;
  sourceDirty?: boolean;
  fallbackReason?: string;
  [key: string]: unknown;
}
export interface WorkspaceReview { workspace: Workspace | null; changes: Array<{ path: string; status: string }>; [key: string]: unknown }
export interface ProjectOptions extends ConfigurationPatch { projectRoot: string; harnessRegistry?:HarnessRegistry; githubChannel?: GitHubChannel; repositoryRequest?:(path:string,options?:Record<string,unknown>)=>Promise<unknown>; sources?:SourceAdapter[] }
export declare class ProjectRuntime {
  constructor(options: ProjectOptions);
  projectRoot: string;
  projectId?: string;
  init(): this;
  /** Claim execution and verify GitHub ownership before opening an external listener. */
  prepareExecution(): Promise<RuntimeMachineStatus>;
  machineStatus(): RuntimeMachineStatus;
  githubBindingStatus(): { repository: string | null; bindings: GitHubRepositoryOwnership[] };
  releaseGitHubBinding(options?: { apply?: boolean; repository?: string }): { repository?: string; safe: boolean; bindings: GitHubRepositoryOwnership[]; reason: string | null; released?: boolean };
  submit(input: { text: string; scope?: string; attentionSnapshotPaths?: string[]; operatorNotifications?: boolean; managedJobs?: boolean }): Ticket;
  list(): Ticket[];
  /** Advisory cross-process state invalidation. Coalesced, serialized, not a durable event feed.
   * Re-read current state, reconcile once on startup, and retain periodic recovery.
   * Returns unsubscribe; close() also releases watches. No execution loop is started.
   * Database replacement closes the watch with WATCH_REOPEN_REQUIRED; native watch errors use WATCH_FAILED.
   */
  watchChanges(listener: () => void | Promise<void>, options?: { onError?: (error: unknown) => void }): () => void;
  get(id: string): Ticket;
  getDetailed(id: string): TicketDetails;
  getConfigV2(): Omit<ProjectConfig,'schemaVersion'|'concurrency'|'execution'> & {schemaVersion:3;concurrency:number;execution?:ExecutorSettings['execution'];scheduler:Record<string,unknown>};
  schedulerStatus(): {version:2;revision:number;maxWorkers:number;humanReserve:number;active:Array<Record<string,unknown>>};
  configureScheduler(settings:{maxWorkers?:number;humanReserve?:number},options:{expectedRevision:number}): Record<string,unknown>|OwnerControlReceipt;
  getExecutorSettings(): ExecutorSettings;
  listHarnesses(): HarnessDescriptor[];
  getHarnessRegistry(): HarnessRegistry;
  probeHarness(execution:HarnessExecution,options?:HarnessProbeOptions):Promise<HarnessProbeResult>;
  executorStatus():{settings:ExecutorSettings;effective:ExecutorSettings['execution'];history:ExecutorSettings[];migration:{required:boolean;from:string|null;target:string|null;tickets:Array<{id:string;driver:string;action:'replace-session'}>;coordinator:{driver:string;action:'reconfigure-coordinator'}|null;child:{driver:string;action:'reconfigure-jobs'}|null}};
  configureExecutor(execution:NonNullable<ExecutorSettings['execution']>,options:{expectedRevision:number}):ExecutorSettings;
  getJobsSettings(): {revision:number;settings:ManagedJobsSettings|null;at?:string};
  configureJobs(settings:ManagedJobsSettings,options:{expectedRevision:number}):ReturnType<ProjectRuntime['getJobsSettings']>;
  listJobs(ticketId:string):ManagedJobRecord[];
  /** Requests are executed by the live owner; status completed still requires checking the business result. */
  requestControl(request:OwnerControlRequest):OwnerControlReceipt;
  controlStatus(operationId:string):OwnerControlReceipt|null;
  listControls(options?:{limit?:number}):OwnerControlReceipt[];
  jobControl(ticketId:string,jobId:string,options:{action:'preview'|'renew'|'close'|'cancel'|'message'|'reply'|'resume';ttlMs?:number;reason?:string;text?:string;requestId?:string}):Promise<ManagedJobRecord|PreviewLease|OwnerControlReceipt|{jobId:string;messageId:string;status:'accepted'}>;
  /** Controls the current live lease only; close releases the entire lease. */
  controlNativePreview(ticketId:string,options:{leaseId:string;jobId:string;action:'renew'|'close';ttlMs?:number}):Promise<NativeHandoffRecord|OwnerControlReceipt>;
  planChildAdoption(ticketId:string,jobId:string):ChildAdoptionPlan;
  /** Applies only an unchanged reviewed plan; invalidates prior host verification. */
  adoptChild(ticketId:string,jobId:string,options:{expectedPlanDigest:string}):Promise<ChildAdoptionRecord|OwnerControlReceipt>;
  listChildAdoptions(ticketId:string):ChildAdoptionRecord[];
  recoverChildAdoption(ticketId:string,adoptionId:string,options:{mode:'rollback'|'finish'}):Promise<ChildAdoptionRecord|OwnerControlReceipt>;
  ticketTrace(ticketId:string,options?:{cursor?:string;limit?:number}):TicketTrace;
  sessionStatus(ticketId:string):SessionStatus;
  /** Read-only operator guidance; mutations independently recheck current state. */
  actionAvailability(ticketId:string):{requestStatus:{allowed:boolean;code:string;reason:string|null};sessionReplace:{allowed:boolean;code:string;reason:string|null;expectedSessionId:string|null}};
  /** Explicit replacement preserves scope and work; expectedSessionId may be null for no native session. */
  replaceSession(ticketId:string,options:{reason:string;expectedSessionId:string|null;adoptCurrentSettings?:boolean}):Promise<SessionStatus|OwnerControlReceipt>;
  getRecoverySettings():RecoverySettings & {revision:number;at?:string};
  configureRecovery(settings:Partial<RecoverySettings>,options:{expectedRevision:number}):ReturnType<ProjectRuntime['getRecoverySettings']>|OwnerControlReceipt;
  managementStatus():{threads:Array<{thread:string;subscriptions:string[];revision:string}>;decisions:Array<{decisionId:string;decision:unknown;revision:string}>};
  unsubscribeThread(thread:string,options:{expectedRevision:string}):{thread:string;unsubscribed:boolean};
  dismissDecision(decisionId:string,options:{expectedRevision:string}):unknown;
  promptStatus():PromptStatus;
  previewPrompts(settings:PromptSettingsPatch,options:{expectedRevision:number}):PromptPreview;
  uiEvidenceStatus(id:string):UIEvidenceRecord|null;
  readUIEvidenceImage(id:string,phase:'before'|'after'):Uint8Array;
  configurePrompts(settings:PromptSettingsPatch,options:{expectedRevision:number;origin?:'sdk'|'cli'|'panel'|'migration'}):PromptSettings;
  businessHealth():BusinessHealth;
  getIncidents(options?:{includeResolved?:boolean;limit?:number}):BusinessIncident[];
  acknowledgeIncident(id:string,options:{expectedRevision:number}):BusinessIncident;
  reevaluate(triggerId:string):unknown;
  requestStatus(ticketId:string):unknown;
  getRepositorySourceSettings(): RepositorySourceSettings;
  configureRepositorySource(settings:Partial<Omit<RepositorySourceSettings,'revision'|'at'|'streams'>>&{streams?:Partial<RepositorySourceSettings['streams']>},options:{expectedRevision:number}):RepositorySourceSettings|OwnerControlReceipt;
  registerSource(adapter:SourceAdapter):this;
  receiveSourceEvent(id:string,event:unknown):Record<string,unknown>;
  sourceStatus():Array<Record<string,unknown>>;
  readSource(id:string,reference:unknown):Promise<unknown>;
  receive(trigger:import('../dist/core/index.js').Trigger): 'stored'|'duplicate'|'filtered';
  reviewActionStatus(ticketId?:string):PRReviewRequestRecord[];
  requestPRReview(ticketId:string,input:PRReviewRequest):PRReviewRequestRecord;
  runPRReview(requestId:string):Promise<PRReviewRequestRecord|OwnerControlReceipt>;
  botReviewStatus():BotReviewBudgetRecord[];
  setBotReviewBudget(pullNumber:number,actorId:string,options:{remaining:number;reason:string;expectedRevision:number}):BotReviewBudgetRecord;
  associateBotReviewRun(pullNumber:number,actorId:string,options:{eventIds:string[];runId:string;reason:string}):{associated:number};
  getDeliverySettings(): DeliverySettings & {revision:number};
  configureDelivery(settings:DeliverySettings, options:{expectedRevision:number}): DeliverySettings & {revision:number};
  verifyTicket(id:string): Promise<Record<string,unknown>|OwnerControlReceipt>;
  deliverTicket(id:string): Promise<Record<string,unknown>|OwnerControlReceipt>;
  request(input: {text: string; threadId?: string}): {triggerId: string; threadId: string};
  coordinatorStatus(): {settings: CoordinatorSettings; active: boolean; history: CoordinatorSettings[]};
  configureCoordinator(settings: Pick<Partial<CoordinatorSettings>, 'policy'|'assessor'|'workflowMode'> & {workRetry?:Partial<CoordinationRetrySettings>}, options: {expectedRevision:number}): CoordinatorSettings;
  /** Queue only; explicit runNext/start processes messages in continuous mode. */
  coordinate(input:{text:string;id?:string;management?:ManagementIntent}):CoordinationEvent;
  /** Requeue the same failed event; does not start a model or replay completed actions. */
  retryCoordination(id:string):CoordinationEvent;
  coordinationStatus():{mode:'candidates'|'continuous';active:boolean;pending:number;events:CoordinationEvent[]};
  readContext(resource: 'tickets'|'threads'|'decisions'|'triggers', options?: {cursor?:string;limit?:number;textLimit?:number;query?:string}): Record<string,unknown>;
  readContextRecord(resource: 'tickets'|'threads'|'decisions'|'triggers', id:string, options?:{version?:string;offset?:number;limit?:number}): Record<string,unknown>|null;
  /** Read-only projections of existing intake, domain and delivery records. These methods never retry work. */
  eventDiagnostics(options?:DiagnosticOptions):DiagnosticPage<EventDiagnostic>;
  eventDiagnostic(id:string):EventDiagnostic|null;
  replyDiagnostics(options?:DiagnosticOptions):DiagnosticPage<ReplyDiagnostic>;
  handback(id:string, triggerId:string, reason:string): unknown;
  followForContext(id:string, thread:{source:string;id:string}): unknown;
  note(id:string, text:string): unknown;
  /** Effective configuration: invocation overrides take precedence over persisted settings. */
  getConfig(): ProjectConfig;
  /** Persist validated settings; refuses updates during execution. */
  configure(patch: ConfigurationPatch): ProjectConfig;
  configureV2(patch:ConfigurationPatch):ReturnType<ProjectRuntime['getConfigV2']>;
  getWorkspace(id: string): Workspace | null;
  inspectWorkspace(id: string): WorkspaceReview;
  getSession(id: string): DriverSession | null;
  getDomainTicket(id: string): DomainTicket;
  notifications(): Notification[];
  /** Pull scoped GitHub snapshots and send queued replies without executing a model. */
  syncGitHub(options?: { flush?: boolean }): Promise<GitHubSyncResult>;
  githubStatus(): GitHubStatus;
  /** Fetch and explicitly authorize this repository's PR at its current head, without checkout or push. */
  linkGitHubPullRequest(ticketId: string, input: { number: number }): Promise<GitHubPullRequestBinding|OwnerControlReceipt>;
  /** Remove the local binding and stop following or sending queued results to this PR. */
  unlinkGitHubPullRequest(number: number): boolean;
  /** Trusted adapter entry point; local configuration still controls admission and fan-out. */
  receiveGitHubEvent(event: GitHubEvent): { status: 'received' | 'ignored' | 'duplicate'; ticketId?: string; reason?: string };
  /** Verify raw bytes and durably accept delivery without calling a model or network service. */
  receiveGitHubWebhook(input: GitHubWebhookRequest): GitHubWebhookReceipt;
  /** Process persisted deliveries; runNext also processes this queue before polling. */
  processGitHubWebhooks(): Promise<GitHubWebhookProcessResult>;
  /** Local receipt and queue state only; excludes body bytes, signatures and secret values. */
  githubWebhookStatus(): GitHubWebhookStatus;
  flushNotifications(): Promise<number>;
  upgradeRuntime(): {schemaVersion:14;coordination:RuntimeMachineStatus};
  isPaused(): boolean;
  pause(reason?: string): ReturnType<ProjectRuntime["status"]>;
  resume(): ReturnType<ProjectRuntime["status"]>;
  status(): { running: boolean; active: boolean; paused: boolean; pause: { paused: boolean; reason?: string; at: string } | null; ingressActive: boolean; lastError: string | null; effects: Array<Record<string, unknown>>; machine: RuntimeMachineStatus };
  /** Start local serial scheduling with an injected or configured driver. */
  start(options?: { intervalMs?: number }): this;
  /** Stop scheduling, abort active work and wait for the driver to settle. */
  stop(): Promise<void>;
  reply(id: string, text: string): Ticket;
  /** Attach immutable choices to a current unanswered local-operator question; queues a card without resuming the Worker. */
  attachDecision(id: string, input: { attentionId: string; decision: AttentionDecision }): { ticketId: string; attentionId: string; decision: AttentionDecision; changed: boolean };
  /** Answer the ticket's open structured question. Only the first answer to a question is accepted. */
  answer(id: string, input: { answers: AttentionAnswers; attentionId?: string }): AttentionAnswerRecord;
  listAnswers(id: string): AttentionAnswerRecord[];
  listAttentionSnapshots(id: string): AttentionSnapshot[];
  /** Feishu card.action.trigger callback for the operator's decision cards; returns the toast and card Feishu shows. */
  receiveFeishuCardAction(data: unknown): { toast: { type: 'success' | 'error' | 'info'; content: string }; card?: { type: 'raw'; data: Record<string, unknown> } };
  retry(id: string): Ticket;
  cancel(id: string): Ticket;
  /** Runs at most one Driver turn. Returns null when this bounded pass executes no Driver (busy, no due work, or control effects only). */
  runNext(): Promise<Ticket | null>;
  /** Refuses to close while this instance has active work. */
  close(): void;
}
export declare function createProjectAgent(options: ProjectOptions): ProjectRuntime;

export interface CodexDriverOptions {
  contextLimits?: ContextLimits;
  prompt?: string;
  executable?: string;
  model?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

/** DSH is an optional installed executable, never supplied by js-agent-runtime. */
export interface DshDriverOptions {
  executable?:string;
  model:string;
  backend:{auth:'api-key';provider:'deepseek-official';protocol:'anthropic-messages';baseURL:string;apiKeyEnv:string};
  permission?:'read-only'|'workspace-write';
  timeoutMs?:number;killGraceMs?:number;prompt?:string;contextLimits?:ContextLimits;
  enableAgentTools?:boolean;enableManagedJobs?:boolean;
}
/** Coordination uses the same SDK transport with read-only role permissions. */
export interface DshAssessorOptions extends Omit<DshDriverOptions,'permission'|'enableAgentTools'|'enableManagedJobs'> {
  driver?:'dsh-sdk';permission?:'read-only';enableAgentTools?:false;enableManagedJobs?:false;
}
export function createDshSdkDriver(options:DshDriverOptions, context?:{role?:HarnessRole}):AgentDriverV2;
export function validateDshOptions(options:DshDriverOptions,context?:{role?:HarnessRole;driver?:'dsh-sdk'}):DshDriverOptions;
export function createDshAssessor(options:DshAssessorOptions):HarnessAssessor;

/** Cursor CLI print mode. Without apiKeyEnv the personal keychain login is used and its account rules apply. An omitted model becomes grok-4.7-high-fast. */
export interface CursorDriverOptions {
  executable?:string;model?:string;permission?:'read-only'|'workspace-write';apiKeyEnv?:string;
  timeoutMs?:number;killGraceMs?:number;prompt?:string;contextLimits?:ContextLimits;
}
export interface CursorAssessorOptions extends Omit<CursorDriverOptions,'permission'> {driver?:'cursor-agent';permission?:'read-only'}
export function createCursorAgentDriver(options:CursorDriverOptions, context?:{role?:HarnessRole}):AgentDriverV2;
export function validateCursorOptions(options:CursorDriverOptions, context?:{role?:HarnessRole}):CursorDriverOptions;
export function createCursorAssessor(options:CursorAssessorOptions):HarnessAssessor;

/** Per-user state root: JS_SUPERAGENT_HOME, or ~/.js-superagent. */
export function stateHome(env?:Record<string,string|undefined>):string;
/** <stateHome>/projects/<real project path with non-alphanumerics replaced by "-">. Nothing is kept inside the project. */
export function projectStateDirectory(projectRoot:string, env?:Record<string,string|undefined>):string;

export type HarnessRole = 'worker'|'child'|'coordinator';
export type HarnessCapability = 'structuredProgress'|'sessionResume'|'realtimeInput'|'inputAcknowledgements'|'backgroundTasks'|'subagents'|'agentTools'|'nativeBackgroundOwnership';
export interface HarnessExecution {
  driver:string;adapterVersion?:string;requiredCapabilities?:HarnessCapability[];
  executable?:string;model?:string;timeoutMs?:number;killGraceMs?:number;prompt?:string;
  contextLimits?:ContextLimits;enableManagedJobs?:boolean;enableAgentTools?:boolean;
  /** Adapter-specific fields are checked by its registered trusted validator. */
  [key:string]:unknown;
}
export interface HarnessDescriptor {
  id:string;version:string;roles:HarnessRole[];
  /** Supported capability ceiling; effective configuration is checked separately. */
  capabilities?:Partial<DriverCapabilities>;
  label?:string;settingsFields:string[];preserveOnSave:string[];
}
export interface HarnessProbeOptions {role?:HarnessRole;checkExecutable?:boolean;timeoutMs?:number}
export interface HarnessProbeResult {
  ok:boolean;adapter:{id:string;version:string};role:HarnessRole;capabilities:Partial<DriverCapabilities>;
  checks:HarnessCheck[];
}
export interface HarnessCheck {name:string;status:'passed'|'failed'|'unknown'|'skipped';message:string}
export interface HarnessAssessorFactory {
  validate?(options:Record<string,unknown>,context:{role:HarnessRole}):Record<string,unknown>;
  create(options:Record<string,unknown>):HarnessAssessor;
}
export interface HarnessAssessor {
  assess(input:Record<string,unknown>):Promise<Record<string,unknown>>;
  handleEvent?(input:CoordinationInput):Promise<CoordinationResult>;
  /** Read-only classification; the host separately verifies authorization and provisions any workspace. */
  inspectContinuation?(input:ContinuationInspectionInput):Promise<ContinuationDecision>;
}
export interface ContinuationDecision {
  kind:'reply'|'work'|'clarify'|'handback';summary:string;question:string|null;base:'target'|'previous-head'|null;
}
export interface ContinuationInspectionInput {
  projectRoot:string;sourceProjectRoot?:string;runId:string;signal:AbortSignal;
  facts:{scope:string;source:GitHubPullRequest;sources:GitHubPullRequest[];
    messages:unknown[];previousReports:unknown[];target:GitHubContinuation['target']|null};
  registerProcess(pid:number):void;checkpoint(session:DriverSession):void;
}
export interface HarnessServiceLaunch {
  executable:string;environment:Record<string,string>;credentialEnvNames:string[];
}
export interface HarnessLoginProbe {
  id:string;status:'passed'|'failed'|'blocked'|'unchecked';message:string;nextAction?:string;
}
export interface HarnessAdapter {
  id:string;version:string;roles:HarnessRole[];
  capabilities?:Partial<DriverCapabilities>;defaultExecutable?:string;
  /** Process supervision can prove the adapter has not started work. */
  supervised?:boolean;
  label?:string;settingsFields?:string[];preserveOnSave?:string[];
  serviceLaunch?(execution:HarnessExecution,processEnv:NodeJS.ProcessEnv):HarnessServiceLaunch;
  loginProbe?(execution:HarnessExecution,context:{execFileSync?:typeof import('node:child_process').execFileSync;timeoutMs?:number}):HarnessLoginProbe|null;
  coordinatorExecution?(execution:HarnessExecution):HarnessExecution;
  validateLease?(record:NativeHandoffRecord):NativeHandoffRecord;
  validate(options:Record<string,unknown>,context:{role:HarnessRole}):Record<string,unknown>;
  createDriver?(options:Record<string,unknown>,context?:{role:HarnessRole}):AgentDriver;
  createAssessor?(options:Record<string,unknown>):HarnessAssessor;
  assessor?:HarnessAssessorFactory;
  probe?(options:HarnessExecution,context:{role:HarnessRole;timeoutMs:number}):Promise<HarnessCheck[]>;
}
export interface HarnessRegistry {
  /** Trusted code registration, isolated per registry. Built-in IDs cannot be replaced. */
  register(adapter:HarnessAdapter):()=>void;
  list():HarnessDescriptor[];
  validateExecution(execution:HarnessExecution,options?:{role?:HarnessRole}):HarnessExecution;
  createDriver(execution:HarnessExecution,options?:{role?:HarnessRole}):AgentDriver;
  createAssessor(execution:HarnessExecution):HarnessAssessor;
  describeExecution(execution:HarnessExecution,options?:{role?:HarnessRole}):{adapter:{id:string;version:string};role:HarnessRole;supervised:boolean;capabilities:Partial<DriverCapabilities>;execution:HarnessExecution};
  supervised(driver:string):boolean;
  serviceLaunch(execution:HarnessExecution,processEnv?:NodeJS.ProcessEnv):HarnessServiceLaunch;
  loginProbe(execution:HarnessExecution,context?:{execFileSync?:typeof import('node:child_process').execFileSync;timeoutMs?:number}):HarnessLoginProbe|null|Promise<HarnessLoginProbe|null>;
  coordinatorExecution(execution:HarnessExecution):HarnessExecution;
  validateLease(record:NativeHandoffRecord):NativeHandoffRecord;
  probeExecution(execution:HarnessExecution,options?:HarnessProbeOptions):Promise<HarnessProbeResult>;
}
export function createHarnessRegistry(options?:{adapters?:HarnessAdapter[];assessors?:Record<string,HarnessAssessorFactory>}):HarnessRegistry;
/** Uses configured App installation authentication or native gh, scoped to github.com and one repository. */
export declare function createGitHubChannel(options: GitHubConfig): GitHubChannel;

export interface GitHubWebhookRequest {
  body: Uint8Array;
  headers: Record<string, string | string[] | undefined>;
}
export interface GitHubWebhookReceipt {
  status: 'accepted' | 'duplicate' | 'ignored';
  deliveryId: string;
  reason?: string;
}
export interface GitHubWebhookProcessResult {
  processed: number;
  duplicates: number;
  ignored: number;
  busy?: boolean;
}
export interface GitHubWebhookDelivery {
  deliveryId: string;
  event: string;
  repository: string;
  installationId?: number;
  receivedAt: string;
  status: 'pending' | 'processed' | 'ignored';
  reason?: string;
  processedAt?: string;
  bodySha256: string;
}
export interface GitHubWebhookStatus {
  configured: boolean;
  pending: number;
  processed: number;
  ignored: number;
  deliveries: GitHubWebhookDelivery[];
  lastError: string | null;
}
export interface GitHubWebhookListenerOptions {
  host?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
}
export interface GitHubWebhookServer { url: string; close(): Promise<void> }
/** Starts only when explicitly called; requests verify and persist before acknowledgement. */
export declare function listenGitHubWebhook(runtime: Pick<ProjectRuntime, 'receiveGitHubWebhook'>, options?: GitHubWebhookListenerOptions): Promise<GitHubWebhookServer>;
export declare function verifyGitHubWebhook(input: GitHubWebhookRequest & { secret: string | Uint8Array; maxBodyBytes?: number }): {
  deliveryId: string; event: string; payload: Record<string, unknown>; bodySha256: string;
};

/** Independent domain engine, also used by ProjectRuntime through SQLite adapters. */
export * as core from '../dist/core/index.js';

export interface DriverCapabilities {
  reportVersion: 2; structuredProgress: boolean; sessionResume: boolean;
  realtimeInput: boolean; inputAcknowledgements: boolean; backgroundTasks: boolean; subagents: boolean;
  agentTools?: boolean;
  /** The adapter can transfer live native background work to the host. */
  nativeBackgroundOwnership?: boolean;
  /** Absent retains the legacy complete-input contract; 1 uses explicit delivered record receipts. */
  boundedContextVersion?: 1;
}
export interface DriverReportV2 {
  version: 2; state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
  /** With answers, summary is the answer to the original owned human trigger. */
  answers?: string; summary: string; artifacts?: string[]; attention?: { question: string; triggerId?: string; decision?: AttentionDecision } | null;
}
/** Fixed options for one or more items; channels show it as a list or a card. */
export interface AttentionDecision {
  items: Array<{ id: string; title: string; summary?: string; url?: string }>;
  options: Array<{ id: string; label: string }>;
  reason: 'required' | 'optional' | 'none';
}
export type AttentionAnswers = Record<string, { option: string; reason?: string }>;
export interface AttentionSnapshot {
  ticketId: string; attentionId: string; at: string; question: string; decision?: AttentionDecision;
  files: Array<{ path: string; content: string; sha256: string }>;
}
export interface AttentionAnswerRecord {
  attentionId: string; ticketId: string; question: string; kind: 'structured' | 'text';
  answers?: AttentionAnswers; text?: string;
  by: { source: 'local' | 'feishu'; id: string }; via: 'local' | 'feishu-card' | 'feishu-text'; at: string;
}
export type InputReadEvidence =
  | {type:'model-final-ack';sessionId:string;turnId:string}
  | {type:'native-user-message';driver:string;sessionId:string;messageId:string;eventSequence:number;runId:string;inputId:string;sourceRunId?:string};
export interface HostToolReceipt {
  callId:string;name:string;arguments:Record<string,unknown>;result:unknown;sessionId:string;turnId:string;
}
export interface HostToolVerification extends HostToolReceipt {driver:string;runId:string;nativeCallId?:string}
export interface RecoveryInspectionInput {
  session:DriverSession;runId:string;projectRoot:string;sourceProjectRoot:string;signal:AbortSignal;
  inputs?:Array<{inputId:string;status:string;receipt?:Record<string,unknown>}>;
  /** Enables structured refusal reasons rather than an ambiguous null. */
  diagnostics?:boolean;
  verifyHostTool?(query:HostToolVerification):boolean;
}
export interface NativePendingInput {inputId:string;messageId:string;nativeDigest:string;sourceRunId:string}
export interface NativeInputAdoption {
  sourceRunId:string;sessionId:string;eventSequence:number;pending:NativePendingInput[];
  status?:'prepared'|'active'|'consumed';preparedAt?:string;adoptingRunId?:string;
}
export interface RecoveryInspection {
  version:1;kind:'inspection';safeToResume:false;reason:string;session?:DriverSession;runId?:string;nativeVersion?:string;
  /** Known pending inputs remain held when the native harness cannot wake them without replay. */
  pendingInputs?:{sourceRunId:string;sessionId:string;eventSequence:number;pending:NativePendingInput[]};
}
export interface AgentDriver {
  reportVersion: 2;
  capabilities?: Partial<DriverCapabilities>;
  run(input: DriverRunInput & {
    jobs?:ManagedJobs;jobProfiles?:Array<{id:string;kind:string;description:string;preview?:boolean}>;
    agentTools?:WorkerToolHost;
    contextDelivered?(input:{records:ContextRecordReference[]}):void;
    progress(report: DriverReportV2): void;
    inputRead(input:{inputId:string;evidence:InputReadEvidence}):void;
  }): Promise<DriverReportV2>;
  sendInput?(input:{runId:string;inputId:string;text:string}):Promise<{accepted:true;read:false;inputId:string;sessionId:string;turnId?:string;messageId?:string}>;
  /** Native consumption evidence must match the adapter's actual receipt and event. */
  validateInputRead?(input:{inputId:string;evidence:InputReadEvidence}):boolean;
  /** Read-only native-history inspection; never starts work or replays tools. */
  inspectRecovery?(input:RecoveryInspectionInput):Promise<RecoveryEvidence|RecoveryInspection|null>;
}
export interface RecoveryEvidence {
  version:1;kind:'transient'|'interrupted';safeToResume:true;toolsSettled:true;session:DriverSession;
  checkpoint:{runId:string;eventSequence:number};code:'RATE_LIMIT'|'SERVER'|'TIMEOUT'|'HISTORY_VERIFIED';
  outcome?:'resume'|'completed'|'adopt-pending';report?:DriverReportV2;readInputIds?:string[];contextRecords?:ContextRecordReference[];adoption?:NativeInputAdoption;
}
/** Only not-sent permits same-run retry. Unknown delivery remains held for reconciliation. */
export type InputDeliveryError = Error & {deliveryState?:'not-sent'|'unknown'|'rejected'};
/** Compatibility type name for the same modern adapter contract; no v1 execution path. */
export type AgentDriverV2 = AgentDriver;
export interface GitHubContinuation {
  version:1;id:string;ticketId:string;generation:number;triggerIds:string[];
  source:{repository:string;number:number;state:'closed';merged:boolean;headSha:string};
  target:{repository:string;base:string;baseCommit:string;strategy:'target-branch'|'previous-head'};
  previousProvisionId:string;status:'preparing'|'ready';createdAt:string;
  previousWorkspace:Workspace;previousSession:DriverSession|null;workspace?:Workspace;
  previousDelivery?:Record<string,unknown>|null;previousVerification?:Record<string,unknown>|null;
}
export interface GitHubContinuationInspection {
  status:'inspection'|'ready';at:string;reason?:string|null;version?:1;
  source?:GitHubContinuation['source'];previousProvisionId?:string;previousHeadSha?:string;generation?:number;
}
export interface TicketDetails {
  version: 2; ticket: Ticket; stage: string; action?: string; outcome: string | null;
  reportState: DriverReportV2['state'] | null; attention: Record<string, unknown> | null;
  sessionSettings?:{execution:ExecutorSettings['execution'];revision:number|null;promptVersion:string|null;pinOrigin?:string|null};
  deliveryAttempt?:Record<string,unknown>|null;
  delivery: Record<string, unknown> | null; verification: Record<string, unknown> | null;
  continuation?:GitHubContinuation|null;
  continuationHistory?:GitHubContinuation[];
  continuationInspection?:GitHubContinuationInspection|null;
  nativeHandoffs?:NativeHandoffRecord[];
  reviewActions?:PRReviewRequestRecord[];botReviews?:BotReviewBudgetRecord[];uiEvidence?:UIEvidenceRecord|null;
  cancellation?:{source:'github';triggerId:string;actor:string;reason:string;at:string;policyVersion:string}|null;
  liveInputs?:Array<Record<string,unknown>>;
  failure?:{origin:string;requiresInspection:boolean;runId:string;at:string}|null;
  heldFeedback?:Array<{id:string;at:string;reason:string}>;
  recovery?:(Record<string,unknown>&{jobInspections?:Array<{jobId:string;reason:string}>})|null;
  nativeFacts?:(Record<string,unknown>&{policy?:WorkerPolicyObservation;nativeHandoffSupported?:boolean})|null;
  policyStatus?:{status:'ready'|'legacy-unresolved';reason:string|null;desiredRevision:number;selectedRevision:number|null;selectedAt:string;runId:string;recovering:boolean}|null;
  executionObservation?:ExecutionObservation|null;
  nativeResultRecoveredFrom?:string|null;
  interrupted: boolean; reports: Array<DriverReportV2 & {runId:string;at:string}>; capabilities?: DriverCapabilities;
}
export interface CoordinatorSettings {
  revision: number; version: string; policy: Record<string, unknown> & {sourceRows?:PolicySourceRow[]};
  assessor: HarnessExecution | null;
  workflowMode?:'candidates'|'continuous';
  workRetry?:CoordinationRetrySettings;
  at: string | null;
}
export interface CoordinationRetrySettings {autoRetry:boolean;maxAttempts:number;initialDelayMs:number;timeoutMs:number}
export interface CoordinationResult {summary:string;actions:Array<{kind:'note'|'requestStatus'|'reply'|'stop'|'request'|'manage'|'answer'|'notify'|'retryRequest';ticketId:string|null;text:string|null;triggerId?:string|null;expectedVersion?:string|null}>}
export interface CoordinationReadRequest {resource:'tickets'|'threads'|'triggers'|'decisions'|'requests';recordId?:string|null;query?:string|null;cursor?:string|null;offset?:number|null}
export interface CoordinationInput extends Record<string,unknown> {
  timeoutMs?:number;readContext?(request:CoordinationReadRequest):unknown;
}
export interface CoordinationEvent {
  id:string;kind:'follow_up'|'operator'|'report'|'progress'|'question'|'result'|'subscription'|'ended';text:string;ticketId?:string;
  version:string;sequence:number;needsModel:boolean;requiresCoordination:boolean;
  status:'pending'|'recorded'|'completed'|'failed'|'unsupported';createdAt:string;attempts:number;
  result?:CoordinationResult;receipts:Array<{id:string;kind:string;result:unknown}>;error?:string;
  generation?:number;cycleAttempts?:number;deadlineAt?:string|null;nextAt?:string|null;attemptActive?:boolean;
  failureKind?:'stale'|'transient'|'inspection'|'unsupported'|'exhausted';
  history?:Array<{at:string;kind:'failure'|'manual-retry';failureKind?:string;attempt?:number;nextAt?:string|null;error?:string}>;
  readSet?:Array<{request:CoordinationReadRequest;version:string}>;
}
export function driverCapabilities(driver?: AgentDriver): DriverCapabilities;
export function createCodexAssessor(options?: {driver?:'codex-app-server';executable?:string;model?:string;prompt?:string;timeoutMs?:number;killGraceMs?:number;contextLimits?:ContextLimits}): {
  assess(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  handleEvent(input:CoordinationInput):Promise<CoordinationResult>;
  inspectContinuation(input:ContinuationInspectionInput):Promise<ContinuationDecision>;
};

export interface VerificationProfile {
  id:string; version:string; kind?:'verify'|'prepare'; command:string; args?:string[]; cwd?:string;
  timeoutMs?:number; environment:'host'; allowHostExecution:true; env?:Record<string,string>;
  maxLogBytes?:number; paths?:string[];
}
export interface GitHubPRReviewSnapshot {
  repository:string;number:number;id:string;headSha:string;state:'open'|'closed';merged:boolean;isDraft:boolean;author:string|null;
  requestedReviewers:string[];requestedTeams:string[];reviews:Array<{id:string|number;login:string;state:string;commitSha:string}>;
  thread?:{id:string;isResolved:boolean;commentIds:number[]};
}
export interface PRReviewSettings {
  ready?:boolean;requestReviewers?:boolean;resolveThreads?:boolean;reviewers?:string[];teams?:string[];
}
export type PRReviewRequest = {pullNumber?:number} & (
  {kind:'ready'} | {kind:'requestReviewers';reviewers?:string[];teams?:string[]} |
  {kind:'resolveThread';commentId:number;triggerId:string;reason:string} |
  {kind:'finding';disposition:'fixed'|'declined'|'unresolved';commentId:number;triggerId:string;reason:string}
);
export interface PRReviewRequestRecord {
  id:string;ticketId:string;runId:string;provisionId:string;generation:number;input:PRReviewRequest;
  tree:{digest:string;paths:string[];[key:string]:unknown};status:'pending'|'sending'|'completed'|'failed'|'inspection'|'retrying';
  attempts?:number;retryCycle?:number;nextAt?:string|null;exhausted?:boolean;
  at:string;updatedAt?:string;actionId?:string;error?:string|null;action?:PRReviewActionRecord|null;
}
export interface FindingReplyReceipt {id:string;authorId:string;rootId:number;bodyDigest:string}
export interface PRReviewActionRecord {
  id:string;intent:PRReviewRequest & {ticketId:string;repository:string;pullNumber:number;headSha:string;provisionId:string;generation:number;policyVersion?:string;threadId?:string;evidence?:Record<string,unknown>;authorKind?:'human'|'bot';reviewerIdentities?:Array<{id:string;login:string;type:'User'|'Bot'}>};
  status:'pending'|'sending'|'completed'|'failed'|'inspection';attempts:number;createdAt:string;updatedAt:string;
  completedAt?:string;observation?:Record<string,unknown>;error?:string|null;resolvedThreadId?:string;
  stage?:'reply'|'resolve'|'action';replyAuthorId?:string;replyReceipt?:FindingReplyReceipt;
}
export interface BotReviewBudgetRecord {
  version:1;repository:string;pullId:string;pullNumber:number;actorId:string;revision:number;limit:number;historicalUnknown:boolean;
  rounds:Array<{runId:string;number:number;status:'reserved'|'assessed';ticketIds:string[];eventIds:string[];at:string;disposition?:{runId:string;summary:string;state:string;eventIds:string[];at:string}}>;
  observations?:Array<{eventId:string;runId:string|null;ticketId:string;at:string;reason:string|null}>;
  history:Array<{kind:string;remaining:number;reason:string;actor:string;at:string}>;updatedAt?:string;
}
export interface DeliverySettings {
  mode?:'local'|'draft-pr'; automatic?:boolean; repository?:string; base?:string; allowedPaths?:string[];
  credentialMode?:'native-gh'; verify?:VerificationProfile; prepare?:VerificationProfile;review?:PRReviewSettings;uiEvidence?:UIEvidenceSettings;
}
export function createManagementServer(runtime:ProjectRuntime, options?:{host?:string;port?:number;token?:string}):
  Promise<{url:string;token:string;bootstrapUrl:string;close():Promise<void>}>;
export function inspectDatabase(path:string): Record<string,unknown>;
export function createDatabaseBackup(options:{path:string;destination?:string;assertStopped():boolean|Promise<boolean>}): Promise<Record<string,unknown>>;
export function migrateDatabase(options:{path:string;targetVersion:number;migrations:Array<{id:string;from:number;to:number;up(db:any):void}>;backupPath?:string;assertStopped():boolean|Promise<boolean>}): Promise<Record<string,unknown>>;
export function prepareDatabaseRestore(options:{path:string;backupPath:string;destination?:string;expectedVersion:number;reconciliation:{backupId:string;note:string};assertStopped():boolean|Promise<boolean>}): Promise<Record<string,unknown>>;

export interface ExecutorSettings {revision:number;execution:HarnessExecution|null;at?:string}
export function createCodexAppServerDriver(options?:CodexDriverOptions & {enableManagedJobs?:boolean;enableAgentTools?:boolean;prompt?:string}): AgentDriverV2;
export interface SourceAdapter {
  id:string;source:string;pollIntervalMs?:number;configurationKey?:string;
  normalize(raw:unknown):import('../dist/core/index.js').Trigger|null;
  poll(input:{cursor:unknown;signal:AbortSignal}):Promise<{events:unknown[];cursor?:unknown;errors?:Array<{scope:string;error:string;repositoryFailure?:true;object?:{kind:string;id:number;number?:number};nextAt?:string}>}>;
  deliver?(message:OutboundMessage):Promise<DeliveryReceipt|GoneDelivery>;
  readContext?(reference:unknown):Promise<unknown>;
}
export class SourceRegistry {
  constructor(options:{store:any;receive(trigger:import('../dist/core/index.js').Trigger):unknown;leaseMs?:number;now?:()=>number});
  register(adapter:SourceAdapter):this; unregister(id:string):this; ingest(id:string,event:unknown):Record<string,unknown>;
  poll(id:string):Promise<Record<string,unknown>>;pollDue(options?:{intervalMs?:number}):Promise<PromiseSettledResult<unknown>[]>;
  pollAll():Promise<PromiseSettledResult<unknown>[]>;status():Array<Record<string,unknown>>;
  deliver(message:OutboundMessage):Promise<DeliveryReceipt|GoneDelivery>;read(id:string,reference:unknown):Promise<unknown>;
  stop():Promise<void>;close():Promise<void>;
}
export function createFeishuSource(options:{id?:string;client:any;botOpenId:string;tenantKey:string;scopes:Array<{chatId:string;type:'p2p'|'group'|'topic_group';mode:'mentions'|'all'}>;maxPages?:number}):SourceAdapter;
export function createFeishuConnection(options:Record<string,unknown>):Promise<unknown>;

export interface RepositorySourceSettings {
  revision:number;enabled:boolean;observe:boolean;fetchPullHead:boolean;
  /** reviewComments defaults to false when absent in older settings. */
  streams:{pulls:boolean;issues:boolean;comments:boolean;reviewComments?:boolean;mentions?:boolean;defaultBranchCI:boolean};at?:string|null;
}
export function createGitHubRepositorySource(config:GitHubConfig,options?:{
  streams?:Partial<RepositorySourceSettings['streams']>;observe?:boolean;
  isTrackedPullRequest?(number:number):boolean;isTrackedIssue?(number:number):boolean;
  request?(path:string,options?:Record<string,unknown>):Promise<unknown>;
}):SourceAdapter;
export function createGitHubNotificationsSource(config:GitHubConfig, options?:Parameters<typeof createGitHubRepositorySource>[1]):SourceAdapter;
export interface ManagedJobsSettings {
  profiles:Record<string,({kind:'command';preview?:{url:string;ttlMs?:number}} & Omit<VerificationProfile,'kind'>)|{kind:'agent';version:string;instruction:string;paths:string[];timeoutMs?:number;maxTurns?:number}>;
  paths:string[];limits?:{maxJobs?:number;maxActive?:number;maxDepth?:number;maxDurationMs?:number};
  lifecycle?:'turn'|'assignment';childWorkspace?:'project'|'parent-snapshot';
  childExecution?:Omit<NonNullable<ExecutorSettings['execution']>,'enableAgentTools'|'contextLimits'>;
}
export interface ManagedJobRecord {
  id:string;kind:'command'|'agent';status:string;parent:{ticketId:string;assignmentId:string;runId:string;jobId?:string};
  previewLease?:PreviewLease;workspace?:Workspace;scope?:{instruction:string;paths:string[]};
  session?:DriverSession;turn?:number;maxTurns?:number;
  messages?:Array<{id:string;text:string;status:'queued'|'accepted'|'consumed'|'inspection';createdAt:string;runId?:string;parentRunId?:string;acceptedAt?:string;consumedAt?:string}>;
  turns?:Array<{number:number;runId:string;messageId:string;status:'running'|'completed'|'inspection';startedAt:string;endedAt?:string;session:DriverSession|null;report?:DriverReportV2;error?:string}>;
  /** Captured before command launch; does not reinterpret an older job using current settings. */
  executionBinding?:ManagedCommandExecutionBinding;
  /** Read-only evidence outcome persisted by recovery; absent for jobs not yet inspected. */
  recoveryInspection?:ManagedJobRecoveryInspection;
  [key:string]:unknown;
}
export interface ManagedCommandExecutionBinding {
  version:1;jobId:string;jobToken:string;parent:ManagedJobRecord['parent'];profileId:string;profileVersion:string;
  profileDigest:string;executionProfileDigest:string;commandDigest:string;workspaceProvisionId:string;ticketId:string;
}
export interface ManagedJobRecoveryInspection {
  version:1;outcome:'inspection'|'settled';reason:string;at:string;previousStatus?:string;previousCompletion?:Record<string,unknown>|null;
  evidence?:{source:'managed-job.execution';resultDigest:string;executionProfileDigest:string;jobToken:string};
}
export interface ManagedJobs {
  readonly persistent:boolean;
  beginTurn(input:{runId:string;slotChanged?(event:Record<string,unknown>):void|Promise<void>}):this;
  endTurn(options?:{handoff?:boolean}):Promise<{pending:number;previews:number;holdsSlot:boolean}>;
  launch(request:{profileId:string;text?:string;paths?:string[]},options?:{requestId?:string}):{id:string;done:Promise<ManagedJobRecord>};
  /** Queues a scoped follow-up behind the current child turn; never replays an uncertain execution. */
  message(id:string,request:{text:string},options?:{requestId?:string}):{id:string;messageId:string;status:string;done:Promise<ManagedJobRecord>};
  /** Like message, but refuses while a child turn is still active. */
  resume(id:string,request:{text:string},options?:{requestId?:string}):{id:string;messageId:string;status:string;done:Promise<ManagedJobRecord>};
  get(id:string):ManagedJobRecord;list():ManagedJobRecord[];
  wait(id:string):Promise<ManagedJobRecord>;cancel(id:string):Promise<ManagedJobRecord>;
  handoff(id:string,reason:string):Promise<ManagedJobRecord>;recover():unknown;close():Promise<void>;
  preview(id:string,options?:{ttlMs?:number}):Promise<PreviewLease>;
  renewPreview(id:string,options?:{ttlMs?:number}):Promise<PreviewLease>;
  closePreview(id:string):Promise<ManagedJobRecord>;
}
export function normalizeManagedJobsSettings(settings:ManagedJobsSettings):ManagedJobsSettings;
export function createManagedJobs(options:{
  projectRoot:string;parent:{ticketId:string;assignmentId:string;runId:string;workspace:Workspace;scope:{instruction:string;paths:string[]};depth?:number};
  profiles:ManagedJobsSettings['profiles'];limits?:ManagedJobsSettings['limits'];signal?:AbortSignal;persistentMode?:boolean;redactedEnvironmentKeys?:string[];
  journal:{list():ManagedJobRecord[];save(record:ManagedJobRecord):void};wakeParent(event:Record<string,unknown>):void;
  assertActive?():void;
  slotChanged?(event:Record<string,unknown>):void|Promise<void>;
  prepareChildWorkspace?(input:Record<string,unknown>):Promise<Workspace>;
  createChildDriver?(input:Record<string,unknown>):AgentDriver|Promise<AgentDriver>;
}):ManagedJobs;

/** Trusted byte budgets. Byte fields accept 1024..1048576; maxReads accepts 1..128. */
export interface ContextLimits {initialBytes?:number;pageBytes?:number;readBytes?:number;maxReads?:number}
export interface ContextRecordReference {resource:string;id:string;version:string}
export interface WorkerToolHost {
  readonly version:1;
  readonly identity:{ticketId:string;assignmentId:string;runId:string};
  readonly definitions:Array<{type:'function';name:string;description:string;inputSchema:Record<string,unknown>}>;
  contextResources():Array<{resource:string;id:string;value:unknown;remote?:true}>;
  consumedRecords():ContextRecordReference[];
  terminalReport():{state:DriverReportV2['state'];summary:string;question:string|null;artifacts:string[];answers?:string|null}|null;
  /** Runtime-bound identity and authorization are checked on every call, including retries.
   * Local reads/mutations remain synchronous; remote GitHub record reads may return a Promise.
   * Await this result in native bridges; only host-issued references authorize remote reads. */
  call(input:{callId:string;name:string;arguments:Record<string,unknown>;sessionId:string;turnId:string}):unknown;
}
export interface PreviewLease {
  id:string;status:'active'|'closed'|'expired'|'ended';ticketId:string;assignmentId:string;
  workspaceProvisionId?:string;jobId:string;url:string;createdAt:string;renewedAt:string|null;
  expiresAt:string;endedAt?:string;holder:'human-review';endpoint:Record<string,unknown>;tree:Record<string,unknown>;
}
export interface ChildAdoptionPlan {
  version:1;parentProvisionId:string;childProvisionId:string;paths:string[];
  baselineDigest:string;childDigest:string;digest:string;
  changes:Array<{path:string;status:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null}>;
}
export interface ChildAdoptionRecord {
  version:1;id:string;kind:'child-adoption';status:'pending'|'applying'|'applied'|'interrupted'|'rolled-back'|'recovering';
  plan:ChildAdoptionPlan;createdAt:string;endedAt?:string;appliedPaths:string[];rollbackPaths:string[];
  requiresVerification:true;recoveryDirectory:string;error?:string;parentDigestAfter?:string;
  ticketId?:string;jobId?:string;recoveryMode?:'rollback'|'finish';recoveredPaths?:string[];
}
export interface TicketTrace {
  ticketId:string;domainId:string;version:string;total:number;
  items:Array<{kind:string;id:string;at:string;value:unknown}>;nextCursor:string|null;
}
export interface SessionStatus {
  ticketId:string;session:DriverSession|null;history:Array<Record<string,unknown>>;
  execution:ExecutorSettings['execution'];promptVersion:string|null;toolVersion:number|null;contextVersion:number|null;
  harnessBinding:HarnessSessionBinding|null;
}
export interface HarnessSessionBinding {
  version:1;adapter:{id:string;version:string};workspaceRoot:string;workspaceProvisionId?:string;
  executionDigest:string;origin:'legacy-session-binding'|'new-session';session:DriverSession|null;createdAt:string;
}
export interface RecoverySettings {retryBeforeStart:boolean;autoResume:boolean;maxAttempts:number;initialDelayMs:number}
export type PromptPart = 'runtime/worker'|'runtime/coordinator'|'runtime/environment';
export interface PromptSettingsPatch {
  sections?:Partial<Record<'communication'|'scope'|'delivery',string>>;
  overrides?:Partial<Record<PromptPart,string|{text:string;base?:string;baseDigest?:string}>>;
  knowledge?:Array<{id:string;title:string;text:string}>;
}
export interface PromptSettings {
  revision:number;version:string;predecessor:number|null;at:string|null;origin:string;
  sections:Record<'communication'|'scope'|'delivery',string>;
  overrides:Partial<Record<PromptPart,{text:string;base:string;baseDigest:string}>>;
  knowledge:Array<{id:string;title:string;text:string}>;
  defaults:Record<PromptPart,{text:string;digest:string}>;
}
export interface PromptAssembly {role:'worker'|'coordinator';revision:number;version:string;settingsVersion:string;digest:string;text:string;parts:string[]}
/** Private runtime-to-adapter snapshot; public ticket views expose only revision and application facts. */
export interface WorkerPolicySnapshot {
  version:1;revision:number;digest:string;settingsVersion:string;text:string;
  basePrompt:string;baseDigest:string;sourcePromptDigest:string;
}
export interface WorkerPolicyObservation {
  version:1;revision:number;digest:string;status:'selected'|'accepted'|'applied';at:string;evidence:Record<string,unknown>;
}
export type NativeWaitReason='budget'|'rate-limit'|'authentication'|'transient'|'unknown';
export interface ExecutionStateEvent {
  version:1;driver:string;runId:string;sessionId:string;sequence:number;
  state:'waiting'|'active'|'ended';turnId?:string|null;at?:string;reason?:string|null;evidence:string;
  provider?:string|null;attempts?:number|null;since?:string|null;nextAt?:string|null;
}
export interface ExecutionObservation extends ExecutionStateEvent {
  at:string;turnId:string|null;reason:string|null;previousWait?:ExecutionObservation;
}
export interface PromptStatus {
  settings:PromptSettings;history:PromptSettings[];
  diff:Array<{key:PromptPart;overridden:boolean;changed:boolean;oldDefault:string;newDefault:string;custom:string|null;requiredPlaceholders:string[]}>;
  assembled:{worker:PromptAssembly;coordinator:PromptAssembly};
}
export interface BusinessIncident {
  id:string;key:string;kind:string;subject:string;severity:string;summary:string;action:string;facts:Record<string,unknown>;
  status:'active'|'resolved';revision:number;occurrences:number;startedAt:string;updatedAt:string;
  resolvedAt:string|null;acknowledgedAt:string|null;resolution?:string;
}
export interface BusinessHealth {
  at:string;
  sources:Array<{id:string;state:'disabled'|'stopped'|'stale'|'degraded'|'healthy'|'starting';healthy:boolean;enabled:boolean;lastAttempt:string|null;lastSuccess:string|null;consecutiveFailures:number;staleAfterMs:number}>;
  /** Current active native waits only; an absent provider/retry time is unknown, never inferred. */
  models:Array<{runId:string;sessionId:string;driver:string;reason:NativeWaitReason;provider:string|null;attempts:number|null;since:string|null;at:string|null;nextAt:string|null}>;
  incidents:BusinessIncident[];
  transitions:Array<{incidentId:string;revision:number;transition:'opened'|'changed'|'resolved';at:string;reason?:string}>;
}

export type ManagementIntent = {kind:'retry'|'unsubscribe'|'dismiss';target:string;expectedRevision:string}
  | {kind:'configure';target:'scheduler'|'recovery'|'repository'|'prompts';settings:Record<string,unknown>;expectedRevision:number};
export interface PromptPreview {revision:number;draft:PromptStatus['assembled'];saved:PromptStatus['assembled'];defaults:PromptStatus['assembled']}
export interface UIEvidenceSettings {mode?:'auto'|'required'|'off';paths?:string[];capture?:VerificationProfile;scenario?:string;viewport?:{width:number;height:number};theme?:'light'|'dark'|'system'}
export interface UIEvidenceCapture {phase:'before'|'after';path:string;sha256:string;bytes:number;conditions:{scenario:string;viewport:{width:number;height:number};theme:string};conditionsDigest:string;profileDigest:string;treeDigest:string;uiTreeDigest:string;paths:string[];verificationId:string;at:string;workspaceProvisionId:string;baseCommit:string|null}
export interface UIEvidenceRecord {workspaceProvisionId:string;baselineTrusted?:boolean;status:'baseline-recorded'|'incomplete'|'complete'|'not-required';beforeTree?:{digest:string;files:string[]};before?:UIEvidenceCapture;after?:UIEvidenceCapture;error?:string;settings?:UIEvidenceSettings}

export interface AdmissionMatrix {
  listedUnaddressed?:boolean|'inferred'|'ignore';
  unlistedAddressed?:boolean|'explicit'|'inferred'|'ignore';
  unlistedUnaddressed?:boolean|'inferred'|'ignore';
}
export interface PolicySourceRow {id:string;source:string;scope?:Record<string,string|number>;actors?:string[];bots?:string[];admission?:AdmissionMatrix}

import { readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { prepareCodexIsolation, readCodexIsolationConfig } from './codex-isolation.mjs';
import { normalizeDriverReport } from '../runtime/reports.mjs';
import { hostToolSettled, nativeJsonResult, recoveryInspection } from './native-recovery.mjs';
import { codexSessionHome } from './codex-home.mjs';
import { projectStateDirectory } from '../state-paths.mjs';

export const CODEX_HISTORY_VERSION = '0.166.0-alpha.5.1';
export const codexRecoverySignature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID = /^[A-Za-z\d._:-]{1,160}$/;
function jsonFile(path) { if (statSync(path).size > 1024 * 1024) throw new Error('Native recovery record exceeds limit'); return JSON.parse(readFileSync(path, 'utf8')); }

/** Interpret only the pinned public thread/read shape. Unknown or unfinished tools fail closed. */
export function inspectCodexHistory(thread, record, inputs = [], options = {}) {
  const reject = reason => recoveryInspection({ ...options, session: record.session, runId: record.runId }, reason);
  if (thread?.id !== record.session.id || thread.cliVersion !== CODEX_HISTORY_VERSION || resolve(thread.cwd ?? '') !== record.cwd ||
      !['notLoaded','idle','systemError'].includes(thread.status?.type) || !Array.isArray(thread.turns)) return reject('native-history-binding-or-active');
  const turn = thread.turns.at(-1);
  if (!turn || turn.id !== record.turnId || (turn.itemsView && turn.itemsView !== 'full') || !Array.isArray(turn.items) ||
      !['completed','interrupted','failed','inProgress'].includes(turn.status)) return reject('native-turn-unavailable');
  const messages = turn.items.filter(item => item.type === 'userMessage');
  if (!messages.some(item => item.clientId === `run-${record.runId}`)) return reject('native-run-anchor-missing');
  const harmless = new Set(['userMessage','agentMessage','reasoning','plan']);
  for (const item of turn.items) {
    if (harmless.has(item.type)) continue;
    if (item.type === 'commandExecution' && ['completed','failed','declined'].includes(item.status) && (item.status === 'declined' || Number.isInteger(item.exitCode))) continue;
    if (item.type === 'fileChange' && ['completed','failed','declined'].includes(item.status)) continue;
    if (item.type === 'dynamicToolCall' && item.status === 'completed' && item.success === true && item.namespace == null) {
      try {
        const result = nativeJsonResult(item.contentItems, 'inputText');
        if (hostToolSettled(options.verifyHostTool, { driver: 'codex-app-server', runId: record.runId, sessionId: record.session.id,
          turnId: turn.id, nativeCallId: item.id, callId: item.id, name: item.tool, arguments: item.arguments, result })) continue;
      } catch { /* An absent or malformed native result never proves host settlement. */ }
      return reject('host-tool-receipt-unverified');
    }
    return reject('native-tool-unsettled-or-unsupported');
  }
  const observed = new Set(messages.map(item => item.clientId).filter(Boolean));
  if (inputs.some(input => !['not-sent','rejected'].includes(input.status) && !observed.has(input.inputId))) return reject('native-input-unresolved');
  const proof = { version:1,kind:'interrupted',safeToResume:true,toolsSettled:true,session:record.session,
    checkpoint:{runId:record.runId,eventSequence:turn.items.length},code:'HISTORY_VERIFIED',outcome:'resume',
    readInputIds:inputs.filter(input=>observed.has(input.inputId)).map(input=>input.inputId),contextRecords:record.contextRecords ?? [] };
  if (turn.status !== 'completed') return proof;
  const text = turn.items.filter(item=>item.type==='agentMessage'&&item.phase!=='commentary').at(-1)?.text;
  let parsed; try { parsed=JSON.parse(text); } catch { return reject('native-report-invalid'); }
  const initialIds=new Set((record.contextRecords??[]).map(ref=>ref.id));
  if (!parsed || !Array.isArray(parsed.artifacts) || !(parsed.question===null||typeof parsed.question==='string') ||
      !Array.isArray(parsed.acknowledgedInputIds) || parsed.acknowledgedInputIds.some(id=>!observed.has(id)&&!initialIds.has(id)) ||
      Object.keys(parsed).some(key=>!['state','summary','artifacts','question','questionForTriggerId','decision','answers','acknowledgedInputIds'].includes(key)) ||
      !(parsed.questionForTriggerId===undefined||parsed.questionForTriggerId===null||typeof parsed.questionForTriggerId==='string') ||
      parsed.questionForTriggerId&&!parsed.question) return reject('native-report-invalid');
  const report={version:2,state:parsed.state,summary:parsed.summary,artifacts:parsed.artifacts,attention:parsed.question?{question:parsed.question,...(parsed.questionForTriggerId?{triggerId:parsed.questionForTriggerId}:{}),...(parsed.decision!=null?{decision:parsed.decision}:{})}:null,...(parsed.answers == null ? {} : {answers:parsed.answers})};
  try { normalizeDriverReport(report,{version:2}); } catch { return reject('native-report-invalid'); }
  return {...proof,outcome:'completed',report,readInputIds:parsed.acknowledgedInputIds.filter(id=>inputs.some(input=>input.inputId===id))};
}

/** Only the typed native protocol can classify a retry; error prose is never evidence. */
export function codexFailure(error) {
  const info=error?.codexErrorInfo;
  if(info==='rateLimitExceeded')return {code:'RATE_LIMIT'};
  if(['internalServerError','serverOverloaded','flexUnavailable'].includes(info))return {code:'SERVER'};
  for(const kind of ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']){
    const status=info?.[kind]?.httpStatusCode;
    if(status===429)return {code:'RATE_LIMIT',statusCode:status};
    if(status===408)return {code:'TIMEOUT',statusCode:status};
    if([500,502,503,504].includes(status))return {code:'SERVER',statusCode:status};
  }
  return {};
}

export async function inspectCodexRecovery({ executable, signature, ...input }) {
  const reject = reason => recoveryInspection(input, reason);
  if (!ID.test(input.runId??'') || input.session?.driver !== 'codex-app-server') return reject('native-history-binding-mismatch');
  const cwd=realpathSync(input.projectRoot), runs=join(projectStateDirectory(realpathSync(input.sourceProjectRoot)),'runs');
  const path=join(runs,input.runId,'native-run.json');
  let record; try { if(realpathSync(path)!==path)return reject('native-run-anchor-mismatch'); record=jsonFile(path); } catch { return reject('native-run-anchor-missing'); }
  if(record.version!==1||record.signature!==signature||record.cwd!==cwd||record.runId!==input.runId||record.session?.id!==input.session.id||!record.turnId)return reject('native-history-binding-mismatch');
  const env=Object.fromEntries(['PATH','HOME','CODEX_HOME','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','OPENAI_API_KEY'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  const sessionHome=codexSessionHome({sourceRoot:realpathSync(input.sourceProjectRoot),sessionId:input.session.id,env});
  if(sessionHome)env.CODEX_HOME=sessionHome.path;
  const {stdout}=await promisify(execFile)(executable,['--version'],{env,signal:input.signal,timeout:5000,maxBuffer:8192});
  if(stdout.trim()!==`codex-cli ${CODEX_HISTORY_VERSION}`)return reject('native-version-unsupported');
  const policy=await prepareCodexIsolation({executable,cwd,env,signal:input.signal,extraArgs:['-c','approval_policy="never"','-c','sandbox_mode="read-only"']});
  const result=await readCodexIsolationConfig({executable,cwd,env,args:policy.args,policy,signal:input.signal,threadId:input.session.id});
  return inspectCodexHistory(result?.thread,record,input.inputs,input);
}

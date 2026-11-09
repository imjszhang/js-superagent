import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCodexHistory, CODEX_HISTORY_VERSION, codexFailure } from '../src/drivers/codex-history.mjs';
const record={runId:'run-1',session:{driver:'codex-app-server',id:'session-1'},cwd:'/tmp/project',turnId:'turn-1',contextRecords:[{resource:'triggers',id:'original',version:'v1'}]};
const history=()=>({id:record.session.id,cwd:record.cwd,cliVersion:CODEX_HISTORY_VERSION,status:{type:'notLoaded'},turns:[{id:record.turnId,status:'interrupted',itemsView:'full',items:[{type:'userMessage',clientId:'run-run-1'},{type:'commandExecution',status:'completed',exitCode:0}]}]});
test('W9 pinned Codex history proves interrupted state only with matched terminal tools and run identity',()=>{
  assert.equal(inspectCodexHistory(history(),record).outcome,'resume');
  for(const change of [h=>h.status.type='active',h=>h.cliVersion='unknown',h=>h.cwd='/another',h=>h.turns[0].id='different',h=>h.turns[0].items[0].clientId=null,h=>h.turns[0].items[1].status='inProgress',h=>h.turns[0].items.push({type:'dynamicToolCall',status:'completed'})]){
    const h=history();change(h);assert.equal(inspectCodexHistory(h,record),null);
  }
});
test('W9 completed reports and consumed live inputs reconcile; missing queued messages remain uncertain',()=>{
  const h=history(),input={inputId:'feedback-1',status:'unknown'};
  assert.equal(inspectCodexHistory(h,record,[input]),null);
  h.turns[0].items.push({type:'userMessage',clientId:input.inputId});
  assert.deepEqual(inspectCodexHistory(h,record,[input]).readInputIds,['feedback-1']);
  h.turns[0].status='completed';
  const report={state:'ready',summary:'Already finished',question:null,artifacts:[],acknowledgedInputIds:['original','feedback-1']};
  h.turns[0].items.push({type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)});
  const proof=inspectCodexHistory(h,record,[input]);assert.equal(proof.outcome,'completed');assert.equal(proof.report.summary,'Already finished');assert.deepEqual(proof.readInputIds,['feedback-1']);
  h.turns[0].items.at(-1).text='not a report';assert.equal(inspectCodexHistory(h,record,[input]),null);
});
test('W9 typed Codex errors retain transient classification without trusting error prose',()=>{
  assert.deepEqual(codexFailure({message:'HTTP 429'}),{});
  assert.deepEqual(codexFailure({codexErrorInfo:'unauthorized'}),{});
  assert.deepEqual(codexFailure({codexErrorInfo:'rateLimitExceeded'}),{code:'RATE_LIMIT'});
  assert.deepEqual(codexFailure({codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:503}}}),{code:'SERVER',statusCode:503});
});

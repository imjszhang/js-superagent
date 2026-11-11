import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeDshTurn, validateDshOptions, createDshSdkDriver, probeDsh, parseDshReport } from '../src/drivers/dsh.mjs';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { Store } from '../src/store.mjs';

const fixtureOwners = new WeakSet();
function fixture(t, behavior = '', nativeVersion = '0.2.1-rc.5') {
  const root = mkdtempSync(join(tmpdir(), 'js-dsh-'));
  const executable = join(root, 'fake-dsh.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync,readFileSync,existsSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
if(process.argv.includes('--version')){console.log(${JSON.stringify(nativeVersion)});process.exit(0);}
const send=v=>console.log(JSON.stringify(v)); let seq=0,sid;
const report=JSON.stringify({version:2,state:'ready',summary:'verified',artifacts:[],attention:null});
const event=(type,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId:sid,event:{type,data,seq:++seq}}});
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line),answer=v=>send({jsonrpc:'2.0',id:r.id,result:v});
 ${behavior}
 if(r.method==='initialize')answer({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});
 else if(r.method==='session/resume'){
  if(!existsSync(join(process.env.DSH_HOME,'fake-session')))send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'missing'}});else answer({});
 }
 else if(r.method==='session/working-directory/get'){sid=r.params.sessionId;answer({cwd:process.cwd()});}
 else if(r.method==='session/prompt'){
  writeFileSync(join(process.env.DSH_HOME,'fake-session'),'durable');
  writeFileSync(join(process.cwd(),'input.txt'),r.params.contentBlocks[0].text);
  answer({messageId:'input-1'});event('user/message',{id:'input-1'});
  event('assistant/message',{message:{content:[{type:'text',text:report}]}});
  event('turn/end',{reason:{kind:'completed'}});
 }else if(r.method==='session/wait')answer({});
 else if(r.method==='shutdown'){answer({});process.exit(0);}
}
`, { mode: 0o700 });
  if (!fixtureOwners.has(t)) {
    fixtureOwners.add(t); const previous = process.env.JS_DSH_TEST_KEY;
    t.after(() => { if(previous === undefined)delete process.env.JS_DSH_TEST_KEY;else process.env.JS_DSH_TEST_KEY=previous; });
  }
  process.env.JS_DSH_TEST_KEY = 'fake-key-to-redact-only';
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const options = { executable, model: 'test-model', backend: { auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://api.deepseek.com/anthropic',apiKeyEnv:'JS_DSH_TEST_KEY' },killGraceMs:30,timeoutMs:5000 };
  const sessions=[],pids=[];
  return {root,options,sessions,pids,input:{projectRoot:root,runId:randomUUID(),signal:new AbortController().signal,prompt:'do bounded work',checkpoint:v=>sessions.push(v),registerProcess:pid=>pids.push(pid)}};
}
const alive = pid => {try{process.kill(pid,0);return true;}catch{return false;}};

function runtimeFixture(t, f, execution = {}) {
  const opened=[];
  const open=()=>{
    const runtime=createProjectAgent({projectRoot:f.root,execution:{driver:'dsh-sdk',...f.options,enableAgentTools:true,enableManagedJobs:true,...execution}}).init();
    opened.push(runtime);return runtime;
  };
  t.after(async()=>{for(const runtime of opened.reverse()){await runtime.stop();runtime.close();}});
  const stored=(id, update)=>{
    const store=new Store(join(stateDir(f.root),'state.sqlite'));
    try{const meta=store.getMeta(`ticket:${id}`);if(update){update(meta);store.setMeta(`ticket:${id}`,meta);}return meta;}finally{store.close();}
  };
  const binding=id=>JSON.parse(readFileSync(join(stateDir(f.root),'harness/dsh',id,'binding.json'),'utf8'));
  return {open,stored,binding};
}

test('runtime narrows DSH managed tools per ticket without enabling project-disabled tools',async t=>{
  for(const enableManagedJobs of [true,false]){
    const f=fixture(t),{open,binding}=runtimeFixture(t,f,{enableManagedJobs}),runtime=open();
    runtime.configureJobs({paths:['fake-dsh.mjs'],profiles:{check:{kind:'command',version:'1',command:process.execPath,args:['-e','process.exit(0)'],environment:'host',allowHostExecution:true,timeoutMs:1000}}},{expectedRevision:0});
    for(const managedJobs of [false,true]){
      const ticket=runtime.submit({text:'Verify a bounded task',managedJobs});
      await runtime.runNext();
      assert.equal(runtime.get(ticket.id).status,'completed');
      const expected=enableManagedJobs&&managedJobs,session=runtime.getSession(ticket.id);
      assert.equal(runtime.sessionStatus(ticket.id).execution.enableManagedJobs,expected);
      assert.equal(binding(session.id).managedJobs,expected);
      assert.equal(binding(session.id).agentTools,true,'Unrelated business tools remain available');
      assert.equal(readFileSync(join(f.root,'input.txt'),'utf8').includes('js_superagent_job_*'),expected);
      assert.equal(runtime.executorStatus().effective.enableManagedJobs,enableManagedJobs,'Ticket grants cannot mutate project settings');
      assert.deepEqual(runtime.listJobs(ticket.id),[]);
    }
  }
});

test('runtime retries a legacy pre-session DSH failure using the ticket grant',async t=>{
  const f=fixture(t),{open,stored,binding}=runtimeFixture(t,f),runtime=open();
  // Reproduce the old persisted state: a globally enabled adapter, no jobs host,
  // and a failure before any native session checkpoint. The old version saved
  // this same executor/binding even when the ticket grant was false.
  const ticket=runtime.submit({text:'Retry bounded work'});await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'failed');
  assert.match(runtime.get(ticket.id).reports.at(-1).summary,/trusted runtime manager and profile catalog/);
  assert.equal(runtime.getSession(ticket.id),null);
  assert.ok(stored(ticket.id).harnessBinding);
  stored(ticket.id,meta=>{meta.managedJobs=false;});
  runtime.retry(ticket.id);await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'completed');
  assert.equal(stored(ticket.id).executionConfig.enableManagedJobs,false);
  assert.equal(binding(runtime.getSession(ticket.id).id).managedJobs,false);
});

test('DSH history inspection and native retry retain narrowed tools after runtime reopen',async t=>{
  const f=fixture(t,`
    if(r.method==='session/prompt'&&!existsSync(join(process.env.DSH_HOME,'failed-once'))){
      writeFileSync(join(process.env.DSH_HOME,'failed-once'),'yes');
      writeFileSync(join(process.env.DSH_HOME,'fake-session'),'durable');
      const user={id:'failed-input',content:r.params.contentBlocks};
      const terminal={reason:{kind:'error',error:{code:'RATE_LIMIT',message:'Retry after inspection'}}};
      const history=join(process.env.DSH_HOME,'sessions','fixture',sid);mkdirSync(history,{recursive:true});
      writeFileSync(join(history,'session.v4.jsonl'),[
        {type:'session',version:4,id:sid,cwd:process.cwd(),isSeeded:false},
        {seq:0,type:'user/message',data:user},{seq:1,type:'turn/end',data:terminal}
      ].map(value=>JSON.stringify(value)).join('\\n')+'\\n');
      answer({messageId:user.id});event('user/message',user);event('turn/end',terminal);continue;
    }
  `);
  const {open,stored,binding}=runtimeFixture(t,f);
  let runtime=open();const ticket=runtime.submit({text:'Inspect and resume bounded work',managedJobs:false});
  await runtime.runNext();assert.equal(runtime.get(ticket.id).status,'failed');
  const session=runtime.getSession(ticket.id),originalBinding=binding(session.id);
  assert.equal(originalBinding.managedJobs,false);
  runtime.close();runtime=open();runtime.retry(ticket.id);
  assert.equal(stored(ticket.id).recovery.status,'inspect');
  await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status,'completed');
  assert.equal(stored(ticket.id).recovery.status,'completed');
  assert.equal(stored(ticket.id).recovery.evidence.code,'HISTORY_VERIFIED');
  assert.deepEqual(runtime.getSession(ticket.id),session);
  assert.deepEqual(binding(session.id),originalBinding);
  assert.equal(stored(ticket.id).executionConfig.enableManagedJobs,false);
  assert.doesNotMatch(readFileSync(join(f.root,'input.txt'),'utf8'),/js_superagent_job_\*/);
});

test('DSH configuration rejects unsupported routes and undeclared abilities',()=>{
  const options={model:'m',backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://example.com/anthropic',apiKeyEnv:'KEY'}};
  assert.equal(validateDshOptions(options).permission,'workspace-write');
  assert.equal(validateDshOptions(options,{role:'coordinator'}).permission,'read-only');
  for(const patch of [{enableAgentTools:'yes'},{enableManagedJobs:1},{permission:'bypass'},{backend:{...options.backend,baseURL:'https://user:password@example.com'}}])assert.throws(()=>validateDshOptions({...options,...patch}));
  assert.throws(()=>validateDshOptions({...options,enableAgentTools:true},{driver:'dsh-headless'}));
  assert.equal(createDshSdkDriver({...options,enableAgentTools:true}).capabilities.agentTools,true);
  assert.equal(createDshSdkDriver(options).capabilities.sessionResume,true);
});
test('SDK checkpoints before prompt, resumes exact persisted identity and cleans owned processes',async t=>{
  const f=fixture(t); const result=await executeDshTurn(f.options,f.input);
  assert.equal(JSON.parse(result.text).state,'ready');assert.equal(f.sessions.length,1);assert.equal(f.pids.length,2);assert.ok(f.pids.every(pid=>!alive(pid)));
  const next=await executeDshTurn(f.options,{...f.input,runId:randomUUID(),session:f.sessions[0],prompt:'/permission must remain literal'});
  assert.equal(next.sessionId,result.sessionId);assert.equal(readFileSync(join(f.root,'input.txt'),'utf8'),'/permission must remain literal');
  await assert.rejects(executeDshTurn({...f.options,model:'another'}, {...f.input,runId:randomUUID(),session:f.sessions[0]}),/configuration changed/);
});
test('SDK alpha.2 supports its declared protocol while unknown native versions remain rejected',async t=>{
  const f=fixture(t,'','0.2.2-alpha.2');
  assert.equal((await probeDsh(f.options)).version,'0.2.2-alpha.2');
  const first=await executeDshTurn(f.options,f.input);
  const second=await executeDshTurn(f.options,{...f.input,runId:randomUUID(),session:f.sessions[0]});
  assert.equal(first.sessionId,second.sessionId);assert.ok(f.pids.every(pid=>!alive(pid)));
  const unknown=fixture(t,'','0.2.2-alpha.999');
  await assert.rejects(probeDsh(unknown.options),/Unsupported DSH version/);
  assert.equal(unknown.pids.length,0);
  const old=fixture(t);await executeDshTurn(old.options,old.input);
  const bindingPath=join(stateDir(old.root), 'harness/dsh',old.sessions[0].id,'binding.json');
  const originalBinding=readFileSync(bindingPath,'utf8');
  writeFileSync(old.options.executable,readFileSync(old.options.executable,'utf8').replace('"0.2.1-rc.5"','"0.2.2-alpha.2"'));
  await assert.rejects(executeDshTurn(old.options,{...old.input,runId:randomUUID(),session:old.sessions[0]}),/configuration changed/);
  assert.equal(readFileSync(bindingPath,'utf8'),originalBinding,'A binary upgrade cannot rewrite an existing session binding');
});
test('SDK native failure and cancellation cannot become successful output',async t=>{
  const f=fixture(t,`if(r.method==='session/prompt'){answer({messageId:'i'});continue;}if(r.method==='session/wait')continue;`);
  const controller=new AbortController();const running=executeDshTurn(f.options,{...f.input,signal:controller.signal});
  const assertion=assert.rejects(running,/cancel/);
  const deadline=Date.now()+4000;while(!f.sessions.length && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  controller.abort();await assertion;assert.ok(f.pids.every(pid=>!alive(pid)));
});
test('coordinator profile removes tools, and unavailable restored session is not recreated',async t=>{
  const f=fixture(t);await executeDshTurn(f.options,{...f.input,role:'coordinator'});
  assert.equal(f.sessions[0].driver,'dsh-sdk-assessor');
  const patches=JSON.parse(readFileSync(join(stateDir(f.root),'harness','dsh',f.sessions[0].id,'profiles','sdk','cordis.patch.yml'),'utf8'));
  for(const id of ['tool-fs','tool-fs-search','tool-bash','tool-pwsh','tool-jobs','tool-skill'])assert.equal(patches.find(p=>p.id===id).disabled,true);
  await assert.rejects(executeDshTurn(f.options,{...f.input,runId:randomUUID(),session:{driver:'dsh-sdk',id:'js-missing'}}),/binding is missing/);
});
test('SDK does not accept repaired historical output as the current input result',async t=>{
  const f=fixture(t,`
    if(r.method==='session/working-directory/get'){
      sid=r.params.sessionId;event('assistant/message',{turn:1,message:{content:[{type:'text',text:report}]}});event('turn/end',{turn:1,reason:{kind:'completed'}});answer({cwd:process.cwd()});continue;
    }
    if(r.method==='session/prompt'){answer({messageId:'current'});event('user/message',{id:'current'});continue;}
  `);
  await assert.rejects(executeDshTurn(f.options,f.input),/does not follow the submitted input/);
  assert.ok(f.pids.every(pid=>!alive(pid)));
});

test('SDK live input separates enqueue/read and deduplicates the stable host input', async t => {
  const f=fixture(t,`
    if(r.method==='session/prompt'){
      const count=globalThis.prompts=(globalThis.prompts??0)+1;
      if(count===1){answer({messageId:'original'});event('user/message',{id:'original'});continue;}
      writeFileSync(join(process.cwd(),'followup-count.txt'),String(count-1));
      answer({messageId:'followup-native'});
      setTimeout(()=>{event('user/message',{id:'followup-native'});event('assistant/message',{turn:2,message:{content:[{type:'text',text:report}]}});event('turn/end',{turn:2,reason:{kind:'completed'}});},40);
      continue;
    }
    if(r.method==='session/wait'){setTimeout(()=>answer({}),80);continue;}
  `);
  let control, sending, accepted, reads=[];
  const result=await executeDshTurn(f.options,{...f.input,
    onLiveControl(value){control=value;if(value)sending=(async()=>{
      const first=value.sendInput({inputId:'host-input-1',text:'Additional constraint'});
      const repeated=value.sendInput({inputId:'host-input-1',text:'Additional constraint'});
      accepted=await first;assert.deepEqual(await repeated,accepted);assert.equal(accepted.read,false);assert.equal(reads.length,0);
      await assert.rejects(value.sendInput({inputId:'host-input-1',text:'Changed content'}),/identity conflict/);
    })();},
    inputRead(value){assert.equal(control.validateInputRead(value),true);assert.equal(control.validateInputRead({...value,evidence:{...value.evidence,messageId:'forged'}}),false);reads.push(value);},
  });
  await sending;assert.equal(JSON.parse(result.text).state,'ready');assert.equal(readFileSync(join(f.root,'followup-count.txt'),'utf8'),'1');
  assert.equal(reads.length,1);assert.equal(reads[0].evidence.type,'native-user-message');assert.equal(reads[0].evidence.messageId,accepted.messageId);
  const journal=JSON.parse(readFileSync(join(stateDir(f.root), 'harness/dsh',result.sessionId,'input-receipts.json'),'utf8'));
  assert.equal(journal['host-input-1'].state,'read');assert.equal(control,null);
});

test('SDK interrupted unread feedback is retained and never blindly re-enqueued on resume', async t => {
  const f=fixture(t,`
    if(r.method==='session/prompt'){
      writeFileSync(join(process.env.DSH_HOME,'fake-session'),'durable');
      answer({messageId:'pending-native'});continue;
    }
    if(r.method==='session/wait')continue;
  `);
  const controller=new AbortController();let accepted;
  const running=executeDshTurn(f.options,{...f.input,signal:controller.signal,onLiveControl(value){if(value)accepted=value.sendInput({inputId:'cancelled-input',text:'Keep this once'}).then(()=>controller.abort());}});
  await assert.rejects(running,/cancel/);await accepted;
  await assert.rejects(executeDshTurn(f.options,{...f.input,runId:randomUUID(),session:f.sessions[0]}),/unconfirmed queued feedback/);
  const journal=JSON.parse(readFileSync(join(stateDir(f.root), 'harness/dsh',f.sessions[0].id,'input-receipts.json'),'utf8'));
  assert.equal(journal['cancelled-input'].state,'accepted');assert.ok(f.pids.every(pid=>!alive(pid)));
});

test('SDK exposes transient evidence only for typed native failure without tool dispatch', async t => {
  for (const [code,tool,expected] of [['RATE_LIMIT',false,true],['AUTH',false,false],['SERVER',true,false]]) {
    const f=fixture(t,`
      if(r.method==='session/prompt'){
        answer({messageId:'original'});event('user/message',{id:'original'});
        ${tool ? "event('tool/call',{callId:'unknown-shell',name:'bash'});" : ''}
        event('turn/end',{turn:1,reason:{kind:'error',error:{code:'${code}',message:'Native retry exhausted'}}});continue;
      }
      if(r.method==='session/wait'){send({jsonrpc:'2.0',id:r.id,error:{code:-32000}});continue;}
    `);
    await assert.rejects(executeDshTurn(f.options,f.input),error=>{
      assert.equal(!!error.recoveryEvidence,expected);
      if(expected){assert.equal(error.recoveryEvidence.code,code);assert.equal(error.recoveryEvidence.session.id,f.sessions[0].id);assert.equal(error.recoveryEvidence.toolsSettled,true);}
      return true;
    });
  }
});


test('SDK project rules load only current directory ancestors and refresh the recorded snapshot on resume',async t=>{
  const f=fixture(t,'','0.2.2-alpha.2'),driver=createDshSdkDriver(f.options),facts=[];
  writeFileSync(join(f.root,'AGENTS.md'),'ROOT_RULE_FIRST');
  mkdirSync(join(f.root,'unrelated'));writeFileSync(join(f.root,'unrelated/AGENTS.md'),'UNRELATED_RULE_'.repeat(6000));
  const input={...f.input,ticket:{id:'rules-ticket',text:'Bounded work',scope:'Only result.txt'},checkpointNative:value=>facts.push(value)};
  await driver.run(input);
  assert.match(readFileSync(join(f.root,'input.txt'),'utf8'),/ROOT_RULE_FIRST/);
  assert.doesNotMatch(readFileSync(join(f.root,'input.txt'),'utf8'),/UNRELATED_RULE_/);
  const first=facts.find(x=>x.projectRules).projectRules;
  assert.equal(first.version,2);assert.deepEqual(first.files.map(x=>x.path),['AGENTS.md']);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir(f.root), 'harness-context',input.runId,'project-rules.json'))),first);
  writeFileSync(join(f.root,'AGENTS.md'),'ROOT_RULE_REFRESHED');const runId=randomUUID();
  await driver.run({...input,runId,session:f.sessions[0]});
  assert.equal(f.sessions.at(-1).id,f.sessions[0].id);
  const next=facts.filter(x=>x.projectRules).at(-1).projectRules;
  assert.notEqual(next.files[0].sha256,first.files[0].sha256);
  const prompt=readFileSync(join(f.root,'input.txt'),'utf8');assert.match(prompt,/ROOT_RULE_REFRESHED/);assert.doesNotMatch(prompt,/ROOT_RULE_FIRST|UNRELATED_RULE_/);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir(f.root), 'harness-context',runId,'project-rules.json'))),next);
  assert.ok(f.pids.every(pid=>!alive(pid)));
});

test('a DSH report that ends the message is accepted after a leading sentence', () => {
  const bare = { version: 2, state: 'ready', summary: 'Fetched the title.', artifacts: ['subtask/fetch.json'], attention: null, answers: null };
  assert.equal(parseDshReport(JSON.stringify(bare)).state, 'ready');
  assert.equal(parseDshReport(`The fetch job completed successfully.\n\n${JSON.stringify(bare)}`).summary, 'Fetched the title.');
  assert.equal(parseDshReport(`Done.\n\`\`\`json\n${JSON.stringify(bare, null, 2)}\n\`\`\``).artifacts[0], 'subtask/fetch.json');
  assert.throws(() => parseDshReport(`${JSON.stringify(bare)}\nMore text after the report.`), /not a JSON report/);
  assert.throws(() => parseDshReport('No report at all.'), /not a JSON report/);
  assert.throws(() => parseDshReport(`Note ${JSON.stringify({ ...bare, version: 1 })}`), /not a JSON report/);
  assert.throws(() => parseDshReport(`Note ${JSON.stringify({ ...bare, state: 'invented' })}`), /Invalid DSH business report/);
});

test('SDK distinguishes completed reasoning-only output from incomplete native turns', async t => {
  for (const [final, reason, code] of [
    [[{ type: 'reasoning', text: 'synthetic placeholder' }], { kind: 'completed' }, 'DSH_MISSING_FINAL_REPORT'],
    [[{ type: 'text', text: ' \n\t' }], { kind: 'completed' }, 'DSH_MISSING_FINAL_REPORT'],
    [[{ type: 'text', text: 'an interrupted response' }], { kind: 'max-tokens' }, 'DSH_TURN_INCOMPLETE'],
  ]) {
    const f = fixture(t, `if(r.method==='session/prompt'){
      answer({messageId:'original'});event('user/message',{id:'original'});
      event('assistant/message',{turn:1,message:{content:[{type:'text',text:report}]}});
      event('tool/call',{turn:1,callId:'read',name:'bash'});
      event('tool/result',{turn:1,message:{toolCallId:'read',isError:false}});
      event('assistant/message',{turn:1,message:{content:${JSON.stringify(final)}}});
      event('turn/end',{turn:1,reason:${JSON.stringify(reason)}});continue;
    }`, '0.2.2-alpha.2');
    await assert.rejects(executeDshTurn(f.options, f.input), error => error.code === code);
    assert.ok(f.pids.every(pid => !alive(pid)));
  }
});

test('SDK invalid report is typed separately and report continuation keeps the same native session', async t => {
  const f = fixture(t, `if(r.method==='session/prompt'&&!existsSync(join(process.env.DSH_HOME,'invalid-once'))){
    writeFileSync(join(process.env.DSH_HOME,'invalid-once'),'yes');writeFileSync(join(process.env.DSH_HOME,'fake-session'),'durable');
    answer({messageId:'original'});event('user/message',{id:'original'});
    event('assistant/message',{turn:1,message:{content:[{type:'text',text:'Completed without the requested JSON report.'}]}});
    event('turn/end',{turn:1,reason:{kind:'completed'}});continue;
  }`, '0.2.2-alpha.2');
  const driver = createDshSdkDriver(f.options), input = { ...f.input, ticket: { id: 'ticket', text: 'Inspect existing material', scope: 'Read-only' } };
  await assert.rejects(driver.run(input), error => error.code === 'DSH_INVALID_FINAL_REPORT');
  const session = f.sessions[0];
  const result = await driver.run({ ...input, runId: randomUUID(), session, recoveryContinuation: { sourceRunId: input.runId, finalReportFailure: 'invalid-final-report' } });
  assert.equal(result.state, 'ready'); assert.deepEqual(f.sessions.at(-1), session);
  const prompt = readFileSync(join(f.root, 'input.txt'), 'utf8');
  assert.match(prompt, /Continue this same saved native session/);
  assert.match(prompt, /Do not replay the original request or repeat completed actions/);
  assert.ok(f.pids.every(pid => !alive(pid)));
});

test('runtime repairs a settled DSH reasoning-only turn in the original session without replaying tools', async t => {
  const f = fixture(t, `if(r.method==='session/prompt'){
    const folder=join(process.env.DSH_HOME,'sessions','fixture',sid);mkdirSync(folder,{recursive:true});
    const path=join(folder,'session.v4.jsonl'), existed=existsSync(path);
    const rows=existed?readFileSync(path,'utf8').trim().split('\\n').map(JSON.parse).slice(1):[];
    const record=(type,data)=>{
      const value={seq:rows.length,type,data};rows.push(value);
      writeFileSync(path,[{type:'session',version:4,id:sid,cwd:process.cwd(),isSeeded:false},...rows].map(v=>JSON.stringify(v)).join('\\n')+'\\n');
      send({jsonrpc:'2.0',method:'session.event',params:{sessionId:sid,event:value}});
    };
    writeFileSync(join(process.env.DSH_HOME,'fake-session'),'durable');
    const id=existed?'continued-input':'original-input',turn=existed?2:1;
    writeFileSync(join(process.cwd(),existed?'continuation-prompt.txt':'original-prompt.txt'),r.params.contentBlocks[0].text);
    answer({messageId:id});record('user/message',{id,content:r.params.contentBlocks,source:{kind:'user'}});
    if(!existed){
      record('tool/call',{turn,callId:'settled-read',name:'bash',arguments:'{"command":"read-existing-record"}'});
      record('tool/result',{turn,message:{toolCallId:'settled-read',isError:false,content:[{type:'text',text:'existing evidence'}]}});
      writeFileSync(join(process.cwd(),'tool-count.txt'),'1');
      record('assistant/message',{turn,message:{content:[{type:'reasoning',text:'synthetic placeholder'}]}});
    }else record('assistant/message',{turn,message:{content:[{type:'text',text:report}]}});
    record('turn/end',{turn,reason:{kind:'completed'}});continue;
  }`, '0.2.2-alpha.2');
  const { open, stored } = runtimeFixture(t, f, { enableAgentTools: false, enableManagedJobs: false });
  const runtime = open(), ticket = runtime.submit({ text: 'Inspect existing material once.', managedJobs: false });
  await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'failed');
  assert.match(runtime.get(ticket.id).reports.at(-1).summary, /completed the turn without a final response/);
  const session = runtime.getSession(ticket.id);
  runtime.retry(ticket.id); await runtime.runNext();
  assert.equal(runtime.get(ticket.id).status, 'completed');
  assert.deepEqual(runtime.getSession(ticket.id), session);
  assert.equal(stored(ticket.id).recovery.evidence.finalReportFailure, 'missing-final-report');
  assert.equal(readFileSync(join(f.root, 'tool-count.txt'), 'utf8'), '1');
  const continued = readFileSync(join(f.root, 'continuation-prompt.txt'), 'utf8');
  assert.match(continued, /Continue this same saved native session/);
  assert.match(continued, /Do not replay the original request or repeat completed actions/);
  assert.doesNotMatch(continued, /^Execute this authorized js-superagent task/);
  assert.ok(f.pids.every(pid => !alive(pid)));
});

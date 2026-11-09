// Explicit alpha.2 protocol acceptance; temporary profile and loopback provider only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(),'js-w28-native-')));
let calls = 0, phase = 'first', session, held;
const errors = [], guardians = [], leases = [], facts = [], requests = [];
function respond(res, request, output) {
  const blocks = typeof output === 'string' ? [{ type: 'text', text: JSON.stringify({ version: 2, state: 'ready', summary: output, artifacts: [], attention: null }) }] : output;
  const stop = blocks.some(item => item.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: `msg_${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } };
  if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', { type: 'message_stop' }); res.end();
}

const server = createServer(async(req,res) => {
  try {
    let body=''; for await(const chunk of req) body+=chunk;
    const request=JSON.parse(body); calls++; requests.push({phase,request});
    if(calls===1) return respond(res,request,[{type:'tool_use',id:'native_shell',name:'bash',input:{command:'sleep 9; printf W28_NATIVE_JOB_RESULT',description:'Bounded local native handoff acceptance',timeoutMs:60000}}]);
    if(phase==='first'||phase==='reply') return respond(res,request,[{type:'text',text:JSON.stringify({version:2,state:'waiting',summary:'Native command remains supervised while waiting for a human decision.',artifacts:[],attention:{question:phase==='first'?'Which wording should the result use?':'Please confirm the final wording.'}})}]);
    assert.match(JSON.stringify(request.messages),/W28_NATIVE_JOB_RESULT/);
    return respond(res,request,'Consumed the saved native result after the real human reply.');
  } catch(error) { errors.push(error);res.writeHead(500);res.end(String(error)); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const previous=process.env.JS_W28_NATIVE_KEY;process.env.JS_W28_NATIVE_KEY='fake-only';
const options={executable:process.env.DSH_EXECUTABLE??'dsh',model:'deepseek-flash',timeoutMs:25000,killGraceMs:1000,
 backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,apiKeyEnv:'JS_W28_NATIVE_KEY'}};
const driver=createDshSdkDriver(options);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const input=runId=>({runId,projectRoot:root,sourceProjectRoot:root,assignmentId:'native-assignment',ticket:{id:'native-ticket',text:'Perform the small command and ask for wording before final result.',scope:'local fixture'},
 signal:new AbortController().signal,checkpoint:value=>{session=value;},checkpointNative:value=>facts.push({runId,...value}),registerProcess:pid=>guardians.push(pid),
 nativeHandoff:{...(held?{current:held}:{}),hold(record,control){held={record,control};leases.push(held);return true;},update(id,event){const entry=leases.find(item=>item.record.id===id);assert.ok(entry);(entry.record.results??=[]).push(event);}}});
try {
 const first=await driver.run(input('native-first'));
 assert.equal(first.state,'waiting');assert.ok(held);assert.ok(guardians.some(alive));assert.equal(calls,2);
 const firstControl=held.control;
 phase='reply';
 const second=await driver.run({...input('native-reply'),session});
 assert.equal(second.state,'waiting');assert.equal(leases.length,2);assert.equal(held.control,firstControl);assert.equal(calls,3);
 await held.control.closed;
 assert.ok(guardians.every(pid=>!alive(pid)));assert.equal(calls,3,'Completion must not call the model');
 assert.ok(held.record.results?.some(event=>event.type==='settled'&&JSON.stringify(event.output).includes('W28_NATIVE_JOB_RESULT')));
 const saved=held.record;held=null;phase='final';
 const final=await driver.run({...input('native-final'),session,nativeHandoffResults:[saved]});
 assert.equal(final.state,'ready');assert.equal(calls,4);assert.ok(facts.some(value=>value.nativeHandoffConsumed?.includes(saved.id)));
 assert.equal(errors.length,0,errors.map(e=>e.stack).join('\n'));assert.ok(guardians.every(pid=>!alive(pid)));
 console.log(JSON.stringify({nativeVersion:'0.2.2-alpha.2',localProviderCalls:calls,liveHandoff:true,sameProcessReply:true,completionWithoutWakeup:true,durableResultConsumed:true,processCleanup:true}));
} finally {
 await held?.control.close('Acceptance ended');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 if(previous===undefined)delete process.env.JS_W28_NATIVE_KEY;else process.env.JS_W28_NATIVE_KEY=previous;
 if(process.env.JS_W28_KEEP==='1')console.error(root);else rmSync(root,{recursive:true,force:true});
}

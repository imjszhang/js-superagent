// Explicit W34 alpha.2 check: a real SDK, two loopback replies, no external model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshSdkDriver } from '../src/drivers/dsh.mjs';
const root=realpathSync(mkdtempSync(join(tmpdir(),'js-w34-native-')));
let calls=0,held,session;const guardians=[],errors=[];
const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
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

const server=createServer(async(req,res)=>{try{
 let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);calls++;
 if(calls===1){assert.ok(request.tools.some(tool=>tool.name==='js_superagent_native_preview_start'));return respond(res,request,[{type:'tool_use',id:'preview_launch',name:'js_superagent_native_preview_start',input:{profileId:'demo'}}]);}
 assert.match(JSON.stringify(request.messages),/commandPid/);assert.match(JSON.stringify(request.messages),/127.0.0.1/);
 return respond(res,request,'The local fixture is ready; the verified native preview remains available.');
}catch(error){errors.push(error);res.writeHead(500);res.end(String(error));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const previous=process.env.JS_W34_NATIVE_KEY;process.env.JS_W34_NATIVE_KEY='fake-only';
const driver=createDshSdkDriver({executable:process.env.DSH_EXECUTABLE??'dsh',model:'deepseek-flash',timeoutMs:12000,killGraceMs:100,
 backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,apiKeyEnv:'JS_W34_NATIVE_KEY'}});
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try{
 const before=Date.now();
 const result=await driver.run({runId:'native-preview',projectRoot:root,sourceProjectRoot:root,assignmentId:'assignment',ticket:{id:'ticket',text:'Show the preview',scope:'local fixture'},signal:new AbortController().signal,
  checkpoint:value=>{session=value;},registerProcess:pid=>guardians.push(pid),
  nativePreviewProfiles:[{id:'demo',version:'1',kind:'command',command:process.execPath,args:['-e',`require('http').createServer((q,s)=>s.end('W34_NATIVE_PREVIEW')).listen(${port},'127.0.0.1')`],environment:'host',allowHostExecution:true,preview:{url:`http://127.0.0.1:${port}/`,ttlMs:6000}}],
  nativeHandoff:{hold(record,control){held={record,control};return true;},update(id,event){assert.equal(id,held.record.id);(held.record.results??=[]).push(event);}}});
 assert.equal(result.state,'ready');assert.equal(calls,2);assert.ok(held.record.previews.length);
 const jobId=held.record.previews[0].jobId;
 const renewed=await held.control.renewPreview({jobId,ttlMs:20000});assert.ok(Date.parse(renewed.deadlineAt)>before+12000);
 await new Promise(resolve=>setTimeout(resolve,Math.max(1,before+12500-Date.now())));
 assert.equal(await(await fetch(`http://127.0.0.1:${port}/`)).text(),'W34_NATIVE_PREVIEW');
 assert.equal(calls,2,'Preview must not wake the model');
 await held.control.close('acceptance cleanup');await held.control.closed.catch(()=>{});
 assert.ok(guardians.every(pid=>!alive(pid)));await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
 assert.equal(errors.length,0,errors.map(error=>error.stack).join('\n'));
 console.log(JSON.stringify({nativeVersion:'0.2.2-alpha.2',localProviderCalls:calls,readyNativePreview:true,renewalPastRunDeadline:true,noAutomaticWakeup:true,processCleanup:true}));
}finally{
 await held?.control.close('acceptance ended');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 if(previous===undefined)delete process.env.JS_W34_NATIVE_KEY;else process.env.JS_W34_NATIVE_KEY=previous;
 if(process.env.JS_W34_KEEP==='1')console.error(root);else rmSync(root,{recursive:true,force:true});
}

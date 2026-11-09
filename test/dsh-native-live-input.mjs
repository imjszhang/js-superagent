// Explicit native rc.5 smoke with a loopback fake provider; no external model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDshTurn } from '../src/drivers/dsh.mjs';
const root=mkdtempSync(join(tmpdir(),'js-w3-native-'));
let calls=0,control,receipt,seen=[],sessions=[],read=[];
const server=createServer(async(req,res)=>{try{
 let body='';for await(const c of req)body+=c;
 const request=JSON.parse(body);seen.push(JSON.stringify(request.messages));calls++;
 if(calls===1){receipt=await control.sendInput({inputId:'human-followup-1',text:'Use the appended requirement'});assert.equal(receipt.read,false);assert.equal(read.length,0);}
 const text=JSON.stringify({version:2,state:'ready',summary:`native mock request ${calls}`,artifacts:[],attention:null});
 if(request.stream){res.writeHead(200,{'content-type':'text/event-stream'});for(const [event,data]of [
 ['message_start',{type:'message_start',message:{id:'msg_'+calls,type:'message',role:'assistant',model:'deepseek-flash',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}],
 ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}}],['message_stop',{type:'message_stop'}]])res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);res.end();}
 else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg',type:'message',role:'assistant',model:'deepseek-flash',content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:2}}));}
 }catch(error){res.writeHead(500);res.end(String(error));console.error(error);}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.JS_W3_MOCK_KEY='fake-only';
try{
 const options={executable:process.env.DSH_EXECUTABLE ?? 'dsh',model:'deepseek-flash',backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,apiKeyEnv:'JS_W3_MOCK_KEY'},timeoutMs:30000};
 const result=await executeDshTurn(options,{projectRoot:root,runId:'w3-live',prompt:'Return the JSON report',checkpoint:v=>sessions.push(v),registerProcess:()=>{},signal:new AbortController().signal,onLiveControl:value=>{control=value},inputRead:value=>{assert.equal(control.validateInputRead(value),true);read.push(value);}});
 assert.equal(calls,2);assert.equal(read.length,1);assert.equal(read[0].evidence.messageId,receipt.messageId);assert.ok(seen[1].includes('human-followup-1'));assert.equal(JSON.parse(result.text).summary,'native mock request 2');
 console.log(JSON.stringify({version:result.version,calls,receipt,read,result:JSON.parse(result.text),root}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));delete process.env.JS_W3_MOCK_KEY;rmSync(root,{recursive:true,force:true});}

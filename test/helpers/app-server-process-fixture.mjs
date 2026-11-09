import { fakeCodexIsolationPrelude } from './codex-isolation-fixture.mjs';

// A local JSON-RPC subprocess fixture; never launches a model or a background service.
export function fakeAppServerProcessScript() {
  return `#!${process.execPath}
${fakeCodexIsolationPrelude({ appServer: true })}
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const args=process.argv.slice(2),turnId='turn-1';
let id;
if(args[0]==='--version'){console.log('codex-cli test');process.exit(0);}
if(args[0]==='login'){console.error('Logged in private-account-secret');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
let sessionMethod,model;
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line),{method,params}=request;
 if(method==='config/read')return send({id:request.id,result:__isolationConfig()});
 if(method==='initialize')return send({id:request.id,result:{}});
 if(['thread/start','thread/resume'].includes(method)){id=method==='thread/resume'?params.threadId:randomUUID();sessionMethod=method;model=params.model;return send({id:request.id,result:{thread:{id},collaborationMode:{mode:'default',settings:{model:params.model||'fixture-model',reasoning_effort:null}}}});}
 if(method==='turn/interrupt'){send({id:request.id,result:{}});return send({method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'interrupted'}}});}
 if(method!=='turn/start')return;
 appendFileSync('calls.jsonl',JSON.stringify({args,input:JSON.stringify(params.input),sessionMethod,sessionId:id,model})+'\\n');
 writeFileSync('seen.json',JSON.stringify({args,model,cwd:process.cwd(),executable:process.argv[1]}));
 send({id:request.id,result:{turn:{id:turnId,status:'inProgress'}}});
 send({method:'turn/started',params:{threadId:id,turn:{id:turnId,status:'inProgress'}}});
 const mode=existsSync('mode.txt')?readFileSync('mode.txt','utf8'):'completed';
 if(mode==='failed')return send({method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'failed',error:{message:'Verification failed in the fake executor'}}}});
 if(mode==='hang'){writeFileSync('started.txt',String(process.pid));setInterval(()=>writeFileSync('heartbeat.txt',String(Date.now())),20);return;}
 const report={state:mode==='waiting'?'waiting':'ready',summary:mode==='waiting'?'Which rounding rule should I use?':'Applied the requested rule and verified it.',artifacts:mode==='waiting'?[]:['result.txt'],question:mode==='waiting'?'Which rounding rule should I use?':null,acknowledgedInputIds:[]};
 if(mode!=='waiting')writeFileSync('result.txt','verified');
 send({method:'item/completed',params:{threadId:id,turnId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)}}});
 send({method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'completed',items:[]}}});
});
`;
}

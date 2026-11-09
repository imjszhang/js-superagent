import { BLOCKED_CODEX_FEATURES } from '../../src/drivers/codex-isolation.mjs';

/** Explicit protocol fixture only. Production adapters always probe their selected executable. */
export function fakeCodexIsolationPrelude({ commonjs = false, appServer = false } = {}) {
  return `
const __isolationArgs = process.argv.slice(2);
const __isolationFeatures = ${JSON.stringify(BLOCKED_CODEX_FEATURES)};
const __hasIsolationFlags = () => __isolationFeatures.every(name => __isolationArgs.some((arg, index) => arg === '--disable' && __isolationArgs[index + 1] === name));
const __isolationFeatureValues = () => {
  const result = {...Object.fromEntries(__isolationFeatures.map(name => [name, false])),shell_tool:true,skill_search:true,skip_host_skill_discovery:false};
  for(let i=0;i<__isolationArgs.length;i++)if(['--disable','--enable'].includes(__isolationArgs[i]) && Object.hasOwn(result,__isolationArgs[i+1]))result[__isolationArgs[i+1]]=__isolationArgs[i]==='--enable';
  return result;
};
const __isolationConfig = () => ({ config: { features: __isolationFeatureValues(), notify: [], web_search: 'disabled', mcp_servers: {} }, layers: [{name:{type:'mock-fixture'},version:'fixture-v1'}] });
if (__isolationArgs.includes('features') && __isolationArgs.includes('list')) {
  if (!__hasIsolationFlags()) process.exit(64);
  process.stdout.write(Object.entries(__isolationFeatureValues()).map(([name,value]) => name+' stable '+value).join('\\n')+'\\n'); process.exit(0);
}
if (__isolationArgs[0] === 'app-server'${appServer ? " && __isolationArgs.includes('--startup-client-info')" : ''}) {
  if (!__hasIsolationFlags()) process.exit(64);
  const {createInterface: __isolationLines} = ${commonjs ? "require('node:readline')" : "await import('node:readline')"};
  __isolationLines({input:process.stdin}).on('line',line => {
    const request=JSON.parse(line);
    if(request.method==='initialize')process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');
    else if(request.method==='config/read')process.stdout.write(JSON.stringify({id:request.id,result:__isolationConfig()})+'\\n');
    else if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,error:{code:-32601,message:'Unexpected fixture probe request'}})+'\\n');
  });
  ${commonjs ? 'return;' : 'await new Promise(() => {});'}
}
`;
}

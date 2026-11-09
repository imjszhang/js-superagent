import { createHarnessRegistry, createProjectAgent, createDshSdkDriver, createDshAssessor, createCursorAgentDriver, createCursorAssessor, type HarnessAdapter, type DshDriverOptions, type CursorDriverOptions } from 'js-superagent';

const cursor={apiKeyEnv:'CURSOR_WORKER_KEY'} satisfies CursorDriverOptions;
createCursorAgentDriver(cursor);
createCursorAssessor({model:'composer-2.5'});
// @ts-expect-error coordination is read-only
createCursorAssessor({model:'composer-2.5',permission:'workspace-write'});
// @ts-expect-error Cursor credentials are environment references, not inline keys
createCursorAgentDriver({model:'composer-2.5',apiKey:'crsr_secret'});

const options={model:'selected-model',backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://provider.example/anthropic',apiKeyEnv:'DSH_KEY'}} satisfies DshDriverOptions;
createDshSdkDriver(options);
createDshSdkDriver({...options,enableAgentTools:true,enableManagedJobs:true});
createDshAssessor({...options,permission:'read-only'});
// @ts-expect-error coordination cannot launch managed jobs
createDshAssessor({...options,enableManagedJobs:true});
// @ts-expect-error coordination has read-only permissions
createDshAssessor({...options,permission:'workspace-write'});
const adapter:HarnessAdapter={id:'custom-harness',version:'1',label:'Custom',roles:['worker'],settingsFields:['workspaceMode'],preserveOnSave:['tokenEnv'],validate:options=>options,createDriver:()=>({reportVersion:2,run:async()=>({version:2 as const,state:'ready' as const,summary:'done'})})};
const listed=createHarnessRegistry({adapters:[adapter]}).list().find(item=>item.id==='custom-harness');
if(!listed) throw new Error('custom harness missing');
listed.settingsFields.map(field=>field.length);
listed.preserveOnSave.map(field=>field.length);
const registry=createHarnessRegistry({adapters:[adapter]});
const agent=createProjectAgent({projectRoot:'/example',harnessRegistry:registry});
agent.configureExecutor({driver:'dsh-sdk',...options},{expectedRevision:0});
agent.listHarnesses();
agent.sessionStatus('example').harnessBinding?.adapter.version;
agent.probeHarness({driver:'dsh-sdk',...options},{checkExecutable:false});
registry.describeExecution({driver:'custom-harness'},{role:'worker'});
// @ts-expect-error capabilities require named boolean contracts, not arbitrary strings
registry.describeExecution({driver:'custom-harness',requiredCapabilities:['invented']});
// @ts-expect-error DSH credentials are references, not inline secrets
createDshSdkDriver({model:'selected-model',backend:{auth:'api-key',provider:'deepseek-official',protocol:'anthropic-messages',baseURL:'https://provider.example',apiKey:'secret'}});

import { projectStateDirectory as stateDir } from '../src/state-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgent} from './helpers/runtime-fixture.mjs';
import {Store} from '../src/store.mjs';
test('role model and prompt versions stay pinned on existing sessions while new sessions use the latest revision',async t=>{
 const root=mkdtempSync(join(tmpdir(),'js-superagent-role-'));
 const driver={async run({checkpoint}){checkpoint({driver:'fixture',id:'saved-session'});return{status:'waiting',summary:'Please supply the next step'};}};
 const runtime=createProjectAgent({projectRoot:root,driver,execution:{driver:'codex-app-server',model:'original'}}).init();
 t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 runtime.configureExecutor({driver:'codex-app-server',model:'first',prompt:'Explain verification evidence clearly.'},{expectedRevision:0});
 const old=runtime.submit({text:'Inspect first'});await runtime.runNext();
 const first=runtime.getDetailed(old.id).sessionSettings;assert.equal(first.execution.prompt,'Explain verification evidence clearly.');assert.equal(first.revision,1);
 runtime.configureExecutor({driver:'codex-app-server',model:'second',prompt:'Summarize checks concisely.'},{expectedRevision:1});
 runtime.reply(old.id,'Continue');await runtime.runNext();assert.deepEqual(runtime.getDetailed(old.id).sessionSettings,first);
 const next=runtime.submit({text:'Inspect new'});await runtime.runNext();const current=runtime.getDetailed(next.id).sessionSettings;
 assert.equal(current.execution.model,'second');assert.equal(current.execution.prompt,'Summarize checks concisely.');assert.equal(current.revision,2);assert.notEqual(current.promptVersion,first.promptVersion);
 const status=runtime.executorStatus();assert.equal(status.history.length,2);assert.equal(status.history[0].execution.model,'first');
 assert.throws(()=>runtime.configureExecutor({driver:'codex-app-server',prompt:'old browser edit'},{expectedRevision:1}),/revision conflict/);
 assert.throws(()=>runtime.configureExecutor({driver:'codex-app-server',prompt:'\0'},{expectedRevision:2}),/prompt/);
});

test('changing executor preserves legacy session effective settings with explicit provenance',async t=>{
 const root=mkdtempSync(join(tmpdir(),'js-superagent-legacy-role-'));
 const runtime=createProjectAgent({projectRoot:root,execution:{driver:'codex-app-server',model:'old-model'},driver:{async run({checkpoint}){checkpoint({driver:'fixture',id:'ae48e33c-628b-40dc-9fc6-a792fd94ae8a'});return{status:'waiting',summary:'Next step?'};}}}).init();
 t.after(async()=>{await runtime.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 const ticket=runtime.submit({text:'Legacy work'});await runtime.runNext();
 const store=new Store(join(stateDir(root), 'state.sqlite'));
 const key=`ticket:${ticket.id}`,meta=store.getMeta(key);delete meta.executionConfig;delete meta.executionRevision;delete meta.executionPromptVersion;store.setMeta(key,meta);store.close();
 runtime.configureExecutor({driver:'codex-app-server',model:'new-model',prompt:'New session guidance.'},{expectedRevision:0});
 const details=runtime.getDetailed(ticket.id).sessionSettings;assert.equal(details.execution.driver,'codex-app-server');assert.equal(details.execution.model,'old-model');assert.equal(details.pinOrigin,'legacy-effective-settings-before-change');
});

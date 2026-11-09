import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createProjectAgent } from './helpers/runtime-fixture.mjs';
import { fakeCodexIsolationPrelude } from './helpers/codex-isolation-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let count = 0; count < 800; count++) { if (check()) return; await delay(10); } assert.fail('Timed out waiting for runtime state'); }
function fixture(t, driver, workspace = 'copy') {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-jobs-runtime-')));
  writeFileSync(join(projectRoot, 'example.txt'), 'unchanged\n');
  const runtime = createProjectAgent({ projectRoot, workspace, driver }).init();
  t.after(async () => { await runtime.stop(); runtime.close(); rmSync(projectRoot, { recursive: true, force: true }); });
  return { projectRoot, runtime };
}
const command = milliseconds => ({ kind: 'command', version: '1', command: process.execPath,
  args: ['-e', `setTimeout(()=>{},${milliseconds})`], environment: 'host', allowHostExecution: true, timeoutMs: 20_000 });
const configure = (runtime, profiles, extra = {}) => runtime.configureJobs({ paths: ['example.txt'], profiles, ...extra }, { expectedRevision: 0 });

test('managed wait yields an isolated Worker slot, bounds spare execution, then reacquires before returning', { timeout: 15_000 }, async t => {
  const release = deferred(), started = [], resumed = []; let jobId;
  const { runtime } = fixture(t, { async run(input) {
    started.push(input.ticket.text);
    if (input.ticket.text === 'parent') {
      jobId = input.jobs.launch({ profileId: 'check' }).id;
      assert.equal((await input.jobs.wait(jobId)).status, 'completed');
      resumed.push('parent');
    } else await Promise.race([release.promise, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))]);
    return { status: 'completed', summary: 'Verified' };
  } });
  t.after(() => release.resolve());
  configure(runtime, { check: command(180) });
  const parent = runtime.submit({ text: 'parent' }); runtime.start({ intervalMs: 10 });
  await until(() => runtime.schedulerStatus().active.some(item => item.yielded));
  const second = runtime.submit({ text: 'second' }), third = runtime.submit({ text: 'third' });
  await until(() => started.includes('second'));
  await until(() => runtime.listJobs(parent.id).find(job => job.id === jobId)?.status === 'completed');
  assert.deepEqual(resumed, []); assert.deepEqual(started, ['parent', 'second']);
  for (let count = 0; count < 15; count++) {
    assert.ok(runtime.schedulerStatus().active.filter(item => !item.yielded).length <= 1);
    await delay(10);
  }
  release.resolve(); await until(() => [parent, second, third].every(ticket => runtime.get(ticket.id).status === 'completed'));
  assert.deepEqual(resumed, ['parent']); assert.equal(started.filter(value => value === 'parent').length, 1);
  assert.equal(runtime.getDomainTicket(parent.id).undelivered.length, 0);
  assert.ok(runtime.schedulerStatus().active.length <= 1);
});

test('in-place managed jobs retain capacity until their parent returns', { timeout: 10_000 }, async t => {
  const started = []; let jobId;
  const { runtime } = fixture(t, { async run(input) {
    started.push(input.ticket.text);
    if (input.ticket.text === 'parent') { jobId = input.jobs.launch({ profileId: 'check' }).id; await input.jobs.wait(jobId); }
    return { status: 'completed', summary: 'Verified' };
  } }, 'in-place');
  configure(runtime, { check: command(400) });
  const parent = runtime.submit({ text: 'parent' }), second = runtime.submit({ text: 'second' }); runtime.start({ intervalMs: 10 });
  await until(() => jobId); await delay(100);
  assert.deepEqual(started, ['parent']); assert.equal(runtime.schedulerStatus().active.some(item => item.yielded), false);
  await until(() => [parent, second].every(ticket => runtime.get(ticket.id).status === 'completed'));
  assert.deepEqual(started, ['parent', 'second']);
});

test('stop persists cancellation of running managed jobs before releasing ownership and survives reopen', { timeout: 10_000 }, async t => {
  let jobId;
  const { runtime, projectRoot } = fixture(t, { async run(input) {
    jobId = input.jobs.launch({ profileId: 'long-check' }).id;
    try { await input.jobs.wait(jobId); } catch { /* Runtime records interruption. */ }
    return { status: 'completed', summary: 'Stopped' };
  } });
  configure(runtime, { 'long-check': command(15_000) });
  const ticket = runtime.submit({ text: 'Run managed check' }); runtime.start({ intervalMs: 10 });
  await until(() => runtime.listJobs(ticket.id).some(job => job.guardians.length >= 2));
  await runtime.stop();
  const job = runtime.listJobs(ticket.id).find(record => record.id === jobId);
  assert.equal(job.status, 'cancelled'); assert.equal(runtime.schedulerStatus().active.length, 0);
  for (const owner of job.guardians) assert.throws(() => process.kill(owner.pid, 0), error => error.code === 'ESRCH');
  const reopened = createProjectAgent({ projectRoot, driver: { async run() { assert.fail('Interrupted work must not replay'); } } }).init();
  try {
    assert.equal(reopened.listJobs(ticket.id)[0].status, 'cancelled');
    assert.equal(reopened.get(ticket.id).status, 'interrupted'); assert.equal(await reopened.runNext(), null);
  } finally { reopened.close(); }
});

test('nested child job wait retains root ownership and emits no redundant root completion turn', { timeout: 15_000 }, async t => {
  let runs = 0;
  const { runtime, projectRoot } = fixture(t, { async run(input) {
    runs++;
    const child = input.jobs.launch({ profileId: 'child', text: 'Use the trusted nested check.', paths: ['example.txt'] });
    assert.equal((await input.jobs.wait(child.id)).status, 'completed');
    return { version: 2, state: 'ready', summary: 'Nested check completed' };
  } });
  const executable = join(projectRoot, 'fake-child-codex');
  writeFileSync(executable, `#!/usr/bin/env node
${fakeCodexIsolationPrelude({ appServer: true })}
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
const threadId=randomUUID(),turnId='nested-turn',send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const tool=(id,callId,tool,args)=>send({id,method:'item/tool/call',params:{threadId,turnId,callId,namespace:null,tool,arguments:args}});
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);
if(request.method==='initialize')send({id:request.id,result:{}});
if(request.method==='config/read')send({id:request.id,result:__isolationConfig()});
if(request.method==='thread/start')send({id:request.id,result:{thread:{id:threadId}}});
if(request.method==='turn/start'){send({id:request.id,result:{turn:{id:turnId}}});send({method:'turn/started',params:{threadId,turn:{id:turnId}}});tool(100,'nested-start','js_superagent_job_start',{profileId:'check'});}
if(request.id===100&&request.result){const job=JSON.parse(request.result.contentItems[0].text);tool(101,'nested-wait','js_superagent_job_wait',{jobId:job.id});}
if(request.id===101&&request.result){const result=JSON.parse(request.result.contentItems[0].text);send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({state:result.status==='completed'?'ready':'failed',summary:'Nested check complete',artifacts:[],question:null,questionForTriggerId:null,answers:null,acknowledgedInputIds:[]})}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});}
});

`, { mode: 0o700 });
  configure(runtime, { check: command(30), child: { kind: 'agent', version: '1', instruction: 'Use the check profile without editing files.', paths: ['example.txt'] } },
    { childExecution: { driver: 'codex-app-server', executable, timeoutMs: 5000, killGraceMs: 40, enableManagedJobs: true } });
  const ticket = runtime.submit({ text: 'Run a nested check' }); runtime.start({ intervalMs: 10 });
  await until(() => runtime.get(ticket.id).status === 'completed'); await delay(100);
  const jobs = runtime.listJobs(ticket.id); assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.status === 'completed'));
  assert.equal(runs, 1); assert.equal(runtime.getDomainTicket(ticket.id).undelivered.length, 0);
  assert.equal(runtime.getDomainTicket(ticket.id).inputs.filter(input => input.kind === 'note' && input.text.startsWith('Managed job ')).length, 1);
});

test('hard parent death leaves a durable interrupted job after owned supervisors exit, without replay', { timeout: 15_000 }, async t => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'js-superagent-job-recovery-')));
  const setup = createProjectAgent({ projectRoot, workspace: 'copy', driver: { async run() { assert.fail('Setup cannot execute'); } } }).init();
  configure(setup, { check: command(15_000) }); const ticket = setup.submit({ text: 'A recoverable managed job' }); setup.close();
  const script = `import {createProjectAgent} from ${JSON.stringify(new URL('./helpers/runtime-fixture.mjs', import.meta.url).href)};
const runtime=createProjectAgent({projectRoot:${JSON.stringify(projectRoot)},driver:{async run(input){
const handle=input.jobs.launch({profileId:'check'});
const timer=setInterval(()=>{const record=input.jobs.get(handle.id);if(record.guardians.length>=2){clearInterval(timer);process.send({jobId:handle.id,guardians:record.guardians});}},10);
await input.jobs.wait(handle.id);return{status:'completed',summary:'Done'};
}}}).init();runtime.start({intervalMs:10});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(projectRoot, { recursive: true, force: true }); });
  const message = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child did not launch managed work: ${diagnostics}`)), 5000);
    child.once('message', value => { clearTimeout(timeout); resolve(value); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  await until(() => message.guardians.every(owner => { try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }));
  const reopened = createProjectAgent({ projectRoot, driver: { async run() { assert.fail('Recovery must not replay effects'); } } }).init();
  try {
    const job = reopened.listJobs(ticket.id).find(record => record.id === message.jobId);
    assert.equal(job.status, 'interrupted'); assert.equal(job.completion.status, 'interrupted');
    assert.equal(reopened.get(ticket.id).status, 'interrupted'); assert.equal(await reopened.runNext(), null);
    assert.equal(reopened.schedulerStatus().active.length, 0);
  } finally { reopened.close(); }
});

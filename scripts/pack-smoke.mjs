import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// One clean consumer proves package boundaries; adapter protocol tests live in test/.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'js-superagent-pack-'));
// The consumer registers its project; keep that out of the operator's machine registry.
const env = { ...process.env, JS_SUPERAGENT_MACHINE_DIRECTORY: join(scratch, '.machine'), JS_SUPERAGENT_HOME: join(scratch, '.state-home') };
function run(command, args, cwd = scratch) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], packageRoot))[0];
  const consumer = join(scratch, 'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename)], consumer);
  const installed = join(consumer, 'node_modules/js-superagent');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
  assert.ok(!manifest.dependencies?.['js-agent-runtime']);
  assert.ok(!existsSync(join(installed, 'src/drivers/codex.mjs')));
  assert.ok(existsSync(join(installed, 'src/drivers/codex-supervisor.mjs')), 'shared verification guardian retained');
  const project = join(scratch, 'python-project'); mkdirSync(project);
  writeFileSync(join(consumer, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { createProjectAgent, createHarnessRegistry } from 'js-superagent';
    const registry = createHarnessRegistry({adapters:[{id:'package-fixture',version:'1',roles:['worker'],validate:o=>o,
      createDriver:()=>({reportVersion:2, async run(){return {version:2,state:'ready',summary:'Installed SDK contract verified'};}})}]});
    assert.deepEqual(registry.list().slice(0,3).map(x=>x.id),['codex-app-server','dsh-sdk','cursor-agent']);
    const system = createProjectAgent({projectRoot:process.argv[2],harnessRegistry:registry,execution:{driver:'package-fixture'}}).init();
    try {const ticket=system.submit({text:'Verify local package contract'});await system.runNext();assert.equal(system.get(ticket.id).status,'completed');}
    finally {await system.stop();system.close();}
  `);
  run(process.execPath, [join(consumer, 'smoke.mjs'), project], consumer);
  const cli = join(installed, 'bin/js-superagent.mjs');
  const list = JSON.parse(run(process.execPath, [cli, '--project', project, 'status'], consumer));
  assert.equal(list.length, 1); assert.equal(list[0].status, 'completed');
  const harnesses = JSON.parse(run(process.execPath, [cli, 'harness', 'list'], consumer));
  assert.ok(JSON.stringify(harnesses).includes('dsh-sdk'));
  console.log('Clean package: CLI/SDK, registered adapter, history, independence passed; no native model or service started.');
} finally { rmSync(scratch, { recursive: true, force: true }); }

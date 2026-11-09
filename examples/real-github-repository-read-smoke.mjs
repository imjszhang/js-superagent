import { parseAcceptanceArgs, importFrozenModule } from './acceptance/frozen-package.mjs';
const { values, artifact } = parseAcceptanceArgs();
// Read-only baseline and follow-up poll; never starts an Engine or sends a message.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const { readProjectConfig } = await importFrozenModule(artifact, 'src/config.mjs');
const { createGitHubRepositorySource } = await importFrozenModule(artifact, 'src/channels/github-repository.mjs');

const projectRoot = resolve(process.env.JS_SUPERAGENT_SOURCE_PROJECT ?? '.');
const outputRoot = resolve(values.output);
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const config = readProjectConfig(projectRoot).github;
if (!config) throw new Error('Configure GitHub before running this read-only acceptance');
const source = createGitHubRepositorySource(config, { streams: { pulls: true, issues: true, comments: true, defaultBranchCI: !!config.ci }, observe: false });
const startedAt = new Date().toISOString(), baseline = await source.poll();
assert.equal(baseline.events.length, 0); assert.deepEqual(baseline.errors, []);
const second = await source.poll({ cursor: baseline.cursor }); assert.deepEqual(second.errors, []);
const evidence = { schemaVersion: 1, phase: '11a-read-only-repository-source', status: 'passed', startedAt, completedAt: new Date().toISOString(),
  repository: config.repository, authentication: source.authentication, baselineEvents: baseline.events.length, followupEvents: second.events.length,
  streamCursors: second.cursor.streams, errors: second.errors,
  limits: 'Read-only transport and baseline acceptance only. No external messages, new PR, CI failure injection, model invocation, or Engine work dispatch were performed.' };
writeFileSync(join(outputRoot, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
if (process.env.JS_SUPERAGENT_ACCEPTANCE_EVIDENCE) writeFileSync(resolve(process.env.JS_SUPERAGENT_ACCEPTANCE_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));

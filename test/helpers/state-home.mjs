import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Preloaded by the test scripts; child processes inherit it through process.env.
process.env.JS_SUPERAGENT_HOME ||= mkdtempSync(join(tmpdir(), 'js-superagent-home-'));

// Configuration may reserve an App before a runtime fixture injects its registry.
process.env.JS_SUPERAGENT_MACHINE_DIRECTORY ||= mkdtempSync(join(tmpdir(), 'js-superagent-machine-home-'));

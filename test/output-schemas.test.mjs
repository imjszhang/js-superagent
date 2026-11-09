import test from 'node:test';
import assert from 'node:assert/strict';
import { workerReportSchema } from '../src/drivers/codex-app-server.mjs';
import { candidateAssessmentSchema } from '../src/coordinator.mjs';
import { continuationSchema } from '../src/runtime/continuation-assessment.mjs';
import { workEventSchema, workEventTurnSchema } from '../src/runtime/coordination.mjs';

// Strict structured output requires every object to list all of its properties as required.
function strictObjects(schema, path, found = []) {
  if (!schema || typeof schema !== 'object') return found;
  if (schema.type === 'object' && schema.properties) {
    const missing = Object.keys(schema.properties).filter(key => !schema.required?.includes(key));
    if (missing.length || schema.additionalProperties !== false) found.push({ path, missing, additionalProperties: schema.additionalProperties });
    for (const [key, value] of Object.entries(schema.properties)) strictObjects(value, `${path}.${key}`, found);
  }
  if (schema.items) strictObjects(schema.items, `${path}[]`, found);
  for (const branch of schema.anyOf ?? []) strictObjects(branch, `${path}|`, found);
  return found;
}

test('every model output schema lists all properties as required', () => {
  for (const [name, schema] of Object.entries({ workerReportSchema, candidateAssessmentSchema, continuationSchema, workEventSchema, workEventTurnSchema })) {
    assert.deepEqual(strictObjects(schema, name), [], name);
  }
});

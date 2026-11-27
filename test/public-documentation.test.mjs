import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
test('public documentation excludes host identity and message evidence', () => {
  const files = ['README.md', ...fs.readdirSync('docs').filter(x => /\.(md|json)$/.test(x)).map(x => path.join('docs', x))];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/(?:om|ou|oc)_[a-f0-9]{20,}|\/Users\/[a-zA-Z0-9._-]+\//.test(text), false, file);
    if (file.endsWith('.md')) assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, file);
    if (/phase.*(?:acceptance|status)\.json$/.test(file) && text.includes('private-host-evidence-removed')) {
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['note', 'status']);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubDeliveryList } from '../examples/github-webhook-delivery-metadata.mjs';

test('retains GitHub 64-bit delivery identifiers exactly for redelivery URLs', () => {
  const data = parseGitHubDeliveryList('[{"id":3851573281603715072,"installation_id":177461856,"guid":"delivery","redelivery":false,"other":{"id":42}},{"id":123,"guid":"other","redelivery":false}]');
  assert.equal(data[0].id, '3851573281603715072');
  assert.equal(data[1].id, '123');
  assert.equal(data[0].installation_id, 177461856);
  assert.equal(data[0].other.id, 42);
  assert.notEqual(data[0].id, String(JSON.parse('[{"id":3851573281603715072}]')[0].id));
});

test('rejects malformed delivery lists and invalid numeric identifiers', () => {
  for (const input of ['{}', '[{}]', '[{"id":-1}]', '[{"id":1e20}]', '[{"id":"0"}]']) {
    assert.throws(() => parseGitHubDeliveryList(input));
  }
});

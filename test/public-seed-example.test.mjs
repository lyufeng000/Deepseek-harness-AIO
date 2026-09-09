import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSeedText, inspectPublicConfig } from '../scripts/public-seed-privacy.mjs';

test('published AWS example does not bypass detection of other credentials', () => {
  assert.doesNotThrow(() => inspectSeedText('AccessKeyId: "AKIAIOSFODNN7EXAMPLE"'));
  assert.throws(() => inspectSeedText('AKIAIOSFODNN7EXAMPLE AKIA1234567890ABCDEF'));
  assert.throws(() => inspectSeedText('AKIAIOSFODNN7EXAMPLF'));
  assert.throws(() => inspectPublicConfig({ token: 'AKIAIOSFODNN7EXAMPLE' }));
});

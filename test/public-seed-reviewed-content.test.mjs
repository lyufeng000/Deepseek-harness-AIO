import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectSeedArtifact } from '../scripts/public-seed-privacy.mjs';
import { isReviewedPublicContent } from '../scripts/public-seed-reviewed-content.mjs';

test('reviewed public artifact exception is bound to full bytes and exact dependency path', () => {
  const relative = 'profiles/web-desktop/node_modules/jose/dist/webapi/key/import.js';
  const bytes = fs.readFileSync(new URL('../node_modules/jose/dist/webapi/key/import.js', import.meta.url));
  assert.equal(isReviewedPublicContent(relative, bytes), true);
  assert.doesNotThrow(() => inspectSeedArtifact(relative, bytes));
  const modified = Buffer.concat([bytes, Buffer.from('\nAKIA1234567890ABCDEF')]);
  assert.equal(isReviewedPublicContent(relative, modified), false);
  assert.throws(() => inspectSeedArtifact(relative, modified));
  assert.equal(isReviewedPublicContent('settings.yaml', bytes), false);
  assert.throws(() => inspectSeedArtifact('settings.yaml', bytes));
});

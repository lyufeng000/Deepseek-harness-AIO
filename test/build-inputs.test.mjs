import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('build-inputs workflow downloads, verifies and builds', () => {
  const workflow = read('.github/workflows/aio-build.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: \[self-hosted, Windows, X64, aio\]/);
  assert.match(workflow, /clean: false/);
  assert.match(workflow, /Prepare clean build-input directories/);
  assert.match(workflow, /Verify Rust toolchain/);
  assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain/);
  assert.match(workflow, /tags:\s*\r?\n\s*- 'v\*'/);
  assert.match(workflow, /gh release download \$env:BUILD_INPUTS_TAG/);
  assert.match(workflow, /verify-build-inputs\.ps1/);
  assert.match(workflow, /build-aio-package\.ps1 -ProfileSeedDir/);
  assert.match(workflow, /gh release upload/);
});

test('build-inputs scripts expose package and verify paths', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['build-inputs:package'], /package-build-inputs\.ps1/);
  assert.match(packageJson.scripts['build-inputs:verify'], /verify-build-inputs\.ps1/);
  const packageScript = read('scripts/package-build-inputs.ps1');
  const verifyScript = read('scripts/verify-build-inputs.ps1');
  assert.match(packageScript, /DSHEAC-AIO-build-inputs-v\$Version\.zip/);
  assert.match(packageScript, /vendor\/node\/node\.exe/);
  assert.match(packageScript, /vendor\/npm\/bin\/npm-cli\.js/);
  assert.match(verifyScript, /SHA-256 mismatch/);
  assert.match(verifyScript, /build-inputs-manifest\.json/);
});

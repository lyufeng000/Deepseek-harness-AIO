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
  assert.match(workflow, /working-directory: a/);
  assert.match(workflow, /path: a/);
  assert.match(workflow, /a\/dist\/\*\.exe/);
  assert.match(workflow, /Verify Rust toolchain/);
  // Build inputs are reused only after an identity+SHA-256 check; there is no
  // unconditional delete-and-re-download step.
  assert.match(workflow, /Get-Sha256Hex/);
  assert.match(workflow, /Reusing verified build inputs/);
  assert.match(workflow, /Build-inputs asset digest is unavailable/);
  assert.match(workflow, /Copy-Item -LiteralPath \$sourceVendor/);
  // A shared self-hosted runner must serialize builds and keep Cargo warm.
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /Swatinem\/rust-cache@v2/);
  assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain/);
  // 发版改为本地打包 + 手动上传：tag 只作版本标记，不再触发 workflow。
  assert.doesNotMatch(workflow, /^\s{2}tags:/m);
  assert.match(workflow, /Invoke-RestMethod -Uri "https:\/\/api\.github\.com\/repos\/\$env:GITHUB_REPOSITORY\/releases\/tags\/\$env:BUILD_INPUTS_TAG"/);
  assert.match(workflow, /verify-build-inputs\.ps1/);
  assert.match(workflow, /build-aio-package\.ps1 -ProfileSeedDir/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
  assert.equal((workflow.match(/a\/dist\/SHA256SUMS\.txt/g) || []).length, 1, 'release upload must include only one checksum manifest');
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

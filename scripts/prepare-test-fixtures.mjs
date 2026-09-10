import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { repo, fixtureRoot, publicSeed, upstream, webuiArchive, originalWebui, legacySeed, reviewedArchives } from '../test/fixture-paths.mjs';
import { createMigrationStaging, transformPluginInterfaces, reviewedPackages } from './migrate-plugin-interfaces.mjs';
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'test/fixtures/manifest.json')));
if (createHash('sha256').update(fs.readFileSync(webuiArchive)).digest('hex') !== manifest.webui.sha256) throw new Error('Reviewed WebUI fixture digest mismatch');
if (!fs.existsSync(path.join(publicSeed, 'profiles/web-desktop/node_modules'))) throw new Error('Required full public seed missing; set DSH_PROFILE_SEED_DIR');
fs.mkdirSync(fixtureRoot, { recursive: true });
// Materialize the reviewed local plugin archives next to the other fixtures so
// migration tests never depend on a machine-local build-inputs path. Archives
// that are not part of the current build inputs simply stay absent and their
// specific tests report the missing reviewed input.
const reviewedSource = path.join(repo, 'temp/build-inputs/packages-clean');
const reviewedTracked = path.join(repo, 'test/fixtures/reviewed-plugins');
fs.mkdirSync(reviewedArchives, { recursive: true });
const availableArchives = [];
for (const pkg of reviewedPackages) {
  const source = [path.join(reviewedSource, pkg.archive), path.join(reviewedTracked, pkg.archive)]
    .find(candidate => fs.existsSync(candidate));
  if (!source) continue;
  fs.copyFileSync(source, path.join(reviewedArchives, pkg.archive));
  availableArchives.push(pkg.archive);
}
const manifestFile = JSON.parse(fs.readFileSync(path.join(repo, 'test/fixtures/manifest.json')));
fs.writeFileSync(path.join(reviewedArchives, 'manifest.json'), JSON.stringify({
  packages: Object.fromEntries(reviewedPackages.map(pkg => [pkg.archive,
    { name: pkg.name, version: pkg.version, present: availableArchives.includes(pkg.archive) }])),
  reviewed: Object.fromEntries(Object.entries(manifestFile.reviewedPlugins ?? {}).map(([file, meta]) => [file, meta])),
}, null, 2) + '\n');
if (!fs.existsSync(upstream)) {
  const downloads = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Environment]::ExpandEnvironmentVariables((Get-ItemProperty "HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders")."{374DE290-123F-4565-9164-39C4925E467B}")'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!path.isAbsolute(downloads)) throw new Error('System Downloads directory unavailable');
  const cache = path.join(downloads, 'aio-test-upstream-c389f96');
  if (!fs.existsSync(cache)) execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', manifest.upstream.repository, cache], { stdio: 'inherit', windowsHide: true });
  execFileSync('git', ['-C', cache, 'worktree', 'add', '--detach', upstream, manifest.upstream.commit], { stdio: 'inherit', windowsHide: true });
}
if (execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD']).toString().trim() !== manifest.upstream.commit) throw new Error('Upstream fixture commit mismatch');
fs.mkdirSync(path.dirname(originalWebui), { recursive: true });
execFileSync('tar.exe', ['-xf', webuiArchive, '-C', path.dirname(originalWebui)], { windowsHide: true });
// Separate historical WebUI from the current seed. Tests never mutate build inputs.
const copy = spawnSync('robocopy.exe', [publicSeed, legacySeed, '/E', '/COPY:DAT', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, stdio: 'ignore' });
if (copy.error || copy.status === null || copy.status >= 8) throw new Error('Fixture seed copy failed');
const webui = path.join(legacySeed, 'profiles/web-desktop/node_modules/@dsh-external/dsh-webui');
for (const name of ['client.js', 'usage-host.js']) fs.copyFileSync(path.join(originalWebui, 'lib', name), path.join(webui, 'lib', name));
// The historical r4/r5/r6 seeds predate the modular split, so the pre-migration
// WebUI still requires "@deepseek-ai/dsh-client-runtime/client". Rebuild that
// retired module as a faithful re-export of the current owners (the same
// substitutions the migration applies), not a behavior mock.
const runtime = path.join(legacySeed, 'profiles/web-desktop/node_modules/@deepseek-ai/dsh-client-runtime');
fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true });
fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-client-runtime', version: '0.1.3-alpha.2', private: true,
  type: 'module', main: './lib/client.js',
  exports: { './client': { default: './lib/client.js' }, './package.json': './package.json' },
}, null, 2) + '\n');
fs.writeFileSync(path.join(runtime, 'lib', 'client.js'), [
  'window.__ModuleLoader__.load({',
  '  id: "@deepseek-ai/dsh-client-runtime",',
  '  factory: (require) => {',
  '    const store = require("@deepseek-ai/dsh-client-store");',
  '    const surface = require("@deepseek-ai/dsh-session/surface");',
  '    return {',
  '      createSnapshotStore: store.createSnapshotStore,',
  '      isAppendSurfaceEvent: surface.isAppendSurfaceEvent,',
  '      isReplacementSurfaceEvent: surface.isReplacementSurfaceEvent,',
  '    };',
  '  },',
  '});',
  '',
].join('\n'));
// The prompt-optimize end-to-end test needs the r6 revision: every interface
// migration already applied EXCEPT the prompt-optimize repair, whose collision
// it exercises. Rebuild that revision from the real migration chain instead of
// a historical seed that no longer exists.
function regionReplace(source, start, from, to, label) {
  const from0 = source.indexOf(start);
  const to0 = source.indexOf('//#endregion', from0 + start.length);
  if (from0 < 0 || to0 < from0 || source.indexOf(start, from0 + start.length) >= 0) {
    throw new Error(`r6 fixture: unrecognized region ${label}`);
  }
  const region = source.slice(from0, to0);
  if (!region.includes(from) || region.includes(to)) throw new Error(`r6 fixture: unexpected region content ${label}`);
  return source.slice(0, from0) + region.replace(from, to) + source.slice(to0);
}
function restorePrePromptOptimize(source) {
  const migrated = source.replace(/\r\n/g, '\n');
  const button = 'function PromptOptimizeButton({ available, directory, useInput, inputActions, sessionId }) {\n\t\t\tconst input = useInput((state) => state);';
  if (!migrated.includes(button)) throw new Error('r6 fixture: prompt button not migrated');
  let out = migrated.replace(button,
    'function PromptOptimizeButton({ available, directory, input, inputActions, sessionId }) {');
  out = regionReplace(out, 'function applyPromptOptimize(ctx)',
    '"modelDirectories",\n\t\t\t\t"remote.session",\n\t\t\t\t"sessions"',
    '"modelDirectories",\n\t\t\t\t"sessions"', 'applyPromptOptimize');
  out = regionReplace(out, '//#region src/client/skill-source/locales.ts',
    'NS$1 = "webui.skill";', 'NS$1 = "skill";', 'locales');
  out = regionReplace(out, 'function apply$3(ctx)',
    'key: "skill",\n\t\t\t\tpriority: -100,\n\t\t\t\tlocale: NS$1',
    'key: "skill",\n\t\t\t\tlocale: NS$1', 'apply$3');
  return out;
}
const staging = createMigrationStaging();
try {
  execFileSync('tar.exe', ['-xf', webuiArchive, '-C', staging.root], { windowsHide: true });
  const report = transformPluginInterfaces(path.join(staging.root, 'package'), { stage: staging, useUiCompat: true });
  const migrated = report.proposedFiles['lib/client.js'];
  if (!migrated) throw new Error('r6 fixture: migration produced no client.js');
  fs.writeFileSync(path.join(webui, 'lib', 'client.r6.js'), restorePrePromptOptimize(migrated));
} finally {
  fs.rmSync(staging.root, { recursive: true, force: true });
}
console.log('Required fixtures ready: pinned upstream, digest-verified WebUI, isolated legacy seed');

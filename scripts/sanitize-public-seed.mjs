import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectSeedTree, inspectPublicConfig, inspectSeedArtifact } from './public-seed-privacy.mjs';

function main() {
  const root = path.resolve(process.argv[2] || process.cwd());
  const seedRoot = process.env.DSH_PROFILE_SEED_DIR
    ? path.resolve(process.env.DSH_PROFILE_SEED_DIR)
    : path.join(root, 'distribution', 'profile-seed');
  const settingsFile = path.join(seedRoot, 'settings.yaml');
  const require = createRequire(path.join(root, 'package.json'));
  const yaml = require('js-yaml');

  const files = inspectSeedTree(seedRoot);
  const settingsSource = fs.readFileSync(settingsFile, 'utf8');
  const input = yaml.load(settingsSource) || {};
  const output = {};
  for (const key of ['status-rotator', 'webui-modules']) {
    if (!Object.hasOwn(input, key)) throw new Error(`missing public section: ${key}`);
    output[key] = input[key];
  }
  inspectPublicConfig(output);
  const eol = settingsSource.includes('\r\n') ? '\r\n' : '\n';
  const sanitizedSettings = yaml.dump(output, { noRefs: true, lineWidth: -1, noCompatMode: true }).replaceAll('\n', eol);

  const forbiddenState = ['.modules.yaml', '.pnpm-workspace-state-v1.json', path.join('.pnpm', 'lock.yaml')];
  const profileNodeModules = path.join(seedRoot, 'profiles', 'web-desktop', 'node_modules');
  const removedFiles = new Set(forbiddenState.map(rel => path.join(profileNodeModules, rel)));
  for (const { file, relative } of files) {
    if (removedFiles.has(file)) continue;
    const bytes = file === settingsFile ? Buffer.from(sanitizedSettings) : fs.readFileSync(file);
    const text = bytes.toString('utf8');
    inspectSeedArtifact(relative, bytes);
    if (/^profiles\/web-desktop\/(?:cordis(?:\.patch)?\.yml|package\.json)$/.test(relative)) {
      inspectPublicConfig(yaml.load(text));
    }
  }
  if (sanitizedSettings !== settingsSource) fs.writeFileSync(settingsFile, sanitizedSettings, 'utf8');
  for (const file of removedFiles) fs.rmSync(file, { force: true });
  console.log('AIO seed privacy scan passed');
}

try {
  main();
} catch (error) {
  // Parser and filesystem errors can contain private paths or entire source lines.
  const safe = /^(?:seed root must not be a symbolic link|external seed symbolic link rejected|cyclic seed symbolic link rejected|unknown seed user state entry rejected|seed manifest symbolic link rejected|invalid seed layout|unsupported seed entry rejected|cyclic public configuration rejected|secret-bearing public configuration rejected|machine-local seed paths found|secret-bearing seed content rejected|missing public section: (?:status-rotator|webui-modules))$/;
  console.error(safe.test(error.message) ? error.message : 'seed privacy validation failed');
  process.exitCode = 1;
}

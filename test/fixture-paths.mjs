import path from 'node:path';
import fs from 'node:fs';
export const repo = path.resolve(import.meta.dirname, '..');
export const fixtureRoot = path.join(repo, 'temp/test-fixtures');
export const upstream = process.env.DSH_AIO_COMPAT_UPSTREAM || path.join(fixtureRoot, 'upstream');
export const publicSeed = process.env.DSH_PROFILE_SEED_DIR || path.join(repo, 'temp/build-inputs/aio-1.2.0-public-seed');
export const legacySeed = path.join(fixtureRoot, 'legacy-seed');
export const reviewedArchives = process.env.DSH_REVIEWED_PLUGIN_ARCHIVES || path.join(fixtureRoot, 'packages');
export const webuiArchive = path.join(repo, 'test/fixtures/webui-0.5.1.tgz');
export const originalWebui = path.join(fixtureRoot, 'webui/package');
export function requireFixture(file) {
  if (!fs.existsSync(file)) throw new Error('Required fixture missing; run node scripts/prepare-test-fixtures.mjs');
  return file;
}

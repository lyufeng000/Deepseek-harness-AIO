import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditReleasePaths } from '../scripts/audit-release-paths.mjs';

test('release path audit detects plain, JSON-escaped and wide binary paths without disclosing contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-release-path-test-'));
  try {
    const privatePath = 'Q:\\Users\\PrivateFixture';
    fs.writeFileSync(path.join(root, 'plain.js'), `${privatePath}\\source.ts`);
    fs.writeFileSync(path.join(root, 'escaped.json'), JSON.stringify({ file: `${privatePath}\\source.ts` }));
    fs.writeFileSync(path.join(root, 'wide.exe'), Buffer.from(`prefix\0${privatePath}\\source.rs\0suffix`, 'utf16le'));
    fs.writeFileSync(path.join(root, 'public.js'), 'public content');
    const report = auditReleasePaths(root, [privatePath]);
    assert.equal(report.files, 4);
    assert.deepEqual(report.findings.sort(), ['escaped.json', 'plain.js', 'wide.exe']);
    assert.ok(!JSON.stringify(report).includes('PrivateFixture'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

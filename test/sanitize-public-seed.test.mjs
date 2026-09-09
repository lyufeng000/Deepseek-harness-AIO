import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'sanitize-public-seed.mjs');

function makeSeed(base, settings) {
  const seed = path.join(base, 'profile-seed');
  const modules = path.join(seed, 'profiles', 'web-desktop', 'node_modules');
  fs.mkdirSync(path.join(modules, '.pnpm'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'settings.yaml'), settings, 'utf8');
  fs.writeFileSync(path.join(modules, '.modules.yaml'), 'storeDir: H:/CODEX/pnpm/store\n', 'utf8');
  fs.writeFileSync(path.join(modules, '.pnpm-workspace-state-v1.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(modules, '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  return { seed, modules };
}

test('seed sanitizer targets DSH_PROFILE_SEED_DIR and preserves CRLF', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-seed-'));
  try {
    const settings = 'status-rotator:\r\n  enabled: true\r\nwebui-modules:\r\n  rewind: false\r\nprivate-key:\r\n  value: remove-me\r\n';
    const { seed, modules } = makeSeed(temp, settings);
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, DSH_PROFILE_SEED_DIR: seed },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sanitized = fs.readFileSync(path.join(seed, 'settings.yaml'), 'utf8');
    assert.ok(sanitized.includes('\r\n'));
    assert.doesNotMatch(sanitized, /private-key/);
    assert.ok(!fs.existsSync(path.join(modules, '.modules.yaml')));
    assert.ok(!fs.existsSync(path.join(modules, '.pnpm-workspace-state-v1.json')));
    assert.ok(!fs.existsSync(path.join(modules, '.pnpm', 'lock.yaml')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('seed sanitizer rejects machine-local paths in the selected external seed', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-seed-'));
  try {
    const { seed } = makeSeed(temp, 'status-rotator:\n  enabled: true\nwebui-modules:\n  rewind: false\n');
    fs.writeFileSync(path.join(seed, 'README.md'), 'C:/Users/another-user/private\n', 'utf8');
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, DSH_PROFILE_SEED_DIR: seed },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /machine-local seed paths found/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const publicSettings = 'status-rotator:\n  enabled: true\nwebui-modules:\n  rewind: false\n';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-privacy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const value = makeSeed(temp, publicSettings);
  return {
    ...value, temp,
    run() {
      return spawnSync(process.execPath, [script, root], {
        cwd: root, env: { ...process.env, DSH_PROFILE_SEED_DIR: value.seed }, encoding: 'utf8',
      });
    },
  };
}

for (const entry of ['unknown.json', '.env', '.npmrc', 'sessions', 'credentials.yaml']) {
  test(`rejects unknown root state: ${entry}`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.seed, entry), 'private-sentinel');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown seed user state/);
    assert.doesNotMatch(result.stderr + result.stdout, /private-sentinel/);
  });
}

for (const local of ['D:/Users/Alice/private', String.raw`E:\Users\Bob\private`,
  String.raw`C:\\Users\\Somebody\\private`, 'Z:/Documents and Settings/Person/private']) {
  test(`rejects generalized Windows user path ${local}`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.modules, 'source.ts'), local);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /machine-local seed paths found/);
    assert.ok(!result.stderr.includes(local));
  });
}

test('dependency source fixtures and dotenv examples are not user state', t => {
  const f = fixture(t);
  const fixtures = path.join(f.modules, 'some-package', 'fixtures', 'sessions');
  fs.mkdirSync(fixtures, { recursive: true });
  fs.writeFileSync(path.join(fixtures, '.env.example'), 'API_KEY=your-api-key\nPASSWORD=example\n');
  fs.writeFileSync(path.join(fixtures, '.env'), 'TOKEN=test-token\n');
  fs.writeFileSync(path.join(fixtures, 'settings.yaml'), 'apiKey: test-value\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const kind of ['external', 'cycle', 'internal']) {
  test(`${kind} directory links are checked before mutation`, t => {
    const f = fixture(t);
    const target = kind === 'external' ? path.join(f.temp, 'outside')
      : kind === 'cycle' ? f.modules : path.join(f.modules, 'package');
    if (kind !== 'cycle') fs.mkdirSync(target);
    const sentinel = path.join(target, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'unchanged');
    fs.symlinkSync(target, path.join(f.modules, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = fs.readFileSync(path.join(f.seed, 'settings.yaml'), 'utf8');
    const result = f.run();
    if (kind === 'internal') {
      assert.equal(result.status, 0, result.stderr);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, kind === 'external' ? /external seed symbolic link/ : /cyclic seed symbolic link/);
      assert.equal(fs.readFileSync(path.join(f.seed, 'settings.yaml'), 'utf8'), before);
      assert.ok(fs.existsSync(path.join(f.modules, '.modules.yaml')));
    }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  });
}

test('rejects secrets nested in public sections without logging their values', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, 'settings.yaml'),
    'status-rotator:\n  config:\n    apiKey: private-sentinel\nwebui-modules: {}\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret-bearing public configuration/);
  assert.doesNotMatch(result.stderr + result.stdout, /private-sentinel/);
});

test('parser errors do not expose secret source lines', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, 'settings.yaml'), 'password: [private-sentinel\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr + result.stdout, /private-sentinel|password/);
});

test('secret signatures in dependency files with arbitrary extensions are rejected', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.modules, 'secret.dat'), '-----BEGIN PRIVATE KEY-----\nprivate-sentinel');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret-bearing seed content/);
  assert.doesNotMatch(result.stderr + result.stdout, /private-sentinel/);
});

test('reviewed public settings and manifests remain compatible without node_modules', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-reviewed-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(root, 'distribution', 'profile-seed');
  const profile = path.join(temp, 'profiles', 'web-desktop');
  fs.mkdirSync(profile, { recursive: true });
  // Copy only version-controlled public manifests, never a user's dependency tree.
  for (const name of ['settings.yaml', 'README.md']) {
    fs.copyFileSync(path.join(source, name), path.join(temp, name));
  }
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    fs.copyFileSync(path.join(source, 'profiles', 'web-desktop', name), path.join(profile, name));
  }
  const before = fs.readFileSync(path.join(temp, 'settings.yaml'), 'utf8');
  const run = () => spawnSync(process.execPath, [script, root], {
    cwd: root, env: { ...process.env, DSH_PROFILE_SEED_DIR: temp }, encoding: 'utf8',
  });
  assert.equal(run().status, 0);
  const after = fs.readFileSync(path.join(temp, 'settings.yaml'), 'utf8');
  assert.equal(after, before);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(temp, 'settings.yaml'), 'utf8'), after);
  assert.ok(!fs.existsSync(path.join(profile, 'node_modules')));
});

test('rejects dangling dependency links', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.temp, 'missing'), path.join(f.modules, 'dangling'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(f.run().status, 0);
  assert.ok(fs.existsSync(path.join(f.modules, '.modules.yaml')));
});

test('rejects linked manifest directories before touching external state', t => {
  const f = fixture(t);
  const external = path.join(f.temp, 'external-profile');
  fs.mkdirSync(external);
  // Use a fresh seed with no profile directory to avoid moving or deleting fixture trees.
  const seed = path.join(f.temp, 'linked-seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'settings.yaml'), publicSettings);
  fs.symlinkSync(external, path.join(seed, 'profiles'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [script, root], {
    cwd: root, env: { ...process.env, DSH_PROFILE_SEED_DIR: seed }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest symbolic link/);
  assert.deepEqual(fs.readdirSync(external), []);
});

for (const relative of ['profiles/web-desktop/.env', 'profiles/web-desktop/node_modules/.npmrc']) {
  test(`rejects profile-local state ${relative}`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.seed, relative), 'private-sentinel');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown seed user state/);
    assert.doesNotMatch(result.stderr, /private-sentinel/);
  });
}

test('rejects secrets in cordis config while allowing empty public config', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, 'profiles/web-desktop/cordis.patch.yml'),
    '- insert:\n    - name: public-plugin\n      config:\n        password: private-sentinel\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret-bearing public configuration/);
  assert.doesNotMatch(result.stderr, /private-sentinel/);
});

test('decoded configuration strings cannot hide user paths using unicode escapes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, 'settings.yaml'),
    String.raw`status-rotator: {template: "C:\u002fUsers\u002fAlice\u002fprivate"}` + '\nwebui-modules: {}\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /machine-local seed paths found/);
});

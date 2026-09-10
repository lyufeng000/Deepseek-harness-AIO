'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const exe = process.env.DSH_SMOKE_EXE || path.join(repo, 'tauri-app', 'target', 'release', 'DSHEAC AIO.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aio-boot-'));
const home = path.join(work, 'home');
const userData = path.join(work, 'user-data');
const settings = path.join(userData, 'settings.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

(async () => {
  if (!fs.existsSync(exe)) throw new Error(`AIO smoke executable is missing: ${exe}`);
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_USERDATA: userData,
      DSH_DESKTOP_SKIP_PLUGIN_UPDATE: '1',
      DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
    },
    stdio: 'ignore',
  });
  const started = Date.now();
  let port = 0;
  try {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`AIO exited early: ${child.exitCode}`);
      try { port = Number(JSON.parse(fs.readFileSync(settings, 'utf8')).webPort) || 0; } catch {}
      if (port > 0 && await probe(port)) break;
      await sleep(350);
    }
    if (!(port > 0) || !(await probe(port))) throw new Error('AIO web service did not become ready');
    console.log(`[boot-smoke] ready in ${Date.now() - started}ms at http://127.0.0.1:${port}`);
  } finally {
    if (child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
  }
  const closeDeadline = Date.now() + 15000;
  while (Date.now() < closeDeadline && await probe(port)) await sleep(250);
  if (await probe(port)) throw new Error(`web port remained open after exit: ${port}`);
  fs.rmSync(work, { recursive: true, force: true });
  console.log('[boot-smoke] PASS');
})().catch((error) => {
  console.error('[boot-smoke] FAIL:', error.stack || error.message);
  process.exit(1);
});

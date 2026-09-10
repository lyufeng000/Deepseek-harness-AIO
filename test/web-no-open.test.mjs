import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 内核 0.1.1-rc.2 起 `dsh web` 本机启动默认拉起系统浏览器（上游 feat:
// open the ready Web UI by default）。桌面壳自己开窗口，必须显式 --no-open，
// 否则每次启动多弹一个浏览器窗口（行为回归）。

test('Electron 壳启动 dsh web 显式传 --no-open（rc.2 默认开浏览器）', () => {
  const src = readFileSync(join(root, 'legacy/electron/main.js'), 'utf8');
  assert.match(
    src,
    /'--port', String\(webPort\), '--no-open'/,
    'spawn 参数必须在 --port 之后固定携带 --no-open',
  );
});

test('Tauri 壳（service.rs）同样显式传 --no-open', () => {
  const src = readFileSync(join(root, 'tauri-app', 'src', 'service.rs'), 'utf8');
  const portIdx = src.indexOf('.arg("--port")');
  const noOpenIdx = src.indexOf('"--no-open"');
  assert.ok(portIdx > -1, 'service.rs 应存在 --port 参数');
  assert.ok(noOpenIdx > portIdx, '--no-open 必须出现在 --port 之后');
});

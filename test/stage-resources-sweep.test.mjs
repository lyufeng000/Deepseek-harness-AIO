import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// resources/ 完全由 stage.ts 重建。若只清四个已知目录，历史残留的顶层目录
// （例如人工备份的 profile-seed-old-*）会混入 NSIS 打包清单，深层路径或
// 已被删除的文件会让 makensis 以 "File: failed opening file" 中止。
test('staging sweeps foreign top-level entries in tauri-app/resources', () => {
  const source = fs.readFileSync(new URL('../tauri-app/scripts/stage.ts', import.meta.url), 'utf8');
  assert.match(source, /rmrf\(path\.join\(RESOURCES, 'profile-seed'\)\)/);
  // 未知顶层条目清理：遍历 resources 并删除非点文件条目，.gitkeep 必须保留。
  assert.match(source, /fs\.readdirSync\(RESOURCES, \{ withFileTypes: true \}\)/);
  assert.match(source, /entry\.name\.startsWith\('\.'\)/);
  assert.match(source, /rmrf\(path\.join\(RESOURCES, entry\.name\)\)/);
});

// Bundled agent-preset sync.
// 忠实移植自legacy/electron/preset-sync.js：assets/agent-presets 内置 preset 装入
// 用户 preset 根；skip-if-exists（用户编辑与手动安装永远优先）。
// ensureDefaultAgentPreset 做保守的文本级 YAML 编辑，绝不破坏 settings.yaml。

import fs from 'node:fs';
import path from 'node:path';

type LogFn = (m: string) => void;

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const destination = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(source, destination);
    else if (entry.isSymbolicLink()) copyTree(fs.realpathSync(source), destination);
    else if (entry.isFile()) fs.copyFileSync(source, destination);
  }
}

export interface SyncPresetsResult {
  installed: string[];
  kept: string[];
}

export function syncBundledPresets(assetsRoot: string, presetsRoot: string, log: LogFn = () => {}): SyncPresetsResult {
  const installed: string[] = [];
  const kept: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(assetsRoot, { withFileTypes: true });
  } catch {
    return { installed, kept };
  }
  fs.mkdirSync(presetsRoot, { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(assetsRoot, entry.name);
    // Shared resource directories (upstream `_preset/`): preset manifests
    // reference them as `../_preset/<file>.mjs`, so they must be installed
    // next to the presets. Same skip-if-exists semantics.
    if (entry.name.startsWith('_')) {
      const sharedDest = path.join(presetsRoot, entry.name);
      if (fs.existsSync(sharedDest)) continue;
      try {
        copyTree(src, sharedDest);
        log('installed bundled preset shared dir: ' + entry.name);
      } catch (err) {
        log('failed to install bundled preset shared dir ' + entry.name + ': ' + (err instanceof Error ? err.message : String(err)));
      }
      continue;
    }
    // A preset directory must carry preset.yml; anything else in assets is
    // not a preset and is ignored.
    if (!fs.existsSync(path.join(src, 'preset.yml'))) continue;
    const dest = path.join(presetsRoot, entry.name);
    if (fs.existsSync(dest)) {
      kept.push(entry.name);
      continue;
    }
    try {
      copyTree(src, dest);
      installed.push(entry.name);
      log('installed bundled agent preset: ' + entry.name);
    } catch (err) {
      log('failed to install bundled agent preset ' + entry.name + ': ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  return { installed, kept };
}

/**
 * 把内置推荐 preset 设为新会话的默认（settings.yaml 的
 * `agent-presets.default` 字段）。
 *
 * 保守的文本级 YAML 编辑（不引 yaml 依赖）：
 *   · 用户已写过 `default:`（任意值）→ 一律保留（'kept'）；
 *   · 已有 `agent-presets:` 块状 section 但缺 default → 紧随头行插入；
 *   · 没有 section → 文件末尾追加；
 *   · 识别不了的结构（内联 flow、非顶层同名键）→ 跳过（'skipped'），
 *     宿主回落官方默认 preset，绝不破坏用户的 settings.yaml。
 * 指名的 preset 目录不存在时也跳过（默认值不能指向缺失的 preset）。
 */
export function ensureDefaultAgentPreset(home: string, presetId: string, log: LogFn = () => {}): 'kept' | 'set' | 'skipped' {
  try {
    if (!fs.existsSync(path.join(home, '.agent-presets', presetId, 'preset.yml'))) return 'skipped';
    const file = path.join(home, 'settings.yaml');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
    let bom = false;
    if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1); }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const blockHeader = /^agent-presets[ \t]*:[ \t]*(?:#.*)?$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!/^agent-presets[ \t]*:/.test(line)) continue;
      if (!blockHeader.test(line)) {
        // 内联 flow（agent-presets: {…}）等非块状结构：识别不了，不碰。
        log('settings.yaml 的 agent-presets section 不是块状结构，保持不动');
        return 'skipped';
      }
      // section 体：到下一个顶层键（或文件尾）为止。
      let end = i + 1;
      while (end < lines.length && !/^\S/.test(lines[end] as string)) end++;
      for (let k = i + 1; k < end; k++) {
        if (/^[ \t]+default[ \t]*:/.test(lines[k] as string)) return 'kept';
      }
      lines.splice(i + 1, 0, '  default: ' + presetId);
      fs.writeFileSync(file, (bom ? '\uFEFF' : '') + lines.join(eol));
      return 'set';
    }
    // 缩进出现的 agent-presets 键（嵌套在别的 section 里）不归我们管，
    // 直接追加顶层 section 不会与之冲突。
    const trailing = text === '' || text.endsWith(eol) ? '' : eol;
    fs.writeFileSync(file, (bom ? '\uFEFF' : '') + text + trailing + 'agent-presets:' + eol + '  default: ' + presetId + eol);
    return 'set';
  } catch (err) {
    log('设置默认 agent preset 失败: ' + (err instanceof Error ? err.message : String(err)));
    return 'skipped';
  }
}

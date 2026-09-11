// 忠实移植自 scripts/plugin-manager-patch.js
// ---------------------------------------------------------------------------
// 纯文本手术：web profile 的 cordis.patch.yml 中某个插件的用户层 disabled 条目
// 开关。不改写文件其它内容/注释（保留格式与用户手写条目）。
//
//   关闭 —— 先从任何 `- insert:` 块内移除该 id 的内层条目（避免 loader 双登记
//           崩溃），再保证存在一个顶层 `- id: <id>` 条目且带 `disabled: true`；
//           顶层条目已存在（如 llm-deepseek）则就地补 disabled 行。
//   启用 —— insert 内层条目与顶层条目都移除 `disabled` 行；无 config 的顶层
//           条目保留为裸条目 {id, name}（EAC 修改：默认禁用的配套插件被用户
//           启用后，不被下次 sync 重新插回 disabled 行）。
//
// EAC 重写说明（相对上游 dsh_desktop 版本）：上游用「贪婪正则整块匹配」定位
// 条目块，续行模式 (?:[ \t]+[^\n]*\n)* 会连后续兄弟条目一起吞掉（禁用中位/
// 首位条目时，其后的条目被整块误删，实测复现且可用回溯绕过先行断言）。
// 这里改为逐行扫描：条目块 = `- id:` 行 + 其后所有缩进更深的属性行，天然
// 不会越过下一个兄弟条目。
// ---------------------------------------------------------------------------

// loader 条目 id 的白名单：普通标识符（连字符/下划线/点）。防注入：
// id 会被拼进匹配与 YAML 文本，禁止空白、引号、冒号等特殊字符。
const ID_RE = /^[A-Za-z0-9_.-]+$/;

/** YAML 单引号串转义：单引号加倍（''）。 */
function yamlQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

const LEADING = /^([ \t]*)(.*)$/;

// Keep each original terminator attached to its line. Only inserted lines use
// the first observed newline convention; a BOM belongs to the document.
function readPatch(text: string): { bom: string; eol: string; finalEol: boolean; lines: string[] } {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  return {
    bom,
    eol: /\r\n|\n|\r/.exec(body)?.[0] ?? '\n',
    finalEol: /[\r\n]$/.test(body),
    lines: body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [],
  };
}

function lineText(line: string): string {
  return line.replace(/(?:\r\n|\n|\r)$/, '');
}

function insertLines(lines: string[], at: number, added: string[], eol: string, finalEol: boolean): void {
  if (at > 0 && !/[\r\n]$/.test(lines[at - 1]!)) lines[at - 1] += eol;
  const hasNext = at < lines.length;
  lines.splice(at, 0, ...added.map((line, i) =>
    line + (i < added.length - 1 || hasNext || finalEol ? eol : '')));
}

/** 行是否是指定 id 的条目起始行；返回缩进宽度，否则 null。indentLo/Hi 限定层级。 */
function entryIndentOf(line: string, id: string, indentLo: number, indentHi: number): number | null {
  line = lineText(line);
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^- id:\\s*' + escapedId + '(?![A-Za-z0-9_.-])').exec(line.replace(/^[ \t]+/, ''));
  if (!m) return null;
  const ind = LEADING.exec(line)![1]!.length;
  if (ind < indentLo || ind > indentHi) return null;
  return ind;
}

interface EntryBlock {
  start: number;
  end: number;
  indent: number;
}

/**
 * 在行数组中定位第一个满足层级的 `- id: <id>` 条目块。
 * 返回 { start, end, indent }（end 为独占下界）：块 = 起始行 + 其后所有
 * 缩进比起始行更深的非空行（空行视为块结束，保守不吞）。
 */
function findEntryBlock(lines: string[], id: string, indentLo: number, indentHi: number): EntryBlock | null {
  for (let i = 0; i < lines.length; i++) {
    const ind = entryIndentOf(lines[i]!, id, indentLo, indentHi);
    if (ind === null) continue;
    let j = i + 1;
    while (j < lines.length) {
      const [, ws, rest] = LEADING.exec(lineText(lines[j]!))!;
      if (!rest) break; // 空行：块结束
      if (ws!.length <= ind) break; // 兄弟条目或外层结构：块结束
      j += 1;
    }
    return { start: i, end: j, indent: ind };
  }
  return null;
}

/** 块内属性行（缩进 > 条目缩进）里第一个匹配 /^[ \t]*key\s*:/ 的行下标。 */
function findPropLine(lines: string[], block: EntryBlock, keyRe: RegExp): number {
  for (let i = block.start + 1; i < block.end; i++) {
    if (keyRe.test(lineText(lines[i]!))) return i;
  }
  return -1;
}

/**
 * @param text    patch 文件全文
 * @param id      条目 id（白名单字符集）
 * @param enabled true=启用（移除 disabled 覆盖），false=关闭
 * @param name  包名（关闭时顶层条目需要）
 * @returns 手术后的全文
 */
export function togglePluginInPatch(text: string, id: string, enabled: boolean, name?: string): string {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string');
  if (!ID_RE.test(id)) throw new TypeError('id 含非法字符（仅允许字母/数字/下划线/点/连字符）: ' + id);
  const pkgName = typeof name === 'string' && name ? name : id;
  const disabledPropRe = /^[ \t]*disabled\s*:\s*(?:true|false)\s*(?:#.*)?$/;
  const namePropRe = /^[ \t]*name\s*:/;

  const { bom, eol, finalEol, lines: originalLines } = readPatch(text);
  let lines = originalLines;

  if (!enabled) {
    // 1) 从 insert 块内移除内层条目（缩进 >= 1 视为内层；同一 id 只留一个登记点）
    let inner = findEntryBlock(lines, id, 1, Infinity);
    if (inner) lines.splice(inner.start, inner.end - inner.start);
    // 1.5) 清理被掏空的孤立 `- insert:` 空块
    lines = lines.filter((line, idx) => {
      if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
      let k = idx + 1;
      while (k < lines.length && lines[k]!.trim() === '') k += 1;
      return k < lines.length && /^[ \t]+- /.test(lines[k]!);
    });
    // 2) 顶层条目（缩进 0-2）：存在则确保 disabled: true；不存在则追加
    const top = findEntryBlock(lines, id, 0, 2);
    if (top) {
      if (findPropLine(lines, top, disabledPropRe) === -1) {
        const nameIdx = findPropLine(lines, top, namePropRe);
        const insertAt = nameIdx >= 0 ? nameIdx + 1 : top.start + 1;
        insertLines(lines, insertAt, ['  disabled: true'], eol, finalEol);
      }
    } else {
      // 追加前先清掉历史遗留的标记注释（避免反复开关时注释堆积）
      lines = lines.filter((l) => !new RegExp('# [^\\n]*关闭 ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])').test(l));
      insertLines(lines, lines.length, ['', '# 插件管理（设置页「插件」栏）：关闭 ' + id, '- id: ' + id, '  name: ' + yamlQuote(pkgName), '  disabled: true'], eol, finalEol);
    }
    return bom + lines.join('');
  }

  // 启用：insert 内层条目与顶层条目都移除 disabled 属性行；顶层无 config
  // 时保留裸条目 {id, name}（见文件头说明）；标记注释仍清理。
  for (const range of [[1, Infinity], [0, 2]] as const) {
    for (;;) {
      const block = findEntryBlock(lines, id, range[0], range[1]);
      if (!block) break;
      const idx = findPropLine(lines, block, disabledPropRe);
      if (idx === -1) break;
      lines.splice(idx, 1);
    }
  }
  lines = lines.filter((l) => !new RegExp('# [^\\n]*关闭 ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])').test(l));
  return bom + lines.join('');
}

/**
 * 幂等地把指定插件条目标记为 disabled: true，但保留它原来的登记位置和
 * config。用于默认关闭的配套插件迁移；用户之后重新启用时，不再调用本函数。
 */
export function ensurePluginDisabledInPatch(text: string, id: string, name?: string): string {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string');
  if (!ID_RE.test(id)) throw new TypeError('id 含非法字符（仅允许字母/数字/下划线/点/连字符）: ' + id);
  const pkgName = typeof name === 'string' && name ? name : id;
  const disabledPropRe = /^[ \t]*disabled\s*:\s*(?:true|false)\s*(?:#.*)?$/;
  const disabledTrueRe = /^[ \t]*disabled\s*:\s*true\s*(?:#.*)?$/;
  const namePropRe = /^[ \t]*name\s*:/;
  const { bom, eol, finalEol, lines: originalLines } = readPatch(text);
  const lines = originalLines;
  const block = findEntryBlock(lines, id, 1, Infinity) ?? findEntryBlock(lines, id, 0, 2);
  if (!block) {
    insertLines(lines, lines.length, ['', '# 插件管理（设置页「插件」栏）：关闭 ' + id,
      '- id: ' + id, '  name: ' + yamlQuote(pkgName), '  disabled: true'], eol, finalEol);
    return bom + lines.join('');
  }
  const disabledIdx = findPropLine(lines, block, disabledPropRe);
  if (disabledIdx !== -1) {
    const content = lineText(lines[disabledIdx]!);
    if (disabledTrueRe.test(content)) return text;
    const terminator = lines[disabledIdx]!.slice(content.length);
    lines[disabledIdx] = content.replace(/(disabled\s*:\s*)false\b/, '$1true') + terminator;
    return bom + lines.join('');
  }
  const insertAt = block.end;
  insertLines(lines, insertAt, [' '.repeat(block.indent + 2) + 'disabled: true'], eol, finalEol);
  return bom + lines.join('');
}

/**
 * 从 patch 中彻底移除某插件的全部登记点：顶层条目（缩进 0-2）+ insert 内层
 * 条目（缩进 >=1）+ 关闭标记注释；顺带清理被掏空的孤立 `- insert:` 空块。
 * 用于「移除内置插件」（区别于 toggle 的禁用——移除后 sync 不再写回该行）。
 */
export function removePluginFromPatch(text: string, id: string): string {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string');
  if (!ID_RE.test(id)) throw new TypeError('id 含非法字符（仅允许字母/数字/下划线/点/连字符）: ' + id);
  const { bom, lines: originalLines } = readPatch(text);
  let lines = originalLines;
  // 先删内层（insert 块内），再删顶层；同一 id 的所有登记点都移除
  for (const range of [[1, Infinity], [0, 2]] as const) {
    for (;;) {
      const block = findEntryBlock(lines, id, range[0], range[1]);
      if (!block) break;
      lines.splice(block.start, block.end - block.start);
    }
  }
  lines = lines.filter((line, idx) => {
    if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
    let k = idx + 1;
    while (k < lines.length && lines[k]!.trim() === '') k += 1;
    return k < lines.length && /^[ \t]+- /.test(lines[k]!);
  });
  lines = lines.filter((l) => !new RegExp('# [^\\n]*关闭 ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])').test(l));
  return bom + lines.join('');
}

/**
 * patch 文本里是否已登记 `id: <id>`（顶层条目或 insert 内层条目）。
 * 用于 syncCompanionPlugins / restoreCompanionPlugin 的「已有行不重写」判定。
 * 负向断言 (?![A-Za-z0-9_.-]) 防止前缀误匹配：dsh-pet 不得命中
 * `- id: dsh-pet-settings` 这类兄弟条目（旧 `\b` 词边界会命中）。
 */
export function hasEntryId(text: string, id: string): boolean {
  if (typeof text !== 'string' || !text || typeof id !== 'string' || !id) return false;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('id:\\s*' + escapedId + '(?![A-Za-z0-9_.-])').test(text);
}

/** 包名归属：`@scope/name/子路径` → `@scope/name`，`name/子路径` → `name`。 */
export function packageNameOf(reference: string): string {
  const parts = String(reference).split('/');
  if (reference.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] || reference;
}

/** 去掉 YAML 单/双引号包裹。 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const single = trimmed.startsWith("'") && trimmed.endsWith("'");
  const double = trimmed.startsWith('"') && trimmed.endsWith('"');
  if (single || double) {
    const body = trimmed.slice(1, -1);
    return single ? body.replace(/''/g, "'") : body.replace(/\\"/g, '"');
  }
  return trimmed;
}

export interface PrunedRow {
  id: string;
  name: string;
}

/**
 * 更新（发行包替换）换掉依赖闭包后，patch 里引用已不存在的包会让 dsh 因缺包失败。
 * 这里按退场规则删除整条块（原文留在调用方的 `.pre-prune.bak` 备份里），并返回
 * 被删除的条目清单供留档；子项被删空的 `- insert:` 头行一并清理。
 *
 * 只处理能确定包名归属的条目：name 是相对/绝对路径的条目、缺 name 的裸条目
 * 一律保留；available 由调用方按 profile 实际内容（闭包 + 用户依赖）构建。
 */
export function pruneUnavailableRows(
  text: string,
  available: Iterable<string>,
): { patch: string; pruned: PrunedRow[] } {
  if (typeof text !== 'string' || text === '') {
    return { patch: typeof text === 'string' ? text : '', pruned: [] };
  }
  const names = available instanceof Set ? (available as Set<string>) : new Set(available);
  const { bom, lines } = readPatch(text);
  const drops: { start: number; end: number }[] = [];
  const pruned: PrunedRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^([ \t]*)- id:[ \t]*([A-Za-z0-9_.-]+)[ \t]*(?:#.*)?$/.exec(lineText(lines[i]!));
    if (!start) continue;
    const indent = start[1]!.length;
    let end = i + 1;
    while (end < lines.length) {
      const [, ws, rest] = LEADING.exec(lineText(lines[end]!))!;
      if (!rest || ws!.length <= indent) break;
      end += 1;
    }
    let name: string | null = null;
    for (let k = i + 1; k < end; k++) {
      const match = /^[ \t]+name[ \t]*:[ \t]*(.+?)[ \t]*$/.exec(lineText(lines[k]!));
      if (match && match[1]) {
        name = unquote(match[1]);
        break;
      }
    }
    if (!name || /^[./\\]/.test(name) || names.has(packageNameOf(name))) {
      i = end - 1;
      continue;
    }
    drops.push({ start: i, end });
    pruned.push({ id: start[2]!, name });
    i = end - 1;
  }
  if (!drops.length) return { patch: text, pruned: [] };
  for (const drop of drops.slice().sort((a, b) => b.start - a.start)) {
    lines.splice(drop.start, drop.end - drop.start);
  }
  // 子项被删空的 `- insert:` 头行一并清理（与插件管理的删除语义一致）。
  for (let i = lines.length - 1; i >= 0; i--) {
    const header = /^([ \t]*)- insert:[ \t]*$/.exec(lineText(lines[i]!));
    if (!header) continue;
    const indent = header[1]!.length;
    let j = i + 1;
    let child = false;
    while (j < lines.length) {
      const bare = lineText(lines[j]!);
      const [, ws, rest] = LEADING.exec(bare)!;
      if (!rest) break;
      if (ws!.length <= indent) break;
      if (/^[ \t]*- /.test(bare)) {
        child = true;
        break;
      }
      j += 1;
    }
    if (!child) lines.splice(i, 1);
  }
  return { patch: bom + lines.join(''), pruned };
}

/** 从 bundle 清单里剔除指向不存在包的项（缺包 bundle 会让 dsh 直接起不来）。 */
export function pruneUnavailableBundles(
  bundles: unknown,
  available: Iterable<string>,
): { kept: unknown[]; removed: string[] } {
  if (!Array.isArray(bundles)) return { kept: [], removed: [] };
  const names = available instanceof Set ? (available as Set<string>) : new Set(available);
  const kept: unknown[] = [];
  const removed: string[] = [];
  for (const name of bundles) {
    if (typeof name !== 'string' || !name) {
      kept.push(name);
      continue;
    }
    if (/^[./\\]/.test(name) || names.has(packageNameOf(name))) {
      kept.push(name);
      continue;
    }
    removed.push(name);
  }
  return { kept, removed };
}

// 插件管理状态合并（v4.2）：把 profile cordis.patch.yml 解析出的 entries
// 合并成管理页 / 桌宠设置可消费的行列表。纯函数，不碰磁盘。
//
// 忠实移植自legacy/electron/plugin-manager-state.js（语义要点见原文件头注释）：
//  · 顶层 `- id: x` 条目与 `- insert:` 内层条目都算登记点；
//  · 任一登记点带 disabled: true 即视为禁用；
//  · hasConfig 只读顶层条目。

export interface PatchInsertEntry {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
}

export interface PatchEntry {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  config?: unknown;
  insert?: unknown;
}

export interface CompanionPlugin {
  id: string;
  name: string;
}

export interface CollectCtx {
  companion?: CompanionPlugin[];
  coreIds?: Iterable<string>;
  removedIds?: Iterable<string>;
  describe?: (name: string) => string;
  bundles?: string[];
}

export interface PluginRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  toggleable: boolean;
  removable: boolean;
  removed: boolean;
  core: boolean;
  group: 'companion' | 'other' | 'core';
}

interface RegistrationInfo {
  name: string;
  disabled: boolean;
  hasConfig?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function collectPluginRows(entries: unknown[], ctx: CollectCtx = {}): PluginRow[] {
  const companion = Array.isArray(ctx.companion) ? ctx.companion : [];
  const companionById = new Map(companion.map((p) => [p.id, p.name] as const));
  const companionNames = new Set(companion.map((p) => p.name));
  const coreIds = new Set(ctx.coreIds || []);
  const removedIds = new Set(ctx.removedIds || []);
  const describe = typeof ctx.describe === 'function' ? ctx.describe : () => '';
  const bundles = Array.isArray(ctx.bundles) ? ctx.bundles : [];

  const insertById = new Map<string, RegistrationInfo>();
  const userById = new Map<string, RegistrationInfo>();
  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const entry = raw as PatchEntry;
    if (Array.isArray(entry.insert)) {
      for (const rawIt of entry.insert) {
        if (!isRecord(rawIt)) continue;
        const itId = rawIt.id;
        if (typeof itId !== 'string') continue;
        const itName = rawIt.name;
        insertById.set(itId, {
          name: typeof itName === 'string' ? itName : '',
          disabled: rawIt.disabled === true,
        });
      }
    } else if (typeof entry.id === 'string') {
      userById.set(entry.id, {
        name: typeof entry.name === 'string' ? entry.name : '',
        disabled: entry.disabled === true,
        hasConfig: entry.config !== undefined && entry.config !== null,
      });
    }
  }

  const seen = new Set<string>();
  const rows: PluginRow[] = [];
  const addRow = (id: string, name: string, group: PluginRow['group'], extra?: { removed?: boolean; core?: boolean }): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const user = userById.get(id);
    const insert = insertById.get(id);
    // 顶层或 insert 内层任一登记点带 disabled 即禁用（v4.2 修复点）。
    const disabled = !!(user && user.disabled) || !!(insert && insert.disabled);
    const hasConfig = !!(user && user.hasConfig);
    const isRemoved = !!(extra && extra.removed);
    const isCore = !!(extra && extra.core);
    const toggleable = group !== 'core' && !(hasConfig && !disabled);
    rows.push({
      id,
      name: name || id,
      description: describe(name || id),
      enabled: !disabled && !isRemoved,
      toggleable: toggleable && !isRemoved,
      removable: group === 'companion' && !isCore && !isRemoved,
      removed: isRemoved,
      core: isCore,
      group,
    });
  };
  for (const p of companion) {
    addRow(p.id, p.name, 'companion', { removed: removedIds.has(p.id), core: coreIds.has(p.id) });
  }
  for (const [id, info] of insertById) if (!companionById.has(id)) addRow(id, info.name, 'other');
  for (const [id, u] of userById) if (!companionById.has(id)) addRow(id, u.name, 'other');
  for (const name of bundles) {
    if (companionNames.has(name)) continue;
    const id = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (!seen.has(id)) addRow(id, name, 'core');
  }
  const order: Record<PluginRow['group'], number> = { companion: 0, other: 1, core: 2 };
  return rows.sort((a, b) => order[a.group] - order[b.group] || a.id.localeCompare(b.id));
}

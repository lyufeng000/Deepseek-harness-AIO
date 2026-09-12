// DeepSeek 官方适配器在 1.3.1 起与通用模型配置使用相同的 providers.<route>
// 结构。本迁移只处理用户 settings.yaml 中的 llm-deepseek 节，并在改写前保留原文。

import fs from 'node:fs';
import path from 'node:path';
import yaml = require('js-yaml');

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const PROVIDER = 'deepseek-official';

type Plain = Record<string, unknown>;

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function migrateModel(value: unknown): unknown {
  if (!plain(value)) return value;
  const next = { ...value };
  if (next.input === undefined && Array.isArray(next.inputModalities)) next.input = [...next.inputModalities];
  delete next.inputModalities;
  return next;
}

export type DeepSeekSettingsMigration =
  | { changed: false; reason: 'missing' | 'not-needed' | 'unsafe' }
  | { changed: true; backup: string };

export function migrateDeepSeekSettings(home: string): DeepSeekSettingsMigration {
  const file = path.join(home, 'settings.yaml');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { changed: false, reason: 'missing' };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) {
    return { changed: false, reason: 'unsafe' };
  }

  const original = fs.readFileSync(file, 'utf8');
  const document = yaml.load(original);
  if (!plain(document) || !plain(document['llm-deepseek'])) return { changed: false, reason: 'not-needed' };

  const section = document['llm-deepseek'] as Plain;
  const existingProviders = plain(section.providers) ? section.providers as Plain : {};
  const explicit = plain(existingProviders[PROVIDER]) ? existingProviders[PROVIDER] as Plain : {};
  const legacy = Object.fromEntries(Object.entries(section).filter(([key]) => key !== 'providers'));
  const merged: Plain = { ...legacy, ...explicit };
  if (Array.isArray(merged.models)) merged.models = merged.models.map(migrateModel);

  const onlyNested = Object.keys(legacy).length === 0
    && plain(existingProviders[PROVIDER])
    && !Array.isArray((explicit as Plain).models)
      ? true
      : Object.keys(legacy).length === 0
        && JSON.stringify(existingProviders[PROVIDER]) === JSON.stringify(merged);
  if (onlyNested) return { changed: false, reason: 'not-needed' };

  document['llm-deepseek'] = {
    providers: {
      ...existingProviders,
      [PROVIDER]: merged,
    },
  };

  const backupDir = path.join(home, '.aio-user-settings-backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'settings.yaml.before-deepseek-provider-v1.bak');
  try {
    fs.writeFileSync(backup, original, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const next = yaml.dump(document, { noRefs: true, lineWidth: -1, sortKeys: false });
  const temp = path.join(home, `.settings.yaml.deepseek-migration-${process.pid}.tmp`);
  fs.writeFileSync(temp, next, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore cleanup failure */ }
    throw error;
  }
  return { changed: true, backup };
}

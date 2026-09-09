const regions = [
  { name: 'BetterAssistantNodeView', hooks: 3 },
  { name: 'ToolGroupNodeView', hooks: 2 },
];

// Only the reviewed WebUI renderers consume the retired session chat projection.
export function migrateWebuiChatRenderers(source) {
  let output = source;
  for (const { name, hooks } of regions) {
    const start = output.indexOf(`const ${name} = `);
    const end = output.indexOf('//#endregion', start);
    if (start < 0 || end < start || output.indexOf(`const ${name} = `, start + 1) >= 0) {
      throw new Error(`Unrecognized WebUI chat renderer: ${name}`);
    }
    const original = output.slice(start, end);
    if (!original.includes('useSession')) {
      if ((original.match(/useChat\(/g) || []).length !== hooks
          || !original.includes('snapshot.legacy.turnTimings')) {
        throw new Error(`Incomplete WebUI chat migration: ${name}`);
      }
      continue;
    }
    if ((original.match(/useSession\(/g) || []).length !== hooks
        || !original.includes('snapshot.chat.locations')
        || !original.includes('snapshot.turnTimings')) {
      throw new Error(`Unexpected WebUI chat projection: ${name}`);
    }
    const migrated = original.replaceAll('useSession', 'useChat')
      .replaceAll('snapshot.chat.', 'snapshot.')
      .replaceAll('snapshot.turnTimings', 'snapshot.legacy.turnTimings');
    output = output.slice(0, start) + migrated + output.slice(end);
  }
  return output;
}

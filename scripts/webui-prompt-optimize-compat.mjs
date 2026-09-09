// Reviewed dsh-webui 0.5.1 boundary; the staging caller owns package validation.
// Current owner: ui-conversation SessionStandardProps, upstream c389f96bf3a9b6807cb71ed6bdad5849be0df6d8.
export function migrateWebuiPromptOptimize(source) {
  const old = 'function PromptOptimizeButton({ available, directory, input, inputActions, sessionId }) {';
  const current = 'function PromptOptimizeButton({ available, directory, useInput, inputActions, sessionId }) {\n\t\t\tconst input = useInput((state) => state);';
  if (!(source.includes(current) && !source.includes(old))) {
    if (source.split(old).length !== 2) {
      throw new Error('Unrecognized dsh-webui prompt optimizer component boundary');
    }
    source = source.replace(old, current);
  }
  // applySkills precedes optimizer registration. Its old shared locale name
  // throws when the current official ui-skill has already registered.
  for (const [start, oldText, newText] of [
    ['function applyPromptOptimize(ctx)', '"modelDirectories",\n\t\t\t\t"sessions"',
      '"modelDirectories",\n\t\t\t\t"remote.session",\n\t\t\t\t"sessions"'],
    ['//#region src/client/skill-source/locales.ts', 'NS$1 = "skill";', 'NS$1 = "webui.skill";'],
    ['function apply$3(ctx)', 'key: "skill",\n\t\t\t\tlocale: NS$1',
      'key: "skill",\n\t\t\t\tpriority: -100,\n\t\t\t\tlocale: NS$1'],
  ]) {
    const from = source.indexOf(start);
    const to = source.indexOf('//#endregion', from + start.length);
    if (from < 0 || to < from || source.indexOf(start, from + start.length) >= 0) {
      throw new Error('Unrecognized dsh-webui skill registration boundary');
    }
    const original = source.slice(from, to);
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    let region = original.replace(/\r\n/g, '\n');
    if (!(region.includes(newText) && !region.includes(oldText))) {
      if (region.split(oldText).length !== 2) throw new Error('Unrecognized dsh-webui skill registration');
      region = region.replace(oldText, newText);
    }
    source = source.slice(0, from) + region.replace(/\n/g, newline) + source.slice(to);
  }
  return source;
}

// c389f96 Remote signatures, scoped to the reviewed webui provider page.
// This adapter is emitted into that browser bundle; never patch connection.api.
export function createAioProviderSettingsApi(remote) {
  const wrap = async (pending, project = value => value) => {
    const result = await pending;
    if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid provider Remote response');
    if (result.ok) return { result: { ok: true, value: project(result.value) } };
    return { result: { ...result, error: {
      ...result.error,
      code: result.error.code === 'settings/conflict' ? 'settings-conflict' : result.error.code,
    } } };
  };
  return {
    llm: {
      providers: async () => {
        const [registered, declared] = await Promise.all([
          remote.llm.listProviders(), remote.llm.listConfigurableProviders(),
        ]);
        if (!registered.ok) return wrap(registered);
        if (!declared.ok) return wrap(declared);
        const active = new Set(registered.value.map(row => row.id));
        const seen = new Set(declared.value.map(row => row.provider));
        const providers = declared.value.map(row => ({
          ...row, settingsPath: [...row.settingsPath], active: active.has(row.provider),
        }));
        for (const row of registered.value) {
          if (!seen.has(row.id)) providers.push({
            provider: row.id, displayName: row.name, settingsNs: '', settingsPath: [], active: true,
          });
        }
        return { result: { ok: true, value: { providers } } };
      },
      discoverModels: ({ settingsNs, ...request }) =>
        wrap(remote.llm.discoverModels(settingsNs, request), models => ({ models })),
    },
    settings: {
      describe: () => wrap(remote.settings.describe()),
      mutate: ({ ns, ops, expectedRevision }) => wrap(remote.settings.mutate(ns, ops, expectedRevision)),
    },
    credentials: {
      describe: ({ refs }) => wrap(remote.credentials.describe(refs), credentials => ({ credentials })),
      set: ({ ref, value }) => wrap(remote.credentials.set(ref, value)),
      unset: ({ ref }) => wrap(remote.credentials.unset(ref)),
    },
  };
}

export function migrateProviderSettingsClient(source) {
  const start = source.indexOf('function applyProviderHub(ctx) {');
  const end = source.indexOf('//#endregion', start);
  if (start < 0 || end < 0) throw new Error('Unknown reviewed provider-hub boundary');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const original = source.slice(start, end);
  let block = original.replace(/\r\n/g, '\n');
  const old = 'ctx.effect(() => {\n'
    + '\t\t\t\tconst connection = ctx.get("connection");\n'
    + '\t\t\t\tconst controller = new ModelsSettingsStore(connection.api);\n'
    + '\t\t\t\tconst injected = () => ({\n'
    + '\t\t\t\t\tcontroller,\n'
    + '\t\t\t\t\tapi: connection.api\n'
    + '\t\t\t\t});';
  const replacement = 'ctx.inject(["remote.llm", "remote.settings", "remote.credentials"], (scope) => scope.effect(() => {\n'
    + '\t\t\t\tconst api = createAioProviderSettingsApi(scope.remote);\n'
    + '\t\t\t\tconst controller = new ModelsSettingsStore(api);\n'
    + '\t\t\t\tconst injected = () => ({ controller, api });';
  if (block.split(old).length !== 2 ||
      block.split('}, "@dsh-external/dsh-webui: provider section");').length !== 2) {
    throw new Error('Unknown reviewed provider-hub API usage');
  }
  block = block.replace(old, replacement).replace(
    '}, "@dsh-external/dsh-webui: provider section");',
    '}, "@dsh-external/dsh-webui: provider section"));');
  return source.slice(0, start)
    + createAioProviderSettingsApi.toString().replace(/\n/g, newline) + newline
    + block.replace(/\n/g, newline) + source.slice(end);
}

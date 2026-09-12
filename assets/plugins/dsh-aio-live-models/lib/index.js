// DSHEAC AIO 配套插件：内置 DeepSeek 官方 provider（设置命名空间 `llm-deepseek`，
// 路由 `deepseek-official`）的实时模型发现。
//
// 上游 `@deepseek-ai/dsh-llm-deepseek` 只带一个静态 DEFAULT_MODELS 且不注册模型
// 发现，所以 Web UI 的「获取可用模型」对 DeepSeek 只会内联报错、不弹窗。这里注册
// 一个发现处理器，始终向 provider 的 `GET {baseURL}/models` 请求；不做静态回退，
// 请求失败就以可读错误上抛，由界面呈现。

const name = 'dsh-aio-live-models';
const inject = ['llm'];

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_CONTEXT_WINDOW = 262144; // 256k：发现结果只带基础字段，上下文窗口按默认给
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const OFFICIAL_IMAGE_MODELS = new Set([
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]);

function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '');
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

async function readBoundedJson(response) {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error('DeepSeek /models 响应超出大小限制');
  }
  return JSON.parse(text);
}

/** Map an OpenAI-compatible `/models` payload to discovery rows, deduplicated by id. */
function toDiscoveredModels(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload && payload.data) ? payload.data
      : [];
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (row && typeof row.id === 'string' ? row.id : '');
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const model = { id, contextWindow: DEFAULT_CONTEXT_WINDOW };
    if (OFFICIAL_IMAGE_MODELS.has(id)) model.inputModalities = ['text', 'image'];
    if (row && typeof row === 'object' && typeof row.name === 'string' && row.name.length > 0) {
      model.name = row.name;
    }
    if (row && typeof row === 'object' && Number.isSafeInteger(row.max_tokens) && row.max_tokens > 0) {
      model.maxTokens = row.max_tokens;
    }
    models.push(model);
  }
  return models;
}

function apply(ctx) {
  const deepseekSettings = () => {
    try {
      const settings = ctx.get('settings');
      const section = settings && typeof settings.get === 'function' ? settings.get('llm-deepseek') || {} : {};
      return section.providers?.['deepseek-official'] ?? section;
    } catch {
      return {};
    }
  };

  const apiKeyFor = async (request, settings) => {
    if (typeof request.apiKey === 'string' && request.apiKey.length > 0) return request.apiKey;
    const ref = stringOr(settings.apiKeyEnv, DEFAULT_API_KEY_ENV);
    try {
      const credentials = ctx.get('credentials');
      const hit = credentials ? await credentials.resolve(ref) : undefined;
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
    } catch {
      // 凭据服务不可用/未配置：让请求以 provider 的鉴权错误上抛。
    }
    return undefined;
  };

  ctx.llm.registerModelDiscovery('llm-deepseek', async (request = {}, signal) => {
    const settings = deepseekSettings();
    const baseURL = trimTrailingSlashes(stringOr(request.baseURL, stringOr(settings.baseURL, DEFAULT_BASE_URL)));
    const apiKey = await apiKeyFor(request, settings);
    const headers = { accept: 'application/json' };
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal && signal.aborted) throw error;
      throw new Error(`无法连接 ${baseURL}/models：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '（请检查 API Key）' : '';
      throw new Error(`${baseURL}/models 返回 HTTP ${response.status}${hint}`);
    }
    const models = toDiscoveredModels(await readBoundedJson(response));
    if (models.length === 0) throw new Error(`${baseURL}/models 未返回任何模型`);
    return models;
  });
}

export { apply, inject, name, toDiscoveredModels, DEFAULT_CONTEXT_WINDOW };

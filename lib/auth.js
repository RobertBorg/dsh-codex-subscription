/**
 * Codex CLI 本地凭证的读取与刷新。
 *
 * 凭证来源是 codex CLI 的 `~/.codex/auth.json`(CODEX_HOME 可覆盖),与 CLI
 * 完全同源,因此「用户已登录的 codex 凭证」天然被复用:CLI 登录/退出/换号,
 * 本插件下一次请求自动跟随。文件里两种形态:
 *
 * - `OPENAI_API_KEY`(auth_mode: apikey)→ 官方 API:`api.openai.com/v1/responses`
 * - `tokens`(auth_mode: chatgpt)→ ChatGPT 订阅:`chatgpt.com/backend-api/codex/responses`,
 *   Bearer `tokens.access_token` + `chatgpt-account-id: tokens.account_id`
 *
 * 订阅 access_token 过期(HTTP 401)时,启动 Codex CLI app-server 请求刷新。
 * OAuth 轮换与 auth.json 持久化完全由 Codex 所有;本插件只在成功后重读文件。
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LlmError } from '@deepseek-ai/dsh-llm';

import { requestCodexAppServerRefresh } from './codex-app-server.js';
import { CHATGPT_BASE_URL, OPENAI_API_BASE_URL } from './constants.js';

/** 解析 Codex 配置目录:显式配置 > CODEX_HOME > ~/.codex。 */
export function codexHomeDir(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override;
  const env = process.env.CODEX_HOME;
  if (typeof env === 'string' && env.trim().length > 0) return env;
  return path.join(os.homedir(), '.codex');
}

export function defaultAuthFile(override) {
  if (typeof override === 'string' && override.trim().length > 0) {
    const configured = override.trim();
    if (path.basename(configured) !== 'auth.json') {
      throw new LlmError(
        `authFile 只能指向名为 auth.json 的文件；请把凭证放在独立目录的 auth.json 中，当前值为 ${configured}。`,
        'INVALID_CONFIG',
      );
    }
    return configured;
  }
  return path.join(codexHomeDir(), 'auth.json');
}

/** app-server 必须与被读取的 auth.json 使用同一个 Codex 配置目录。 */
export function codexHomeForAuthFile(authFileOverride) {
  if (typeof authFileOverride === 'string' && authFileOverride.trim().length > 0) {
    return path.dirname(path.resolve(defaultAuthFile(authFileOverride)));
  }
  return path.resolve(codexHomeDir());
}

export function defaultModelsCacheFile(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return path.join(codexHomeDir(), 'models_cache.json');
}

/** 读取 codex CLI 的 auth.json;缺失/损坏时抛 MISSING_CREDENTIAL。 */
export async function readAuthFile(authFile) {
  let raw;
  try {
    raw = await readFile(authFile, 'utf8');
  } catch (error) {
    throw new LlmError(
      `无法读取 Codex 凭证文件 ${authFile}:请先运行 "codex login" 完成登录(或改用 OPENAI_API_KEY)。`,
      'MISSING_CREDENTIAL',
      { cause: error },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new LlmError(`Codex 凭证文件 ${authFile} 不是合法 JSON。`, 'MISSING_CREDENTIAL', { cause: error });
  }
}

/**
 * 从 auth.json 解析出当前生效的凭证形态。
 * 优先级与 codex CLI 一致:显式 auth_mode 优先;否则有 OPENAI_API_KEY 走
 * API key,否则有 tokens 走 ChatGPT 订阅。
 */
export function resolveCredentials(auth) {
  const mode = typeof auth?.auth_mode === 'string' ? auth.auth_mode : undefined;
  const apiKey =
    typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim().length > 0
      ? auth.OPENAI_API_KEY.trim()
      : undefined;
  const tokens = auth?.tokens;
  const accessToken =
    tokens && typeof tokens.access_token === 'string' && tokens.access_token.length > 0
      ? tokens.access_token
      : undefined;

  if (mode === 'apikey' || (mode === undefined && apiKey && !accessToken)) {
    if (!apiKey) throw new LlmError('Codex auth.json 缺少 OPENAI_API_KEY。', 'MISSING_CREDENTIAL');
    return { mode: 'apikey', apiKey, baseURL: OPENAI_API_BASE_URL };
  }

  if (mode === 'chatgpt' || accessToken) {
    if (!accessToken) throw new LlmError('Codex auth.json 缺少 tokens.access_token。', 'MISSING_CREDENTIAL');
    return {
      mode: 'chatgpt',
      accessToken,
      refreshToken:
        tokens && typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
          ? tokens.refresh_token
          : undefined,
      accountId:
        tokens && typeof tokens.account_id === 'string' && tokens.account_id.length > 0
          ? tokens.account_id
          : undefined,
      baseURL: CHATGPT_BASE_URL,
    };
  }

  throw new LlmError(
    'Codex auth.json 中既没有 OPENAI_API_KEY 也没有 tokens;请先运行 "codex login"。',
    'MISSING_CREDENTIAL',
  );
}

/**
 * Codex 凭证管理器:每次请求重读 auth.json(与 codex CLI 保持同步);
 * 401 时让 Codex app-server 刷新并持久化,随后重读 auth.json。
 * 并发刷新通过共享的 in-flight promise 去重。
 */
export class CodexCredentials {
  /**
   * @param config - 配置对象,或返回配置对象的 thunk(设置热更新时配置随每次
   *   请求重新求值)。字段:`authFile`、`codexCommand`、
   *   `appServerRefreshTimeoutMs`。
   */
  constructor(config) {
    this._options = typeof config === 'function' ? config : () => config ?? {};
    this._refreshing = undefined;
  }

  #options() {
    return this._options();
  }

  get authFile() {
    return defaultAuthFile(this.#options().authFile);
  }

  /** 解析当前凭证(auth.json 缺失时抛 MISSING_CREDENTIAL)。 */
  async current() {
    const auth = await readAuthFile(defaultAuthFile(this.#options().authFile));
    return resolveCredentials(auth);
  }

  /** 刷新 ChatGPT 订阅令牌;失败抛 AUTH。并发调用共享同一次刷新。 */
  refresh() {
    if (this._refreshing !== undefined) return this._refreshing;
    this._refreshing = this.#doRefresh().finally(() => {
      this._refreshing = undefined;
    });
    return this._refreshing;
  }

  async #doRefresh() {
    const config = this.#options();
    const authFile = defaultAuthFile(config.authFile);
    const auth = await readAuthFile(authFile);
    const creds = resolveCredentials(auth);
    if (creds.mode !== 'chatgpt') {
      throw new LlmError('当前 Codex 凭证不是 ChatGPT 订阅模式,无法刷新。', 'AUTH');
    }

    await requestCodexAppServerRefresh({
      codexCommand: config.codexCommand,
      codexHome: codexHomeForAuthFile(config.authFile),
      timeoutMs: config.appServerRefreshTimeoutMs,
    });

    const nextAuth = await readAuthFile(authFile);
    const nextCreds = resolveCredentials(nextAuth);
    if (nextCreds.mode !== 'chatgpt') {
      throw new LlmError('Codex 刷新后 auth.json 不再是 ChatGPT 订阅凭证；请重新运行 "codex login"。', 'AUTH');
    }
    if (
      nextCreds.accessToken === creds.accessToken &&
      nextAuth?.last_refresh === auth?.last_refresh
    ) {
      throw new LlmError(
        'Codex app-server 已返回成功，但 auth.json 的 access_token 和 last_refresh 均未变化；请升级 Codex CLI 或重新运行 "codex login"。',
        'AUTH',
      );
    }
    return nextCreds;
  }
}

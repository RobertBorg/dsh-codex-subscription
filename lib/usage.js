/** Codex plan-usage lookup and the browser-safe read-only HTTP surface. */

import { LlmError } from '@deepseek-ai/dsh-llm';

import { codexHomeForAuthFile } from './auth.js';
import { requestCodexAppServerUsage } from './codex-app-server.js';

export const DEFAULT_USAGE_CACHE_TTL_MS = 5 * 60 * 1_000;
export const USAGE_ROUTE = '/api/plugins/dsh-llm-codex/usage';

function percent(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

function resetTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1_000).toISOString();
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function windowOf(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const usedPercent = percent(value.usedPercent ?? value.used_percent);
  if (usedPercent === undefined) return undefined;
  const duration = value.windowDurationMins ?? value.window_duration_mins;
  const resetsAt = resetTime(value.resetsAt ?? value.reset_at);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(Number.isFinite(duration) ? { windowDurationMins: duration } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function mainRateLimit(result) {
  if (result?.primary !== undefined || result?.secondary !== undefined) return result;
  if (result?.rateLimits !== null && typeof result?.rateLimits === 'object') {
    return result.rateLimits;
  }
  const table = result?.rateLimitsByLimitId;
  if (table === null || typeof table !== 'object') return undefined;
  if (table.codex !== null && typeof table.codex === 'object') return table.codex;
  return Object.values(table).find((entry) => entry !== null && typeof entry === 'object');
}

/** Convert app-server account/rate-limit metadata to the only fields the UI needs. */
export function normalizeCodexUsage(response, now = Date.now()) {
  const result = response?.rateLimits;
  const limit = mainRateLimit(result);
  const session = windowOf(limit?.primary);
  const weekly = windowOf(limit?.secondary);
  if (session === undefined && weekly === undefined) {
    throw new LlmError(
      'Codex app-server 未返回可用的 Session/Weekly 限额；请升级 Codex CLI 后重试。',
      'AUTH',
    );
  }
  const planType = response?.account?.planType ?? limit?.planType ?? null;
  return {
    status: 'available',
    planType: typeof planType === 'string' && planType.length > 0 ? planType : null,
    fetchedAt: new Date(now).toISOString(),
    session: session ?? null,
    weekly: weekly ?? null,
  };
}

/** Five-minute, in-flight-deduplicated plan-usage reader. */
export class CodexUsage {
  constructor(options, credentials, { cacheTtlMs = DEFAULT_USAGE_CACHE_TTL_MS, now = Date.now } = {}) {
    this.options = options;
    this.credentials = credentials;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  read() {
    const now = this.now();
    if (this.cached !== undefined && now < this.cached.expiresAt) return Promise.resolve(this.cached.value);
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.#read(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async #read(now) {
    const credentials = await this.credentials.current();
    if (credentials.mode !== 'chatgpt') {
      const value = { status: 'unavailable', reason: 'api_key', fetchedAt: new Date(now).toISOString() };
      this.cached = { value, expiresAt: now + this.cacheTtlMs };
      return value;
    }
    const config = this.options();
    const response = await requestCodexAppServerUsage({
      codexCommand: config.codexCommand,
      codexHome: codexHomeForAuthFile(config.authFile),
      timeoutMs: config.appServerRefreshTimeoutMs,
    });
    const value = normalizeCodexUsage(response, now);
    this.cached = { value, expiresAt: now + this.cacheTtlMs };
    return value;
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sameOriginRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

/** Register the same-origin GET endpoint consumed by this package's Client face. */
export function registerCodexUsageRoute(webServer, usage) {
  return webServer.register({
    kind: 'exact',
    path: USAGE_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (!sameOriginRequest(req)) {
        json(res, 403, { status: 'error', error: 'Cross-origin usage requests are not allowed.' });
        return;
      }
      try {
        json(res, 200, await usage.read());
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1_000) : 'Codex usage lookup failed.';
        json(res, 503, { status: 'error', error: message });
      }
    },
  });
}

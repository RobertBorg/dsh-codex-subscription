/**
 * Minimal JSONL client for short-lived Codex CLI app-server operations.
 *
 * This module never receives OAuth credentials. Codex reads and updates its own
 * credential store; refresh callers re-read auth.json only after the process exits.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { LlmError } from '@deepseek-ai/dsh-llm';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');

export const DEFAULT_APP_SERVER_REFRESH_TIMEOUT_MS = 20_000;
export const MAX_APP_SERVER_REFRESH_TIMEOUT_MS = 120_000;

const MAX_STDERR_BYTES = 8_192;
const MAX_STDOUT_BUFFER_BYTES = 1_048_576;
const TERMINATE_GRACE_MS = 500;

function redactDiagnostic(value) {
  return String(value ?? '')
    .replace(/(["']?(?:(?:access|refresh|id)[ _-]?token|api[ _-]?key)["']?\s*[=:]\s*)["']?[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s,"'}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]');
}

function boundedTimeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_APP_SERVER_REFRESH_TIMEOUT_MS) {
    throw new LlmError(
      `appServerRefreshTimeoutMs 必须大于 0 且不超过 ${MAX_APP_SERVER_REFRESH_TIMEOUT_MS}。`,
      'INVALID_CONFIG',
    );
  }
  return value;
}

function requestCodexAppServer({
  codexCommand = 'codex',
  codexHome,
  timeoutMs = DEFAULT_APP_SERVER_REFRESH_TIMEOUT_MS,
  packageVersion = PACKAGE_VERSION,
  operation = 'refresh',
} = {}) {
  const command = typeof codexCommand === 'string' ? codexCommand.trim() : '';
  if (command.length === 0) {
    throw new LlmError('codexCommand 必须是 Codex CLI 可执行文件的路径或命令名。', 'INVALID_CONFIG');
  }
  if (typeof codexHome !== 'string' || codexHome.length === 0) {
    throw new LlmError('Codex app-server 操作缺少 CODEX_HOME。', 'INVALID_CONFIG');
  }
  const refreshTimeoutMs = boundedTimeout(timeoutMs);
  const action = operation === 'refresh' ? '刷新' : '用量查询';

  return new Promise((resolve, reject) => {
    let child;
    let stdoutBuffer = '';
    let stderr = Buffer.alloc(0);
    let expectedId = 0;
    let accountResult;
    let finalResult;
    let failure;
    let closed = false;
    let terminateTimer;

    const diagnostic = () => {
      const safe = redactDiagnostic(stderr.toString('utf8')).trim();
      return safe.length === 0 ? '' : ` Codex stderr: ${safe.slice(-MAX_STDERR_BYTES)}`;
    };

    const rememberFailure = (message, cause) => {
      if (failure !== undefined) return;
      failure = { message, cause };
      if (child?.exitCode === null && child.signalCode === null) {
        child.stdin.destroy();
        child.kill('SIGTERM');
        terminateTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, TERMINATE_GRACE_MS);
        terminateTimer.unref?.();
      }
    };

    const writeMessage = (message) => {
      if (failure !== undefined || child?.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined && finalResult === undefined) {
          rememberFailure(`无法向 Codex app-server 发送${action}请求。`, error);
        }
      });
    };

    const handleMessage = (line) => {
      if (failure !== undefined || line.trim().length === 0) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rememberFailure('Codex app-server 返回了无法解析的 JSONL 消息；请升级 Codex CLI。', error);
        return;
      }

      if (message?.id !== expectedId) return;
      if (message.error !== undefined) {
        const code = message.error?.code;
        const detail = redactDiagnostic(message.error?.message ?? '未知 JSON-RPC 错误').slice(0, 500);
        const upgrade = code === -32601 ? ' 当前 Codex CLI 可能过旧，请升级后重试。' : '';
        rememberFailure(`Codex app-server ${action}失败(JSON-RPC ${code ?? 'error'}): ${detail}.${upgrade}`);
        return;
      }
      if (!Object.hasOwn(message, 'result')) {
        rememberFailure(`Codex app-server 对请求 ${expectedId} 的响应缺少 result。`);
        return;
      }

      if (expectedId === 0) {
        expectedId = 1;
        writeMessage({ method: 'initialized' });
        writeMessage({ method: 'account/read', id: 1, params: { refreshToken: operation === 'refresh' } });
        return;
      }

      const account = message.result?.account;
      if (expectedId === 1) {
        if (account?.type !== 'chatgpt') {
          if (account === null || account === undefined) {
            rememberFailure('Codex CLI 未登录 ChatGPT；请先运行 "codex login"，再重试。');
          } else if (account?.type === 'apiKey') {
            rememberFailure('Codex app-server 当前使用 API key，而不是 ChatGPT 登录；请运行 "codex login"。');
          } else {
            rememberFailure('Codex app-server 未报告 ChatGPT 账号；请升级 Codex CLI 并重新运行 "codex login"。');
          }
          return;
        }

        accountResult = message.result;
        if (operation === 'usage') {
          expectedId = 2;
          writeMessage({ method: 'account/rateLimits/read', id: 2 });
          return;
        }
        finalResult = message.result;
        child.stdin.end();
        return;
      }

      finalResult = {
        account: accountResult?.account,
        rateLimits: message.result,
      };
      child.stdin.end();
    };

    const consumeStdout = (chunk) => {
      if (failure !== undefined) return;
      stdoutBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(stdoutBuffer) > MAX_STDOUT_BUFFER_BYTES) {
        rememberFailure(`Codex app-server 输出超过安全上限，未收到预期${action}响应。`);
        return;
      }
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleMessage(line);
      }
    };

    const timer = setTimeout(() => {
      rememberFailure(
        `Codex app-server ${action}在 ${refreshTimeoutMs}ms 内未完成；请确认 Codex CLI 已安装、版本兼容且已登录。`,
      );
    }, refreshTimeoutMs);
    timer.unref?.();

    try {
      child = spawn(command, ['app-server', '--stdio'], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      clearTimeout(timer);
      reject(
        new LlmError(
          `无法启动 Codex CLI "${command}"；请安装兼容版本，或配置 codexCommand 指向可执行文件。`,
          'AUTH',
          { cause: error },
        ),
      );
      return;
    }

    child.stdout.on('data', consumeStdout);
    child.stderr.on('data', (chunk) => {
      const remaining = MAX_STDERR_BYTES - stderr.length;
      if (remaining <= 0) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
    });
    child.stdin.on('error', (error) => {
      if (finalResult === undefined) rememberFailure('Codex app-server 标准输入意外关闭。', error);
    });
    child.on('spawn', () => {
      writeMessage({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'dsh_llm_codex',
            title: 'dsh-llm-codex',
            version: packageVersion,
          },
        },
      });
    });
    child.on('error', (error) => {
      const message =
        error?.code === 'ENOENT'
          ? `找不到 Codex CLI "${command}"；请安装 Codex、确认 PATH，或配置 codexCommand。`
          : `无法启动 Codex CLI "${command}"；请检查 codexCommand 和执行权限。`;
      rememberFailure(message, error);
    });
    child.on('close', (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(terminateTimer);

      if (failure === undefined && stdoutBuffer.trim().length > 0) {
        handleMessage(stdoutBuffer.replace(/\r$/, ''));
      }
      if (failure !== undefined) {
        reject(new LlmError(`${failure.message}${diagnostic()}`, 'AUTH', { cause: failure.cause }));
        return;
      }
      if (finalResult === undefined) {
        reject(
          new LlmError(
            `Codex app-server 在返回预期响应 ${expectedId} 前退出(code=${code ?? 'null'}, signal=${signal ?? 'none'})。${diagnostic()}`,
            'AUTH',
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new LlmError(
            `Codex app-server ${action}后未能正常退出(code=${code ?? 'null'}, signal=${signal ?? 'none'})。${diagnostic()}`,
            'AUTH',
          ),
        );
        return;
      }
      resolve(finalResult);
    });
  });
}

/**
 * Ask one short-lived `codex app-server --stdio` process to refresh its managed
 * ChatGPT account. Resolves with account metadata, never with tokens.
 */
export function requestCodexAppServerRefresh(options = {}) {
  return requestCodexAppServer({ ...options, operation: 'refresh' });
}

/**
 * Read ChatGPT plan metadata and rate-limit windows through the official Codex
 * app-server. No credential material is returned to the caller.
 */
export function requestCodexAppServerUsage(options = {}) {
  return requestCodexAppServer({ ...options, operation: 'usage' });
}

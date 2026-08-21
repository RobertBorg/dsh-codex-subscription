import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexCredentials } from '../lib/auth.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const temporaryHomes = [];
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await chmod(fixture, 0o755);

after(async () => {
  await Promise.all(temporaryHomes.map((directory) => rm(directory, { recursive: true, force: true })));
});

function chatgptAuth() {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-before',
      refresh_token: 'refresh-before',
      account_id: 'account-before',
    },
    last_refresh: '2026-08-20T00:00:00.000Z',
  };
}

async function makeHome(mode = 'success', auth = chatgptAuth(), extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-llm-codex-test-'));
  temporaryHomes.push(home);
  await writeFile(path.join(home, 'auth.json'), `${JSON.stringify(auth, null, 2)}\n`);
  await writeFile(path.join(home, 'fake-config.json'), JSON.stringify({ mode, ...extra }));
  return home;
}

function credentialsFor(home, extra = {}) {
  return new CodexCredentials({
    authFile: path.join(home, 'auth.json'),
    codexCommand: fixture,
    appServerRefreshTimeoutMs: 2_000,
    ...extra,
  });
}

async function protocol(home) {
  return (await readFile(path.join(home, 'protocol.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function spawnCount(home) {
  try {
    return (await readFile(path.join(home, 'spawn-count'), 'utf8')).trim().split('\n').length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

test('uses initialize -> initialized -> account/read JSONL ordering and exact payloads', async () => {
  const home = await makeHome();
  process.env.DSH_CODEX_TEST_PRESERVED = 'preserved-value';
  try {
    await credentialsFor(home).refresh();
  } finally {
    delete process.env.DSH_CODEX_TEST_PRESERVED;
  }

  const messages = await protocol(home);
  assert.deepEqual(messages.map((message) => message.method), [
    'initialize',
    'initialized',
    'account/read',
  ]);
  assert.deepEqual(messages[0], {
    method: 'initialize',
    id: 0,
    params: {
      clientInfo: {
        name: 'dsh_llm_codex',
        title: 'dsh-llm-codex',
        version: packageJson.version,
      },
    },
  });
  assert.deepEqual(messages[1], { method: 'initialized' });
  assert.deepEqual(messages[2], {
    method: 'account/read',
    id: 1,
    params: { refreshToken: true },
  });
  const env = JSON.parse(await readFile(path.join(home, 'spawn-env.json'), 'utf8'));
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.preserved, 'preserved-value');
});

test('returns access, refresh, and account credentials persisted by Codex', async () => {
  const home = await makeHome('success', chatgptAuth(), {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    accountId: 'new-account',
  });
  const refreshed = await credentialsFor(home).refresh();
  assert.equal(refreshed.accessToken, 'new-access');
  assert.equal(refreshed.refreshToken, 'new-refresh');
  assert.equal(refreshed.accountId, 'new-account');
  const persisted = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8'));
  assert.equal(persisted.tokens.access_token, refreshed.accessToken);
  assert.equal(persisted.tokens.refresh_token, refreshed.refreshToken);
});

test('refresh never performs an in-process HTTP token request', async () => {
  const home = await makeHome();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected direct HTTP request');
  };
  try {
    await credentialsFor(home).refresh();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test('concurrent refresh calls share one app-server process', async () => {
  const home = await makeHome();
  const credentials = credentialsFor(home);
  const first = credentials.refresh();
  const second = credentials.refresh();
  assert.strictEqual(first, second);
  await Promise.all([first, second]);
  assert.equal(await spawnCount(home), 1);
});

test('API-key credentials never spawn app-server', async () => {
  const home = await makeHome('success', { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-only' });
  await assert.rejects(credentialsFor(home).refresh(), /不是 ChatGPT 订阅模式/);
  assert.equal(await spawnCount(home), 0);
});

test('reports a redacted JSON-RPC error and reaps the child', async () => {
  const home = await makeHome('rpc-error');
  await assert.rejects(credentialsFor(home).refresh(), (error) => {
    assert.match(error.message, /JSON-RPC -32601/);
    assert.match(error.message, /升级/);
    assert.doesNotMatch(error.message, /should-never-leak/);
    return true;
  });
  assert.match(await readFile(path.join(home, 'cleanup-signal'), 'utf8'), /^(?:SIGTERM|stdin-closed)$/);
});

test('rejects malformed app-server output without exposing it', async () => {
  const home = await makeHome('malformed');
  await assert.rejects(credentialsFor(home).refresh(), (error) => {
    assert.match(error.message, /无法解析的 JSONL/);
    assert.doesNotMatch(error.message, /should-never-leak/);
    return true;
  });
});

test('rejects premature app-server exit with the missing response id', async () => {
  const home = await makeHome('premature');
  await assert.rejects(credentialsFor(home).refresh(), /预期响应 1 前退出/);
});

test('times out, terminates, and reaps an unresponsive child', async () => {
  const home = await makeHome('timeout');
  const started = Date.now();
  await assert.rejects(
    credentialsFor(home, { appServerRefreshTimeoutMs: 80 }).refresh(),
    /80ms 内未完成/,
  );
  assert.ok(Date.now() - started < 2_000);
  assert.match(await readFile(path.join(home, 'cleanup-signal'), 'utf8'), /^(?:SIGTERM|stdin-closed)$/);
});

test('rejects a successful account response when auth.json did not advance', async () => {
  const home = await makeHome('unchanged');
  const authPath = path.join(home, 'auth.json');
  const beforeContent = await readFile(authPath, 'utf8');
  const beforeStat = await stat(authPath);
  await assert.rejects(credentialsFor(home).refresh(), /均未变化/);
  const afterStat = await stat(authPath);
  assert.equal(await readFile(authPath, 'utf8'), beforeContent);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('honors CODEX_HOME when authFile is not configured', async () => {
  const home = await makeHome();
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const refreshed = await new CodexCredentials({
      codexCommand: fixture,
      appServerRefreshTimeoutMs: 2_000,
    }).refresh();
    assert.equal(refreshed.accessToken, 'access-after');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('rejects custom auth filenames before spawning Codex', async () => {
  const home = await makeHome();
  const credentials = new CodexCredentials({
    authFile: path.join(home, 'credentials.json'),
    codexCommand: fixture,
  });
  await assert.rejects(credentials.refresh(), /只能指向名为 auth\.json/);
  assert.equal(await spawnCount(home), 0);
});

test('reports an actionable error when the Codex executable is missing', async () => {
  const home = await makeHome();
  await assert.rejects(
    credentialsFor(home, { codexCommand: path.join(home, 'missing-codex') }).refresh(),
    /找不到 Codex CLI.*codexCommand/,
  );
});

test('rejects a non-ChatGPT account/read result', async () => {
  const home = await makeHome('api-account');
  await assert.rejects(credentialsFor(home).refresh(), /当前使用 API key/);
});

test('authentication source contains no direct OAuth request or credential-store writes', async () => {
  const authSource = await readFile(new URL('../lib/auth.js', import.meta.url), 'utf8');
  const appServerSource = await readFile(new URL('../lib/codex-app-server.js', import.meta.url), 'utf8');
  const constantsSource = await readFile(new URL('../lib/constants.js', import.meta.url), 'utf8');
  const indexSource = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const combined = `${authSource}\n${appServerSource}\n${constantsSource}`;
  assert.doesNotMatch(combined, /auth\.openai\.com\/oauth\/token/);
  assert.doesNotMatch(authSource, /\b(?:writeFile|rename)\b/);
  assert.doesNotMatch(combined, /includeToken/);
  assert.doesNotMatch(combined, /getAuthStatus/);
  assert.doesNotMatch(indexSource, /\bwriteBack\s*:/);
});

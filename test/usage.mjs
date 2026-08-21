import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { CodexCredentials } from '../lib/auth.js';
import { requestCodexAppServerUsage } from '../lib/codex-app-server.js';
import { CodexUsage, normalizeCodexUsage, registerCodexUsageRoute, USAGE_ROUTE } from '../lib/usage.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const temporaryHomes = [];

await chmod(fixture, 0o755);

after(async () => {
  await Promise.all(temporaryHomes.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeHome(auth = {
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'usage-access',
    refresh_token: 'usage-refresh',
    account_id: 'usage-account',
  },
}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-llm-codex-usage-'));
  temporaryHomes.push(home);
  await writeFile(path.join(home, 'auth.json'), `${JSON.stringify(auth)}\n`);
  await writeFile(path.join(home, 'fake-config.json'), JSON.stringify({
    mode: 'usage',
    sessionUsedPercent: 37,
    weeklyUsedPercent: 61,
  }));
  return home;
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

function options(home) {
  return {
    authFile: path.join(home, 'auth.json'),
    codexCommand: fixture,
    appServerRefreshTimeoutMs: 2_000,
  };
}

test('usage uses initialize -> initialized -> account/read -> account/rateLimits/read', async () => {
  const home = await makeHome();
  const response = await requestCodexAppServerUsage({
    codexCommand: fixture,
    codexHome: home,
    timeoutMs: 2_000,
  });
  assert.equal(response.account.type, 'chatgpt');
  assert.equal(response.rateLimits.rateLimits.primary.usedPercent, 37);
  assert.deepEqual(await protocol(home), [
    {
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'dsh_llm_codex',
          title: 'dsh-llm-codex',
          version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
        },
      },
    },
    { method: 'initialized' },
    { method: 'account/read', id: 1, params: { refreshToken: false } },
    { method: 'account/rateLimits/read', id: 2 },
  ]);
});

test('normalizes the Session and Weekly windows without credential fields', () => {
  const normalized = normalizeCodexUsage({
    account: { type: 'chatgpt', planType: 'plus' },
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_787_318_400 },
        secondary: { usedPercent: 80, windowDurationMins: 10_080, resetsAt: 1_787_750_400 },
      },
    },
  }, 1_787_300_000_000);
  assert.equal(normalized.planType, 'plus');
  assert.equal(normalized.session.usedPercent, 12.5);
  assert.equal(normalized.session.remainingPercent, 87.5);
  assert.equal(normalized.weekly.usedPercent, 80);
  assert.doesNotMatch(JSON.stringify(normalized), /token|account_id|authorization/i);
});

test('concurrent and cached usage reads spawn one app-server process', async () => {
  const home = await makeHome();
  const config = options(home);
  let now = 1_787_300_000_000;
  const usage = new CodexUsage(() => config, new CodexCredentials(config), {
    cacheTtlMs: 5 * 60 * 1_000,
    now: () => now,
  });
  const first = usage.read();
  const second = usage.read();
  assert.strictEqual(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.session.usedPercent, 37);
  assert.equal(a.weekly.usedPercent, 61);
  await usage.read();
  assert.equal(await spawnCount(home), 1);
  now += 5 * 60 * 1_000 - 1;
  await usage.read();
  assert.equal(await spawnCount(home), 1);
  now += 1;
  await usage.read();
  assert.equal(await spawnCount(home), 2);
});

test('API-key usage does not spawn app-server', async () => {
  const home = await makeHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-usage' });
  const config = options(home);
  const result = await new CodexUsage(() => config, new CodexCredentials(config)).read();
  assert.deepEqual(result.status, 'unavailable');
  assert.equal(result.reason, 'api_key');
  assert.equal(await spawnCount(home), 0);
});

test('usage route is GET-only, same-origin, no-store, and returns normalized metadata', async () => {
  let route;
  const dispose = registerCodexUsageRoute({
    register(value) {
      route = value;
      return () => { route = undefined; };
    },
  }, {
    read: async () => ({ status: 'available', planType: 'plus', session: null, weekly: null }),
  });
  assert.equal(route.path, USAGE_ROUTE);

  const response = () => ({
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; },
  });

  const allowed = response();
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-origin' } }, allowed);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(allowed.body).planType, 'plus');

  const rejected = response();
  await route.handler({
    method: 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
  }, rejected);
  assert.equal(rejected.status, 403);

  const wrongMethod = response();
  await route.handler({ method: 'POST', headers: {} }, wrongMethod);
  assert.equal(wrongMethod.status, 405);
  dispose();
  assert.equal(route, undefined);
});

test('package exposes a client face registered for the composer right slot', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(packageJson.exports['./client'], './lib/client.js');
  assert.equal(packageJson.exports['./package.json'], './package.json');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.match(client, /conversation\.input\.right/);
  assert.match(client, /Session/);
  assert.match(client, /Weekly/);
  assert.match(client, /session\.turnEnds/);
  assert.doesNotMatch(client, /setInterval/);
  assert.doesNotMatch(client, /access_token|refresh_token|authorization/i);
});

test('Harness client-module discovery can resolve the exported package manifest', async () => {
  const manifestUrl = import.meta.resolve('dsh-llm-codex/package.json');
  const manifest = JSON.parse(await readFile(new URL(manifestUrl), 'utf8'));
  assert.equal(manifest.name, 'dsh-llm-codex');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './lib/client.js');
});

test('client bundle loads through the DSH module factory and registers its slot entry', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let registration;
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  vm.runInNewContext(source, {
    document,
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  });
  assert.equal(registration.id, 'dsh-llm-codex');
  const react = {
    createElement() {},
    useCallback() {},
    useEffect() {},
    useRef() {},
    useState() {},
    useSyncExternalStore() {},
  };
  const client = registration.factory((specifier) => {
    assert.equal(specifier, 'react');
    return react;
  });
  let entry;
  const ctx = {
    effect(setup) { return setup(); },
    inject(_services, apply) { apply(this); },
    modelDirectories: {},
    slots: {
      inject(name, apply) {
        assert.equal(name, 'conversation.input.right');
        return apply();
      },
      register(meta, component) {
        entry = { meta, component };
        return () => {};
      },
    },
  };
  client.apply(ctx);
  assert.equal(entry.meta.name, 'conversation.input.right');
  assert.equal(entry.meta.id, 'codex-plan-usage');
  assert.equal(typeof entry.component, 'function');
});

#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.CODEX_HOME;
if (!home || process.argv[2] !== 'app-server' || process.argv[3] !== '--stdio') process.exit(64);

const configPath = path.join(home, 'fake-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const protocolPath = path.join(home, 'protocol.jsonl');
appendFileSync(path.join(home, 'spawn-count'), '1\n');
writeFileSync(
  path.join(home, 'spawn-env.json'),
  JSON.stringify({ CODEX_HOME: home, preserved: process.env.DSH_CODEX_TEST_PRESERVED }),
);

let state = 0;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendInitializeResponse() {
  if (config.chunked === false) {
    send({ id: 0, result: { serverInfo: { name: 'fake-codex' } } });
    return;
  }
  process.stdout.write('{"method":"unrelated/notification"}\n{"id":0,"res');
  setTimeout(() => process.stdout.write('ult":{"serverInfo":{"name":"fake-codex"}}}\n'), 5);
}

process.on('SIGTERM', () => {
  writeFileSync(path.join(home, 'cleanup-signal'), 'SIGTERM');
  process.exit(0);
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  appendFileSync(protocolPath, `${line}\n`);
  const message = JSON.parse(line);

  if (state === 0) {
    if (message.method !== 'initialize' || message.id !== 0) process.exit(65);
    state = 1;
    if (config.mode === 'malformed') {
      process.stdout.write('{not-json access_token=should-never-leak}\n');
      return;
    }
    sendInitializeResponse();
    return;
  }

  if (state === 1) {
    if (message.method !== 'initialized' || Object.hasOwn(message, 'params')) process.exit(66);
    state = 2;
    return;
  }

  if (config.mode === 'usage' && state === 3) {
    if (message.method !== 'account/rateLimits/read' || message.id !== 2 || Object.hasOwn(message, 'params')) {
      process.exit(69);
    }
    state = 4;
    send({
      id: 2,
      result: {
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          primary: {
            usedPercent: config.sessionUsedPercent ?? 35,
            windowDurationMins: 300,
            resetsAt: 1_787_318_400,
          },
          secondary: {
            usedPercent: config.weeklyUsedPercent ?? 20,
            windowDurationMins: 10_080,
            resetsAt: 1_787_750_400,
          },
        },
      },
    });
    return;
  }

  if (state !== 2 || message.method !== 'account/read' || message.id !== 1) process.exit(67);
  state = 3;

  if (config.mode === 'usage') {
    if (message.params?.refreshToken !== false) process.exit(68);
    send({
      id: 1,
      result: { account: { type: 'chatgpt', email: null, planType: config.planType ?? 'plus' } },
    });
    return;
  }

  if (config.mode === 'premature') process.exit(0);
  if (config.mode === 'timeout') return;
  if (config.mode === 'rpc-error') {
    process.stderr.write('refresh token: stderr-secret-should-never-leak\n');
    send({ id: 1, error: { code: -32601, message: 'method missing Bearer should-never-leak' } });
    return;
  }

  const account =
    config.mode === 'api-account'
      ? { type: 'apiKey' }
      : { type: 'chatgpt', email: null, planType: 'plus' };

  if (config.mode !== 'unchanged' && config.mode !== 'api-account') {
    const authPath = path.join(home, 'auth.json');
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    auth.tokens = {
      ...auth.tokens,
      access_token: config.accessToken ?? 'access-after',
      refresh_token: config.refreshToken ?? 'refresh-after',
      account_id: config.accountId ?? 'account-after',
    };
    auth.last_refresh = config.lastRefresh ?? '2026-08-21T00:00:00.000Z';
    writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  }

  send({ id: 1, result: { account, requiresOpenaiAuth: true } });
});

input.on('close', () => {
  if (config.mode === 'timeout' || config.mode === 'rpc-error') {
    writeFileSync(path.join(home, 'cleanup-signal'), 'stdin-closed');
  }
});

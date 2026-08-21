import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodexAdapter } from '../lib/adapter.js';

test('a Responses 401 triggers only one refresh and one retry', async () => {
  let requests = 0;
  let refreshes = 0;
  const credentials = {
    current: async () => ({
      mode: 'chatgpt',
      accessToken: requests === 0 ? 'rejected-access' : 'refreshed-access',
      accountId: 'account-id',
      baseURL: 'https://chatgpt.example.test/backend-api',
    }),
    refresh: async () => {
      refreshes += 1;
    },
  };
  const fetchImpl = async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };
  const adapter = new CodexAdapter({
    options: () => ({ clientVersion: 'test' }),
    credentials,
    fetchImpl,
    transport: async () => ({ fetch: fetchImpl }),
  });

  const iterator = adapter.request(
    {
      provider: 'codex',
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    },
    new AbortController().signal,
    () => {},
  );
  await assert.rejects(async () => {
    for await (const _chunk of iterator) {
      // No chunks are expected from 401 responses.
    }
  }, /unauthorized/);
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
});

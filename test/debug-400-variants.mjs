// 调试:定位 DSH 真实请求形状下的 400(逐项加字段,打印后端 detail)
import { CodexCredentials } from '../lib/auth.js';
import { createTransport } from '../lib/transport.js';
import { CODEX_HEADERS, CODEX_HEADER_VALUES } from '../lib/constants.js';

const proxy = 'http://127.0.0.1:7890';
const credentials = new CodexCredentials({ writeBack: false });
const creds = await credentials.current();
const transport = await createTransport({ proxy });

const base = {
  model: 'gpt-5.6-sol',
  instructions: '你是 DSH 的编码代理。',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
  ],
  stream: true,
  store: false,
};

const tools = [
  { type: 'function', name: 'tool_a', description: '工具 A', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
  { type: 'function', name: 'tool_b', description: '工具 B', parameters: { type: 'object', properties: { y: { type: 'string' } } } },
  { type: 'function', name: 'tool_c', description: '工具 C', parameters: { type: 'object', properties: { z: { type: 'string' } } } },
];

const variants = {
  'baseline': {},
  '+reasoning.max': { reasoning: { effort: 'max' } },
  '+reasoning.medium': { reasoning: { effort: 'medium' } },
  '+max_output_tokens_128k': { max_output_tokens: 128000 },
  '+tools_x3': { tools },
  '+session_headers': { _headers: { session_id: 'session-test-123', conversation_id: 'session-test-123', 'x-client-request-id': 'session-test-123' } },
  '+temperature': { temperature: 0 },
  '+stop': { stop: ['\n\n'] },
  '+all': { reasoning: { effort: 'max' }, max_output_tokens: 128000, tools },
};

for (const [name, extra] of Object.entries(variants)) {
  const body = { ...base, ...extra };
  delete body._headers;
  const headers = {
    authorization: `Bearer ${creds.accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    [CODEX_HEADERS.BETA]: CODEX_HEADER_VALUES.BETA_RESPONSES,
    [CODEX_HEADERS.ORIGINATOR]: CODEX_HEADER_VALUES.ORIGINATOR,
    [CODEX_HEADERS.VERSION]: '0.144.1',
    ...(creds.accountId ? { [CODEX_HEADERS.ACCOUNT_ID]: creds.accountId } : {}),
    ...(extra._headers ?? {}),
  };
  try {
    const res = await transport.fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    console.log(`[${name}] -> ${res.status} ${text.slice(0, 300)}`);
  } catch (e) {
    console.log(`[${name}] -> ERROR ${e.message}`);
  }
}

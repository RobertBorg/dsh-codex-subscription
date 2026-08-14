# dsh-llm-codex

DSH(DeepSeek Harness)LLM 适配器插件:**直接复用 Codex CLI 的本地登录凭证**,在 DSH 中
使用 ChatGPT 订阅模型(gpt-5.6-sol 等),不需要 API Key。

## 原理

Codex CLI(`codex login`)会把 ChatGPT 订阅的 OAuth 令牌写入 `~/.codex/auth.json`(或
`CODEX_HOME`)。本插件与 codex CLI **同源读取该文件**,并参照两个成熟实现
(参考实现:你的 [oh-my-pi-cn](https://github.com/yequ172672/oh-my-pi-cn) 与
[opencodex](https://www.npmjs.com/package/@bitkyc08/opencodex))的 wire 细节:

| 凭证形态 | 端点 | 认证 |
| --- | --- | --- |
| `tokens`(auth_mode: chatgpt,订阅) | `https://chatgpt.com/backend-api/codex/responses` | `Authorization: Bearer <access_token>` + `chatgpt-account-id` + `OpenAI-Beta: responses=experimental` + `originator: pi` + `version` |
| `OPENAI_API_KEY`(auth_mode: apikey) | `https://api.openai.com/v1/responses` | `Authorization: Bearer <api_key>` |

- **凭证热跟随**:每次请求都重新读 `auth.json`,CLI 登录/换号/登出,DSH 下一次请求自动生效。
- **令牌刷新**:access_token 过期(HTTP 401)时用 `refresh_token` 走
  `auth.openai.com/oauth/token` 刷新并自动重试一次;刷新成功后默认**原子写回**
  auth.json(`writeBack: false` 可关闭),与 codex CLI 行为一致,两边凭证永远同步。
- **模型目录**:优先实时拉取 `GET {base}/codex/models`,失败时回退
  `~/.codex/models_cache.json`,再回退内置静态列表。
- **协议**:OpenAI Responses API(`stream: true` SSE),推理摘要、正文、工具调用分别映射为
  DSH 的 reasoning / text / tool-call 块,usage 从 `response.completed` 提取。

## 目录结构

```
lib/
  index.js      插件入口(注册 provider "codex" + 可配置 provider 目录)
  adapter.js    CodexAdapter:fetch + SSE → StreamChunk(仿 dsh-llm-deepseek)
  auth.js       auth.json 读取 / 订阅令牌刷新 / 原子写回
  serialize.js  harness 消息 → Responses API 请求体
  translate.js  Responses SSE 事件 → StreamChunk
  sse.js        SSE 字节流解析(Responses 协议无 [DONE])
  models.js     模型目录:实时发现 → models_cache.json → 静态兜底
  constants.js  wire 常量(端点/头/上下文窗口)
test/smoke.mjs  端到端冒烟测试(只读,绝不写 auth.json)
install.ps1     dsh 部署接入脚本(junction + 校验 + patch 提示)
```

## 接入 dsh

1. **联调依赖**:本仓库代码直接 import `@deepseek-ai/dsh-llm` 等包,它们随 dsh 部署提供。
   开发/测试时让本仓库能解析到它们:

   ```powershell
   # 在仓库目录下建立指向 dsh 部署依赖树的 junction(node_modules 已 gitignore)
   New-Item -ItemType Junction -Path .\node_modules -Target "C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
   ```

2. **安装到部署**(或直接运行 `install.ps1`,它会做 2、3 两步并校验):

   ```powershell
   .\install.ps1
   ```

   脚本在 `…\@deepseek-ai\dsh\node_modules\dsh-llm-codex` 建立指向本仓库的 junction,
   使 cordis loader 能以包名解析到插件。`npm i -g @deepseek-ai/dsh` 升级后会清除
   junction,重新运行脚本即可。

3. **加一行到 profile patch**(`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`):

   ```yaml
   - insert:
       - id: llm-codex
         name: 'dsh-llm-codex'
   ```

   可选配置项(composer 行 config 或 settings.yaml 的 `llm-codex:` 段,热更新):
   `clientVersion`(默认 `0.144.1`)、`writeBack`(默认 `true`)、`proxy`、
   `authFile`、`modelsCacheFile`、`staticModels`(显式模型目录)。

4. **重启 dsh**。之后 Web 的模型选择器(或 `settings.yaml` 的 `agent-default-model:`
   段)会出现 `codex` provider:

   ```yaml
   agent-default-model:
     provider: codex
     model: gpt-5.6-sol
     reasoningEffort: medium
   ```

## 代理

Node 的原生 fetch 不读取系统代理。若 ChatGPT 后端需要走本地代理(如 Clash),
在 `llm-codex:` 设置段配置:

```yaml
llm-codex:
  proxy: http://127.0.0.1:7890
```

或直接设置环境变量 `HTTPS_PROXY`(优先级:显式 `proxy` 配置 > `HTTPS_PROXY` >
`HTTP_PROXY`;`NO_PROXY` 命中的主机直连)。代理经 `https-proxy-agent` +
`node-fetch` 实现 CONNECT 隧道,这两个包随 dsh 部署提供。

## 冒烟测试(真实凭证,只读)

```powershell
node test\smoke.mjs                  # 文本对话(默认模型 gpt-5.6-sol)
node test\smoke.mjs gpt-5.5          # 指定模型
node test\smoke.mjs gpt-5.6-sol --tools   # 额外验证工具调用路径
```

输出凭证形态、模型目录(实时拉取)、一次真实流式对话的结果与 usage。
测试默认只读(`writeBack: false`),绝不改写 auth.json;需要走代理时设置
`HTTPS_PROXY`(如 `http://127.0.0.1:7890`)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `MISSING_CREDENTIAL:无法读取 Codex 凭证文件` | 先运行 `codex login` 登录 |
| `TRANSPORT:Connect Timeout` | 本机直连 ChatGPT 后端被墙;配置 `proxy`(见上文代理一节) |
| HTTP 401 且刷新失败 | 订阅过期或被风控;运行 `codex login` 重新登录 |
| HTTP 429 | 订阅额度/限流,稍后重试 |
| `INVALID_REQUEST:System messages are not allowed` | 系统提示已自动改走 `instructions` 字段,不应出现;如出现请升级插件 |
| 模型列表为空 | 实时发现失败且本地无 models_cache.json 时使用内置静态列表 |

## 注意事项

- 本插件会读取并(在刷新时)改写 `~/.codex/auth.json`,与 codex CLI 行为一致;如不希望
  写回,设置 `writeBack: false`(届时过期令牌只在内存中刷新,重启 dsh 后重新刷新)。
- 适配器为文本 only:图片内容会以 `UNSUPPORTED_CONTENT` 拒绝。
- 订阅额度由 OpenAI 按账号计量,与 codex CLI 共用同一配额。

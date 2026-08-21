# dsh-llm-codex

> 📦 已发布到 npm:[dsh-llm-codex](https://www.npmjs.com/package/dsh-llm-codex)
> · 📚 GitHub:[yequ172672/dsh-codex-subscription](https://github.com/yequ172672/dsh-codex-subscription)
> · 🏷️ 属于 [dsh-plugin](https://github.com/topics/dsh-plugin) 插件话题

DSH(DeepSeek Harness)LLM 适配器插件:**直接复用 Codex CLI 的本地登录凭证**,在 DSH 中
使用 ChatGPT 订阅模型(gpt-5.6-sol 等),不需要 API Key。

这是一个标准的 **dsh 插件包**:包内 `dsh.bundle.patch` 声明使其成为 profile 层,
通过官方 `dsh plugin` 命令安装后**自动激活**,无需手工编辑任何 composition 文件。

## 搭配推荐:dsh-session-import-codex

配合 [dsh-session-import-codex](https://github.com/xing01l/session-import-codex) 使用
效果更佳:它把 Codex 的历史会话导入 DSH(会话 id 形如 `codex-<thread-id>`),与本插件的
"凭证/模型复用"互补 —— 在 DSH 里既能用 Codex 订阅模型对话,又能无缝续聊 Codex 里
开过的对话,实现"模型 + 历史"全链路打通。

```powershell
dsh plugin --profile web add dsh-session-import-codex
# 迁移(离线流程:先停止 dsh web 进程 → dry-run → 正式导入 → 重启 dsh)
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" exec dsh-import-codex --profile web --dry-run
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" exec dsh-import-codex --profile web
```

> ℹ️ `dsh-session-import-codex@0.1.1` 起已正确声明全部依赖,直接安装即可。

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
- **令牌刷新**:access_token 过期(HTTP 401)时,本插件启动一次短生命周期的
  `codex app-server --stdio`,通过 JSONL `account/read` 请求 Codex 主动刷新。OAuth
  refresh-token 轮换与 `auth.json` 持久化完全由官方 Codex CLI 负责;app-server
  成功退出后,本插件重读 Codex 的凭证并最多重试原 Responses 请求一次。
- **模型目录**:优先实时拉取 `GET {base}/codex/models`,失败时回退
  `~/.codex/models_cache.json`,再回退内置静态列表。
- **协议**:OpenAI Responses API(`stream: true` SSE),推理摘要、正文、工具调用分别映射为
  DSH 的 reasoning / text / tool-call 块,usage 从 `response.completed` 提取。

## 目录结构

```
lib/
  index.js      插件入口(注册 provider "codex" + 可配置 provider 目录 + 设置段)
  adapter.js    CodexAdapter:fetch + SSE → StreamChunk(仿 dsh-llm-deepseek)
  auth.js       auth.json 只读解析 / 刷新协调
  codex-app-server.js  短生命周期 Codex app-server JSONL 客户端
  serialize.js  harness 消息 → Responses API 请求体
  translate.js  Responses SSE 事件 → StreamChunk
  sse.js        SSE 字节流解析(Responses 协议无 [DONE])
  models.js     模型目录:实时发现 → models_cache.json → 静态兜底
  transport.js  可选 HTTP CONNECT 代理(https-proxy-agent + node-fetch)
  constants.js  wire 常量(端点/头/上下文窗口)
cordis.bundle.yml   dsh.bundle 声明的 profile 层(插件行;安装后自动挂载)
test/serialize.mjs  请求序列化单元测试
test/smoke.mjs      真实凭证端到端冒烟测试(401 时可能触发 Codex CLI 刷新)
```

## 安装(dsh 官方插件命令)

### 前置条件

1. **已安装 dsh 本体**(本插件是 dsh 的 profile 层,必须先有 dsh):
   ```powershell
   npm install -g @deepseek-ai/dsh
   dsh --version   # 确认命令可用
   ```
   > 若提示 `无法将"dsh"项识别为 cmdlet…` / `dsh: command not found`,
   > 说明 dsh 尚未安装或不在 PATH,与插件无关。
2. **已安装 pnpm**(`dsh plugin` 会转发给它;缺失时 CLI 会提示)。
3. **已安装兼容版本并登录 Codex CLI**:`codex login`。订阅令牌刷新依赖
   `codex app-server --stdio` 的 `account/read` + `refreshToken` 能力;插件不会自行刷新。
4. **能访问 chatgpt.com**(国内网络通常需要代理,见下文"机器相关配置")。

### 安装插件

安装已发布的包:

```powershell
dsh plugin --profile web add dsh-llm-codex
```

本地开发直接加路径(pnpm 会以 `link:` 链接,改动即时生效):

```powershell
dsh plugin --profile web add D:\CODE\dsh\dsh-llm-codex
```

`dsh plugin` 做了什么:在 profile 目录里执行 `pnpm add <spec>`,然后把安装结果与
`dsh.profile.bundles` 层栈**自动 reconcile** —— 任何声明了 `dsh.bundle.patch` 的依赖
自动成为 profile 层,`update` 时新版本获得 bundle 声明也会自动激活,`remove` 后自动
移除。**无需手工编辑 cordis.patch.yml。**

> 💡 **版本范围建议**:请用**不带版本号**的方式安装(`add dsh-llm-codex`),pnpm 会保存
> `^x.y.z` 范围,之后的 `dsh plugin update` 能自动收取更新。若 profile 里依赖被写成
> 精确版本(例如 `"dsh-llm-codex": "0.1.0"`,常见于从本地 `link:` 依赖切换或显式指定
> 版本号的情况),`update` 会显示 "Already up to date" 而不会升级;重新执行一次不带
> 版本号的 `add` 即可回到范围跟踪。另外,刚发布的新版本可能触发 pnpm 的
> `minimumReleaseAge` 供应链策略(写入 pnpm-workspace.yaml 的排除清单或短暂提示),
> 属正常现象。

验证组合结果(不启动服务):

```powershell
dsh --profile web --dump-config   # 应看到 "# == dsh-llm-codex" 与 llm-codex 行
```

重启 dsh 后,Web 模型选择器出现 **Codex (ChatGPT 订阅)** provider,插件清单页
(设置 → 插件)也会列出 `llm-codex` 条目。

## 机器相关配置(settings.yaml,不进包)

ChatGPT 后端通常需要走本地代理;Node 原生 fetch 不读系统代理,在
`$DSH_HOME/settings.yaml` 配置:

```yaml
llm-codex:
  proxy: http://127.0.0.1:7890
  # codexCommand: C:\\path\\to\\codex.exe
  # appServerRefreshTimeoutMs: 20000
```

也可用环境变量 `HTTPS_PROXY`(优先级:显式 `proxy` 配置 > `HTTPS_PROXY` >
`HTTP_PROXY`;`NO_PROXY` 命中的主机直连)。其他可选字段:`clientVersion`(默认
`0.144.1`)、`codexCommand`(默认 `codex`)、`appServerRefreshTimeoutMs`(默认 20000,
范围 1–120000)、`authFile`、`modelsCacheFile`、`staticModels`(显式模型目录)。设置段
热更新,无需重启。

默认凭证目录继续遵循 `CODEX_HOME`。若显式设置 `authFile`,文件名必须是
`auth.json`;刷新时插件会把它的父目录作为子进程的 `CODEX_HOME`,同时保留所有其他
环境变量。若需要隔离账号,请使用例如 `/isolated/codex/auth.json`,不要改成自定义文件名。

选用 codex 作为默认模型(settings.yaml):

```yaml
agent-default-model:
  provider: codex
  model: gpt-5.6-sol
  reasoningEffort: medium
```

## 发布到 npm(dsh 插件库)

dsh 的"插件库"即 npm registry:`dsh.bundle.patch` 声明就是插件身份。

```powershell
npm login
npm publish            # 仓库目录内执行
# 任何机器上:
dsh plugin --profile web add dsh-llm-codex
dsh plugin --profile web update          # 升级所有 profile 插件
dsh plugin --profile web remove dsh-llm-codex   # 移除
```

发布前检查:`files` 字段含 `lib` 与 `cordis.bundle.yml`;`dsh.bundle.patch` 指向的
patch 文件只含插件行,不含任何机器相关的配置。

## 测试

```powershell
npm test                              # 无凭证单元测试
npm run test:smoke                    # 文本对话(默认模型 gpt-5.6-sol)
npm run test:smoke -- gpt-5.5         # 指定模型
npm run test:smoke -- gpt-5.6-sol --tools   # 额外验证工具调用路径
```

单元测试使用假的 `codex` 可执行文件和一次性 `CODEX_HOME`,不会接触正常的
`~/.codex/auth.json`,也不会发出真实刷新请求。冒烟测试会读取真实凭证并发送真实
对话;如果请求遇到 401,官方 Codex CLI 可能刷新并更新自己的凭证文件。需要走代理时
设置 `HTTPS_PROXY`(如 `http://127.0.0.1:7890`)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `MISSING_CREDENTIAL:无法读取 Codex 凭证文件` | 先运行 `codex login` 登录 |
| `TRANSPORT:Connect Timeout` | 本机直连 ChatGPT 后端被墙;配置 `proxy`(见上文) |
| HTTP 401 且提示找不到 Codex | 安装兼容的 Codex CLI,确认 `codex` 在 PATH,或设置 `codexCommand` |
| app-server 方法不存在/响应不兼容 | 升级 Codex CLI 后重试 |
| HTTP 401 且刷新失败/未登录 | 运行 `codex login` 重新登录;自定义 `authFile` 时确认其父目录是对应的 Codex home |
| HTTP 429 | 订阅额度/限流,稍后重试 |
| `INVALID_REQUEST:System messages are not allowed` | 系统提示已自动改走 `instructions` 字段,不应出现;如出现请升级插件 |
| `INVALID_REQUEST:Unsupported parameter` | 订阅后端拒绝 `max_output_tokens`/`temperature`/`stop`,适配器已自动剥离;如仍出现请升级插件 |
| 模型列表为空 | 实时发现失败且本地无 models_cache.json 时使用内置静态列表 |

## 注意事项

- 本插件自身只读取 `auth.json`,从不写入、重命名或直接提交其中的 `refresh_token`。
  Codex CLI 独占 OAuth refresh-token 轮换与凭证持久化。
- `writeBack`/`writeBack: false` 已移除。消费一个会轮换的 refresh token 却不持久化
  替代令牌可能使 Codex 登录失效,因此不再提供这种不安全模式。
- 适配器为文本 only:图片内容会以 `UNSUPPORTED_CONTENT` 拒绝。
- 订阅额度由 OpenAI 按账号计量,与 codex CLI 共用同一配额。

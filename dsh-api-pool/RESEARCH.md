# 调研报告：从 AI-Scientist-v2 的 api_pool 到 DSH 的 API Pool

本文件记录实现前的调研结论，作为实现依据。所有 DSH 结论都对应固定版本
`dsh-v0.2.0-rc.2`（commit `639ed015397290b3745d163aafe02ffee4aa3f84`），
不依赖记忆。

## 1. 参考实现：AI-Scientist-v2 的多 key API 池

位置：`/home/lenovo/code/myproj/AI-Scientist-v2/ai_scientist/api_pool.py`（1360 行），
文档 `docs/API_POOL.md`，测试 `tests/test_api_pool.py`（14 个离线用例）。

核心分层（与 DSH 无关，可直接移植）：

1. **错误分类** `classify_error(exc) -> ErrorInfo`：把 401/403、预算/配额文案、429、
   超时、连接错误、5xx、其他 4xx 归成 8 个 `ErrorKind`，并从 LiteLLM 的错误体/响应头抽
   出 `limit_type`/`remaining`/`reset_at`/`retry-after`。
2. **每端点健康状态机**：`cooldown_until`（指数退避，基数按 kind，乘数上限 8，
   受 `max_cooldown_seconds` 封顶）、`disabled_until`（`-1` = 永久禁用/auth；
   配额 = `min(quota_recheck_seconds, reset_at)`）、`consecutive_failures`、
   滑动窗口 `recent_requests`（RPM 负载）、配额快照。
3. **选点策略** `_select`：`least_loaded`（排序键 `(load, priority, name)`）、
   `priority`、`round_robin`。
4. **请求循环** `request()`：选中端点 → 调用 → 失败则分类/冷却/换端点；
   全忙时阻塞等待（最长 5s 轮询，总等待受 `max_block_wait_seconds` 约束），
   最终抛 `AllEndpointsUnavailable`。`BAD_REQUEST` 默认不换端点。
5. **配额发现**：`GET {root}/key/info`、`/user/info` 取 `spend/max_budget/
   budget_reset_at/rpm_limit`，响应头 `x-litellm-*` 增量刷新；取使用率最高的预算为绑定预算。
6. **跨进程状态**：`fcntl.flock` + 原子重命名写 `api_pool_state.json`；JSONL 事件 + 人类日志。

移植时要修掉的缺陷（详见调研结论）：`safety_margin` 声明未用；流式错误绕过 failover；
`read_state()` 也写盘；`max_retries` 被忽略；凭据缓存永不失效；400 冷却基准实际不生效。

## 2. DSH 0.2.0-rc.2 的关键约束（本方案的选型依据）

### 2.1 LLM 接缝

- `ctx.llm.registerAdapter(providers, adapter)`（`packages/llm/llm/src/index.ts:396`）
  要求传入一个 `LlmAdapter` 子类（`index.ts:208`）；`LlmAdapter` 是抽象基类，
  `stream(options)` 是唯一必实现方法。
- `ctx.llm.registerConfigurableProviders([{provider, displayName, settingsNs, settingsPath}])`
  （`index.ts:490`，类型 `types.ts:245`）把路由登记进“可选 provider 目录”；
  客户端 `ui-settings-models` 的 `ProviderDirectoryEntry` 由
  `llm/listProviders` + `llm/listConfigurableProviders` 合并而来
  （`packages/client/ui-settings-models/src/client/store.ts:39-73`）。
- 复合器/模型选择器读取 `remote.session.modelCatalog()` 的 groups
  （`packages/client/ui-model-selection/src/client/catalog.ts`），groups 来自
  已注册 adapter 的 `listModels`。**因此注册 route + listModels 即可在 UI 中选择。**
- 失败以 `LlmFailure{message, code, status, providerRetryAfterMs, requestId}` 表达
  （`packages/llm/llm/src/types.ts:41`）；重试在 agent 循环的
  `agent/request-error` 瀑布上执行（`packages/llm/llm-retry/src/index.ts:243`），
  默认 retryable codes：`EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`
  （`packages/llm/llm/src/retry-policy.ts:18`）。
- DeepSeek 适配器直接 `fetch`（`packages/llm/llm-deepseek/src/adapter.ts:120`）；
  pi-ai 适配器 `PiAiAdapter` 走 pi-ai 库（`packages/llm/llm-pi-ai/src/adapter.ts`），
  把失败映射成终止 `finish` chunk（`llm-pi-ai/src/stream.ts`）。

### 2.2 决定性约束：外部插件只能用包的根导出

已发布包只带 `lib/`：

- `@deepseek-ai/dsh-llm-pi-ai/package.json` 的 `files` = `["lib/index.js", "lib/types/**/*.d.ts"]`；
- `@deepseek-ai/dsh-llm` 同理。

`exports["./src/*"]` 虽然存在，但安装后的包没有 `src/`，所以外部插件**不能**导入
`llm-pi-ai/src/config.ts` 的 `resolveProfiles`、`models.ts` 的 `createModels`，
也不能导入 `toPiContext`/`toStreamChunks`。因此：

- 不能自己构造 `ResolvedPiAiProviderProfile` 来复用 `PiAiAdapter`；
- 自己写 OpenAI/Anthropic 适配器则要重做 DSH↔provider 的消息/工具/流式翻译，风险高。

### 2.3 可行的公开接缝

- `ctx.settings`（`SettingsForms`，`packages/settings/settings/src/index.ts:224`）：
  `update(ns, patch)` / `mutate(ns, ops)`（`index.ts:347/367`），
  路径必须是 volatile（`schema.ts:74 isVolatilePath`）。`llm-pi-ai` 的
  `providers` 字段是 `Volatile<Record<...>>`（`llm-pi-ai/src/config.ts:228`），
  所以可以直接写入/删除某一条 provider profile。
- `ctx.credentials`：`resolve(ref)` / `set(ref, value)` / `describe(ref)`
  （`packages/credentials/credentials-local/src/index.ts:609/633/622`）。
- 浏览器插件是 `window.__ModuleLoader__.load({id, factory(require){...}})` 的普通 JS
  （`apps/web/tests/fixtures/plugins/fixture-live-client/client.js`），
  可以用 `ctx.slots.inject('settings.section', ...)` 注册设置页；
  `settings.section` 由 `ui-settings-general` 声明
  （`packages/client/ui-settings-general/src/client/index.ts:208,232`）。
- 客户端读写设置：`ctx.configForms.get(ns)` → `ConfigForm.mutate(ops)`，
  `SettingsPathOpView` 只有 `{op:'set', path, value}` / `{op:'unset', path}`
  （`packages/settings/settings/src/types.ts:52`）；对数组下标 `unset` 即删除元素
  （`index.ts:362` 注释）。

## 3. 选型结论

采用 **本地回环中继 + 复用 llm-pi-ai provider profile** 的方案：

```
DSH 会话 LLM
  └─ llm-pi-ai adapter（协议/流式/工具翻译由 DSH 负责，零改动）
       └─ provider profile: deepseek-pool
            baseURL = http://127.0.0.1:<port>/v1      ← 本插件的“API 池”中继
                 └─ 本插件中继：按策略选端点 → 转发 → 失败分类/冷却/换端点
                      ├─ ustc   (USTC_API_KEY)
                      ├─ ustc-1 (USTC_1_API_KEY)
                      └─ ustc-2 (USTC_2_API_KEY)
```

理由：

- **零协议翻译**：中继只做 OpenAI-compatible 透传（含 SSE），
  DSH↔provider 的翻译全部由既有的 `llm-pi-ai` 完成，最稳。
- **完整能力**：中继在首字节前失败可换端点（等价于 Python 版
  “只替换 client 对象”的语义），并保留 429/配额/超时/5xx 的分类与冷却。
- **provider 选择**：宿主插件在 `llm-pi-ai` 的 settings 命名空间里 upsert 一条
  `deepseek-pool` profile（displayName = “API Pool”，models 默认 `deepseek-flash`），
  它自动出现在 provider 目录与模型选择器里；卸载/禁用时移除。
- **设置页**：浏览器半通过 `settings.section` 注册 “API Pool” 页，
  增删/启停端点直接写本插件自己的 volatile 配置。

### 为什么不选另外两条路

| 方案 | 结论 |
| --- | --- |
| 自建 `LlmAdapter` + `PiAiAdapter`（每端点一个实例） | 需要 `resolveProfiles`/`createModels` 等内部函数；已发布包不含 `src/`，不可行 |
| 自写 OpenAI-compatible 适配器 | 需要重做 DSH 消息/工具/流式翻译（pi-ai 已实现），重复且高风险 |

## 4. 环境事实（本机）

- `dsh --version` = `0.2.0-rc.2`；`~/code/deepseek-harness` 在 tag `dsh-v0.2.0-rc.2`，
  工作区干净，未修改 DSH 源码。
- `~/.dsh/profiles/web/cordis.patch.yml` 已用 `llm-pi-ai` 配置三个 OpenAI-compatible 端点
  `ustc` / `ustc-1` / `ustc-2`（同一 `https://api.llm.ustc.edu.cn/v1`），
  key 在 `~/.dsh/.credentials.yaml`（`USTC_API_KEY` / `USTC_1_API_KEY` / `USTC_2_API_KEY`）。
- 默认模型当前为 `ustc-1/deepseek-flash`。
- 已发布依赖可从 npm 取到（例如 `@deepseek-ai/schemastery@3.18.4`）。
- Node v22.23.2（原生支持 `.ts` 类型剥离，本项目仍用纯 ESM JS，避免构建步骤）。

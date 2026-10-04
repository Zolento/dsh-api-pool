# dsh-api-pool

给 **DeepSeek Harness (DSH) 0.2.0-rc.2** 用的多端点（多 key）API 池插件。
把多个 OpenAI 兼容端点当作**一个容量池**使用：某个 key 被限流、配额耗尽、鉴权失败或
网络异常时，按错误类型冷却该端点并**自动切换到下一个端点**——对话不会中断，因为每次
请求都携带完整历史，连接状态与 agent 状态解耦。

移植自 `AI-Scientist-v2` 的 [`ai_scientist/api_pool.py`](../../myproj/AI-Scientist-v2/ai_scientist/api_pool.py)
（设计分析见 [RESEARCH.md](RESEARCH.md)）。

安装后你会得到：

- 模型选择器里多出一个 provider：**API Pool**（路由 `deepseek-pool`），默认模型 `deepseek-flash`；
- 设置页 **Settings → API Pool**：添加 / 修改 / 启用停用 / 删除上游端点，选择调度策略；
- 自动故障切换、冷却、配额探测与事件日志。

```
DSH 会话 LLM
  └─ llm-pi-ai adapter（协议 / 流式 / 工具翻译，DSH 自带，零改动）
       └─ provider profile: deepseek-pool  →  http://127.0.0.1:8765/v1
            └─ dsh-api-pool 中继（本插件）
                 ├─ ustc    (USTC_API_KEY)
                 ├─ ustc-1  (USTC_1_API_KEY)
                 └─ ustc-2  (USTC_2_API_KEY)
```

## 为什么是「本地中继」

DSH 已发布的包只包含编译后的入口（`@deepseek-ai/dsh-llm-pi-ai` 的 `files` 只有
`lib/`），所以外部插件**不能**导入 `resolveProfiles` / `toPiContext` 等内部函数，
也无法自己构造 `ResolvedPiAiProviderProfile`。若自己重写适配器，则要重做 DSH ↔ provider
的消息 / 工具 / 流式翻译。因此本插件选择：

1. 宿主插件在 **`llm-pi-ai` 设置命名空间**里幂等地 upsert 一条 `deepseek-pool` provider
   profile（协议处理全部交给 DSH，插件不碰消息/流式翻译）；
2. 插件只运行一个 **OpenAI 兼容的本地回环中继**，把池逻辑做在转发层——与 Python 版
   「只替换 client 对象」的语义一致。

> 为什么不把 profile 写进 bundle 的 `cordis.patch.yml`？loader 对 patch 条目的 `config`
> 子树是**替换**而不是深合并；只要用户的 profile 自己配置了 `llm-pi-ai`（几乎总是如此），
> 后一层的 `providers` 就会覆盖 bundle 声明的那条。因此这条 profile 必须写进**拥有
> `llm-pi-ai.providers` 的那一层**，也就是设置文档——这正是本插件做的。写入是幂等的
> （内容相同就跳过），中继端口固定为 `127.0.0.1:8765`，所以写入的 profile 不会在下次
> 启动时失效；第二个实例检测到端口已被同类中继占用时会复用而不抢占。

## 安装

```bash
dsh plugin --profile web add /home/lenovo/code/dsh-plugin/dsh-api-pool
# 重启 dsh web 让 bundle 生效：
#   停掉当前 dsh web，再 dsh web
```

安装会：

- 把 `dsh-api-pool` 加入 `~/.dsh/profiles/web/package.json` 的依赖与 `dsh.profile.bundles`；
- 由 bundle 的 `cordis.patch.yml` 插入宿主插件；
- 首次启动时把中继 token 写入 `~/.dsh/.credentials.yaml` 的 `DSH_API_POOL_LOCAL_KEY`，
  并把 `deepseek-pool` provider profile 写入 `llm-pi-ai` 的设置命名空间（幂等）。

卸载：

```bash
dsh plugin --profile web remove dsh-api-pool
```

`plugin remove` 不会自动删掉设置文档里那条 provider profile；删除该文件里
`llm-pi-ai.providers.deepseek-pool` 段即可（`~/.dsh/api-pool/` 与
`DSH_API_POOL_LOCAL_KEY` 也可手动删除）。

## 使用

### 1. 在 provider 里选择

模型选择器 / Models 设置页会出现 **API Pool**（`deepseek-pool`），模型列表来自插件配置的
`models`（默认 `deepseek-flash`）。选中它即可，池会在后台自动选端点。也可以把默认模型设为
`deepseek-pool/deepseek-flash`（`agent-default-model`）。

> 池的模型与「当前选中的 provider 模型」无关：例如你现在用 `ustc/deepseek-flash`，池默认
> 仍然是 `deepseek-flash`（因为 `models` 默认就是它）。每个端点还可以用
> `endpoints[].model` 覆盖发给上游的模型名。

### 2. 在设置里管理 API

**Settings → API Pool** 页可以：

- 添加端点：名称、Base URL（如 `https://api.llm.ustc.edu.cn/v1`）、key 引用
  （环境变量名或凭据名，如 `USTC_API_KEY`）、可选模型覆盖、优先级、RPM 上限；
- 启用 / 停用某个端点；
- 删除端点；
- 选择策略：`least_loaded`（默认，按 RPM 窗口负载）/ `priority` / `round_robin`；
- 编辑 provider 暴露的 **模型（逗号分隔）**，例如 `deepseek-flash, deepseek-flash-2`。

修改会即时生效（volatile 配置热更新），无需重启。

### 远程访问（frp / 非 loopback）时的限制

DSH 只把 **Host 设置**开放给从 `127.0.0.1` / `localhost` 打开的页面：
`ctx.connection.isLoopback` 由浏览器 `window.location.hostname` 判定
（`localhost`、`[::1]`、`127.0.0.0/8`），非 loopback 时 `ui-settings` 把持久化切到
`memory`，`configForms` 直接进入 `status: 'unavailable'`（只读、也读不到值）。
`dsh web --trusted-host <域名>` 只放宽 `/api` 的请求信任围栏，**不会**让设置变成可写。

所以在 frp 域名下：

- **聊天、模型选择、API 池的实际调用都正常**（只有设置页受此限制）；
- **API Pool 设置页不可读写**，页面会明确提示原因，这不代表插件没装好；
- 要管理端点，任选其一：
  1. SSH 端口转发后用 loopback 打开：`ssh -N -L 3080:127.0.0.1:3080 <user>@<host>`，
     再访问 `http://127.0.0.1:3080`（浏览器地址栏是 `127.0.0.1` 即可）；
  2. 在宿主上直接编辑 `~/.dsh/profiles/web/cordis.patch.yml` 里 `- id: dsh-api-pool`
     的 `config.endpoints`，DSH 会热应用（必要时重启一次）；
  3. 用宿主机本地的浏览器打开 `http://127.0.0.1:3080`。

### 3. 查看健康状态

聊天里输入 `/api-pool`：

```
dsh-api-pool — 3 endpoint(s), strategy=least_loaded
  ustc    ready  rpm=0/20
  ustc-1  cooldown(42s)  rpm=1/20  last=rate_limit
  ustc-2  ready  rpm=0/20
  relay: http://127.0.0.1:8765/v1 (owned by this process)
```

## 配置参考

除 `endpoints` 外的所有字段都可热更新；默认值见 `src/config.js`。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 池总开关（关闭时中继返回 503） |
| `strategy` | `least_loaded` | `least_loaded` \| `priority` \| `round_robin` |
| `models` | `['deepseek-flash']` | provider 暴露的模型列表（逗号分隔编辑） |
| `api` | `openai-completions` | provider profile 的协议 |
| `reasoning` | `high` | provider profile 的默认思考强度 |
| `thinkingFormat` | `deepseek` | provider profile 的 `compat.thinkingFormat` |
| `contextWindow` / `maxTokens` | `1000000` / `65536` | profile 里每个模型的容量声明 |
| `endpoints[].name` | 必填 | 端点名，日志/状态里的标识 |
| `endpoints[].baseURL` | 必填 | OpenAI 兼容根地址（自动去掉末尾 `/`） |
| `endpoints[].apiKeyEnv` | — | 凭据引用；解析顺序：`apiKey` → 环境变量 → `ctx.credentials` |
| `endpoints[].apiKey` | — | 内联 key（不推荐，会写进设置文档） |
| `endpoints[].model` | — | 覆盖请求里的模型名 |
| `endpoints[].priority` | `100` | 越小越优先 |
| `endpoints[].rpmLimit` | — | 静态 RPM；探测到的值优先 |
| `endpoints[].enabled` | `true` | 静态启停 |
| `safetyMargin` | `0.9` | 负载软闸门：已知 RPM 时，负载 ≥ 该值的端点仅在无更优选择时才用 |
| `rpmWindowMs` | `60000` | RPM 滑动窗口 |
| `maxCooldownMs` | `3600000` | 普通冷却上限 |
| `quotaRecheckMs` | `1800000` | 配额禁用后的重新探测窗口 |
| `quotaRefreshMs` | `300000` | 主动配额探测节流 |
| `quotaProbeEnabled` | `true` | 是否探测 `/key/info`、`/user/info` |
| `maxAttemptsPerRequest` | `20` | 单次请求最多失败尝试数 |
| `totalRequestTimeoutMs` | `1800000` | 单次请求总时长上限 |
| `maxBlockWaitMs` | `21600000` | 全端点不可用时的最长阻塞等待 |
| `requestTimeoutMs` | `600000` | 单次上游请求超时 |
| `failoverOnBadRequest` | `false` | 400 是否也换端点 |
| `logSuccesses` | `false` | 是否记录成功事件 |
| `cooldowns` | 见下 | 每类错误的基准冷却（毫秒） |

默认冷却：`rate_limit=60000`、`connection=30000`、`timeout=60000`、`server=60000`、
`bad_request=30000`、`unknown=30000`；实际冷却为
`base × min(2^(连续失败数-1), 8)`，再与 `Retry-After` / 服务端 `reset_at` 取最大值，
最后受 `maxCooldownMs` 封顶。

## 故障切换语义

| 分类 | 判定 | 动作 |
| --- | --- | --- |
| `auth` | 401/403，或明确的 invalid key 文案 | **永久禁用**该端点，换端点 |
| `quota_exhausted` | 402、budget/quota 文案、`budget_exceeded` 等 | 禁用 `min(quotaRecheckMs, reset_at)`，到点自动恢复 |
| `rate_limit` | 429 / `throttling_error` | 指数冷却，换端点 |
| `timeout` | 408 / 504 / 超时文案 | 冷却，换端点 |
| `connection` | ECONNREFUSED / fetch failed / socket 关闭 | 短冷却，换端点 |
| `server` | 5xx | 指数冷却（封顶），换端点 |
| `bad_request` | 其他 4xx | **不换端点**，原样返回（换 key 不能修复请求本身） |

只有**在响应正文开始传输之前**失败才会换端点；一旦已经开始流式输出，就按原样结束
（与 Python 版行为一致）。全部端点不可用时，中继在 `maxBlockWaitMs` 内阻塞轮询，
超时后返回 503 并给出可操作的信息。

## 配额探测

每个端点周期性（`quotaRefreshMs`）探测 `GET {root}/key/info` 与 `{root}/user/info`：

- `spend` / `max_budget` / `budget_reset_at` / `rpm_limit`；
- 取**使用率最高**的预算作为绑定预算；
- 响应头 `x-litellm-key-spend` / `x-litellm-key-max-budget` / `x-litellm-key-rpm-limit`
  会在每次调用后增量刷新；
- 探测值优先于配置的 `rpmLimit`，用于 `least_loaded` 的负载计算。

## 文件与日志

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/api-pool/api-pool.log` | 人类可读：`[FAILOVER] endpoint=... kind=... cooldown-seconds=...` |
| `~/.dsh/api-pool/api-pool-events.jsonl` | 机器可读（`failover` / `all_endpoints_busy` / `quota_refresh` / `success`） |
| `~/.dsh/api-pool/state.json` | 端点健康 / 冷却 / RPM 窗口 / 配额快照 |
| `~/.dsh/api-pool/relay-token` | 中继共享令牌（0600） |

状态文件由原子重命名写入，并用锁目录在进程间做尽力互斥。

## 测试与验收

```bash
npm install
npm test                          # 38 个测试
bash scripts/acceptance.sh        # 离线验收：测试 + 组合校验
ACCEPTANCE_BOOT=1 bash scripts/acceptance.sh             # 额外做一次真实 dsh web 启动并探测中继
ACCEPTANCE_BOOT=1 DSH_API_POOL_LIVE=1 bash scripts/acceptance.sh   # 再发一次真实补全
```

覆盖：错误分类、冷却/禁用状态机、三种选择策略、配额探测、请求循环故障切换、
中继（SSE 透传、token 校验、503）、宿主装配（含 profile 发布与撤回）、浏览器半的模块契约。

## 已知限制

- **单实例固定端口**：provider profile 指向 `127.0.0.1:8765`。第一个启动的实例拥有中继，
  后续实例复用（通过 `/healthz` + token 判断），不会互相抢占。若 8765 被无关进程占用，
  插件会记录错误、provider 会连接失败；改端口需要同时改 `src/index.js` 的 `RELAY_PORT`
  与已写入的 profile（插件下次启动会按新端口重写）。
- **卸载残留**：`plugin remove` 不会自动删除设置文档里的 `deepseek-pool` profile，
  需手动删除该段（或在删除前先在设置里停用）。
- **短命进程**：像 `dsh web --dump-config` 这样会挂载 profile 的命令会短暂绑定 8765，
  进程退出后端口释放；因为端口固定，写入的 profile 不会因此失效。
- **流式中途失败不换端点**：已开始输出后按原样结束。
- **浏览器 UI 未人工点击验证**：设置页与 provider 选择通过真实组合、真实启动、中继探测、
  模块契约测试与真实补全验证；未在浏览器里逐一点击。
- **配额探测针对 LiteLLM 风格代理**：`/key/info`、`/user/info` 与 `x-litellm-*` 头；
  其他代理下探测自然失败，仅退化为无配额信息（不影响故障切换）。

## 版本固定与适配新 DSH

本插件针对 **DSH `0.2.0-rc.2`**（源码 tag `dsh-v0.2.0-rc.2`，commit
`639ed015397290b3745d163aafe02ffee4aa3f84`）开发与验证，未修改 DSH 本体源码。

### 版本记录规则

| 记录 | 位置 | 含义 |
| --- | --- | --- |
| 插件版本 | `package.json` `version`（SemVer） | 本插件自己的功能/修复 |
| DSH 兼容性 | `dsh-compat.json` | 已**验证**通过的 DSH 版本 + tag + commit + 依赖的接缝清单 |
| 发版 tag | git annotated tag `v<插件版本>-dsh<DSH版本>` | 例如 `v0.1.0-dsh0.2.0-rc.2`；一眼看出这条 tag 验证的是哪个 DSH |
| 变更记录 | `CHANGELOG.md` | 每个版本改了什么、验证了什么 |

分支建议：

- `main`：跟随**最新已验证**的 DSH 线；DSH 升级验证通过后在此打新 tag。
- `dsh/<DSH版本>`（例如 `dsh/0.2.0-rc.2`）：一旦开始适配更新的 DSH 线，就从对应
  commit 拉出这条维护分支，旧线的小修复 cherry-pick 回去，互不干扰。
- 适配过程中可以开临时分支 `adapt/dsh-<新版本>`，验证通过后再合回 `main` 并打 tag。

### 升级 DSH 的标准流程

```bash
# 1. 看当前是否已经漂移（会同时检查安装版与源码 checkout）
npm run check-dsh

# 2. 切到新的 DSH 源码 tag（不改 DSH 本体）
git -C ~/code/deepseek-harness checkout <new-tag>
dsh --version

# 3. 全量验证
npm test
ACCEPTANCE_BOOT=1 DSH_API_POOL_LIVE=1 bash scripts/acceptance.sh

# 4. 若失败：按 dsh-compat.json 的 seams 清单逐项核对（设置/凭据/命令接口、
#    浏览器 slots 与 configForms、bundle/client 清单字段、llm-pi-ai profile 形状、
#    设置文档中 - id: llm-pi-ai 的替换语义）

# 5. 通过后更新记录并发版
#    - dsh-compat.json: version/tag/commit/verifiedAt
#    - package.json:    version（如 0.1.1 或 0.2.0）
#    - CHANGELOG.md:    新条目
git add -A && git commit -m "adapt to DSH <new-version>"
git tag -a "v0.1.1-dsh<new-version>" -m "dsh-api-pool 0.1.1 for DSH <new-version>"
```

> 为什么不一上来就用 `peerDependencies` 卡死 DSH 版本：本插件运行时不 import 任何
> DSH 包（只通过 `ctx` 服务与 `@deepseek-ai/schemastery` 交互），写死 peer 会在 DSH
> 升级时直接拒绝安装，反而挡住「先跑起来看看哪里坏了」。因此改成
> **显式 pin + 可执行的漂移检查**：`npm run check-dsh` 失败即提醒重新验证。

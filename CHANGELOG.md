# Changelog

本插件同时记录两个版本：**插件版本**（SemVer）与**已验证的 DSH 版本**。
每次发版都打一个形如 `v<插件版本>-dsh<DSH版本>` 的 tag，例如
`v0.1.0-dsh0.2.0-rc.2`；DSH 升级后若尚未重新验证，不要沿用旧 tag。

## v0.1.10 — dsh0.2.0-rc.2（2026-10-04）

`cum` 改为**按自然日结转**（此前是「窗口回落即结转」，且重启也会参与，语义不清）：

- `dayKey` 始终等于当天的本地日期；当天记录端点**观察到的最大 window spend**。
  本地跨过 0 点后的第一次检查把**前一天**的数值结转并清零当天计数
  （即 **5 号 00:00 结转 4 号**），`dayKey` 前进到新的一天。
- 新增结转记录文件 `~/.dsh/api-pool/rollovers.json`：记录已结转的日期、当天金额、
  每端点金额与结转时间。它是「是否已结转」的**唯一权威**——重启、多进程、反复检查
  都不会把同一天记两次（已存在的日期只清零、不重复计账）。
- **启动时不再做任何累计/结转**；检查在运行 `/api-pool` 时进行，也在每次配额探测/
  成功调用观察 spend 时进行（保证你不运行命令也不会漏结转，且每天只真正结转一次）。
- `/api-pool` 输出保持不变；`/healthz` 增加 `bankedSpend` / `bankedDays` / `dayKey`。
- 前提与限制（按日刷新的 API、key/账号级口径、仅供参考）在
  `observeDaySpend`/`rollOverDays`/`rollover.js` 与 README 同步标注。
- 新增 `test/rollover.test.js`（记录文件幂等、跨重启、损坏容错、跨日累计）与按日结转测试。

## v0.1.9 — dsh0.2.0-rc.2（2026-10-04）

`cum` 改为**窗口最大值累计**（用代理自己的消费口径，不再按 token 估价）：

- 实测：流式响应**不返回** `x-litellm-response-cost`（值为 `null`），而 `x-litellm-key-spend`
  是跨客户端共享、批量结转的（连续 3 次调用该值纹丝不动）。因此「token × 我们猜的价格」
  并不可靠，改为使用代理现成的窗口消费。
- 算法：一个预算窗口内记录该端点**观察到的最大的 window spend**；窗口结束
  （消费数值回落，或 `budgetResetAt` 前移）时把上一窗口的最大值**结转**进累计并开新窗口。
  端点 `cum = 已结转窗口之和 + 当前窗口最大值`；池级 `cum = 全部已结转 + 当前各端点窗口最大值
  之和`（端点被删除也不丢历史）。
- **前提与限制已在代码（`observeWindowSpend`）和 README 同步标注**：只在预算窗口会周期性
  重置的 API 上成立（本项目验证的 key 为 24h）；窗口消费是 key/账号级的，包含其他客户端的
  用量，两个端点绑定同一账号级预算时池级总计会各记一份；**`cum` 仅供参考，不是账单**。
- 保留中继解析出的精确 token 计数（注入 `stream_options.include_usage`，流式与非流式都解析）
  作为 `/healthz` 的次要指标；`/api-pool` 输出保持原样。
- 移除尚未发布的「token × 自配价格」路径及其设置项与测试。

## v0.1.8 — dsh0.2.0-rc.2（2026-10-04）

修复「重启后 `/api-pool` 短暂没有 `window=` 列」——数值本身没问题，是**启动探测那一轮整轮失败**：

- 启动的强制探测在进程起来约 1 秒时执行，此时凭据服务可能对本 fiber 还不可见，
  4 个端点的 key 都解析不出来 → 8 个 GET 一个都没发；旧逻辑要等 60 秒后的下一轮才补数据，
  正好在那段窗口里看到空列。
- `resolveKey` 现在会**短暂等待凭据服务**（最多 2 秒）再判定「缺少 key」。
- 启动探测改为**最多 3 轮、每轮间隔 5 秒**，直到读到任意预算数据为止。
- 空轮的重试间隔由 60s 缩短为 **30s**。
- **修好从未生效的配额事件上报**：`config.onEvent` 之前没有接线，`quota_refresh` 一直没写进
  日志；现在 `quota_refresh` 与新增的 `quota_refresh_failed`（附每端点原因
  `no-credential` / `probe-failed`）都会进入 `api-pool.log` 与 JSONL。
- 新增 `ApiPool.hasQuotaHints()`；补 4 个测试（空轮上报 + 30s 重试、无凭据原因、
  成功轮上报、hints 状态）。

## v0.1.7 — dsh0.2.0-rc.2（2026-10-04）

修复「重启后 `ustc-1` 仍显示 `quota(999%)  window=$1282.93/$100`」——根因是**配额快照被跨进程持久化**，
而不是作用域修复本身失效：

- `state.json` 会留下 `(spend, maxBudget, quotaSource)` 三元组。旧版本写下的错误口径
  （key 的累计 spend 配 user 的预算）在重启时被**直接加载**；如果启动探测又失败
  （本次 `/key/info` 被限流，`quotaCheckedAt` 仍停在重启前），这份坏数据就一直生效，
  把健康端点长期判成「配额耗尽」。
- `StateStore.load()` 现在**丢弃全部配额提示字段**（`spend` / `maxBudget` / `budgetDuration` /
  `budgetResetAt` / `quotaSource` / `quotaCheckedAt`），交给启动与周期探测重新填充；
  `cooldownUntil` / `disabledUntil`（自带到期时间，会自愈）与累计消费
  `totalSpend` / `spendSince` 继续保留。
- 启动的**强制探测不再被 in-flight 守卫吞掉**：强制调用会等当前轮结束后再跑一轮。
- 配额探测改为**并行**（4 端点 8 次往返压成一轮），整轮读不到任何数据时把下次刷新缩短到 ≤60s。
- 新增 4 个回归测试：坏数据加载即丢弃、陈旧配额对不再使端点不可用、强制轮不被合并吞掉、空轮缩短重试。

## v0.1.6 — dsh0.2.0-rc.2（2026-10-04）

文档与界面示例去标识化：仓库内不再出现具体供应商名称，示例统一为
`primary` / `secondary` / `tertiary` / `spare` 与 `https://api.example.com/v1` /
`PRIMARY_API_KEY` 等中性占位符；测试夹具里真实 429 报文中的 api_key 哈希也换成假值。
行为无变化（仅文案、示例与夹具标识）。

## v0.1.5 — dsh0.2.0-rc.2（2026-10-04）

代码健壮性复查（全部代码逐文件过了一遍），修掉以下问题：

- **分类器顺序错误（影响最大）**：正文关键词判断跑在显式 HTTP 状态之前，导致
  400 里只要出现 "connection"/"fetch failed" 就被判成传输错误 → 会轮询所有 key；
  503 里出现 "network" 被降级为 connection 冷却。现在显式状态优先，文本启发式只在
  没有状态时使用。
- **409 不再当配额耗尽**（之前会让端点被禁用整个 `quotaRecheckMs`）。
- **收窄 budget 正则**：普通 400 里的 "billing"/"quota" 字样不再触发 30 分钟禁用；
  真正的 `ExceededBudget` / `budget_exceeded` 仍能识别（仅允许 400/402/429/无状态）。
- **热路径去阻塞**：状态落盘改为最多 1 秒合并一次（退出时 flush），并去掉同步自旋的
  锁目录——写是「临时文件 + rename」的原子替换，且本插件从不在此做读改写，
  锁只会带来最多 2s 的 event-loop 卡顿。
- **请求不再等配额探测**：探测转后台执行并做单飞（in-flight）合并。
- **`readBody` 挂起**：客户端发一半断开时立即 reject，不再等 socket 超时。
- **响应已结束/已销毁时不再写入**（错误路径 guard）。
- **优雅退出能撤回 provider profile**：settings 服务引用改回在 apply 时捕获。
  （之前 dispose 时才 `ctx.get('settings')`，服务已拆卸时返回 undefined，
  这正是「退出后设置文档里仍残留 `deepseek-pool`」的根因。）
- 重建实例前先 flush 旧实例待写状态；`quota(NaN%)` 防御。
- 设置页：写入被拒时显示提示（不再静默回弹）；清空 RPM 字段改为 `unset`
  （之前写 `undefined` 会被设置校验拒绝）。

## v0.1.4 — dsh0.2.0-rc.2（2026-10-04）

新增**累计消费统计**（逐端点 + 池级总计）：

- 从每个成功响应的 `x-litellm-response-cost` 头累加，写入 `state.json`，**永不清零**，
  端点被删除后池级总计仍保留；`spendSince` 记录首次计数时间。
- `/api-pool` 显示每个端点的 `cum=$…` 与 `cumulative spend: $… since …`；
  `GET /healthz` 增加 `totalSpend` / `spendSince`。
- **兜底**：成本头缺失、为空或非数字一律计 0；池级总计对 `undefined`/非有限值同样返回 0，
  不会出现 NaN 或抛错（新增 4 个测试覆盖）。
- 区分两个口径：`window=` 是预算窗口消费（会随 `budget_reset_at` 清零），`cum=` 才是累计值。

## v0.1.3 — dsh0.2.0-rc.2（2026-10-04）

**修复配额口径混用（会让健康端点被静默停用）**：本代理对其中一个 key 的
`/key/info` 返回 `spend=$1281.80, max_budget=null`，而真正生效的预算在
`/user/info`（`spend=$89.26 / $100 / 24h`）。`quotaFromHeaders()` 把 key 作用域的
`x-litellm-key-spend` 写进了 user 作用域的预算里，比值 12.8 倍 → 该端点被判
「配额耗尽」并从此不再被选中（`ok` 停在 25 就是证据）。

- `quotaFromHeaders()` 只在绑定预算也是 key 作用域时才采纳 key 档的 spend/budget；
  RPM 是 key 级，始终采纳。
- `probeQuota()` 改为**优先 key 记录的预算**，key 没有 `max_budget` 时才用 user 记录
  （偏离 Python 原版的「取使用率最高者」，原因见上；原策略在这种代理上会误判）。
- 启动时**强制探测一次配额**并越过节流窗口，使历史遗留的错误口径在启动后立即纠正，
  不必等 5 分钟。
- 回归测试：key 档 spend 不得污染 user 档预算、健康端点保持可选、启动强制刷新。

**新增 `/api-pool` 容量信息**：显示 `capacity: N/M ready now`；有端点冷却/配额禁用时
显示 `next recovery: <端点> in <时间> (<原因>)`；全不可用时显示
`blocked: no endpoint available — waiting for ...`；并单列永久禁用（401/403）端点。
探测到配额耗尽但没有报错时，端点状态也会如实显示 `quota(NN%)`，不再假装 `ready`。

## v0.1.2 — dsh0.2.0-rc.2（2026-10-04）

**修复进程崩溃（严重）**：中继转发上游响应体用的是
`Readable.fromWeb(upstream.body).pipe(res)`，异步错误无人接管；上游流式中断/超时
（undici 默认 300s bodyTimeout，栈里是 `TLSSocket`）时源流 emit `error` →
`uncaughtException` → **整个 DSH 进程退出**（`dsh: fatal uncaught exception: TypeError: terminated`）。
改为 `stream/promises.pipeline` 并捕获、记 `relay_error` 事件、干净关闭响应；
`req`/`res` 也补了 error 监听。回归测试：上游发一半断流后中继必须存活并继续服务
（临时还原旧写法可复现完全相同的栈）。

- **修复误 abort 上游请求**：原先用 `req.on('close')` 判断客户端断连，但 Node 22 在请求体
  读完后就会触发（实测 `+1ms, res.writableEnded=false`），会竞态地 abort 正在进行的上游请求。
  改用 `res.on('close')` + `!res.writableEnded`。
- **`maxBlockWaitMs` 默认 6h → 240s**：全端点不可用时静默阻塞超过 undici 的 300s
  bodyTimeout，harness 自己的 fetch 会先超时。新默认刻意低于它；需要等更久可在设置里调大。

## v0.1.1 — dsh0.2.0-rc.2（2026-10-04）

- 修正远程（frp / 非 loopback）访问时的提示：区分「Host 未提供命名空间」与
  「DSH 对非 loopback 页面关闭 Host 设置（memory 模式）」两种情况，并给出可操作建议，
  不再让人误以为插件没装好；README 增加「远程访问限制」一节。

## v0.1.0 — dsh0.2.0-rc.2（2026-10-04）

首个可用版本：DSH 0.2.0-rc.2 的「API Pool」provider + 设置页端点管理。

- 池核心移植自 AI-Scientist-v2 `api_pool.py`：错误分类（8 类）、每端点冷却/禁用状态机、
  指数退避 + `Retry-After`/`reset_at`、`least_loaded`/`priority`/`round_robin` 选点、
  全忙阻塞等待、配额探测（`/key/info`、`/user/info`、`x-litellm-*`）、JSONL 事件 + 人类日志。
- OpenAI 兼容本地回环中继（`127.0.0.1:8765/v1`，带共享 token）：首字节前失败自动换端点，
  SSE 透传。
- provider 暴露：宿主插件在 `llm-pi-ai` 设置命名空间幂等 upsert `deepseek-pool`
  profile（默认 `deepseek-flash`，模型列表可在设置里编辑）。
  * 曾尝试把 profile 写进 bundle 的 `cordis.patch.yml`——不可行：loader 对 patch 的
    `config` 子树是替换而非深合并，用户 profile 的 `llm-pi-ai.providers` 会覆盖它。
- 浏览器半：`settings.section` 注册「API Pool」页，增删/启停端点、选策略、编辑模型列表。
- 宿主 `/api-pool` 命令输出端点健康。
- 验证：39 个单元/集成测试；离线验收 + 真实 `dsh web` 启动 + 真实补全 + 真实故障切换。

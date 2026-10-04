# 验收记录

环境：DSH `0.2.0-rc.2`（`dsh --version`），源码 tag `dsh-v0.2.0-rc.2`，
commit `639ed015397290b3745d163aafe02ffee4aa3f84`，工作区无改动；Node v22.23.2。

## 1. 单元 / 集成测试

```
$ node --test test/*.test.js
# tests 38
# pass 38
# fail 0
```

覆盖文件：`classify`、`state`、`select`（含 pool 循环）、`relay`、`config`（含防漂移）、
`host`、`client`。

## 2. 组合校验（真实 `dsh web --dump-config`）

```
# == dsh-api-pool, patched by /home/lenovo/.dsh/profiles/web/cordis.patch.yml
- id: dsh-api-pool
  name: dsh-api-pool
  config:
    endpoints:
      - name: primary
        baseURL: https://api.example.com/v1
        apiKeyEnv: PRIMARY_API_KEY
      - name: secondary
        baseURL: https://api.example.com/v1
        apiKeyEnv: SECONDARY_API_KEY
        priority: 2
      - name: tertiary
        baseURL: https://api.example.com/v1
        apiKeyEnv: TERTIARY_API_KEY
        priority: 3
```

组合树中 `llm-pi-ai.providers` 同时包含 `primary` / `secondary` / `tertiary` / `deepseek-pool`
——bundle 层声明与用户层的 providers 深合并，未互相覆盖。

## 3. 真实启动 + 真实补全（`ACCEPTANCE_BOOT=1 DSH_API_POOL_LIVE=1`）

```
== 3/4 real boot: relay reachable with the configured endpoints ==
relay: http://127.0.0.1:8765/v1
endpoints: primary(ready), secondary(ready), tertiary(ready)

== 4/4 live completion through the pool ==
reply: "POOL_OK"

PASS: dsh-api-pool acceptance
```

## 4. 真实故障切换（人工验收）

临时把优先级最高的死端点 `https://127.0.0.1:9/v1`（priority 0）加入配置，热更新后发请求：

```
$ curl .../v1/chat/completions  -d '{"model":"deepseek-flash", ... "Reply with exactly: FAILOVER_OK"}'
{"choices":[{"message":{"content":"FAILOVER_OK"} ...}]}

$ curl /healthz
dead   cooldown(30s)   ok=0  fail=1  connection
primary   ready           ok=0  fail=0
secondary ready           ok=1  fail=0
tertiary ready           ok=1  fail=0

$ tail -1 ~/.dsh/api-pool/api-pool-events.jsonl
{"event":"failover","endpoint":"dead","kind":"connection","attempt":1,
 "cooldown_seconds":30,"message":"fetch failed"}
```

请求在死端点上失败后自动冷却并切换，调用方仍拿到 `FAILOVER_OK`。

另一次真实调用（未加死端点）返回 `POOL_OK`，被 `least_loaded` + priority 选中的是
`secondary`，健康计数 `ok=1`。

## 5. 安装后的环境变化

- `~/.dsh/profiles/web/package.json`：新增依赖 `dsh-api-pool`（link 本目录）与
  `dsh.profile.bundles` 条目。
- `~/.dsh/profiles/web/cordis.patch.yml`：新增 `- id: dsh-api-pool` 的端点配置
  （预置三个上游端点）；备份见同目录 `cordis.patch.yml.bak-api-pool`。
- `~/.dsh/.credentials.yaml`：新增 `DSH_API_POOL_LOCAL_KEY`（中继共享令牌）。
- `~/.dsh/api-pool/`：`relay-token`、`state.json`、`api-pool.log`、`api-pool-events.jsonl`。

## 6. 未验证项

- 浏览器里的人工点击（设置页增删端点、provider 下拉选择）；已用真实组合、真实启动、
  中继 HTTP 探测、浏览器半模块契约测试与真实补全间接验证。
- 真实 429 / 配额耗尽（当日各端点配额未耗尽）；该类路径由单元测试用真实 LiteLLM
  429 报文与 budget 报文覆盖。
- Slurm / 多进程共享（本插件不涉及）。

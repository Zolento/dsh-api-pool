# Changelog

本插件同时记录两个版本：**插件版本**（SemVer）与**已验证的 DSH 版本**。
每次发版都打一个形如 `v<插件版本>-dsh<DSH版本>` 的 tag，例如
`v0.1.0-dsh0.2.0-rc.2`；DSH 升级后若尚未重新验证，不要沿用旧 tag。

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

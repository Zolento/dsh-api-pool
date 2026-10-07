# dsh-plugin

给 **DeepSeek Harness (DSH) 0.2.0-rc.2** 用的插件工作区。约定很简单：**根目录下一个目录 = 一个插件**，
每个插件自带 `package.json`、`cordis.patch.yml`、测试与验收脚本，互相独立。

| 目录 | 插件 | 作用 | 版本 |
|---|---|---|---|
| [`dsh-api-pool/`](dsh-api-pool/README.md) | `dsh-api-pool` | 多端点（多 key）API 池 provider：限流/配额/鉴权失败时冷却并自动切换端点 | v0.1.13 |
| [`dsh-loop/`](dsh-loop/README.md) | `dsh-loop` | 类 Claude Code 的 `/loop`：在同一 session 里按固定间隔或自适应调度重复执行 prompt | v0.1.0 |

## 版本基线

所有插件都针对本地 `deepseek-harness` 检出 **`dsh-v0.2.0-rc.2`**（commit `639ed015…`）开发并验证，
不假设 master 或更新版本上的 API。每个插件的 `dsh-compat.json` 固定它验证过的 DSH 版本、commit，
以及它实际依赖的 public seam 清单；升级 DSH 后按该清单逐条复核。

**本仓库不修改 DSH core**：只用 bundle patch 挂载插件行，通过 public seam（`ctx.commands`、
`ctx.tools`、`agent.ctx`、`ctx.systemPrompt`、`ctx.timeout`、`agent.followup`、session 事件等）实现功能。

## 通用约定

- **安装到某个 profile**（bundle 集合是启动边界，装入后需重启该 profile）：

  ```sh
  dsh plugin --profile <profile> add /home/lenovo/code/dsh-plugin/<plugin-dir>
  dsh --profile <profile> --dump-config | grep -A2 '^# == <plugin-dir>'   # 免启动核对
  ```

- **`@deepseek-ai/*` 依赖**：运行时需要的包声明为 `peerDependencies`。链接进 profile 的插件，
  其 peer 由宿主安装副本解析（不会装出第二份实例）；开发期各插件用 `scripts/link-dsh.mjs`
  在自己的 `node_modules/` 下建软链，供 `node --test` 使用。该目录不入库。
- **测试与验收**：测试用 `node --test`（自带 runner，不下载依赖）；验收脚本
  (`scripts/acceptance.sh`) 使用**独立 `DSH_HOME` 与临时端口**，不会碰正在运行的 harness 实例。

## 仓库沿革与远端

本仓库的 git 历史来自原来的 `dsh-api-pool` 独立仓库：`.git` 已上移到工作区根目录，历史中所有路径
重写为 `dsh-api-pool/` 前缀（19 个 commit、14 个 tag 全部保留，因此 commit/tag 哈希已改变）。

远端 `origin` 仍指向 `git@github.com:Zolento/dsh-api-pool.git`——那是**单个插件**的远端，
而本仓库的树根现在是整个工作区。直接推送会把工作区结构（含 `dsh-loop/`、根 `README.md`）推到那个远端，
推送前需要先决定远端策略（拆库、改名为 workspace 远端，或只对子目录做 subtree 推送）。

# dsh-plugin

给 **DeepSeek Harness (DSH)** 用的插件工作区。约定很简单：**根目录下一个目录 = 一个插件**，
每个插件自带 `package.json`、`cordis.patch.yml`、测试与验收脚本，互相独立。

| 目录 | 插件 | 作用 | 当前版本 |
|---|---|---|---|
| [`dsh-api-pool/`](dsh-api-pool/README.md) | `dsh-api-pool` | 多端点（多 key）API 池 provider：限流 / 配额 / 鉴权失败时冷却并自动切换端点 | v0.1.13 |
| [`dsh-loop/`](dsh-loop/README.md) | `dsh-loop` | 类 Claude Code 的 `/loop`：在同一 session 里按固定间隔或自适应调度重复执行 prompt | v0.1.0 |

## 版本基线、分支与 tag

插件都是针对**具体的 DSH 版本**写的：DSH 的 API 会变，「适配哪个 DSH」本身就是发布信息的一部分，
所以它写在分支名、tag 后缀和每个插件的 `dsh-compat.json` 里，而不是固定成文档里的某一个版本。

当前基线是 **`dsh-v0.2.0-rc.2`**（下文 `0.2.0-rc.2` 即指它）。以后新增 DSH 版本时，按同一套规则继续，
不需要改动本文档的措辞。

- **分支**：每个 DSH 基线一条分支，例如 `dsh-0.2.0-rc.2`；`main` 跟随最新已适配的基线，
  新基线另开分支，互不覆盖。当前只有 `main`，即 0.2.0-rc.2 基线。
- **tag**：`[<插件名>-]v<插件版本>-dsh<DSH 版本>`。后缀 `-dsh0.2.0-rc.2` 表示该版本是针对
  0.2.0-rc.2 验证发布的；换基线时后缀随之改变，各插件的版本号独立递进。
- 单插件仓库里 tag 形如 `v0.1.13-dsh0.2.0-rc.2`；本仓库容纳多个插件、版本号会相撞
  （`v0.1.0-dsh0.2.0-rc.2` 已属于 dsh-api-pool），因此**新** tag 带插件名前缀。
- tag 一律是附注 tag，message 沿用 `<插件名> <版本> for DSH <DSH版本>` 的写法。
- 每个插件的 `dsh-compat.json` 固定它**实际验证过**的 DSH 版本、commit 与所依赖的 public seam 清单；
  升基线时按该清单逐条复核，再打新后缀的 tag。

```sh
# 以 dsh-loop 在 0.2.0-rc.2 基线上发布 v0.1.0 为例
git tag -a dsh-loop-v0.1.0-dsh0.2.0-rc.2 -m 'dsh-loop 0.1.0 for DSH 0.2.0-rc.2'
git push origin dsh-loop-v0.1.0-dsh0.2.0-rc.2
```

## 通用约定

- **不修改 DSH core**：插件以 bundle patch 挂到 profile 上，功能只通过 public seam 实现
  （`ctx.commands`、`ctx.tools`、`agent.ctx`、`ctx.systemPrompt`、`ctx.timeout`、`agent.followup`、
  session 事件等），并随 DSH 版本升级逐条复核。
- **安装到某个 profile**（bundle 集合是启动边界，装入后需重启该 profile）：

  ```sh
  dsh plugin --profile <profile> add /home/lenovo/code/dsh-plugin/<plugin-dir>
  dsh --profile <profile> --dump-config | grep -A2 '^# == <plugin-dir>'   # 免启动核对
  ```

- **`@deepseek-ai/*` 依赖**：运行时需要的包声明为 `peerDependencies`。链接进 profile 的插件，
  其 peer 由宿主安装副本解析（不会装出第二份实例）；开发期各插件用 `scripts/link-dsh.mjs`
  在自己的 `node_modules/` 下建软链供 `node --test` 使用，该目录不入库。
- **测试与验收**：测试用 `node --test`（自带 runner，不下载依赖）；`scripts/acceptance.sh` 使用
  **独立 `DSH_HOME` 与临时端口**，不会碰正在运行的 harness 实例。

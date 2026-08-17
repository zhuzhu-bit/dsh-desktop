# Harness 构建支持

本目录保存从**官方 Harness 固定提交**可复现生成内置运行时所需的最小材料：

- `harness.patch`：唯一补丁。在官方
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  的固定提交上注册 `deploy-roots/dsh-desktop` 部署清单（纯新增，不修改任何
  上游文件内容）；
- 固定基线：`47f943859bef60e4160492346772ded9b24f765a`。

CI 与本机均通过 `scripts/prepare-host.mjs` 使用同一套流程：

1. 干净检出固定提交；
2. `git apply` 本补丁；
3. 用固定版本 pnpm 11.7.0 安装并构建 Harness；
4. `pnpm deploy` 物化零 junction 的生产闭包到 `src-tauri/resources/host/`；
5. 全套校验（见 prepare-host.mjs）。

**不得**直接复制本地 Harness 工作区的 `pnpm-lock.yaml` 或把 `resources/host`
提交进仓库——两者都是生成产物。

# dsh-desktop

一个**非官方社区**的 DeepSeek Harness（`dsh`）Web UI 本地桌面壳，基于 **Tauri 2**。

> **本项目与 DeepSeek（深度求索）不存在隶属、授权或背书关系。**
> 壳代码采用 MIT 许可；DeepSeek Harness 本体及其依赖按各自许可证分发
> （见 `THIRD_PARTY_NOTICES.md`）。

- 不 clone、不复制任何第三方桌面仓库的代码；
- 只借用公开的架构模式（Tauri 官方文档的 [Node.js sidecar](https://v2.tauri.app/learn/sidecar-nodejs/) 思路）；
- 壳代码许可：**MIT**（见 `LICENSE`）；
- 打包进来的 DeepSeek Harness 本体（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）是 **MIT** 许可，完整第三方声明见 `THIRD_PARTY_NOTICES.md`；
- **第一阶段没有 Windows Authenticode 代码签名**：Windows 可能显示
  "未知发布者"（SmartScreen）警告，属已知行为；
- 应用图标由 `scripts/gen-icons.ps1` **程序化原创生成**（渐变底 + 文字），
  无第三方图片素材，随壳代码以 MIT 许可分发。

## 工作原理

```
┌────────────────────────────  Tauri 壳 (Rust + WebView2)  ───────────────────────────┐
│                                                                                     │
│  1. spawn:  node <dsh>/lib/bin.js --profile web --port 0                            │
│  2. 逐行读 stdout，等到 "http://127.0.0.1:<port>" 这一行（容忍 ANSI 转义）              │
│  3. 窗口导航到该地址（导航前显示内置 dist/index.html 加载页）                            │
│  4. 点 X：窗口隐藏到托盘，宿主继续运行                                                  │
│  5. 托盘「退出」/ 宿主异常 → taskkill /T /F 清掉整个宿主进程树后退出                     │
│  6. 托盘：左键或「显示窗口」唤回窗口；再次启动应用 = 唤醒已有窗口（单实例）                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

宿主选择优先级（`src-tauri/src/lib.rs` 的 `resolve_host_command`）：

1. 环境变量 `DSH_NODE` + `DSH_CLI`（对本地 checkout 的开发循环）；
2. 随包资源 `resources/host/node.exe` + `resources/host/cli/node_modules/@deepseek-ai/dsh/lib/bin.js`（**默认路径**：内置运行时，装完即用、无需系统 Node/dsh）；
3. `PATH` 上的 `dsh` 命令。

## 内置运行时（可复现构建）

安装包自带 Node 24 + dsh 运行时闭包（约 357 MiB 未压缩 / 安装包约 54 MB），
目标机器**不需要** Node、dsh、npm 或网络。闭包由 CI 与本机用**同一套脚本**
从官方 Harness 的固定 commit 干净检出生成，绝不提交进仓库：

- Harness 固定基线：`47f943859bef60e4160492346772ded9b24f765a`
  （https://github.com/deepseek-ai/deepseek-harness）
- `build-support/harness/harness.patch`：最小、可审计的补丁（注册
  `deploy-roots/dsh-desktop` 部署清单 + 其 manifest 文件本身）；
- `scripts/prepare-host.mjs`：克隆固定 commit → 应用补丁 → 固定 pnpm 11.7.0
  安装并构建 → `pnpm deploy` 物化零 junction 闭包 → 完整校验（bin.js 存在、
  无链接、无 dev/test 残留、`audit-closure.mjs` 通过、node 可运行、dsh web
  能打印 localhost URL）；
- node.exe 下载后按官方 `SHASUMS256.txt` 校验 SHA-256（已存在也会复验）。

本机重新生成：

```powershell
node scripts\prepare-host.mjs      # 干净检出 + 构建 + 闭包 + 全部校验
npm run tauri build               # 重新打包
```

闭包完整性可用 `node scripts\audit-closure.mjs` 复查（剩余的"缺失"名单
全部是测试包/文档误报，可忽略）。

## 目录结构

```
dsh-desktop/
├── dist/index.html              # 内置加载页（宿主起来前的过渡画面）
├── package.json                 # 只有 @tauri-apps/cli 一个 devDependency
├── scripts/gen-icons.ps1        # 本地生成全部图标（无网络依赖，已生成好）
└── src-tauri/
    ├── Cargo.toml               # tauri 2 + tray-icon + single-instance，release 开启 lto/strip 压缩体积
    ├── build.rs
    ├── tauri.conf.json          # 窗口、图标、NSIS（currentUser 免管理员安装）
    ├── capabilities/default.json
    ├── icons/                   # 已生成
    └── src/
        ├── main.rs
        └── lib.rs               # 全部壳逻辑（宿主生命周期、托盘、单实例、关窗进托盘）
```

## 一次性准备：Windows 工具链

```powershell
# 1. Rust（rustup）
winget install --id Rustlang.Rustup -e
rustup default stable

# 2. MSVC Build Tools（编译 Rust 必需；装完在 Visual Studio Installer 勾选「使用 C++ 的桌面开发」）
winget install --id Microsoft.VisualStudio.2022.BuildTools -e

# 3. WebView2 运行时（Win10/11 一般已自带，缺了才装）
winget install --id Microsoft.EdgeWebView2Runtime -e
```

装完**重开一个终端**让 PATH 生效，验证：`cargo --version`、`rustc --version`。

## 开发（推荐先跑通这一步）

```powershell
cd dsh-desktop
npm install            # 或 pnpm install

# 指向你本地的 dsh 宿主（本仓库 checkout 的已构建产物）
$env:DSH_NODE = 'C:\Program Files\nodejs\node.exe'
$env:DSH_CLI  = 'E:\code\deepseek\deepseek-harness\apps\cli\lib\bin.js'

npm run tauri dev
```

- 首次 `tauri dev` 会下载编译 crates，需要几分钟；
- dev 模式保留控制台，能看到宿主输出（`[dsh] ...` 前缀行）和报错；
- 改 Rust 后 `tauri dev` 自动重编重开；改 DSH 本体则回 harness 仓库 `pnpm run build` 重出 dist 后重启本壳即可；
- 本壳会自动用一个**空闲端口**（`--port 0`），与你正在跑的 3080 端口 GUI 互不干扰。

## 打包出 exe

```powershell
npm run tauri build
```

产物在 `src-tauri\target\release\bundle\nsis\DSH Desktop_0.1.0_x64-setup.exe`（免管理员安装）。
首次打包 Tauri 会自动下载 NSIS（需要网络）。

安装包**自带 Node 24 与 dsh 运行时闭包**（见上文「内置运行时」），目标机器无需
Node/dsh/npm/网络；`DSH_NODE`/`DSH_CLI` 环境变量仅用于开发时指向本地 checkout。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_NODE` / `DSH_CLI` | 无 | 指定 node.exe 与 dsh 的 `bin.js` 路径（开发循环首选） |
| `DSH_WEB_ARGS` | 空 | 追加给宿主的参数（空格分隔，如 `--trusted-host 192.168.1.5`） |
| `DSH_HOST_TIMEOUT_SECS` | 120 | 等待宿主打印 URL 的超时秒数 |

## 行为约定

- 窗口标题「DeepSeek Harness」，1280×820，最小 940×600；
- **点 X = 隐藏到托盘**，dsh/Node 宿主继续运行，进行中的任务不受影响；最小化按钮仍是普通任务栏最小化；
- **正确退出方式是托盘「退出」**：强杀完整宿主进程树后退出（dsh 的会话/凭据存在它自己的存储里，不受影响）；
- **单实例**：再次启动应用不会开第二个实例/宿主，而是唤醒并聚焦已有窗口；
- **孤儿进程防护**：Node 宿主绑定 Windows Job Object（KILL_ON_JOB_CLOSE）——
  即使壳被任务管理器/安装器强杀，内核也会自动终结整个 Node 进程树；
- 宿主启动失败 / 提前退出 / 超时 → 日志 + 退出码 1 结束（不会藏在托盘）；
- 托盘左键或「显示窗口」唤回并聚焦窗口；
- **自动更新**：启动后后台检查一次（失败仅记日志）；托盘「检查更新」可手动
  检查；确认后下载，安装前完整清理宿主进程树再重启，绝不静默重启；
- 日志：dev 模式打在控制台；**打包版写入 exe 同目录的 `dsh-desktop.log`**（排查问题的第一现场）。

## 剩余路线图（按需选做）

1. Windows Authenticode 代码签名（改善 SmartScreen 体验，第一阶段明确不做）；
2. 更新服务器与密钥由所有者管理（设计见 `docs/auto-update-design.md`，
   确认表见 `docs/auto-update-owner-checklist.md`）。

## 故障排查

| 现象 | 处理 |
|---|---|
| `failed to start dsh host` | 设 `DSH_NODE`/`DSH_CLI`，或把 `dsh` 放进 PATH |
| 卡在加载页直到超时 | 手动跑 `node <DSH_CLI> --profile web --port 0` 看真实报错（多为凭据/构建产物缺失）；缺 `apps/web/dist` 时回 harness 仓库 `pnpm run build` |
| 壳能起但页面空白 | 看 dev 控制台 `[dsh]` 行：URL 是否打印、是否别的 host/端口 |
| 编译报错 | 把 `cargo build` 报错贴回来 |

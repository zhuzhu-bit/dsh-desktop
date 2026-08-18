# 自动更新设计说明（里程碑 B）

> 状态：**已实现**（0.2.0）。公钥、endpoint、托管方式等参数已由项目所有者确认并落地；
> 剩余工作为发布流程验收（见 `docs/RELEASING.md`）。签名私钥只存在于所有者的
> GitHub release Environment 与离线备份中，本仓库不含任何私钥。

## 已确认的参数

| 参数 | 值 |
|---|---|
| productName | `DSH Desktop` |
| identifier | `io.github.zhuzhu-bit.dsh-desktop` |
| 更新地址 | `https://github.com/zhuzhu-bit/dsh-desktop/releases/latest/download/latest.json` |
| 托管 | GitHub Releases（静态 latest.json） |
| 公钥 | 所有者本机 `tauri signer generate` 生成（minisign） |
| 私钥 | GitHub release Environment Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`）+ 加密离线备份 |
| Authenticode | 第一阶段不做（SmartScreen「未知发布者」为已知行为） |
| 安装包 | NSIS、currentUser、passive 更新模式 |

## B1. 更新策略（第一版）

- **启动后异步检查**更新（不阻塞主窗口与宿主启动；失败只写 `dsh-desktop.log`，不关闭应用）；
- 托盘菜单增加「检查更新」入口：**用户主动检查失败时才显示错误**；
- 发现新版本后，弹窗明确展示**版本号 + 更新说明**，用户确认后才下载；
- **下载、安装、重启全程用户驱动，禁止静默重启**；
- 提示文字必须包含（任务书原句要求）：
  「安装更新将重启应用，并中断当前运行中的本地任务。」
  因为壳无法可靠判断 dsh 当前是否在执行任务，该提示固定显示、不做"当前空闲"判断；
- 更新重启前调用 `request_exit(app, 0)`（先置 `shutting_down = true`，
  由现有 `RunEvent::ExitRequested` 路径 `taskkill /T /F` 清理宿主进程树），
  随后触发 updater 的 install-and-relaunch；
- 同一版本不提示；高版本不自动降级；用户取消更新后应用继续运行。

## B2. Updater 配置模板（仅模板，参数确认后填写）

```toml
# Cargo.toml（届时新增）
tauri-plugin-updater = "2"
```

```jsonc
// tauri.conf.json（届时新增，值必须替换为真实参数）
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<minisign 公钥内容，不是文件路径>",
      "endpoints": ["https://<实际域名>/latest.json"],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

硬性约束：

- 必须 HTTPS；**不允许** `dangerousInsecureTransportProtocol`；
- 更新包签名**不能关闭**；私钥只经安全环境变量/CI Secret 注入，不得进仓库、README、日志、`.env`；
- 丢失私钥 = 已装客户端永远无法验证后续更新，必须离线备份；
- 两套签名互不替代：
  - **Tauri Updater 签名**（minisign）：验证更新包内容，强制；
  - **Windows Authenticode 签名**（B5）：改善发布者身份与 SmartScreen 体验，另一套证书体系。

## B3. 更新托管方案（推荐：静态 HTTPS）

`latest.json`（静态托管）格式（字段说明见 Tauri 静态更新文档）：

```json
{
  "version": "0.2.0",
  "notes": "更新说明",
  "pub_date": "2026-08-17T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<对应 .sig 文件的实际内容>",
      "url": "https://<实际域名>/releases/0.2.0/DSH-Desktop-setup.exe"
    }
  }
}
```

- `signature` 字段是签名内容本身，**不能写成 .sig 文件 URL**；
- 发布顺序（严格）：
  1. 构建版本化安装包；
  2. 生成 `.sig`；
  3. 上传安装包与签名；
  4. **从外部网络**验证文件可下载；
  5. 验证 SHA-256；
  6. 最后才更新 `latest.json`（先更新清单会让客户端"看得到、下不到"）。

## B4. 自动更新验收矩阵（实现后逐项实测）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 0.1.0 → 0.2.0 | 检查、下载、安装、重启全部成功 |
| 2 | 重启后 | 仍只有一个实例、一个 Node 宿主 |
| 3 | 相同版本 | 不提示更新 |
| 4 | 服务器版本更低 | 不自动降级 |
| 5 | 错误签名 | 拒绝安装 |
| 6 | latest.json 格式错误 | 应用不退出，只记日志 |
| 7 | 404 / 断网 / 下载中断 | 不影响当前 dsh 会话 |
| 8 | 用户取消更新 | 应用继续运行 |
| 9 | 更新安装前 | 完整清理旧宿主进程树（shutting_down 路径） |
| 10 | 更新后 | 安装目录、内置 Node 与 dsh 闭包完整 |
| 11 | 卸载 | 仍正常 |

## B5. Windows 代码签名

- 在**生产自动更新启用之前**完成；
- Tauri 通过 `bundle.windows.signCommand` 接入签名工具
  （signtool / Azure Trusted Signing），证书与客户端密钥只存在于安全发布环境；
- 与 Tauri Updater 签名（minisign）是**两套独立机制**，都需要。

## 实现顺序建议（参数确认后）

1. 确认 B 前置清单 1–8 → 2. 更新 `identifier`/`productName` → 3. 接入 updater 插件与
   UI（提示框/检查更新菜单） → 4. 建立 CI 签名与发布流水线 → 5. 按 B3 顺序发布
   0.2.0 冒烟包 → 6. 按 B4 矩阵验收 → 7. 版本号 0.2.0 同步改 `package.json`、
   `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`（按任务书放在验收后）。

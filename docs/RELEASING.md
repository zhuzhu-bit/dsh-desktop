# 发布流程（RELEASING）

面向项目所有者的版本发布与验收手册。私钥只存在于 GitHub release Environment
与你的加密离线备份中；本仓库不含任何私钥、口令或 Token。

## 前置条件（一次性）

1. `gh auth login`（浏览器授权）；
2. 本机生成更新签名密钥：`scripts/signer/generate-key.ps1`；
3. 私钥写入 GitHub Secrets：`scripts/signer/setup-github-secrets.ps1`；
4. 私钥已复制到加密离线介质并验证可读。

## 发布一个新版本

```powershell
# 1. 三处版本号同步（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json）
#    Release 工作流的版本门会强制四源一致（+ tag）。

# 2. 提交并打 tag（触发 Release 工作流）
git add package.json src-tauri\Cargo.toml src-tauri\tauri.conf.json src-tauri\Cargo.lock
git commit -m "chore: bump to X.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

Release 工作流（windows-latest，environment: release）会：

1. 四源版本一致性校验（不一致立即失败）；
2. 从固定的 Harness commit 干净生成内置运行时并全量校验（`prepare-host.mjs`）；
3. 严格校验 THIRD_PARTY_NOTICES.md；
4. 用 Secrets 中的私钥签名 NSIS 安装包，产出并上传：
   - `DSH Desktop_X.Y.Z_x64-setup.exe`
   - 对应 `.sig`
   - `latest.json`（签名内容内嵌，静态托管于 GitHub Releases）
5. 创建 **Draft Release**（不会自动公开发布）。

## Draft 验收清单（公开发布前必须逐项完成）

- [ ] 从外部网络验证 `latest.json` 可下载（HTTP 200）且内容正确：
      version、`platforms.windows-x86_64.url` 指向实际 asset、`signature` 为内嵌内容
- [ ] 安装包 SHA-256 与本地构建/报告一致
- [ ] 干净 Windows 用户安装成功；桌面/开始菜单/托盘图标正确
- [ ] SmartScreen 未知发布者警告为已知行为（第一阶段无 Authenticode）
- [ ] 启动后仅一个壳进程 + 一棵 Node 宿主树；点 X 只隐藏；再次启动只唤醒
- [ ] 托盘退出后无残留进程；强杀壳进程后 Node 自动退出（Job Object）
- [ ] 卸载无 libvips-42.dll 占用错误、无安装目录与快捷方式残留
- [ ] latest.json 断网/404/错误 JSON 不影响正常使用；错误签名更新被拒绝
- [ ] 真实 0.2.0 → 0.2.1 更新演练（版本说明、用户确认、下载、宿主完整退出、自动重启、单实例、无孤儿、会话数据保留）

全部通过后在 GitHub 上把 Draft 发布为 Latest。

## 安全红线

- 私钥/口令/Token 绝不进入仓库、日志或聊天；
- 发布顺序固定：先上传安装包与 .sig，最后更新 latest.json（本项目由
  tauri-action 在同一步完成上传，其顺序保证资产先于清单对外可见）；
- 私钥丢失 = 已安装客户端无法再验证任何更新，必须重建密钥并让所有用户
  手动重装。

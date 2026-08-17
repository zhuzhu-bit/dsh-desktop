# 自动更新外部参数确认表（里程碑 B 前置）

> 用途：里程碑 B（自动更新）实现前的项目所有者确认单。8 项全部确认后，
> 才能把真实参数写入 `tauri.conf.json` / CI 配置。**私钥永不写入本仓库。**
>
> 填写方式：复制文末「回答模板」，逐项填写后发回即可。

## 逐项说明

### 1. productName（最终产品名）

- 当前值：`DSH Desktop`
- 影响：安装包文件名、开始菜单/桌面快捷方式、NSIS 卸载注册表项。
  发布后改名会造成旧版卸载残留与更新包路径混乱，**发布前必须定死**。
- 请回答：沿用 `DSH Desktop`，还是改为其他名字？

### 2. identifier（最终应用标识）

- 当前值：`dev.dsh.desktop`（**不可用于生产**）
- 格式要求：反向域名风格，例如 `com.tonikjin.dsh-desktop`
- 影响：单实例互斥名、系统级应用身份、更新器身份。发布后不可更改，
  否则新旧版本会互相视为"不同应用"。
- 请回答：最终 identifier 是什么？

### 3. 正式 HTTPS 更新地址（latest.json 的绝对 URL）

- 示例：`https://updates.example.com/dsh-desktop/latest.json`
- 要求：HTTPS、固定不变（写进每个已安装客户端）。若将来换域名，
  旧域名必须永久保留一个跳转/转发到新地址。
- 请回答：完整 URL？

### 4. 更新文件托管方式

- 影响：上传流程、带宽费用、可用性。
- 可选答案（推荐第一个）：
  - **A（推荐）**：静态对象存储/CDN——Cloudflare R2、阿里云 OSS、腾讯云 COS、
    AWS S3+CloudFront、GitHub Releases（固定直链）任选其一；
  - B：自有服务器静态目录（Nginx/Caddy 挂一个目录）；
  - C：还没定，先告诉我你的倾向。
- 请回答：选哪个 + 具体平台（如已定）。

### 5. Tauri Updater 公钥

- 说明：更新包签名密钥对用 `tauri signer generate`（minisign）生成；
  **公钥**写进 `tauri.conf.json`，**私钥**只存本地/CI Secret，绝不进仓库。
- 需要决定：
  - 谁来生成：**你自己生成**（推荐，私钥全程不离手）还是让我在本机生成后
    把公钥给你（私钥只留在你机器上）；
  - 公钥以什么形式交付（直接发我内容，或告诉我存放路径，由我读入配置）；
  - 私钥备份方式（建议离线备份，丢失后已装客户端无法再验证任何更新）。
- 请回答：生成方式 + 公钥内容/路径 + 私钥保管计划。

### 6. Windows Authenticode 代码签名方案

- 与第 5 项是两套独立机制：Authenticode 改善发布者身份与 SmartScreen 体验。
- 可选答案：
  - **A（个人使用推荐）**：暂不签名，接受 SmartScreen"未知发布者"警告；
  - B：Azure Trusted Signing（按次计费、免自管硬件/证书）；
  - C：购买 OV/EV 代码签名证书（需企业身份，约数百美元/年起）；
  - D：内部 CA（仅内网分发场景）。
- 请回答：选哪个？（选 B/C/D 请注明证书由谁申请、存放位置）

### 7. 壳项目 LICENSE 与第三方许可分发

- 壳代码（本仓库）许可：当前无 LICENSE（默认保留所有权利）。
- 可选答案：闭源不发 LICENSE / MIT / Apache-2.0 / 其他（请注明）。
- 第三方声明：安装包应随附第三方许可文本，来源有三类：
  ① DeepSeek Harness 的 `THIRD_PARTY_NOTICES.md`（MIT，官方仓库自带）；
  ② Rust crate 依赖许可清单（可用 cargo-about 生成）；
  ③ Tauri 及其插件许可。
  需要决定：安装程序的许可页要不要展示这些文本（NSIS license 页），
  以及是否让我生成 ② 的清单。
- 请回答：壳许可选哪个 + 第三方声明"要/不要"随安装包展示。

### 8. 私钥与 CI Secret 通道

- 需要决定：
  - 构建发布在哪里做：**本机手动构建** / GitHub Actions / 其他 CI；
  - 两把私钥（Updater 私钥、Authenticode 私钥或托管签名凭据）如何注入：
    本机环境变量 / CI Secrets / 其他（请注明）。
- 请回答：构建位置 + 每把私钥的注入方式。

---

## 回答模板（复制填写）

```text
1. productName:（沿用 DSH Desktop / 改为 ___）
2. identifier:（如 com.xxx.dsh-desktop）
3. 更新地址:（https://___/latest.json）
4. 托管方式:（A/B/C + 平台名）
5. Updater 公钥:（我自己生成，稍后提供内容 / 帮我本机生成；私钥备份计划:___）
6. Authenticode:（A 暂不签名 / B Azure Trusted Signing / C OV/EV / D 内部 CA）
7. 壳许可:（闭源 / MIT / Apache-2.0 / 其他___）；第三方声明随安装包:（要 / 不要）
8. 构建位置:（本机 / GitHub Actions / ___）；私钥注入:（环境变量 / CI Secret / ___）
```

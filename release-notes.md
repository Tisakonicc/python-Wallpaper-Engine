把 Wallpaper Engine 的壁纸搬进 IDE：视频 / 场景 / 网页壁纸都能动，带壁纸原声，支持 `.mpkg` / `.pkg`
导入导出分享。全程本机运行，不联网、不上传数据。

v0.4.13 集中修解码状态：**硬解判断不再误判成软解**，徽章补上了此前没说明的「未连接」和
「不适用」，多窗口 / 扩展宿主重启后也会自动恢复。

![Trae CN 中的壁纸背景](https://raw.githubusercontent.com/Tisakonicc/python-Wallpaper-Engine/main/docs/images/hero-trae.png)

## 一眼对比

| 0.4.12 | 0.4.13 |
| --- | --- |
| 用自造 H.264 样本让 WebCodecs 实测，样本被 Chromium 判为 `Unsupported configuration` 时一律显示「软解」 | 改用 `navigator.mediaCapabilities.decodingInfo` 的 `powerEfficient`，由浏览器自己的解码能力表判断；旧内核才退回 WebCodecs |
| 探测结果没送到面板时只显示一个「—」，悬停才解释 | 明确显示「未连接」，点重载或等 15 秒自动重报 |
| 网页 / 场景壁纸也显示「检测中 / 软解」，让人误以为当前画面在软解 | 非视频壁纸显示「不适用」，说明它不经过视频解码 |
| 多窗口下非服务属主窗口永远停在「—」 | 从 `/state.json` 同步状态，8 秒内补齐 |
| `diag.log` 无限增长（本机已 101 MB） | 超过 8 MB 自动轮转为 `diag.log.1` |

四种徽章状态：

![解码状态徽章](https://raw.githubusercontent.com/Tisakonicc/python-Wallpaper-Engine/main/docs/images/decode-badge.png)

## 修复

- **硬解误判**：此前探针是一段 16×16、Annex-B、不带 `description` 的 H.264 样本。部分 Chromium / Electron
  会拒绝这个配置（`decoder-error: Unsupported configuration`），导致所有机器都显示「软解」。现在优先用
  MediaCapabilities 的 `powerEfficient` 判断，并按 1080p High / 720p Main 两个常见档次查询；只有旧内核
  没有该 API 时才走 WebCodecs。
- **「未连接」不是硬解也不是软解**：它是探测结果没送到面板时的兜底状态。渲染页现在每 15 秒重报一次
  缓存结果，扩展宿主重启后能自己恢复，不必再手动重载。
- **多窗口徽章不同步**：`onHwState` 只推给起本地服务的那个扩展宿主，其它窗口收不到。现在非属主窗口
  会定期从 `/state.json` 读取 `hwDecode`。
- **非视频壁纸的无效状态**：当前壁纸是场景 / 网页 / 图片时显示「不适用」，不再让「软解」看起来像是
  当前画面正在软解。
- **诊断日志膨胀**：`diag.log` 超过 8 MB 自动轮转，最多保留一份旧的 `diag.log.1`；超过 32 MB 的旧文件直接清空。

## 安装

**方式一：VSIX（Trae CN / VS Code / VSCodium 通用）**

1. 下载下方 `background-wallpaper-engine-0.4.13.vsix`；
2. 扩展面板右上角 `···` → **从 VSIX 安装**（也可直接把 vsix 拖进扩展面板）；
3. **完全退出 IDE 再打开**一次，让扩展完成首次注入。

**方式二：市场安装**

- VS Code：[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=tisakonicc.background-wallpaper-engine)
- Open VSX（VSCodium / Theia / code-server / Gitpod）：

```bash
codium --install-extension tisakonicc.background-wallpaper-engine
```

## 附件

| 文件 | 用途 |
| --- | --- |
| `background-wallpaper-engine-0.4.13.vsix` | VS Code / Trae CN / VSCodium 通用 |

SHA-256：

```
1796DC4745E562B102BCE6EBB3171A84DD68A61D679F183A9A39F340977181AF
```

## 说明

- 扩展通过注入 `workbench.html` 实现背景与音频，属非官方实现；采用两步注入后不再出现完整性提示，
  面板底部「移除注入」可逐字节还原。
- 与 Trae、Steam、Wallpaper Engine 均无隶属关系；壁纸及音乐版权归原作者所有。
- PyCharm 插件本次无变化，仍是 [`pycharm-v0.9.24`](https://github.com/Tisakonicc/python-Wallpaper-Engine/releases/tag/pycharm-v0.9.24)。

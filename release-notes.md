把 Wallpaper Engine 的壁纸搬进 IDE：视频 / 场景 / 网页壁纸都能动，带壁纸原声，支持 `.mpkg` / `.pkg`
导入导出分享。全程本机运行，不联网、不上传数据。

v0.4.14 针对 **Trae 的启动链路**：同时开着 Trae / VS Code 时，不再反复撞错端口、每个端口干等 4 秒；
背景出现更快，换端口也更稳。

![Trae CN 中的壁纸背景](https://raw.githubusercontent.com/Tisakonicc/python-Wallpaper-Engine/main/docs/images/hero-trae.png)

## 一眼对比

| 0.4.13 | 0.4.14 |
| --- | --- |
| 撞到另一个 IDE 占用的端口，要等 4 秒超时才换 | 服务回一个会立刻 `postMessage` 的小页面，注入脚本马上换端口 |
| 每轮都可能再撞一次 32123 | 已确认「别人的 / 不通」的端口进入本轮黑名单，30 秒后才重试 |
| 渲染页已经 boot、但 `/state` 还没返回时，4 秒就判死换端口 | 确认端口正确后额外等 15 秒，不再把正在扫描壁纸库的服务换掉 |
| `/health` 探活最多等 1.5 秒/端口 | 降到 0.6 秒 |
| 旧导航迟到的 boot 可能误触发等待 | boot 带回导航序号，过期消息直接丢弃 |

日志里出现过 `a=12`（连续 12 次导航才连上），主要就是上面几项叠加造成的。这次改完后，错误端口
通常在几十毫秒内被排除，正确端口一旦 boot 就不会被误换。

## 改动

- **错误端口立即切换**：`/render/live.html` 检测到 `app` 不匹配时，不再回纯文本 404，而是返回一个
  会 `parent.postMessage({type:'wrongApp', port})` 的小页面；注入脚本收到后立刻 `advance()`。
- **端口黑名单**：本轮启动记住已确认的错误端口，`nextLivePortIndex()` 跳过它们；30 秒后自动解除，
  避免扩展宿主晚启动时无意义地反复重试。
- **boot 后等待 `/state`**：已经收到渲染页 boot 说明端口选对了，只是壁纸库还在扫描；这时额外等 15 秒，
  不再 4 秒就换端口。
- **探活提速**：`probeServer(port, appKey, 600)` 替代默认 1.5 秒，Trae 冷启动每个端口最多少等 0.9 秒。
- **boot 带序号**：live.js 从 URL 读取 `a` 并回传，runtime 只接受当前导航的 boot，丢掉迟到消息。

## 安装

**方式一：VSIX（Trae CN / VS Code / VSCodium 通用）**

1. 下载下方 `background-wallpaper-engine-0.4.14.vsix`；
2. 扩展面板右上角 `···` → **从 VSIX 安装**（也可直接把 vsix 拖进扩展面板）；
3. **完全退出 IDE 再打开**一次，让扩展完成首次注入。

> 本次 `RUNTIME_REV` 从 4 升到 5，注入脚本本身有变化；已装过旧版的用户升级后需要**重载一次窗口**
> 完成重注入。之后普通升级不会再改写 `workbench.html`。

**方式二：市场安装**

- VS Code：[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=tisakonicc.background-wallpaper-engine)
- Open VSX（VSCodium / Theia / code-server / Gitpod）：

```bash
codium --install-extension tisakonicc.background-wallpaper-engine
```

## 附件

| 文件 | 用途 |
| --- | --- |
| `background-wallpaper-engine-0.4.14.vsix` | VS Code / Trae CN / VSCodium 通用 |

SHA-256：

```
ABB70EE7C02F76E61F81ADD41B508BF7F1301316197A5EA3E7976675BC7491DD
```

## 说明

- 扩展通过注入 `workbench.html` 实现背景与音频，属非官方实现；采用两步注入后不再出现完整性提示，
  面板底部「移除注入」可逐字节还原。
- 与 Trae、Steam、Wallpaper Engine 均无隶属关系；壁纸及音乐版权归原作者所有。
- PyCharm 插件本次无变化，仍是 [`pycharm-v0.9.24`](https://github.com/Tisakonicc/python-Wallpaper-Engine/releases/tag/pycharm-v0.9.24)。

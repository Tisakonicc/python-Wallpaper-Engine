把 Wallpaper Engine 的壁纸搬进 IDE：视频 / 场景 / 网页壁纸都能动，带壁纸原声，支持 `.mpkg` / `.pkg`
导入导出分享。全程本机运行，不联网、不上传数据。

v0.4.16 修复一个音频残留问题：**切换壁纸后，上一张网页壁纸的音乐还在播**。

![Trae CN 中的壁纸背景](https://raw.githubusercontent.com/Tisakonicc/python-Wallpaper-Engine/main/docs/images/hero-trae.png)

## 原因

网页壁纸的 BGM 在 iframe 里，但引擎会用父窗口的 `AudioContext` +
`createMediaElementSource` 把音频接进频谱分析图。这个音频图会持有媒体元素：
换壁纸时只移除 iframe，元素虽然不在 DOM 里，音频图仍然能让它继续出声，所以「魔王追悼」的
`bgm-suo-nian.mp3` 会在切换后继续播。

## 一眼对比

| 0.4.15 | 0.4.16 |
| --- | --- |
| 换壁纸时直接 `media.textContent = ''` 拆 iframe | 拆 iframe 前先停掉旧 iframe 内所有媒体 |
| 只处理 `current.video` / `current.audio` | 额外处理 `<audio>`、`<video>` 和 `new Audio()` 创建的实例 |
| 引擎父层音频图仍可能持有旧元素 | 对每个元素执行 `pause()`、`muted`、`volume=0`、清空 `src`、`load()` |
| 渲染失败回退时也可能残留声音 | 回退路径同样先停音频 |

## 改动

- 新增 `hardStopMedia(el)`：`pause()` + 静音 + 清空 `src` + 移除 `<source>` + `load()`。
- 新增 `stopWebMedia()`：在拆 iframe 前遍历旧 iframe 内的媒体元素和 `win.__bgweAudios`，
  再停掉 `media` 容器上引擎挂的音频。
- `destroyCurrent()` 和 `fallback()` 都先调用 `stopWebMedia()`，再销毁渲染实例。

## 安装

**方式一：VSIX（Trae CN / VS Code / VSCodium 通用）**

1. 下载下方 `background-wallpaper-engine-0.4.16.vsix`；
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
| `background-wallpaper-engine-0.4.16.vsix` | VS Code / Trae CN / VSCodium 通用 |

SHA-256：

```
773AD1F41E2B85FA47D78C5F140C8B6AA4960EE077472DBE725334D38EAC3D06
```

## 说明

- 本次 `live.js` 有变化；已装旧版的用户升级后重载一次窗口（或切换一次壁纸）即可用上新逻辑。
- PyCharm 插件本次无变化，仍是 [`pycharm-v0.9.24`](https://github.com/Tisakonicc/python-Wallpaper-Engine/releases/tag/pycharm-v0.9.24)。

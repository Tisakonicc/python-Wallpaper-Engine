把 Wallpaper Engine 的壁纸搬进 IDE：视频 / 场景 / 网页壁纸都能动，带壁纸原声，支持 `.mpkg` / `.pkg`
导入导出分享。全程本机运行，不联网、不上传数据。

v0.4.15 处理 **网页壁纸卡顿**：4K 底图 + 全屏模糊 + 粒子 canvas 的壁纸，在核显机器上会把 GPU
吃满，连带 IDE 一起卡。现在会自适应降载，优先保住编辑器手感。

![Trae CN 中的壁纸背景](https://raw.githubusercontent.com/Tisakonicc/python-Wallpaper-Engine/main/docs/images/hero-trae.png)

## 为什么「魔王追悼」会卡

以这张壁纸为例，它的负载主要来自：

- 3840×2151 的 4K 底图，两套图层叠放；
- 整屏 `blur(26px)` 柔光层、`blur(46px)` 光束、`blur(30px)` 扫光，配合 `mix-blend-mode: screen/overlay`；
- canvas 按 `devicePixelRatio` 渲染，最多 560 个粒子（默认密度 60% ≈ 336 个），每个用大尺寸贴图、
  `globalCompositeOperation='lighter'` 叠加，部分画 2–3 次；
- 120Hz 物理步长、9 MB MP3 BGM 和音频律动；
- 在 2880×1800 / 200% 缩放下，canvas 实际是 2880×1800，再叠加三层全屏模糊，核显填充率和显存带宽很容易见底。

更关键的是：Wallpaper Engine 把它放在独立桌面层，别的程序最大化时可以暂停；这里是 **IDE 窗口内的一层
iframe**，每一帧都要和编辑器 UI 一起合成，所以壁纸掉帧时打字、滚动也会跟着卡。

## 一眼对比

| 0.4.14 | 0.4.15 |
| --- | --- |
| 网页壁纸一直按 `devicePixelRatio` 全分辨率渲染，卡了也不管 | 统计 iframe 真实帧率，连续两轮低于 45fps 时 DPR 降到 1，canvas 像素数降到 1/4 |
| 降完 DPR 仍卡时没有进一步动作 | 仍低于 38fps 时把 rAF 限到约 30fps |
| 最小化时浏览器限帧也可能被误判成卡顿 | 只在壁纸可见、未暂停时判断 |
| 画质可能来回跳 | 一旦降载，本次页面生命周期内不再回升 |

## 改动

- 在网页壁纸 iframe 的 `requestAnimationFrame` 外再包一层：按时间戳去重统计真实帧率，同帧多个回调只算一帧。
- 连续两轮低于 45fps：`Object.defineProperty(win, 'devicePixelRatio', {get: () => 1})` 并派发 `resize`，
  壁纸自己的 canvas 重建为 1× 分辨率。
- 仍低于 38fps：把 rAF 限到约 30fps；同一帧的多个回调一起放行，避免多个循环互相饿死。
- 只在 `shouldPlay()` 为真时判断；降载后不恢复，防止画质来回跳。
- 降载会写一条 `web-perf` 诊断（`dpr1` / `30fps`），可在输出面板查看。

## 安装

**方式一：VSIX（Trae CN / VS Code / VSCodium 通用）**

1. 下载下方 `background-wallpaper-engine-0.4.15.vsix`；
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
| `background-wallpaper-engine-0.4.15.vsix` | VS Code / Trae CN / VSCodium 通用 |

SHA-256：

```
102FB911CA15D4FF2B50C8C3F9C334B671242C343F8A416D9A1CE33DFE4C7EAF
```

## 说明

- 自适应降载只作用于网页壁纸；视频 / 场景壁纸仍按原有 FPS 设置播放。
- 如果还想更省资源，可以把壁纸自身的 Density 调低、Grain 关掉、Audio Reactive 关掉，并更新核显驱动。
- PyCharm 插件本次无变化，仍是 [`pycharm-v0.9.24`](https://github.com/Tisakonicc/python-Wallpaper-Engine/releases/tag/pycharm-v0.9.24)。

# python-Wallpaper-Engine

把 **Steam Wallpaper Engine** 的壁纸（视频 / 场景 / 网页）以及本地导入的视频、图片渲染成 IDE 编辑器背景。全部在本机运行，不上传任何数据。

本仓库同时维护两个 IDE 的插件实现：

| 目录 | 目标 IDE | 形态 | 状态 |
| --- | --- | --- | --- |
| [trae-extension/](trae-extension/) | Trae CN（VS Code 内核） | VS Code 扩展（vsix） | v0.2.1 · [Open VSX](https://open-vsx.org/extension/tisakonicc/background-wallpaper-engine) |
| [pycharm-plugin/](pycharm-plugin/) | PyCharm 2024.1（IntelliJ 平台） | Gradle 插件（zip） | v0.2.0 |

## Trae CN 扩展（trae-extension）

- 状态栏按钮弹出壁纸面板：缩略图网格、类型筛选、搜索、即点即换
- 视频 / 场景（webwallgl WebGL 渲染）/ 网页 / 图片四类壁纸
- 外部导入本地视频、图片，不复制文件
- 不透明度、压暗层、模糊、饱和度、缩放方式实时调节
- 自动探测 Steam 库（注册表 + `libraryfolders.vdf`）
- 通过注入 `workbench.html` 实现，可一键逐字节还原

详细文档见 [trae-extension/README.md](trae-extension/README.md)。

## PyCharm 插件（pycharm-plugin）

- 右侧「壁纸」工具窗口：缩略图网格面板，点卡片切换壁纸
- JCEF 内嵌浏览器挂在编辑器 `JLayeredPane` 最底层显示背景，**不修改 IDE 安装目录的任何文件**，关闭插件即完全恢复
- 本地 `127.0.0.1` HTTP 服务提供壁纸文件（支持 Range 206 视频流）
- 设置页（`Settings → 工具 → 壁纸背景`）：启用开关、壁纸下拉、不透明度 / 填充 / 模糊、导入本地文件、重新扫描

### 构建

```powershell
$env:JAVA_HOME="D:\PyCharm 2024.1.7\jbr"
gradle -p pycharm-plugin buildPlugin
```

产物在 `pycharm-plugin/build/distributions/`，经 `Settings → Plugins → ⚙ → Install Plugin from Disk...` 安装。

### v0.2.0 修复记录

之前背景一直不显示，根因是两处：

1. **层级放错**：`JLayeredPane` 同一层里是「后添加的组件画在上面」，而 `contentPane` 已经占着
   `FRAME_CONTENT_LAYER`。原来又把壁纸层加到同一层，结果壁纸盖在 IDE 上面（或者反过来被整块盖掉）。
   现在壁纸层固定放在 `FRAME_CONTENT_LAYER - 1`，保证绘制顺序在 `contentPane` 之前。
2. **编辑器不透明**：`EditorComponentImpl` 画背景用的是 Swing 组件自己的 `getBackground()`，
   只改 colors scheme 的 `HighlighterColors.TEXT` 属性没有效果。现在同时把 `rootPane` / `contentPane` /
   编辑器组件链设为非不透明，并把编辑器组件背景换成带 alpha 的颜色，壁纸才透得出来。

另外修掉：重复挂载时 `ComponentListener` 越加越多、卸载后编辑器背景色没有还原、
透明化后拖动窗口留下残影（加了低频重绘兜底）。

## 环境要求

- Windows（Steam 探测依赖注册表）
- 已安装 Steam 与 Wallpaper Engine，并订阅了至少一个壁纸（或直接导入本地文件）

## 隐私与安全

- 本地 HTTP 服务只监听 `127.0.0.1`，不对外网开放
- 不收集、不上传任何数据
- 只读取 Steam 壁纸目录与导入的文件，不修改、不复制、不删除它们

## 致谢

- 场景壁纸渲染依赖 [webwallgl](https://www.npmjs.com/package/webwallgl)
- 思路参考 [dsh-wallpaper-engine](https://github.com/Fish-under-sea/dsh-wallpaper-engine)

许可证：MIT · 作者：Tisako

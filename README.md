# python-Wallpaper-Engine

把 **Steam Wallpaper Engine** 的壁纸（视频 / 场景 / 网页）以及本地导入的视频、图片渲染成 IDE 编辑器背景。全部在本机运行，不上传任何数据。

本仓库同时维护两个 IDE 的插件实现：

| 目录 | 目标 IDE | 形态 | 状态 |
| --- | --- | --- | --- |
| [trae-extension/](trae-extension/) | Trae CN（VS Code 内核） | VS Code 扩展（vsix） | v0.2.2 · [Open VSX](https://open-vsx.org/extension/tisakonicc/background-wallpaper-engine) |
| [pycharm-plugin/](pycharm-plugin/) | PyCharm 2024.1（IntelliJ 平台） | Gradle 插件（zip） | v0.6.0 |

## 下载安装（Trae CN / VS Code 通用）

1. 到 [Releases](https://github.com/Tisakonicc/python-Wallpaper-Engine/releases/latest) 下载 `background-wallpaper-engine-x.y.z.vsix`；
2. 打开 IDE 的扩展面板，点右上角 `···` → **从 VSIX 安装**（也可以直接把 vsix 拖进扩展面板）；
3. **完全退出 IDE 再重新打开**，让扩展完成首次注入。

> Trae CN 的扩展市场与 VS Code 官方市场都**不收录**本扩展，在 IDE 里搜名字是搜不到的。Open VSX 生态（VSCodium / Theia / code-server）可以直接搜 `tisakonicc`。

## Trae CN 扩展（trae-extension）

- 状态栏按钮弹出壁纸面板：缩略图网格、类型筛选、搜索、即点即换
- 视频 / 场景（webwallgl WebGL 渲染）/ 网页 / 图片四类壁纸
- 外部导入本地视频、图片，不复制文件
- 不透明度、压暗层、模糊、饱和度、缩放方式实时调节
- 自动探测 Steam 库（注册表 + `libraryfolders.vdf`）
- 通过注入 `workbench.html` 实现，可一键逐字节还原

详细文档见 [trae-extension/README.md](trae-extension/README.md)。

## PyCharm 插件（pycharm-plugin）

- **整窗壁纸**：项目树、工具栏、编辑器、状态栏全部透出背景
- 基于平台自带的背景图机制（`IdeBackgroundUtil.createTemporaryBackgroundTransform`），平台会把界面内容按透明度绘制
- **不修改任何组件的 opaque / 背景色**，背景挂在 `Disposable` 上，禁用或卸载插件时 dispose 即完全还原
- 右侧「壁纸」工具窗口：缩略图网格 + **不透明度 / 背景虚化 / 代码区压暗 / 填充方式** 四个实时调节项，拖动即生效
- 设置页（`Settings → 工具 → 壁纸背景`）：启用开关、壁纸下拉、不透明度、导入本地文件、重新扫描

### 兼容性声明

**与 Material Theme UI（完整版）存在冲突，请不要同时启用。**

Material Theme UI 会接管界面背景与组件绘制的控制权，覆盖本插件的背景层，表现为壁纸不显示、
只显示一部分、或被主题的深色底整块盖住。冲突已在 **Material Theme UI 9.3.1** 上确认。

处理方式：二选一 —— 禁用 Material Theme UI，或在「壁纸」面板里关闭壁纸。
Material Theme UI **Lite** 只调整配色、不接管组件绘制，理论上影响更小，但未逐一验证。
### 已知限制

平台的背景变换在创建时就会把图像**快照**下来，替换图像内容不会刷新，因此目前只能显示静态画面 ——
视频 / 场景 / 网页类壁纸统一取其预览帧。真要做成动态，需要自己接管玻璃窗格的绘制，不在当前实现范围内。

### 构建

```powershell
$env:JAVA_HOME="D:\PyCharm 2024.1.7\jbr"
gradle -p pycharm-plugin buildPlugin
```

产物在 `pycharm-plugin/build/distributions/`，经 `Settings → Plugins → ⚙ → Install Plugin from Disk...` 安装。

### v0.6.0 重写记录

早期版本试图把 JCEF 浏览器垫在 IDE 组件下面，但 IntelliJ 的窗口和编辑器会用 `UIUtil.getPanelBackground()`
这类**常量**直接刷不透明底色，既不看 `setOpaque(false)` 也不看组件背景色，所以每条路都被那层底色挡住。

v0.6.0 改为复用平台自己的「背景图像」能力：`IdeBackgroundUtil.createTemporaryBackgroundTransform()`
内部用 `ADJUST_ALPHA` 渲染提示把整个界面按透明度绘制，因此背景能透到所有面板后面，而且
关闭时只需 dispose 对应的 `Disposable`，界面即恢复原样（实测禁用前后像素差异 0.02%，仅光标/时钟）。

同时删除了此前所有「改组件透明性」的临时代码、JCEF 背景层、以及诊断接口。

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

许可证：MIT · 作者：Tisakonicc

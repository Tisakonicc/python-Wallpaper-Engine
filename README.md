# python-Wallpaper-Engine

把 **Steam Wallpaper Engine** 的壁纸（视频 / 场景 / 网页）以及本地导入的视频、图片渲染成 IDE 编辑器背景。全部在本机运行，不上传任何数据。

本仓库同时维护两个 IDE 的插件实现：

| 目录 | 目标 IDE | 形态 | 状态 |
| --- | --- | --- | --- |
| [trae-extension/](trae-extension/) | Trae CN（VS Code 内核） | VS Code 扩展（vsix） | v0.2.1 |
| [pycharm-plugin/](pycharm-plugin/) | PyCharm 2024.1（IntelliJ 平台） | Gradle 插件（zip） | v0.1.2 |

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

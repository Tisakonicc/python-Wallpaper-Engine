# Background-Wallpaper-Engine

把 **Steam Wallpaper Engine** 的壁纸（视频 / 场景 / 网页）以及**本地导入的视频、图片**渲染成 Trae CN（VS Code 内核 IDE）的背景层。全部在本机运行，不上传任何数据。

- 作者：Tisako
- 版本：0.2.1
- 许可证：MIT

---

## 功能特性

- **壁纸面板**：点击状态栏右侧的「壁纸」按钮即可打开，顶部显示当前壁纸（缩略图、标题、类型、播放状态），支持暂停 / 刷新 / 清除。
- **缩略图网格**：按「视频 / 场景 / 网页 / 图片」筛选，支持关键词搜索，点一下就切换。
- **外部导入**：可把任意本地视频、动图、图片当作壁纸，**不复制文件**，只记录路径；导入项右上角 `×` 可移除（不会删除源文件）。
- **视觉调节**：不透明度、压暗层、模糊、饱和度、缩放方式（铺满 / 完整 / 拉伸）实时生效。
- **播放控制**：场景 / 网页壁纸可选 30 / 60 FPS；窗口失焦时自动暂停以省电。
- **自动探测 Steam 库**：读取注册表与 `libraryfolders.vdf`，多磁盘库也能找到；也可手动指定 Steam 目录。
- **多窗口共用**：第一个窗口启动本地渲染服务，其它窗口自动复用；服务消失后会自动接管。
- **可完整还原**：面板底部「移除注入」会把 `workbench.html` 逐字节还原到注入前状态。

## 环境要求

- Windows（Steam 探测依赖注册表）
- Trae CN 或 VS Code 1.82 及以上（桌面版）
- 已安装 Steam 与 Wallpaper Engine，并订阅了至少一个壁纸（或直接使用本地导入）

## 安装

```powershell
"D:\trae\Trae CN\bin\trae-cn.cmd" --install-extension background-wallpaper-engine-0.2.0.vsix --force
```

安装后**完全退出 IDE 再重新打开**（不是重载窗口），让扩展完成首次注入。

## 使用

1. 点击状态栏右下角的 `壁纸` 按钮（或按 `Ctrl+Shift+P` 执行「打开壁纸面板」）。
2. 在「壁纸」标签页挑选缩略图，背景立即切换。
3. 「外观」「播放」标签页里的滑块可以直接微调观感。
4. 想用本地文件：点「导入…」，选择视频或图片，导入后会直接应用。

状态栏的 `背景：开 / 关` 按钮可以快速暂停或恢复显示，不会撤销注入。

## 支持的类型

| 类型 | 说明 |
| --- | --- |
| video | `.mp4` `.webm` `.mov` `.m4v`（`.mkv` 因 Chromium 不支持 Matroska 会黑屏，未纳入） |
| image | `.gif` `.apng` `.webp` 以及导入的 `.png` `.jpg` `.jpeg` `.bmp` `.avif` |
| web | 壁纸目录中的 `index.html` |
| scene | 通过 WebGL 运行时（`webwallgl`）渲染的场景壁纸 |

> 场景壁纸由第三方运行时解释执行，复杂着色器可能存在兼容性问题；遇到无法渲染的场景壁纸建议换用视频版本。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `backgroundWallpaperEngine.enabled` | `true` | 是否显示背景 |
| `backgroundWallpaperEngine.wallpaperId` | 空 | 当前壁纸 ID（由面板写入，无需手改） |
| `backgroundWallpaperEngine.steamRoot` | 空 | Steam 安装目录，留空自动探测 |
| `backgroundWallpaperEngine.opacity` | `0.45` | 壁纸不透明度 |
| `backgroundWallpaperEngine.scrim` | `0.45` | 壁纸与 UI 之间的压暗层，保证文字可读 |
| `backgroundWallpaperEngine.blur` | `0` | 模糊半径（0–40 px） |
| `backgroundWallpaperEngine.saturate` | `1` | 饱和度（0 为灰度，最大 3） |
| `backgroundWallpaperEngine.fit` | `cover` | `cover` / `contain` / `fill` |
| `backgroundWallpaperEngine.fps` | `60` | 场景 / 网页壁纸帧率 |
| `backgroundWallpaperEngine.pauseOnBlur` | `true` | 失焦暂停播放 |

## 关于“安装似乎损坏”

IDE 会在启动时校验 `workbench.html` 的哈希，注入背景层后就会提示“安装似乎损坏”。本扩展的处理方式是：**从 `product.json` 的 `checksums` 中移除 `workbench.html` 这一项**，让该文件不再参与完整性校验。

- 这一操作只影响这一个文件，其余校验项保持不变；
- 校验清单只在 IDE 启动时读取，所以注入后的**第一次**启动可能仍会提示一次，**完全退出再打开**后即永久消失；
- 点「移除注入」时会把校验项按还原后的真实内容补回；
- IDE 自身升级覆盖安装目录后，扩展会在下次启动时自动重新注入并再次脱钩。

## 隐私与安全

- 本地 HTTP 服务只监听 `127.0.0.1`，端口为 32123–32125，不对外网开放；
- 不收集、不上传任何数据，不访问网络（除加载本机壁纸文件）；
- 只读取 Steam 壁纸目录与导入的文件，不修改、不复制、不删除它们；
- 浏览器的同源限制 + 目录越权检查（403）确保导入项只能读取自己那个文件。

## 卸载与还原

1. 打开面板 → 底部「移除注入」，把 `workbench.html` 还原；
2. 完全退出 IDE；
3. 在扩展页卸载本扩展。

还原的备份文件位于 `resources/app/out/vs/code/electron-browser/workbench/` 下，形如 `workbench.html.backgroundcover-<哈希>.bak`。

## 致谢

- 场景壁纸渲染依赖 [webwallgl](https://www.npmjs.com/package/webwallgl)
- 思路参考 [dsh-wallpaper-engine](https://github.com/Fish-under-sea/dsh-wallpaper-engine)

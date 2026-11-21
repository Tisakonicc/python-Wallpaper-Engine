# GitHub 文案（仓库 About + Release v0.4.16）

---

## 一、仓库 About（右侧 About 面板）

**Description**（≤ 350 字符，直接粘贴）

```
把 Steam Wallpaper Engine 的壁纸搬进 IDE：视频 / 场景 / 网页壁纸、壁纸原声、硬解状态徽章、场景包导入导出分享。VS Code 扩展 + PyCharm 插件，全程本机运行，不联网。
```

**Website**

```
https://marketplace.visualstudio.com/items?itemName=tisakonicc.background-wallpaper-engine
```

**Topics**

```
wallpaper-engine  vscode-extension  ide  wallpaper  background  pycharm-plugin  trae  steam
```

---

## 二、Release 信息

| 字段 | 值 |
| --- | --- |
| Tag | `trae-v0.4.16` |
| Release title | `Trae / VS Code 扩展 v0.4.16` |
| 附件 | `background-wallpaper-engine-0.4.16.vsix` |
| SHA-256 | `773AD1F41E2B85FA47D78C5F140C8B6AA4960EE077472DBE725334D38EAC3D06` |
| 正文 | 直接使用 [`release-notes.md`](release-notes.md) |
| 勾选 | Set as the latest release |

本次只修网页壁纸切换后的音频残留，PyCharm 插件保持 `pycharm-v0.9.24` 不变。

---

## 三、Release 正文

直接复制 [`release-notes.md`](release-notes.md)，其中包含：

- 为什么只移除 iframe 停不掉旧 BGM（父窗口 `AudioContext` + `createMediaElementSource` 持有元素）；
- 0.4.15 → 0.4.16 对比；
- `hardStopMedia()` / `stopWebMedia()` 的停止流程；
- VSIX / 市场两种安装方式。

---

## 四、发布命令

```powershell
cd d:\pycharm\PycharmProjects\Background-Wallpaper-Engine\trae-extension

node -e "console.log(require('./package.json').version)"
npm run package
Get-FileHash background-wallpaper-engine-0.4.16.vsix -Algorithm SHA256 | ForEach-Object Hash

gh release create trae-v0.4.16 background-wallpaper-engine-0.4.16.vsix `
  --title "Trae / VS Code 扩展 v0.4.16" `
  --notes-file ..\release-notes.md `
  --latest
```

发布后同步更新：

1. 根 `README.md` 直链（指向 `trae-v0.4.16`）；
2. VS Code Marketplace 与 Open VSX 的版本。

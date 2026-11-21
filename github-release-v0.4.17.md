# GitHub 文案（仓库 About + Release v0.4.17）

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
| Tag | `trae-v0.4.17` |
| Release title | `Trae / VS Code 扩展 v0.4.17` |
| 附件 | `background-wallpaper-engine-0.4.17.vsix` |
| SHA-256 | `5FF3BE8B5C91991E731558642B7F69C0C71A7077FBFFF5F2F924AAA9DE443FCE` |
| 正文 | 直接使用 [`release-notes.md`](release-notes.md) |
| 勾选 | Set as the latest release |

本次调整网页壁纸降载时机，并裁剪空闲资源；PyCharm 插件保持 `pycharm-v0.9.24` 不变。

---

## 三、Release 正文

直接复制 [`release-notes.md`](release-notes.md)，其中包含：

- 为什么刚切换网页壁纸会卡一下、旧逻辑如何误触发降载；
- 0.4.16 → 0.4.17 对比（3 秒预热、连续三轮、30fps 仅作最后手段）；
- 空闲定时器、`diag.log`、`product.json` 读写的裁剪；
- 新增 `src/ide.js` 适配层；
- VSIX / 市场两种安装方式。

---

## 四、发布命令

```powershell
cd d:\pycharm\PycharmProjects\Background-Wallpaper-Engine\trae-extension

node -e "console.log(require('./package.json').version)"
npm run package
Get-FileHash background-wallpaper-engine-0.4.17.vsix -Algorithm SHA256 | ForEach-Object Hash

gh release create trae-v0.4.17 background-wallpaper-engine-0.4.17.vsix `
  --title "Trae / VS Code 扩展 v0.4.17" `
  --notes-file ..\release-notes.md `
  --latest
```

发布后同步更新根 `README.md` 直链与两个市场的版本。

# GitHub 文案（仓库 About + Release v0.4.14）

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
| Tag | `trae-v0.4.14` |
| Release title | `Trae / VS Code 扩展 v0.4.14` |
| 附件 | `background-wallpaper-engine-0.4.14.vsix` |
| SHA-256 | `ABB70EE7C02F76E61F81ADD41B508BF7F1301316197A5EA3E7976675BC7491DD` |
| 正文 | 直接使用 [`release-notes.md`](release-notes.md) |
| 勾选 | Set as the latest release |

本次只改 Trae 启动链路，PyCharm 插件保持 `pycharm-v0.9.24` 不变。

---

## 三、Release 正文

直接复制 [`release-notes.md`](release-notes.md)，其中包含：

- 0.4.13 → 0.4.14 逐项对比表；
- 错误端口立即切换、端口黑名单、boot 后等待 `/state` 的说明；
- `RUNTIME_REV` 升到 5，升级后需重载一次窗口；
- VSIX / 市场两种安装方式。

---

## 四、发布命令

```powershell
cd d:\pycharm\PycharmProjects\Background-Wallpaper-Engine\trae-extension

# 1. 确认版本号为 0.4.14
node -e "console.log(require('./package.json').version)"

# 2. 打包
npm run package

# 3. 计算 SHA-256（填入 release-notes.md）
Get-FileHash background-wallpaper-engine-0.4.14.vsix -Algorithm SHA256 | ForEach-Object Hash

# 4. 创建 Release
gh release create trae-v0.4.14 background-wallpaper-engine-0.4.14.vsix `
  --title "Trae / VS Code 扩展 v0.4.14" `
  --notes-file ..\release-notes.md `
  --latest
```

发布后建议同步更新：

1. 根 `README.md` 的直链（指向 `trae-v0.4.14`）；
2. VS Code Marketplace 与 Open VSX 的版本（同一份 vsix 上传即可）。

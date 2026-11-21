# GitHub 文案（仓库 About + Release v0.4.15）

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
| Tag | `trae-v0.4.15` |
| Release title | `Trae / VS Code 扩展 v0.4.15` |
| 附件 | `background-wallpaper-engine-0.4.15.vsix` |
| SHA-256 | `102FB911CA15D4FF2B50C8C3F9C334B671242C343F8A416D9A1CE33DFE4C7EAF` |
| 正文 | 直接使用 [`release-notes.md`](release-notes.md) |
| 勾选 | Set as the latest release |

本次只改网页壁纸渲染负载，PyCharm 插件保持 `pycharm-v0.9.24` 不变。

---

## 三、Release 正文

直接复制 [`release-notes.md`](release-notes.md)，其中包含：

- 「魔王追悼」这类 4K + 全屏模糊 + 粒子 canvas 壁纸的负载拆解；
- 0.4.14 → 0.4.15 逐项对比表；
- 自适应降载触发条件（45fps → DPR 1，38fps → 30fps）与「只降不升」策略；
- VSIX / 市场两种安装方式。

---

## 四、发布命令

```powershell
cd d:\pycharm\PycharmProjects\Background-Wallpaper-Engine\trae-extension

# 1. 确认版本号为 0.4.15
node -e "console.log(require('./package.json').version)"

# 2. 打包
npm run package

# 3. 计算 SHA-256（填入 release-notes.md）
Get-FileHash background-wallpaper-engine-0.4.15.vsix -Algorithm SHA256 | ForEach-Object Hash

# 4. 创建 Release
gh release create trae-v0.4.15 background-wallpaper-engine-0.4.15.vsix `
  --title "Trae / VS Code 扩展 v0.4.15" `
  --notes-file ..\release-notes.md `
  --latest
```

发布后建议同步更新：

1. 根 `README.md` 的直链（指向 `trae-v0.4.15`）；
2. VS Code Marketplace 与 Open VSX 的版本（同一份 vsix 上传即可）。

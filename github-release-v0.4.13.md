# GitHub 文案（仓库 About + Release v0.4.13）

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
| Tag | `trae-v0.4.13` |
| Release title | `Trae / VS Code 扩展 v0.4.13` |
| 附件 | `background-wallpaper-engine-0.4.13.vsix` |
| SHA-256 | `1796DC4745E562B102BCE6EBB3171A84DD68A61D679F183A9A39F340977181AF` |
| 正文 | 直接使用 [`release-notes.md`](release-notes.md) |
| 勾选 | Set as the latest release |

本次只修扩展侧解码状态，PyCharm 插件保持 `pycharm-v0.9.24` 不变。

---

## 三、Release 正文

直接复制 [`release-notes.md`](release-notes.md)，其中包含：

- 0.4.12 → 0.4.13 逐项对比表；
- 四种解码徽章状态（检测中 / 硬解 / 软解 / 未连接）与「不适用」说明；
- 硬解误判、多窗口同步、`diag.log` 轮转的修复说明；
- VSIX / 市场两种安装方式。

---

## 四、发布命令

```powershell
cd d:\pycharm\PycharmProjects\Background-Wallpaper-Engine\trae-extension

# 1. 确认版本号为 0.4.13
node -e "console.log(require('./package.json').version)"

# 2. 打包
npm run package

# 3. 计算 SHA-256（填入 release-notes.md）
Get-FileHash background-wallpaper-engine-0.4.13.vsix -Algorithm SHA256 | ForEach-Object Hash

# 4. 创建 Release
gh release create trae-v0.4.13 background-wallpaper-engine-0.4.13.vsix `
  --title "Trae / VS Code 扩展 v0.4.13" `
  --notes-file ..\release-notes.md `
  --latest
```

发布后建议同步更新：

1. 根 `README.md` 的直链（指向 `trae-v0.4.13`）；
2. VS Code Marketplace 与 Open VSX 的版本（同一份 vsix 上传即可）。

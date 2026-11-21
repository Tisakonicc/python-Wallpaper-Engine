# Trae / VS Code 扩展 v0.4.14

发布正文统一维护在仓库根目录的 [`release-notes.md`](../release-notes.md)，包含效果图、0.4.13 → 0.4.14
逐项对比、Trae 启动链路改动与安装步骤。本文件保留为扩展目录内的入口，避免两份文案版本不一致。

发布时：

```powershell
gh release create trae-v0.4.14 background-wallpaper-engine-0.4.14.vsix `
  --title "Trae / VS Code 扩展 v0.4.14" `
  --notes-file ..\release-notes.md --latest
```

- 附件：`background-wallpaper-engine-0.4.14.vsix`
- 本次 `RUNTIME_REV` 升到 5，旧版升级后需重载一次窗口
- PyCharm 插件本次无变化：[`pycharm-v0.9.24`](https://github.com/Tisakonicc/python-Wallpaper-Engine/releases/tag/pycharm-v0.9.24)

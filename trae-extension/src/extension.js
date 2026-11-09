'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

const { VERSION, PORT_CANDIDATES } = require('./config');
const { scanLibrary } = require('./scanner');
const { Imports, IMPORT_FILTERS, buildItem } = require('./imports');
const { startServer, probeServer } = require('./server');
const { buildScript } = require('./runtime');
const { WallpaperPanel } = require('./panel');
const patcher = require('./patcher');

const CONFIG_SECTION = 'backgroundWallpaperEngine';
const KIND_LABEL = {
  video: '视频',
  image: '动图',
  web: '网页',
  scene: '场景',
};

let context = null;
let output = null;
let statusBar = null;
let lookBar = null;
let panel = null;
let imports = null;
let library = [];
let server = null;
let serverPort = 0;
let isOwner = false;
let healthTimer = null;

const scopedConfig = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

function log(line) {
  if (output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
}

function currentState() {
  const cfg = scopedConfig();
  const id = String(cfg.get('wallpaperId') || '').trim();
  const item = id ? library.find((entry) => entry.id === id) : null;
  const enabled = !!cfg.get('enabled', true);

  const opacity = Number(cfg.get('opacity', 0.45));
  const scrim = Number(cfg.get('scrim', 0.45));
  const blur = Number(cfg.get('blur', 0));
  const saturate = Number(cfg.get('saturate', 1));
  const fit = cfg.get('fit', 'cover');
  const fps = Number(cfg.get('fps', 60));
  const pauseOnBlur = !!cfg.get('pauseOnBlur', true);

  const origin = serverPort ? `http://127.0.0.1:${serverPort}` : '';
  const wallpaper = item
    ? {
        id: item.id,
        kind: item.kind,
        title: item.title,
        file: item.file,
        base: origin ? `${origin}/wallpapers/${encodeURIComponent(item.id)}/files` : '',
        preview: item.preview
          ? `${origin}/preview/${encodeURIComponent(item.id)}`
          : '',
      }
    : null;

  return {
    enabled,
    wallpaper,
    opacity,
    scrim,
    blur,
    saturate,
    fit,
    fps,
    pauseOnBlur,
    // 配置变了 stamp 才变；渲染页据此跳过无意义的重绘
    stamp: [
      enabled ? 1 : 0,
      id,
      wallpaper ? wallpaper.kind : '',
      opacity,
      scrim,
      blur,
      saturate,
      fit,
      fps,
      pauseOnBlur ? 1 : 0,
    ].join('|'),
    version: VERSION,
  };
}

async function reloadLibrary(notifyEmpty) {
  let scanned = [];
  let roots = [];
  try {
    const result = scanLibrary(String(scopedConfig().get('steamRoot') || ''));
    scanned = result.items;
    roots = result.roots;
    log(`扫描到 ${scanned.length} 个 Steam 壁纸；Steam 库：${roots.join('；') || '（无）'}`);
  } catch (err) {
    log(`扫描壁纸失败：${err && err.message ? err.message : err}`);
  }

  const imported = imports ? imports.list() : [];
  if (imported.length) log(`外部导入 ${imported.length} 个壁纸。`);
  // 导入项排在前面：它们通常是用户刚加的，找起来更顺手
  library = [...imported, ...scanned];

  if (notifyEmpty && !library.length) {
    vscode.window.showWarningMessage(
      '没有找到可用壁纸。请在 Steam 创意工坊订阅壁纸，或用面板里的“导入”选择本地视频 / 图片。'
    );
  }
  return library;
}

/** 选择本地视频 / 图片并登记为壁纸。 */
async function importMedia() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: '用作壁纸',
    filters: IMPORT_FILTERS,
  });
  if (!picked || !picked.length) return;

  const added = await imports.add(picked.map((uri) => uri.fsPath));
  await reloadLibrary(false);
  if (!added.length) {
    vscode.window.showInformationMessage('选中的文件都已导入过，或格式不受支持。');
    pushPanel();
    return;
  }

  // 直接应用刚导入的最后一个（导入即生效），同时确保背景处于开启状态
  const target = buildItem(added[added.length - 1]);
  const cfg = scopedConfig();
  if (target) {
    await cfg.update('wallpaperId', target.id, vscode.ConfigurationTarget.Global);
  }
  if (!cfg.get('enabled', true)) {
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  }
  await sync();
  vscode.window.setStatusBarMessage(`已导入 ${added.length} 个壁纸并应用`, 4000);
}

async function removeImport(id) {
  if (!imports) return;
  const removed = await imports.remove(id);
  if (!removed) return;

  await reloadLibrary(false);
  const cfg = scopedConfig();
  if (String(cfg.get('wallpaperId') || '') === id) {
    await cfg.update('wallpaperId', '', vscode.ConfigurationTarget.Global);
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
  }
  await sync();
}

async function findItem(id) {
  let item = library.find((entry) => entry.id === id);
  if (!item && id) {
    await reloadLibrary(false);
    item = library.find((entry) => entry.id === id);
  }
  return item || null;
}

async function ensureServer() {
  if (server) return true;
  if (vscode.env.uiKind !== vscode.UIKind.Desktop) {
    log('非桌面版 IDE，无法注入 workbench，功能不启用。');
    return false;
  }

  for (const port of PORT_CANDIDATES) {
    // 别的窗口已经起了服务：直接共用，不必再注入一次
    const health = await probeServer(port);
    if (health) {
      serverPort = port;
      isOwner = false;
      log(`复用已存在的本地服务：端口 ${port}`);
      startHealthWatch();
      return true;
    }

    try {
      server = await startServer({
        port,
        getState: currentState,
        getLibrary: () => library,
        assetsRoot: path.join(__dirname, '..', 'assets'),
        onLog: (line) => log(line),
      });
      serverPort = port;
      isOwner = true;
      log(`本地渲染服务已启动：http://127.0.0.1:${port}`);
      server.on('error', (err) => log(`本地服务异常：${err.message}`));
      return true;
    } catch (err) {
      if (!err || err.code !== 'EADDRINUSE') {
        log(`端口 ${port} 启动失败：${err && err.message ? err.message : err}`);
      }
    }
  }

  vscode.window.showErrorMessage(
    `Background-Wallpaper-Engine：本地渲染服务启动失败（端口 ${PORT_CANDIDATES.join(' / ')} 均不可用）。`
  );
  return false;
}

/** 非属主窗口：服务所属窗口关掉后，接管端口，让其它窗口的背景自动恢复。 */
function startHealthWatch() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    if (server) {
      clearInterval(healthTimer);
      healthTimer = null;
      return;
    }
    const health = await probeServer(serverPort || PORT_CANDIDATES[0]);
    if (health) return;
    log('共用的本地服务已消失，尝试接管端口。');
    await ensureServer();
    await sync();
  }, 15000);
}

/**
 * 注入用的脚本与标识。
 *
 * 标识取脚本内容的哈希，而不是版本号：版本号一变就重写 workbench.html，
 * 而每写一次都会让当前会话再弹一次“安装似乎损坏”。内容没变就不必动磁盘。
 */
let patchCache = null;

function patchArtifacts() {
  if (!patchCache) {
    const script = buildScript({ ports: PORT_CANDIDATES, version: VERSION });
    const stamp = crypto.createHash('sha1').update(script).digest('hex').slice(0, 8);
    patchCache = { script, stamp };
  }
  return patchCache;
}

function promptReload(message) {
  vscode.window
    .showInformationMessage(message, '立即重载', '稍后')
    .then((choice) => {
      if (choice === '立即重载') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

async function ensurePatched() {
  const appRoot = vscode.env.appRoot;
  if (!appRoot || !serverPort) return false;

  const { script, stamp } = patchArtifacts();
  if (patcher.isPatched(appRoot, stamp)) {
    repairChecksum(appRoot);
    return true;
  }

  const result = patcher.apply(appRoot, script, stamp);
  if (!result.ok) {
    log(`注入失败：${result.reason}`);
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：注入失败。${result.reason}`);
    return false;
  }

  log(`已注入背景层：${result.target}`);
  if (result.checksum === 'detached' || result.checksum === 'absent') {
    log('已把 workbench.html 从 product.json 的校验清单中移除，之后不会再提示“安装似乎损坏”。');
  }
  promptReload('背景层已注入，重载窗口即可看到背景。若仍提示“安装似乎损坏”，请完全退出 Trae 再重新打开（校验清单只在启动时读取，重载窗口不会重读）。');
  return true;
}

/**
 * 已注入的窗口不会重走 apply，历史上“改了文件但没摘校验项”的状态就一直留着，
 * 表现为每次启动都提示“Trae CN 安装似乎损坏”。这里每次激活都检查一遍。
 */
function repairChecksum(appRoot) {
  try {
    const result = patcher.verifyChecksum(appRoot);
    if (!result.ok) {
      log(`完整性校验处理失败：${result.reason}`);
      return;
    }
    if (result.state === 'detached') {
      log('已把 workbench.html 从 product.json 的校验清单中移除，之后不会再提示“安装似乎损坏”。');
    }
  } catch (err) {
    log(`完整性校验处理异常：${err && err.message ? err.message : err}`);
  }
}

function patchedNow() {
  try {
    if (!serverPort) return false;
    return patcher.isPatched(vscode.env.appRoot, patchArtifacts().stamp);
  } catch {
    return false;
  }
}

function panelState() {
  const s = currentState();
  const origin = serverPort ? `http://127.0.0.1:${serverPort}` : '';
  return {
    enabled: s.enabled,
    current: s.wallpaper
      ? {
          id: s.wallpaper.id,
          kind: s.wallpaper.kind,
          title: s.wallpaper.title,
          thumb: s.wallpaper.preview || '',
        }
      : null,
    items: library.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description || '',
      imported: !!item.imported,
      thumb: item.preview && origin ? `${origin}/preview/${encodeURIComponent(item.id)}` : '',
    })),
    opacity: s.opacity,
    scrim: s.scrim,
    blur: s.blur,
    saturate: s.saturate,
    fit: s.fit,
    fps: s.fps,
    pauseOnBlur: s.pauseOnBlur,
    patched: patchedNow(),
    version: VERSION,
  };
}

/** 外观/播放页里的即时调整，直接写配置，渲染页下一轮轮询就会生效。 */
async function applyVisual(key, value) {
  const allowed = {
    opacity: 'number',
    scrim: 'number',
    blur: 'number',
    saturate: 'number',
    fit: 'string',
    fps: 'number',
    pauseOnBlur: 'boolean',
  };
  const type = allowed[key];
  if (!type) return;

  let next = value;
  if (type === 'number') {
    next = Number(value);
    if (!Number.isFinite(next)) return;
  } else if (type === 'boolean') {
    next = !!value;
  } else {
    next = String(value);
  }

  await scopedConfig().update(key, next, vscode.ConfigurationTarget.Global);
}

function ensurePanel() {
  if (panel) return panel;
  panel = new WallpaperPanel(context, {
    snapshot: panelState,
    apply: async (id) => {
      const cfg = scopedConfig();
      await cfg.update('wallpaperId', id, vscode.ConfigurationTarget.Global);
      if (!cfg.get('enabled', true)) {
        await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
      }
      await sync();
    },
    toggle: toggleEnabled,
    clear: async () => {
      const cfg = scopedConfig();
      await cfg.update('wallpaperId', '', vscode.ConfigurationTarget.Global);
      await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
      await sync();
    },
    refresh: async () => {
      await reloadLibrary(true);
      await sync();
    },
    importMedia,
    removeImport,
    visual: applyVisual,
    reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
    reapply: reapplyPatch,
    removePatch,
    settings: () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.steamRoot`),
  });
  return panel;
}

function openPanel() {
  ensurePanel().show();
}

function updateStatus(enabled, item) {
  if (statusBar) {
    statusBar.text = '$(image) 壁纸';
    statusBar.tooltip = item
      ? `打开壁纸面板\n当前壁纸：${item.title}`
      : '打开壁纸面板，挑选一张壁纸作为 IDE 背景';
  }
  if (!lookBar) return;
  if (!item) {
    lookBar.hide();
    return;
  }
  lookBar.text = enabled ? '$(eye) 背景：开' : '$(eye-closed) 背景：关';
  lookBar.tooltip = `当前壁纸：${item.title}\n点击切换开关`;
  lookBar.show();
}

function pushPanel() {
  if (panel) panel.push();
}

async function sync() {
  const cfg = scopedConfig();
  const id = String(cfg.get('wallpaperId') || '').trim();
  const enabled = !!cfg.get('enabled', true);
  const item = await findItem(id);

  updateStatus(enabled, item);

  if (!enabled || !id) {
    pushPanel();
    return;
  }
  if (!item) {
    vscode.window.showWarningMessage(
      `未找到壁纸 ${id}（可能已取消订阅或 Steam 库已移动）。请重新选择壁纸。`
    );
    pushPanel();
    return;
  }

  if (!serverPort) await ensureServer();
  if (!serverPort) {
    pushPanel();
    return;
  }

  await ensurePatched();
  pushPanel();
}

async function chooseWallpaper() {
  await reloadLibrary(true);
  if (!library.length) {
    const action = await vscode.window.showWarningMessage(
      '没有可用的壁纸。请确认 Steam 创意工坊已订阅壁纸，或指定 Steam 安装目录。',
      '设置 Steam 目录'
    );
    if (action) {
      vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.steamRoot`);
    }
    return;
  }

  const items = library.map((entry) => ({
    label: entry.title,
    description: `${KIND_LABEL[entry.kind] || entry.kind} · ${entry.id}`,
    detail: entry.description ? entry.description.slice(0, 180) : entry.dir,
    iconPath: entry.preview ? vscode.Uri.file(entry.preview) : undefined,
    entry,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要作为 IDE 背景的壁纸',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const cfg = scopedConfig();
  await cfg.update('wallpaperId', picked.entry.id, vscode.ConfigurationTarget.Global);
  if (!cfg.get('enabled', true)) {
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  }

  await sync();
  vscode.window.setStatusBarMessage(`背景已切换为：${picked.entry.title}`, 4000);
}

async function toggleEnabled() {
  const cfg = scopedConfig();
  await cfg.update('enabled', !cfg.get('enabled', true), vscode.ConfigurationTarget.Global);
  await sync();
}

async function reapplyPatch() {
  if (!serverPort) await ensureServer();
  if (!serverPort) return;

  const appRoot = vscode.env.appRoot;
  const { script, stamp } = patchArtifacts();
  const result = patcher.apply(appRoot, script, stamp);
  if (!result.ok) {
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：重新注入失败。${result.reason}`);
    return;
  }
  log(`已重新注入：${result.target}`);
  promptReload('背景层已重新注入，请重载窗口。');
}

async function removePatch() {
  const result = patcher.remove(vscode.env.appRoot);
  if (!result.ok) {
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：移除失败。${result.reason}`);
    return;
  }
  log(`已移除注入：${result.target || '（未找到 workbench.html）'}`);
  promptReload('背景层注入已移除，请重载窗口还原 IDE。');
}

async function activate(extensionContext) {
  context = extensionContext;
  imports = new Imports(extensionContext);
  output = vscode.window.createOutputChannel('Background-Wallpaper-Engine');

  // 状态栏就是用户要的“按钮”：左边一个打开面板，右边一个快速开关
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'backgroundWallpaperEngine.panel';
  statusBar.text = '$(image) 壁纸';
  statusBar.tooltip = '打开壁纸面板';
  statusBar.show();

  lookBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  lookBar.command = 'backgroundWallpaperEngine.toggle';
  lookBar.hide();

  extensionContext.subscriptions.push(output, statusBar, lookBar);

  // 命令先注册，避免启动早期点状态栏按钮没反应
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand('backgroundWallpaperEngine.panel', () => {
      openPanel();
      pushPanel();
    }),
    vscode.commands.registerCommand('backgroundWallpaperEngine.choose', chooseWallpaper),
    vscode.commands.registerCommand('backgroundWallpaperEngine.import', importMedia),
    vscode.commands.registerCommand('backgroundWallpaperEngine.toggle', toggleEnabled),
    vscode.commands.registerCommand('backgroundWallpaperEngine.reapply', reapplyPatch),
    vscode.commands.registerCommand('backgroundWallpaperEngine.remove', removePatch),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      if (event.affectsConfiguration(`${CONFIG_SECTION}.steamRoot`)) {
        reloadLibrary(false).then(sync);
        return;
      }
      sync();
    }),
    { dispose: deactivate }
  );

  // 先把本地服务起起来：注入的 iframe 一打开窗口就会去连接它，
  // 服务越早可用，背景出现得越快（扫描壁纸库放在后面，不挡服务启动）
  await ensureServer();
  await reloadLibrary(false);

  // 与是否选过壁纸无关：只要改过 workbench.html，就要保证校验值自洽，
  // 否则每次启动都会弹“安装似乎损坏”。
  if (vscode.env.appRoot) repairChecksum(vscode.env.appRoot);

  await sync();
}

function deactivate() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (panel) {
    panel.dispose();
    panel = null;
  }
  if (server) {
    try {
      server.close();
    } catch (err) {
      // 进程正在退出
    }
    server = null;
  }
}

module.exports = { activate, deactivate };

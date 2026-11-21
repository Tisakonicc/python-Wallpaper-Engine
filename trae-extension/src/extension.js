'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const { VERSION, PORT_CANDIDATES } = require('./config');
const { scanLibrary } = require('./scanner');
const { Imports, IMPORT_FILTERS, projectTitle } = require('./imports');
const { startServer, probeServer } = require('./server');
const { buildScript } = require('./runtime');
const { WallpaperPanel } = require('./panel');
const patcher = require('./patcher');

const CONFIG_SECTION = 'backgroundWallpaperEngine';

// 同一个 IDE 安装内的多个窗口共用一份本地服务；不同 IDE（Trae / VS Code）
// 必须各用各的，否则会共用一个 32123，渲染页读到的是对方的壁纸状态。
const APP_KEY = String(vscode.env.appRoot || vscode.env.appName || 'unknown');

// Trae 的主窗口本来就是 no-user-gesture-required；只有 VS Code 是 user-gesture-required，
// 而背景层是 pointer-events: none，永远拿不到手势，所以只在 VS Code 里放宽该项。
const IS_TRAE = /trae/i.test(
  `${vscode.env.appName || ''} ${vscode.env.appRoot || ''}`
);

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
let hwSyncTimer = null;
let slideshowTimer = null;

// 渲染页实测的硬解能力（由本地服务的 onHwState 回调更新）：
// ok=null 探测中，true 硬解，false 软解。面板据此显示状态徽章。
let hwDecodeInfo = { ok: null, reason: '' };
let hwSyncInFlight = false;

/**
 * 非属主窗口不会收到渲染页的 onHwState 回调（结果只推给起服务的那一个扩展宿主），
 * 所以从 /state.json 把服务端缓存的探测结果同步过来；扩展宿主重启后也靠它恢复。
 */
function fetchServerState(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/state.json', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function syncHwFromServer() {
  if (!serverPort || hwSyncInFlight) return;
  hwSyncInFlight = true;
  try {
    const state = await fetchServerState(serverPort);
    const hw = state && state.hwDecode;
    if (!hw) return;
    const ok = hw.ok === true ? true : hw.ok === false ? false : null;
    if (ok === null) return;
    const reason = hw.reason ? String(hw.reason) : '';
    if (hwDecodeInfo.ok === ok && hwDecodeInfo.reason === reason) return;
    hwDecodeInfo = { ok, reason };
    pushPanel();
  } finally {
    hwSyncInFlight = false;
  }
}

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
  const autoContrast = cfg.get('autoContrast', false) === true;
  // 侧栏 / 聊天 / 底部面板的底衬强度：0 = 纯壁纸全透，1 = 完全遮住
  const surface = Math.min(1, Math.max(0, Number(cfg.get('surfaceOpacity', 0))));
  // 文字增强：提亮 / 加深前景并加字形阴影
  const textContrast = cfg.get('textContrast', false) === true;
  // 1=浅色 2=深色 3=高对比深色 4=高对比浅色；渲染页据此决定是压暗还是提亮
  const themeKind = vscode.window.activeColorTheme ? vscode.window.activeColorTheme.kind : 2;
  const muted = !!cfg.get('muted', false);
  const volume = Math.min(1, Math.max(0, Number(cfg.get('volume', 0.6))));
  // 场景 / 网页壁纸自带的多首音乐：选中的曲目值（project.json 里 music combo 的 value）。
  // 空串表示不主动覆盖，沿用壁纸默认值；"0" 通常是静音项。
  const musicTrack = String(cfg.get('musicTrack') || '');

  // 壁纸轮播：开启后按固定间隔在库里轮换
  const slideshow = !!cfg.get('slideshow', false);
  const slideshowInterval = Math.max(1, Number(cfg.get('slideshowInterval', 10)));

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
        // 视频壁纸的独立音轨（Opus）。原生 AAC 解不了的 IDE 用它出声
        audio:
          origin && item.kind === 'video'
            ? `${origin}/audio/${encodeURIComponent(item.id)}`
            : '',
      }
    : null;

  return {
    enabled,
    // 已选壁纸的 ID 但库还没扫描完时，渲染页靠它继续保持密集轮询，
    // 壁纸一出现就能立刻挂载，不用多等一个 1.5 秒的常规轮询周期。
    wallpaperId: id,
    wallpaper,
    opacity,
    scrim,
    blur,
    saturate,
    fit,
    fps,
    pauseOnBlur,
    autoContrast,
    surface,
    textContrast,
    themeKind,
    muted,
    volume,
    musicTrack,
    // 音乐下拉框在 project.json 里的属性名（music / bgmTrack / …）；没有音乐时为空
    musicKey: item && item.musicKey ? String(item.musicKey) : '',
    musicOptions: Array.isArray(item && item.musicOptions) ? item.musicOptions : [],
    slideshow,
    slideshowInterval,
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
      autoContrast ? 1 : 0,
      surface,
      textContrast ? 1 : 0,
      themeKind,
      muted ? 1 : 0,
      volume,
      musicTrack,
      slideshow ? 1 : 0,
      slideshowInterval,
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
      '没有找到可用壁纸。请在 Steam 创意工坊订阅壁纸，或用面板里的“导入”选择本地视频 / 图片 / 场景包（.mpkg、.pkg）/ 网页壁纸文件夹。'
    );
  }
  return library;
}

/** 选择本地视频 / 图片 / 场景包（.mpkg、.pkg）/ 网页壁纸目录并登记为壁纸。 */
async function importMedia() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    // 网页壁纸是一整个目录（导出/收到的那种），允许直接选文件夹
    canSelectFolders: true,
    openLabel: '用作壁纸',
    filters: IMPORT_FILTERS,
  });
  if (!picked || !picked.length) return;

  // 手机包要解 ETC2、重新编码 PNG、补音频，给个进度条免得以为卡住了
  let added;
  try {
    added = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在导入壁纸', cancellable: false },
      (progress) => imports.add(
        picked.map((uri) => uri.fsPath),
        (text) => progress.report({ message: text })
      )
    );
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    log(`导入失败：${reason}`);
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：导入失败。${reason}`);
    return;
  }
  await reloadLibrary(false);
  if (!added.length) {
    vscode.window.showInformationMessage('选中的文件都已导入过，或格式不受支持。');
    pushPanel();
    return;
  }

  // 直接应用刚导入的最后一个（导入即生效），同时确保背景处于开启状态
  const target = added[added.length - 1];
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

/**
 * 手机包（.mpkg）常常把 music 层引用的 sounds/*.flac 剥掉。
 * 本机订阅过同一张壁纸时，桌面包里就有这些音轨，导入时直接搬过来。
 */
function supplementPkgsFor(workshopId) {
  const id = String(workshopId || '');
  if (!id) return [];
  const out = [];
  for (const item of library) {
    if (item.imported || !item.dir || !item.file) continue;
    if (String(item.id) !== id) continue;
    out.push(path.join(item.dir, item.file));
  }
  return out;
}

/**
 * 把当前壁纸导出成方便分享的形式：
 *   scene        → scene.pkg（导入项取转换缓存，Steam 项取原文件）
 *   video / image→ 原文件另存
 *   web          → 整份目录复制到选定文件夹
 */
async function exportScene(id) {
  if (!imports) return;
  const wanted = String(id || '').trim() || String(scopedConfig().get('wallpaperId') || '').trim();
  const item = library.find((entry) => entry.id === wanted);
  if (!item) {
    vscode.window.showInformationMessage('请先在面板里选择一个壁纸，再点导出。');
    return;
  }

  if (item.kind === 'web') {
    await exportWebDir(item);
    return;
  }

  let source = null;
  let ext = '.pkg';
  if (item.kind === 'scene') {
    const found = imports.packageFor(item.id);
    source = found ? found.pkgPath : path.join(item.dir, item.file);
  } else {
    source = item.mediaPath || path.join(item.dir, item.file);
    ext = path.extname(source) || '';
  }

  if (!source || !fs.existsSync(source)) {
    vscode.window.showErrorMessage('Background-Wallpaper-Engine：找不到这个壁纸的源文件，可能已被移动或删除。');
    return;
  }

  const name = safeFileName(item.title);
  const target = await vscode.window.showSaveDialog({
    saveLabel: '导出',
    filters:
      item.kind === 'scene'
        ? { 场景包: ['pkg'] }
        : { 壁纸文件: [String(ext.replace('.', '') || 'mp4')] },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `${name}${ext}`)),
  });
  if (!target) return;

  try {
    fs.copyFileSync(source, target.fsPath);
    log(`已导出壁纸：${target.fsPath}`);
    vscode.window.showInformationMessage(
      item.kind === 'scene'
        ? `已导出 ${path.basename(target.fsPath)}（画面与音乐已打包在内，可直接发给别人导入）`
        : `已导出 ${path.basename(target.fsPath)}`
    );
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    log(`导出壁纸失败：${reason}`);
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：导出失败。${reason}`);
  }
}

/** 网页壁纸是一整个目录，导出时整份复制到用户选的文件夹下。 */
async function exportWebDir(item) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '导出到此文件夹',
  });
  if (!picked || !picked.length) return;

  const base = picked[0].fsPath;
  // 导出时再读一次 project.json：标题以工程内写的为准，文件夹名可能是错的编码
  const name = safeFileName(projectTitle(item.dir) || item.title);
  let dest = path.join(base, name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(base, `${name} (${i})`);

  try {
    copyTree(item.dir, dest);
    if (!fs.existsSync(dest)) {
      const landed = fs.readdirSync(base).join('、');
      throw new Error(`没找到目标目录 ${dest}；当前目录下是：${landed}`);
    }
    log(`已导出网页壁纸：${dest}`);
    vscode.window.showInformationMessage(`已导出网页壁纸到 ${dest}，对方用「导入…」选中这个文件夹即可。`);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    log(`导出网页壁纸失败：${reason}`);
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：导出失败。${reason}`);
  }
}

/**
 * 递归复制目录。
 * 某些扩展宿主在落盘时会按 ANSI（GBK）重编码新建路径名，中文目录名会变成乱码，
 * 所以 Windows 上交给 robocopy（子进程，路径以 UTF-16 传给系统），Node 只做兜底。
 */
function copyTree(from, to) {
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'robocopy.exe',
        [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'],
        { windowsHide: true, stdio: 'ignore' }
      );
      return;
    } catch (err) {
      // robocopy 的 1~7 都算成功（有复制/有额外文件等），8 以上才是失败
      if (typeof err.status === 'number' && err.status <= 7) return;
    }
  }
  fs.cpSync(from, to, { recursive: true });
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'wallpaper';
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
    // 本 IDE 的其它窗口已经起了服务：直接共用，不必再注入一次。
    // 端口被别的 IDE 占着时 probe 会返回 null，接着往下试下一个端口。
    // 本地回环的 /health 是毫秒级响应，600ms 足够；默认 1.5s 会拖慢 Trae 冷启动
    const health = await probeServer(port, APP_KEY, 600);
    if (health) {
      serverPort = port;
      isOwner = false;
      patchCache = null;   // 端口可能变了，注入脚本里的首选端口要跟着改
      log(`复用已存在的本地服务：端口 ${port}`);
      startHealthWatch();
      return true;
    }

    try {
      server = await startServer({
        port,
        appKey: APP_KEY,
        getState: currentState,
        getLibrary: () => library,
        assetsRoot: path.join(__dirname, '..', 'assets'),
        onLog: (line) => log(line),
        // 渲染页探测到硬解能力后回调：更新进程内状态并刷新面板徽章
        onHwState: (info) => {
          hwDecodeInfo = { ok: info.ok, reason: info.reason || '' };
          pushPanel();
        },
      });
      serverPort = port;
      isOwner = true;
      patchCache = null;   // 注入脚本里的首选端口要跟着改
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
    const health = await probeServer(serverPort || PORT_CANDIDATES[0], APP_KEY);
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
    // 端口列表固定为候选顺序，不再把自己当前占用的端口写进脚本：
    // 同时开着 Trae / VS Code 时端口归属会变来变去，一改端口脚本哈希就变，
    // 于是每次启动都重新注入并弹“重载窗口”。具体连哪个端口交给注入脚本
    // 用 localStorage 记住上次成功的端口来优先尝试。
    const ports = PORT_CANDIDATES.slice();
    const script = buildScript({ ports, version: VERSION, app: APP_KEY });
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

// 注入分两步：先在 product.json 里摘掉 workbench.html 的校验项，等 IDE 完全重启
// （主进程重读校验清单）后再写注入块。`process.ppid` 就是 IDE 主进程的 PID：
// 重载窗口不会变，完全退出重开才会变，正好用来判断“是否已经真的重启过”。
const STAGE_KEY = 'patchStagedPid';

function isWaitingRestart(appRoot) {
  if (!context) return false;
  const staged = context.globalState.get(STAGE_KEY);
  return !!staged && staged.pid === process.ppid && staged.appRoot === appRoot;
}

function markWaitingRestart(appRoot) {
  if (context) context.globalState.update(STAGE_KEY, { pid: process.ppid, appRoot });
}

function clearWaitingRestart() {
  if (context) context.globalState.update(STAGE_KEY, undefined);
}

/** 像 PyCharm 那样提示重启，但不强行弹模态框：给一个“重启 IDE”的按钮。 */
function promptFullRestart() {
  vscode.window
    .showInformationMessage(
      `背景层需要重启一次 ${vscode.env.appName} 才能完成加载。请重启 IDE 后继续。`,
      '重启 IDE',
      '稍后'
    )
    .then((choice) => {
      if (choice === '重启 IDE') {
        vscode.commands.executeCommand('workbench.action.quit');
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

  // 第一步已经做过，还在等完全重启：同一个主进程里继续等，绝不能提前写 html，
  // 否则本条会话的完整性校验仍拿着旧清单，必然弹“安装似乎损坏”。
  if (isWaitingRestart(appRoot)) return false;

  const result = patcher.apply(appRoot, script, stamp);
  if (!result.ok) {
    log(`注入失败：${result.reason}`);
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：注入失败。${result.reason}`);
    return false;
  }

  if (result.staged) {
    markWaitingRestart(appRoot);
    log('已从 product.json 摘除 workbench.html 的校验项，等待 IDE 完全重启后再写入注入块。');
    promptFullRestart();
    return false;
  }

  clearWaitingRestart();
  log(`已注入背景层：${result.target}`);
  if (result.checksum === 'detached' || result.checksum === 'absent') {
    log('已把 workbench.html 从 product.json 的校验清单中移除，之后不会再提示“安装似乎损坏”。');
  }
  promptReload('背景层已注入，重载窗口即可看到背景。');
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

/**
 * VS Code 默认禁止没有用户手势的有声自动播放，而背景 iframe 不接收点击，
 * 结果就是带音轨的壁纸只能静音。这里放宽 VS Code 主窗口的 autoplayPolicy；
 * 主进程参数在启动时读取，所以改完需要完全重启一次（扩展升级后同理）。
 */
function ensureAutoplayPolicy() {
  if (IS_TRAE) return;
  const appRoot = vscode.env.appRoot;
  if (!appRoot) return;

  const result = patcher.applyAutoplayPolicy(appRoot);
  if (!result.ok) {
    log(`VS Code 自动播放策略处理失败：${result.reason}`);
    return;
  }
  if (result.state === 'patched') {
    log('已放宽 VS Code 主窗口的自动播放策略，壁纸音效将在下次完全重启后生效。');
    promptReload('已启用壁纸音效支持，请完全退出 VS Code 再重新打开（不是重载窗口）。');
  } else if (result.state === 'already') {
    log('VS Code 自动播放策略已放宽。');
  } else if (result.reason) {
    log(`VS Code 自动播放策略跳过：${result.reason}`);
  }
}

function panelState() {
  const s = currentState();
  const origin = serverPort ? `http://127.0.0.1:${serverPort}` : '';
  const curItem = s.wallpaper ? library.find((item) => item.id === s.wallpaper.id) : null;
  return {
    enabled: s.enabled,
    current: s.wallpaper
      ? {
          id: s.wallpaper.id,
          kind: s.wallpaper.kind,
          title: s.wallpaper.title,
          // 顶部“导出”按钮：场景导 pkg，视频/图片导原文件，网页导整份目录
          exportable: !!curItem,
          // 场景 / 网页壁纸自带的多首音乐；没有就传空数组，面板据此隐藏下拉框
          musicKey: (curItem && curItem.musicKey) || '',
          musicOptions: Array.isArray(curItem && curItem.musicOptions) ? curItem.musicOptions : [],
          // preview 是磁盘绝对路径，直接塞进 img.src 在 webview 里加载不出来；
          // 必须走本地服务的 /preview/<id>（导入的图片同样由这里代理）。
          // 视频就算没有 preview 也走这个地址：服务端会用 ffmpeg 抽一帧。
          thumb:
            origin && (s.wallpaper.preview || s.wallpaper.kind === 'video')
              ? `${origin}/preview/${encodeURIComponent(s.wallpaper.id)}`
              : '',
          src: origin
            ? `${origin}/wallpapers/${encodeURIComponent(s.wallpaper.id)}/files/${encodeURIComponent(
                s.wallpaper.file || ''
              )}`
            : '',
        }
      : null,
    items: library.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description || '',
      imported: !!item.imported,
      // 所有类型都能导出：场景导 pkg，视频/图片导原文件，网页导整份目录
      exportable: true,
      // 视频即使没有 preview 也给地址，服务端会抽帧当封面
      thumb:
        origin && (item.preview || item.kind === 'video')
          ? `${origin}/preview/${encodeURIComponent(item.id)}`
          : '',
      // 没有封面图的视频：面板侧用这个地址取首帧当封面（导入的视频没有 preview）
      src: origin
        ? `${origin}/wallpapers/${encodeURIComponent(item.id)}/files/${encodeURIComponent(item.file)}`
        : '',
    })),
    opacity: s.opacity,
    scrim: s.scrim,
    blur: s.blur,
    saturate: s.saturate,
    autoContrast: s.autoContrast,
    surfaceOpacity: s.surface,
    textContrast: s.textContrast,
    fit: s.fit,
    fps: s.fps,
    pauseOnBlur: s.pauseOnBlur,
    muted: s.muted,
    volume: s.volume,
    musicTrack: s.musicTrack,
    slideshow: s.slideshow,
    slideshowInterval: s.slideshowInterval,
    port: serverPort,
    patched: patchedNow(),
    version: VERSION,
    // 渲染页实测的硬解能力：ok=null 检测中 / true 硬解 / false 软解，面板 footer 显示徽章
    hwDecode: hwDecodeInfo,
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
    autoContrast: 'boolean',
    surfaceOpacity: 'number',
    textContrast: 'boolean',
    muted: 'boolean',
    volume: 'number',
    musicTrack: 'string',
    slideshow: 'boolean',
    slideshowInterval: 'number',
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
    exportScene,
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
  // 打开面板时先向本地服务要一次已缓存的硬解状态
  syncHwFromServer();
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

/** 停止壁纸轮播定时器。 */
function stopSlideshow() {
  if (slideshowTimer) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }
}

/**
 * 壁纸轮播：按配置间隔在库里轮换。
 * 从当前壁纸的下一张开始，到末尾回到第一张；库里只有一张时不动。
 */
function startSlideshow() {
  stopSlideshow();
  const intervalMin = Math.max(1, Number(scopedConfig().get('slideshowInterval', 10)));
  slideshowTimer = setInterval(async () => {
    const cfg = scopedConfig();
    if (!cfg.get('slideshow', false) || !cfg.get('enabled', true)) {
      stopSlideshow();
      return;
    }
    if (!library.length) return;
    const curId = String(cfg.get('wallpaperId') || '');
    let idx = library.findIndex((entry) => entry.id === curId);
    if (idx < 0) idx = 0;
    const next = library[(idx + 1) % library.length];
    if (!next || next.id === curId) return;
    await cfg.update('wallpaperId', next.id, vscode.ConfigurationTarget.Global);
  }, intervalMin * 60 * 1000);
}

/** 按配置同步轮播定时器的启停。 */
function syncSlideshow() {
  const cfg = scopedConfig();
  if (cfg.get('slideshow', false) && cfg.get('enabled', true)) {
    startSlideshow();
  } else {
    stopSlideshow();
  }
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
  syncSlideshow();
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
  if (isWaitingRestart(appRoot)) {
    promptFullRestart();
    return;
  }
  const { script, stamp } = patchArtifacts();
  const result = patcher.apply(appRoot, script, stamp);
  if (!result.ok) {
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：重新注入失败。${result.reason}`);
    return;
  }
  if (result.staged) {
    markWaitingRestart(appRoot);
    log('已从 product.json 摘除 workbench.html 的校验项，等待 IDE 完全重启后再写入注入块。');
    promptFullRestart();
    return;
  }
  clearWaitingRestart();
  log(`已重新注入：${result.target}`);
  promptReload('背景层已重新注入，请重载窗口。');
}

async function removePatch() {
  const result = patcher.remove(vscode.env.appRoot);
  if (!result.ok) {
    vscode.window.showErrorMessage(`Background-Wallpaper-Engine：移除失败。${result.reason}`);
    return;
  }
  clearWaitingRestart();
  log(`已移除注入：${result.target || '（未找到 workbench.html）'}`);
  if (!IS_TRAE) {
    const audio = patcher.restoreAutoplayPolicy(vscode.env.appRoot);
    if (audio.state === 'restored') log('已恢复 VS Code 的自动播放策略。');
    else if (!audio.ok) log(`恢复自动播放策略失败：${audio.reason}`);
  }
  promptReload('背景层注入已移除，请重载窗口还原 IDE。');
}

async function activate(extensionContext) {
  context = extensionContext;
  imports = new Imports(extensionContext, { resolveSupplement: supplementPkgsFor });
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
    vscode.commands.registerCommand('backgroundWallpaperEngine.export', () => exportScene()),
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

  // 非属主窗口收不到 onHwState 推送，靠这个轮询从 /state.json 补齐徽章状态
  hwSyncTimer = setInterval(() => {
    if (panel && panel.isVisible()) syncHwFromServer();
  }, 8000);

  // 与是否选过壁纸无关：只要改过 workbench.html，就要保证校验值自洽，
  // 否则每次启动都会弹“安装似乎损坏”。
  if (vscode.env.appRoot) {
    repairChecksum(vscode.env.appRoot);
    // VS Code 需要额外放宽自动播放策略，壁纸音效才能出声
    ensureAutoplayPolicy();
  }

  await sync();
}

function deactivate() {
  stopSlideshow();
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (hwSyncTimer) {
    clearInterval(hwSyncTimer);
    hwSyncTimer = null;
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

  // 只在「扩展已被卸载、等待重启删目录」时还原 workbench.html。
  // IDE 卸载时会在 <extensions>/.obsolete 写下本版本目录名，正常退出、
  // 重载窗口、禁用扩展都不会写，所以不会出现“每次启动都要重载一次”的副作用。
  try {
    const appRoot = vscode.env.appRoot;
    const pending = patcher.isUninstallPending(context && context.extensionPath);
    if (appRoot && pending && patchedNow()) {
      const result = patcher.remove(appRoot);
      if (result && result.ok) {
        log('检测到扩展已卸载，已还原 workbench.html');
      } else {
        log(`卸载还原失败：${result && result.reason ? result.reason : '未知原因'}`);
      }
    }
  } catch (err) {
    log(`卸载还原异常：${err && err.message ? err.message : err}`);
  }
  if (output) {
    output.dispose();
    output = null;
  }
}

module.exports = { activate, deactivate };

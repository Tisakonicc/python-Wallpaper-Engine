'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 注册表里的 Steam 安装路径（仅 Windows）。 */
function registrySteamPath() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true }
    );
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function unescapeVdf(value) {
  return value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

/** 从 libraryfolders.vdf 中收集其它 Steam 库根目录（兼容新旧两种写法）。 */
function librariesFrom(vdf) {
  const roots = [];
  if (!vdf) return roots;
  const re = /"((?:[A-Za-z]:[\\/]|\\\\)[^"]*)"/g;
  let m;
  while ((m = re.exec(vdf))) roots.push(unescapeVdf(m[1]));
  return roots;
}

function normalizeRoot(value) {
  if (!value) return null;
  let p = value.trim();
  if (!p) return null;
  // 统一分隔符，避免 d:/steam 与 D:\Steam 被当成两个库
  if (process.platform === 'win32') p = p.replace(/\//g, '\\');
  // 用户可能填的是 steamapps 或 workshop 目录，向上归到库根。
  p = p.replace(/[\\/]+$/, '');
  const lower = p.toLowerCase();
  const cut = lower.indexOf(`${path.sep}steamapps`);
  if (cut >= 0) p = p.slice(0, cut);
  return p;
}

/**
 * 找出所有可能的 Steam 库根目录：配置项 → 注册表 → 常见路径 →
 * 每个根目录的 libraryfolders.vdf。
 */
function findSteamRoots(configured) {
  const seeds = [];
  const push = (v) => {
    const p = normalizeRoot(v);
    if (p && fs.existsSync(p)) seeds.push(p);
  };

  push(configured);
  push(registrySteamPath());
  for (const candidate of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'E:\\Steam',
    'F:\\Steam',
  ]) {
    push(candidate);
  }

  const roots = [];
  const seen = new Set();
  const add = (p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(p);
  };

  for (const seed of seeds) {
    add(seed);
    const vdf = readText(path.join(seed, 'steamapps', 'libraryfolders.vdf'));
    for (const lib of librariesFrom(vdf)) {
      if (fs.existsSync(lib)) add(lib);
    }
  }
  return roots;
}

function previewOf(dir, project) {
  const declared = project && typeof project.preview === 'string' ? project.preview : null;
  if (declared) {
    const p = path.join(dir, declared);
    if (fs.existsSync(p)) return p;
  }
  for (const name of ['preview.jpg', 'preview.png', 'preview.gif', 'preview.webp']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);
const IMAGE_EXT = new Set(['.gif', '.apng', '.webp']);

function firstMediaFile(dir, extSet) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (extSet.has(path.extname(entry.name).toLowerCase())) return entry.name;
  }
  return null;
}

/** 判定壁纸类型：video / image / web / scene。无法识别返回 null。 */
function detectKind(dir, project, declaredFile) {
  const type = String((project && project.type) || '').toLowerCase();
  const ext = declaredFile ? path.extname(declaredFile).toLowerCase() : '';

  if (type === 'video') return IMAGE_EXT.has(ext) ? 'image' : 'video';
  if (type === 'web') return 'web';
  if (type === 'scene') return 'scene';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';

  if (
    fs.existsSync(path.join(dir, 'scene.pkg')) ||
    fs.existsSync(path.join(dir, 'scenes', 'scene.pkg')) ||
    fs.existsSync(path.join(dir, 'scene.json'))
  ) {
    return 'scene';
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'web';

  const video = firstMediaFile(dir, VIDEO_EXT);
  if (video) return 'video';
  const image = firstMediaFile(dir, IMAGE_EXT);
  if (image) return 'image';
  return null;
}

// 属性键名里出现这些词，基本可以确定是“选音乐”的下拉框。
const MUSIC_KEY_RE = /(^|[_\-.])(music|bgm|song|track|soundtrack|playlist)($|[_\-.0-9])/i;
// 属性显示名里出现这些词（中英文），用来兜底识别命名不规范的 combo。
const MUSIC_TEXT_RE = /(音乐|配乐|曲目|背景乐|bgm|music|soundtrack)/i;

/**
 * 从 project.json 里提取“音乐”下拉框：属性名和选项一起返回。
 *
 * Wallpaper Engine 里并没有强制的属性名，实际遇到过这些写法：
 *   - scenes 常见：general.properties.music（combo）
 *   - 网页壁纸可能是：bgmTrack、songList、track…
 * 所以按 key → 显示文字 的顺序挑第一个像音乐的 combo，
 * 只认 combo 类型且带 options 的，避免把 bool / slider 误当成音乐。
 */
function extractMusicOptions(project) {
  const props = project && project.general && project.general.properties;
  if (!props || typeof props !== 'object') return null;

  const combos = [];
  for (const [key, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    if (String(prop.type || '').toLowerCase() !== 'combo') continue;
    if (!Array.isArray(prop.options) || !prop.options.length) continue;
    combos.push({ key, prop });
  }
  if (!combos.length) return null;

  // 优先精确同名 music，再按 key 关键词，最后按显示文字关键词
  const picked =
    combos.find((c) => c.key.toLowerCase() === 'music') ||
    combos.find((c) => MUSIC_KEY_RE.test(c.key)) ||
    combos.find((c) => MUSIC_TEXT_RE.test(String(c.prop.text || '')));
  if (!picked) return null;

  const list = [];
  for (const opt of picked.prop.options) {
    if (!opt || typeof opt !== 'object') continue;
    const value = opt.value == null ? '' : String(opt.value);
    const label = opt.label == null ? value : String(opt.label);
    list.push({ value, label });
  }
  if (!list.length) return null;

  return { key: picked.key, options: list };
}

function buildItem(dir, id, origin) {
  const project = readJson(path.join(dir, 'project.json'));
  let declaredFile = project && typeof project.file === 'string' ? project.file : '';
  const declaredExists = declaredFile && fs.existsSync(path.join(dir, declaredFile));
  if (!declaredExists) {
    // project.json 里写的 file 不存在时 fallback 到实际存在的入口文件
    if (fs.existsSync(path.join(dir, 'index.html'))) declaredFile = 'index.html';
    else if (fs.existsSync(path.join(dir, 'scene.pkg'))) declaredFile = 'scene.pkg';
    else if (fs.existsSync(path.join(dir, 'scene.json'))) declaredFile = 'scene.json';
    else if (fs.existsSync(path.join(dir, 'loop.mp4'))) declaredFile = 'loop.mp4';
    else if (fs.existsSync(path.join(dir, 'preview.webm'))) declaredFile = 'preview.webm';
    else if (!declaredFile) declaredFile = '';
  }

  const kind = detectKind(dir, project, declaredFile);
  if (!kind) return null;

  const music = extractMusicOptions(project);

  return {
    id: String(id),
    dir,
    title: (project && project.title) || path.basename(dir),
    kind,
    preview: previewOf(dir, project),
    file: declaredFile,
    description: String((project && project.description) || '').replace(/\s+/g, ' ').trim(),
    // 音乐下拉框：key 是 project.json 里的属性名（可能是 music / bgmTrack 等）
    musicKey: music ? music.key : '',
    musicOptions: music ? music.options : null,
    origin,
  };
}

function scanDirectory(base, origin, items, seen) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const id = entry.name;
    if (seen.has(id)) continue;
    const item = buildItem(path.join(base, id), id, origin);
    if (!item) continue;
    seen.add(id);
    items.push(item);
  }
}

/**
 * 扫描本机 Wallpaper Engine 库：
 *   - 创意工坊：<root>/steamapps/workshop/content/431960/<id>
 *   - 工程目录：wallpaper_engine/projects/{defaultprojects,myprojects}/<name>
 */
function scanLibrary(configuredSteamRoot) {
  const roots = findSteamRoots(configuredSteamRoot);
  const items = [];
  const seen = new Set();

  for (const root of roots) {
    scanDirectory(
      path.join(root, 'steamapps', 'workshop', 'content', '431960'),
      'workshop',
      items,
      seen
    );
    const projects = path.join(root, 'steamapps', 'common', 'wallpaper_engine', 'projects');
    scanDirectory(path.join(projects, 'defaultprojects'), 'project', items, seen);
    scanDirectory(path.join(projects, 'myprojects'), 'project', items, seen);
  }

  items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return { items, roots };
}

module.exports = { scanLibrary, findSteamRoots };

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

function buildItem(dir, id, origin) {
  const project = readJson(path.join(dir, 'project.json'));
  let declaredFile = project && typeof project.file === 'string' ? project.file : '';
  if (!declaredFile) {
    if (fs.existsSync(path.join(dir, 'index.html'))) declaredFile = 'index.html';
    else if (fs.existsSync(path.join(dir, 'scene.pkg'))) declaredFile = 'scene.pkg';
  }

  const kind = detectKind(dir, project, declaredFile);
  if (!kind) return null;

  return {
    id: String(id),
    dir,
    title: (project && project.title) || path.basename(dir),
    kind,
    preview: previewOf(dir, project),
    file: declaredFile,
    description: String((project && project.description) || '').replace(/\s+/g, ' ').trim(),
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

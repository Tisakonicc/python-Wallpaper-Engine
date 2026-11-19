'use strict';

/**
 * 外部导入的壁纸（本地视频 / 图片 / Wallpaper Engine 手机包 .mpkg）。
 *
 * 视频和图片只记录文件路径，不复制文件：用户放在哪就是在哪，删掉源文件后条目自动消失。
 * 手机包必须转换（ETC2 纹理 → PNG、补齐音乐、重打成桌面包），转换结果缓存在 D 盘，
 * 原始 .mpkg 同样不复制。
 *
 * 列表存在扩展的 globalState 里，跨窗口、跨重启都还在。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { isMpkg, isPkg, convertMpkg, convertPkg, CONVERTER_VERSION } = require('./mpkg');

const STATE_KEY = 'importedWallpapers';
const PACKAGE_KEY = 'importedPackages';

// Chromium 不解 Matroska 容器，所以不收 .mkv，避免选了却黑屏
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXT = new Set(['.gif', '.apng', '.webp', '.png', '.jpg', '.jpeg', '.bmp', '.avif']);

const IMPORT_FILTERS = {
  壁纸: [...VIDEO_EXT, ...IMAGE_EXT, '.mpkg', '.pkg'].map((ext) => ext.slice(1)),
  视频与图片: [...VIDEO_EXT, ...IMAGE_EXT].map((ext) => ext.slice(1)),
  场景包: ['mpkg', 'pkg'],
  手机包: ['mpkg'],
  桌面场景: ['pkg'],
  视频: [...VIDEO_EXT].map((ext) => ext.slice(1)),
  图片: [...IMAGE_EXT].map((ext) => ext.slice(1)),
};

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mpkg' || ext === '.pkg') return 'scene';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** 目录也能导入：带 index.html 的当作网页壁纸（对方导出的网页壁纸就是这种目录）。 */
function kindOfInput(entry) {
  try {
    if (fs.statSync(entry).isDirectory()) {
      return fs.existsSync(path.join(entry, 'index.html')) ? 'web' : null;
    }
  } catch {
    return null;
  }
  return kindOf(entry);
}

function idOf(file) {
  return 'local-' + crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12);
}

/** 网页壁纸的 project.json 带正式标题；文件夹名可能被解压工具按错误编码写过，不能直接拿来当名字。 */
function projectTitle(dir) {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    const title = project && typeof project.title === 'string' ? project.title.trim() : '';
    return title;
  } catch {
    return '';
  }
}

// 与 scanner.js 保持一致：键名 / 显示文字里像“选音乐”的 combo 才认。
const MUSIC_KEY_RE = /(^|[_\-.])(music|bgm|song|track|soundtrack|playlist)($|[_\-.0-9])/i;
const MUSIC_TEXT_RE = /(音乐|配乐|曲目|背景乐|bgm|music|soundtrack)/i;

/**
 * 读取目录下 project.json 里的音乐下拉选项，返回 { key, options }。
 * 属性名并不固定（music / bgmTrack / songList…），所以按 key 与显示文字挑。
 */
function musicOf(dir) {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
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
    return list.length ? { key: picked.key, options: list } : null;
  } catch {
    return null;
  }
}

/** 转换结果放 D 盘（用户约定：数据都放 D 盘），没有 D 盘再退回扩展存储目录。 */
function cacheRootFor(context) {
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync('D:\\')) return path.join('D:', 'TraeData', 'Background-Wallpaper-Engine', 'mpkg');
    } catch {
      // 继续退回
    }
  }
  try {
    return path.join(context.globalStorageUri.fsPath, 'mpkg');
  } catch {
    return path.join(os.tmpdir(), 'background-wallpaper-mpkg');
  }
}

/**
 * 转成和 Steam 壁纸同构的条目，这样渲染、预览、面板全都不用改。
 * dir + file（相对）保证 `/wallpapers/<id>/files/<file>` 能命中。
 */
function buildItem(file) {
  const abs = path.resolve(file);

  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }

  // 目录：网页壁纸（入口固定 index.html，其余资源相对它加载）
  if (stat.isDirectory()) {
    if (!fs.existsSync(path.join(abs, 'index.html'))) return null;
    return {
      id: idOf(abs),
      imported: true,
      dir: abs,
      file: 'index.html',
      dirScoped: true,
      title: projectTitle(abs) || path.basename(abs),
      kind: 'web',
      preview: null,
      description: '',
      musicKey: (musicOf(abs) || {}).key || '',
      musicOptions: (musicOf(abs) || {}).options || null,
      origin: 'import',
    };
  }

  const kind = kindOf(abs);
  if (!kind) return null;
  return {
    id: idOf(abs),
    imported: true,
    dir: path.dirname(abs),
    file: path.basename(abs),
    title: path.basename(abs, path.extname(abs)),
    kind,
    // 图片本身就是缩略图；视频没有可靠的取帧手段，面板里显示类型占位
    preview: kind === 'image' ? abs : null,
    description: '',
    origin: 'import',
    mediaPath: abs,
  };
}

/** 场景包转换后的条目：渲染引擎要 scene.pkg，脚本用户属性要 project.json。 */
function packageItem(record) {
  const files = ['scene.pkg'];
  if (record.projectPath) files.push('project.json');
  const music = musicOf(record.dir);
  return {
    id: idOf(record.src),
    imported: true,
    dir: record.dir,
    file: 'scene.pkg',
    files,
    title: record.title || path.basename(record.src, path.extname(record.src)),
    kind: 'scene',
    preview: record.preview || null,
    description: '',
    musicKey: music ? music.key : '',
    musicOptions: music ? music.options : null,
    origin: record.origin || 'mpkg',
  };
}

class Imports {
  constructor(context, options = {}) {
    this.context = context;
    this.cacheRoot = cacheRootFor(context);
    this.resolveSupplement = options.resolveSupplement || (() => []);
  }

  /** 存的是绝对路径数组，读的时候重建条目，顺带剔除已被删除的文件。 */
  paths() {
    const stored = this.context.globalState.get(STATE_KEY, []);
    return Array.isArray(stored) ? stored.filter((p) => typeof p === 'string' && p) : [];
  }

  records() {
    const stored = this.context.globalState.get(PACKAGE_KEY, []);
    return Array.isArray(stored) ? stored.filter((r) => r && typeof r.src === 'string' && r.dir) : [];
  }

  list() {
    const items = [];
    const seen = new Set();
    for (const file of this.paths()) {
      if (!fs.existsSync(file)) continue;
      const item = buildItem(file);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    for (const record of this.records()) {
      // 源包或缓存被删了就跳过；重新导入一次即可恢复
      if (!fs.existsSync(record.src) || !fs.existsSync(path.join(record.dir, 'scene.pkg'))) continue;
      const item = packageItem(record);
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  /** @returns {Promise<object[]>} 真正新增的条目（媒体或手机包） */
  async add(files, onProgress = () => {}) {
    const paths = this.paths();
    const seen = new Set(paths.map((p) => p.toLowerCase()));
    const records = this.records();
    const added = [];
    let mediaChanged = false;

    for (const file of files) {
      const abs = path.resolve(file);

      if (isMpkg(abs) || isPkg(abs)) {
        const existing = records.find((r) => r.src.toLowerCase() === abs.toLowerCase());
        if (
          existing &&
          existing.version === CONVERTER_VERSION &&
          fs.existsSync(path.join(existing.dir, 'scene.pkg'))
        ) {
          continue;
        }
        const record = await this.convert(abs, existing, onProgress);
        const index = records.findIndex((r) => r.src.toLowerCase() === abs.toLowerCase());
        if (index >= 0) records[index] = record;
        else records.push(record);
        added.push(packageItem(record));
        continue;
      }

      if (!kindOfInput(abs) || seen.has(abs.toLowerCase())) continue;
      seen.add(abs.toLowerCase());
      paths.push(abs);
      mediaChanged = true;
      const item = buildItem(abs);
      if (item) added.push(item);
    }

    if (mediaChanged) {
      await this.context.globalState.update(STATE_KEY, paths);
    }
    if (added.some((item) => item.kind === 'scene')) {
      await this.context.globalState.update(PACKAGE_KEY, records);
    }
    return added;
  }

  async convert(abs, existing, onProgress) {
    if (isPkg(abs)) {
      onProgress('正在读取场景包…');
      const result = convertPkg(abs, {
        cacheRoot: this.cacheRoot,
        onLog: (line) => onProgress(line),
      });
      onProgress('已完成导入');
      return {
        src: abs,
        origin: 'pkg',
        dir: path.dirname(result.pkgPath),
        title: result.title,
        preview: result.previewPath,
        projectPath: result.projectPath,
        version: CONVERTER_VERSION,
        size: result.size,
        projectSynthesized: result.projectSynthesized,
        convertedAt: Date.now(),
      };
    }

    onProgress('正在解包纹理与音乐…');
    const result = convertMpkg(abs, {
      cacheRoot: this.cacheRoot,
      // 手机包通常不含 sounds/，用本机同 ID 的桌面包补；两边都没有就只保留画面
      supplementPkgs: (workshopId) => this.resolveSupplement(workshopId),
      onLog: (line) => onProgress(line),
    });
    onProgress('已生成 scene.pkg');
    return {
      src: abs,
      origin: 'mpkg',
      dir: path.dirname(result.pkgPath),
      title: result.title,
      preview: result.previewPath,
      projectPath: result.projectPath,
      workshopId: result.workshopId,
      version: CONVERTER_VERSION,
      size: result.size,
      soundsAdded: result.soundsAdded,
      mtime: existing && existing.mtime,
      convertedAt: Date.now(),
    };
  }

  /** 找到某个导入项对应的场景包（导出分享用）。 */
  packageFor(id) {
    const record = this.records().find((r) => idOf(r.src) === id);
    if (!record) return null;
    const pkgPath = path.join(record.dir, 'scene.pkg');
    if (!fs.existsSync(pkgPath)) return null;
    return {
      record,
      pkgPath,
      title: record.title || path.basename(record.src, path.extname(record.src)),
    };
  }

  async remove(id) {
    const paths = this.paths();
    const next = paths.filter((file) => idOf(path.resolve(file)) !== id);
    if (next.length !== paths.length) {
      await this.context.globalState.update(STATE_KEY, next);
      return true;
    }

    const records = this.records();
    const kept = records.filter((record) => idOf(record.src) !== id);
    if (kept.length !== records.length) {
      await this.context.globalState.update(PACKAGE_KEY, kept);
      return true;
    }
    return false;
  }
}

module.exports = { Imports, IMPORT_FILTERS, buildItem, projectTitle };

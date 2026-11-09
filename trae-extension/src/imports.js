'use strict';

/**
 * 外部导入的壁纸（本地视频 / 图片）。
 *
 * 只记录文件路径，不复制文件：用户放在哪就是在哪，删掉源文件后条目自动消失。
 * 列表存在扩展的 globalState 里，跨窗口、跨重启都还在。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_KEY = 'importedWallpapers';

// Chromium 不解 Matroska 容器，所以不收 .mkv，避免选了却黑屏
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXT = new Set(['.gif', '.apng', '.webp', '.png', '.jpg', '.jpeg', '.bmp', '.avif']);

const IMPORT_FILTERS = {
  视频与图片: [...VIDEO_EXT, ...IMAGE_EXT].map((ext) => ext.slice(1)),
  视频: [...VIDEO_EXT].map((ext) => ext.slice(1)),
  图片: [...IMAGE_EXT].map((ext) => ext.slice(1)),
};

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function idOf(file) {
  return 'local-' + crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * 转成和 Steam 壁纸同构的条目，这样渲染、预览、面板全都不用改。
 * dir + file（相对）保证 `/wallpapers/<id>/files/<file>` 能命中。
 */
function buildItem(file) {
  const abs = path.resolve(file);
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

class Imports {
  constructor(context) {
    this.context = context;
  }

  /** 存的是绝对路径数组，读的时候重建条目，顺带剔除已被删除的文件。 */
  paths() {
    const stored = this.context.globalState.get(STATE_KEY, []);
    return Array.isArray(stored) ? stored.filter((p) => typeof p === 'string' && p) : [];
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
    return items;
  }

  /** @returns {string[]} 真正新增的文件路径 */
  async add(files) {
    const paths = this.paths();
    const seen = new Set(paths.map((p) => p.toLowerCase()));
    const added = [];
    for (const file of files) {
      const abs = path.resolve(file);
      if (!kindOf(abs) || seen.has(abs.toLowerCase())) continue;
      seen.add(abs.toLowerCase());
      paths.push(abs);
      added.push(abs);
    }
    if (added.length) await this.context.globalState.update(STATE_KEY, paths);
    return added;
  }

  async remove(id) {
    const paths = this.paths();
    const next = paths.filter((file) => idOf(path.resolve(file)) !== id);
    if (next.length !== paths.length) {
      await this.context.globalState.update(STATE_KEY, next);
      return true;
    }
    return false;
  }
}

module.exports = { Imports, IMPORT_FILTERS, buildItem };

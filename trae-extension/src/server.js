'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.apng': 'image/apng',
  '.pkg': 'application/octet-stream',
  '.tex': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 注入脚本跑在 vscode-file:// 里，需要跨域读 /health 才能认出「这个端口是谁的」
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function isInside(root, candidate) {
  const a = path.resolve(root);
  const b = path.resolve(candidate);
  const normalize = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return normalize(b) === normalize(a) || normalize(b).startsWith(normalize(a + path.sep));
}

/** 带 Range 的静态文件响应；视频元素依赖 206 才能拖动与循环播放。 */
function serveFile(file, req, res, { noCache = false } = {}) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const total = stat.size;
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      // 视频循环播放会反复请求同一段 Range；用 no-store 时每次循环都要重新读盘，
      // 大文件在循环点会出现一次可感知的卡顿。本地文件内容不会变，允许缓存。
      // 渲染页的 live.js/live.css 会随版本更新，必须 no-store 否则浏览器会
      // 拿着旧缓存跑，修复不生效。
      'Cache-Control': noCache ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // 壁纸是本地可信资源；网页壁纸内部可能引用同源的贴图/模型文件
      'Access-Control-Allow-Origin': '*',
    };

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      let start;
      let end;
      if (m[1] === '') {
        const suffix = parseInt(m[2], 10);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      end = Math.min(end, total - 1);
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': total });
    fs.createReadStream(file).pipe(res);
  });
}

function findItem(getLibrary, id) {
  return getLibrary().find((item) => item.id === id) || null;
}

// 渲染页的 css / js 直接内联进 live.html 一起返回。
// 实测在 IDE 的 workbench iframe 里，live.html 能拿到 200，但页面随后不再发出
// 任何子资源请求（live.css / live.js 都没到服务端），脚本自然没执行，背景一片黑。
// 内联后整个页面只有一个请求，绕开这类子资源被拦的情况。
const livePageCache = { key: '', html: '' };

function readLivePage(assetsRoot) {
  const dir = path.join(assetsRoot, 'render');
  const htmlPath = path.join(dir, 'live.html');
  const cssPath = path.join(dir, 'live.css');
  const jsPath = path.join(dir, 'live.js');

  let key;
  try {
    key = [htmlPath, cssPath, jsPath].map((file) => fs.statSync(file).mtimeMs).join('-');
  } catch {
    return null;
  }
  if (livePageCache.key === key && livePageCache.html) return livePageCache.html;

  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  // 用函数式替换，避免样式/脚本里的 $& $1 之类被当成替换模式
  const out = html
    .replace('<link rel="stylesheet" href="/render/live.css" />', () => `<style>\n${css}\n</style>`)
    .replace('<script src="/render/live.js"></script>', () => `<script>\n${js}\n</script>`);

  livePageCache.key = key;
  livePageCache.html = out;
  return out;
}

// 外部导入的视频没有 preview 图，webview 里 <video> 取首帧又经常画不出来
// （不播放就只有黑块）。这里用 ffmpeg 抽一帧落盘缓存，面板当普通图片用。
// 缩略图是纯缓存，按用户约定放 D 盘；没有 D 盘再退回临时目录。
const THUMB_DIR = (() => {
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync('D:\\')) {
        return path.join('D:', 'TraeData', 'Background-Wallpaper-Engine', 'thumbs');
      }
    } catch {
      // 继续退回
    }
  }
  return path.join(os.tmpdir(), 'background-wallpaper-thumbs');
})();
const thumbJobs = new Map();

// 渲染页实测的硬解能力：null=探测中，true=能硬解（发原片），false=软解（走代理）。
// 每个 IDE 一个服务进程，这里是进程级状态，天然按 IDE 隔离。
const hwDecodeInfo = { ok: null, reason: '', ts: 0 };

function videoSourceOf(item) {
  if (item.mediaPath) return item.mediaPath;
  if (!item.dir || !item.file) return null;
  return path.join(item.dir, item.file);
}

/** 封面源文件：Steam 的 preview.gif / 导入的图片 / 视频本身。 */
function coverSourceOf(item) {
  if (item.preview) return item.preview;
  if (item.kind === 'video') return videoSourceOf(item);
  return null;
}

/**
 * 用 ffmpeg 生成一张小尺寸静态封面并落盘缓存。
 * 面板一次摆几十张卡片，Steam 的 preview.gif 常常近 1MB、1024×576，
 * 全部解码会让滚动掉帧；缩到 320px 后解码量降一个数量级。
 * @returns {Promise<string|null>} 缩略图路径；失败为 null
 */
function ensureThumb(item, width = 320) {
  const key = `${item.id}|${width}`;
  const cached = thumbJobs.get(key);
  if (cached) return cached;

  const job = new Promise((resolve) => {
    const src = coverSourceOf(item);
    if (!src) {
      resolve(null);
      return;
    }

    let srcStat;
    try {
      srcStat = fs.statSync(src);
    } catch {
      resolve(null);
      return;
    }

    let out;
    try {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      const hash = crypto
        .createHash('sha1')
        .update([item.id, src, srcStat.mtimeMs, width].join('|'))
        .digest('hex')
        .slice(0, 16);
      out = path.join(THUMB_DIR, `${hash}.jpg`);
      const st = fs.statSync(out);
      // 源文件没变就直接复用，省一次解码
      if (st.size > 0 && st.mtimeMs >= srcStat.mtimeMs) {
        resolve(out);
        return;
      }
    } catch {
      if (!out) {
        resolve(null);
        return;
      }
    }

    // 视频跳过开头那 1 秒，避免黑帧；GIF/图片直接取第一帧。
    // 注意图片不能带 -ss（这个 ffmpeg 构建会判成“没有可输出的帧”，写出空文件还返回 0）。
    const args = ['-v', 'error'];
    if (item.kind === 'video' && !item.preview) args.push('-ss', '1');
    args.push('-i', src, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-y', out);

    execFile(
      process.env.FFMPEG_PATH || 'ffmpeg',
      args,
      { timeout: 15000, windowsHide: true },
      (err) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          resolve(fs.statSync(out).size > 0 ? out : null);
        } catch {
          resolve(null);
        }
      }
    );
  });

  thumbJobs.set(key, job);
  // 失败不缓存，下次请求还能重试（比如 ffmpeg 刚好被占用）
  job.then((file) => {
    if (!file) thumbJobs.delete(key);
  });
  return job;
}

/** 视频封面：没有 preview 图时抽一帧，尺寸大一些（面板与顶部都用） */
function ensureVideoThumb(item) {
  return ensureThumb(item, 480);
}

// 视频壁纸的独立音轨。VS Code 的 Electron 不带 AAC 解码器：
// 同一支 mp4 在 Trae 里有声，在 VS Code 里画面能动但完全没声音。
// 这里把音轨抽成 Opus（Ogg）——Chromium 必然支持的免专利编码，
// 30 秒 4K 视频抽一次约 1.3 秒、384KB，渲染页用 <audio> 跟视频同步播放。
const AUDIO_DIR = (() => {
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync('D:\\')) {
        return path.join('D:', 'TraeData', 'Background-Wallpaper-Engine', 'audio');
      }
    } catch {
      // 继续退回
    }
  }
  return path.join(os.tmpdir(), 'background-wallpaper-audio');
})();
const audioJobs = new Map();

/**
 * 抽取（并缓存）视频的第一条音轨。
 * @param {object} item 壁纸条目
 * @param {string} src 视频源文件
 * @returns {Promise<string|null>} Opus 文件路径；没有音轨 / 失败为 null
 */
function ensureAudio(item, src) {
  const key = `${item.id}|${src}`;
  const cached = audioJobs.get(key);
  if (cached) return cached;

  const job = new Promise((resolve) => {
    let srcStat;
    try {
      srcStat = fs.statSync(src);
    } catch {
      resolve(null);
      return;
    }

    let out;
    try {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      const hash = crypto
        .createHash('sha1')
        .update([key, srcStat.mtimeMs, srcStat.size, 'vorbis-v1'].join('|'))
        .digest('hex')
        .slice(0, 16);
      out = path.join(AUDIO_DIR, `${hash}.ogg`);
      const st = fs.statSync(out);
      // 源文件没变就直接复用
      if (st.size > 0 && st.mtimeMs >= srcStat.mtimeMs) {
        resolve(out);
        return;
      }
    } catch {
      if (!out) {
        resolve(null);
        return;
      }
    }

    // 先写临时文件再改名：抽到一半失败不会留下能被当成缓存命中的半截音轨
    const tmp = `${out}.part`;
    execFile(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-v', 'error', '-y',
        '-i', src,
        '-vn',
        '-c:a', 'libvorbis', '-q:a', '4', '-ar', '48000', '-ac', '2',
        '-f', 'ogg', tmp,
      ],
      { timeout: 120000, windowsHide: true },
      (err) => {
        if (err) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // 临时文件可能没生成
          }
          resolve(null);
          return;
        }
        try {
          fs.renameSync(tmp, out);
          resolve(fs.statSync(out).size > 0 ? out : null);
        } catch {
          resolve(null);
        }
      }
    );
  });

  audioJobs.set(key, job);
  // 失败不缓存，下次请求还能重试（比如 ffmpeg 刚被防火墙拦住）
  job.then((file) => {
    if (!file) audioJobs.delete(key);
  });
  return job;
}

// 1080p 代理：4K / 1440p 视频铺满窗口时解码跟不上，Trae 卡顿、VS Code 直接不动。
// 首次请求后后台用 ffmpeg 生成 1080p 版本（原帧率、无音轨），缓存到 D 盘；
// 生成期间继续播原片，生成完渲染页会自动切到代理。
// 按 IDE 隔离代理缓存：VSCode 软解能力弱要降画质，但不能影响 Trae 的画质。
// appKey 由 createHandler 启动时传入，据此判断当前 server 属于哪个 IDE。
let _proxyNs = null; // 'vscode' | 'trae'
function setProxyNs(appKey) {
  _proxyNs = /code\.exe|microsoft vs code/i.test(appKey || '') ? 'vscode' : 'trae';
}
function isVSCodeHost() {
  return _proxyNs === 'vscode';
}
function getProxyDir() {
  const ns = _proxyNs || 'trae';
  let base;
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync('D:\\')) {
        base = path.join('D:', 'TraeData', 'Background-Wallpaper-Engine', 'proxy');
      }
    } catch {
      // 继续退回
    }
  }
  if (!base) base = path.join(os.tmpdir(), 'background-wallpaper-proxy');
  return path.join(base, ns);
}
const probeCache = new Map();
const proxyJobs = new Set();
// 记录每个壁纸最近一次文件请求是不是已经用了代理，
// 免得代理就绪后渲染页再白重载一次
const servedProxy = new Set();

/** 读取视频分辨率与整体码率；失败时按「不需要代理」处理。 */
function probeVideo(src) {
  return new Promise((resolve) => {
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      resolve(null);
      return;
    }
    const key = `${src}|${stat.mtimeMs}|${stat.size}`;
    if (probeCache.has(key)) {
      resolve(probeCache.get(key));
      return;
    }
    execFile(
      process.env.FFPROBE_PATH || 'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=bit_rate',
        '-of', 'json',
        src,
      ],
      { timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          probeCache.set(key, null);
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(stdout);
          const stream = (json.streams && json.streams[0]) || {};
          const info = {
            width: Number(stream.width) || 0,
            height: Number(stream.height) || 0,
            bitrate: Number(json.format && json.format.bit_rate) || 0,
          };
          probeCache.set(key, info);
          if (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value);
          resolve(info);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 查询代理状态，需要时启动后台生成。
 * 只在手动触发（面板按钮 / /proxy/<id>）或有缓存时会生成；
 * 渲染页不会自动启动。
 * @param {object} [options]
 * @param {boolean} [options.generate=true] 没有缓存时是否启动后台生成
 * @param {number} [options.height=1080] 目标高度（1080 / 720 / 480）
 * @returns {Promise<{state: 'none'|'pending'|'ready', path?: string, height?: number}>}
 */
// 把 item.id 转成可安全做文件名前缀的形式，方便 /proxy/<id>/clear 按前缀匹配删除
function safeProxyId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function proxyState(item, src, { generate = true, height = 1080 } = {}) {
  const target = Number(height) || 1080;
  return probeVideo(src).then((info) => {
    // 源高度不超过目标就直接播原片
    if (!info || !info.height || info.height <= target) return { state: 'none' };

    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      return { state: 'none' };
    }

    let out;
    try {
      fs.mkdirSync(getProxyDir(), { recursive: true });
      const hash = crypto
        .createHash('sha1')
        .update([item.id, src, stat.mtimeMs, stat.size, 'h' + target].join('|'))
        .digest('hex')
        .slice(0, 16);
      out = path.join(getProxyDir(), `${safeProxyId(item.id)}-${hash}.mp4`);
      const st = fs.statSync(out);
      if (st.size > 0) return { state: 'ready', path: out, height: target };
    } catch {
      if (!out) return { state: 'none' };
    }

    if (!generate) return { state: 'none' };
    if (proxyJobs.has(out)) return { state: 'pending', height: target };
    proxyJobs.add(out);

    const tmp = `${out}.part.mp4`;
    execFile(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-v', 'error', '-y',
        '-i', src,
        // 高度压到目标值，宽度按比例；保持原帧率
        '-vf', `scale=-2:${target}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        // 音轨由 /audio 单独提供，代理里不再重复封装
        '-an',
        '-movflags', '+faststart',
        '-f', 'mp4', tmp,
      ],
      { timeout: 30 * 60 * 1000, windowsHide: true },
      (err) => {
        proxyJobs.delete(out);
        if (err) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // 临时文件可能没生成
          }
          return;
        }
        try {
          fs.renameSync(tmp, out);
        } catch {
          // 改名失败：下次请求会重新生成
        }
      }
    );
    return { state: 'pending', height: target };
  });
}

/**
 * 视频文件服务时用：按 1080 → 720 → 480 优先级找已生成的代理缓存。
 * 找到哪个用哪个；用户生成多份时优先最高画质。
 */
function findBestProxy(item, src) {
  const heights = [1080, 720, 480];
  return heights.reduce(
    (chain, h) =>
      chain.then((found) => {
        if (found) return found;
        return proxyState(item, src, { generate: false, height: h }).then((r) =>
          r.state === 'ready' ? r : null
        );
      }),
    Promise.resolve(null)
  );
}

// 亮度分析结果（按 源文件 mtime 失效），渲染页据此自动调压暗/模糊
const analysisCache = new Map();

/**
 * 把封面缩成 32×18 灰度原始像素，算平均亮度与方差。
 * 返回 { lum: 0..1, variance: 0..1 }；方差越大说明画面越花，越难压住。
 */
function analyzeItem(item) {
  const src = coverSourceOf(item);
  if (!src) return Promise.resolve(null);

  let srcStat;
  try {
    srcStat = fs.statSync(src);
  } catch {
    return Promise.resolve(null);
  }

  const key = `${item.id}|${src}|${srcStat.mtimeMs}`;
  if (analysisCache.has(key)) return Promise.resolve(analysisCache.get(key));

  return new Promise((resolve) => {
    const args = ['-v', 'error'];
    if (item.kind === 'video' && !item.preview) args.push('-ss', '1');
    args.push('-i', src, '-frames:v', '1', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-');

    execFile(
      process.env.FFMPEG_PATH || 'ffmpeg',
      args,
      { timeout: 15000, windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err || !stdout || !stdout.length) {
          resolve(null);
          return;
        }
        let sum = 0;
        let sumSq = 0;
        const n = stdout.length;
        const values = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const v = stdout[i] / 255;
          values[i] = v;
          sum += v;
          sumSq += v * v;
        }
        const mean = sum / n;
        const variance = Math.max(0, sumSq / n - mean * mean);
        // 90 分位亮度：亮部（水花、灯光、白衣服）才是文字看不清的元凶，
        // 只取平均值会被大片暗背景稀释掉
        values.sort();
        const p90 = values[Math.min(n - 1, Math.floor(n * 0.9))];
        const result = { lum: mean, variance, p90 };
        analysisCache.set(key, result);
        // 只留最近几十条，避免切壁纸切多了越攒越多
        if (analysisCache.size > 64) {
          const oldest = analysisCache.keys().next().value;
          analysisCache.delete(oldest);
        }
        resolve(result);
      }
    );
  });
}

function createHandler({ getState, getLibrary, assetsRoot, onLog, appKey, port }) {
  const note = typeof onLog === 'function' ? onLog : () => {};
  // 启动时锁定 IDE 命名空间：决定 proxy 缓存写到 vscode/ 还是 trae/
  setProxyNs(appKey);

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    const pathname = url.pathname;

    if (pathname === '/health') {
      // app 用来区分「哪个 IDE 的服务」：Trae 和 VS Code 同时开着时都会抢 32123，
      // 只靠 ok 判断会串台，导致渲染页去读另一个 IDE 的 /state.json。
      sendJson(res, {
        ok: true,
        app: appKey || 'background-cover',
        pid: process.pid,
      });
      return;
    }

    // 渲染页的运行时诊断：把 iframe 内音频状态原样落盘，便于定位无声问题
    if (pathname === '/diag/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const file = path.join(path.dirname(THUMB_DIR), 'diag.log');
          // 轮询级诊断写入很频繁：超过 8 MB 就轮转一份，避免无限增长。
          let size = 0;
          try {
            size = fs.statSync(file).size;
          } catch {
            // 文件还不存在
          }
          if (size > 8 * 1024 * 1024) {
            // 已经膨胀到 32 MB 以上的旧文件直接清空，不再保留一份 .1，避免继续占盘
            if (size > 32 * 1024 * 1024) {
              try {
                fs.truncateSync(file, 0);
              } catch {
                // 截断失败也不影响壁纸
              }
            } else {
              const old = `${file}.1`;
              try {
                fs.rmSync(old, { force: true });
                fs.renameSync(file, old);
              } catch {
                try {
                  fs.truncateSync(file, 0);
                } catch {
                  // 截断失败也不影响壁纸
                }
              }
            }
          }
          fs.appendFileSync(file, `${new Date().toISOString()} ${body}\n`, 'utf8');
        } catch {
          // 诊断写不进去不影响壁纸
        }
        // 渲染页的硬解探测结果：step=hw-probe 时更新进程级状态并通知扩展刷新面板
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.step === 'hw-probe') {
            hwDecodeInfo.ok = parsed.ok === true;
            hwDecodeInfo.reason = parsed.reason ? String(parsed.reason) : '';
            hwDecodeInfo.ts = Date.now();
            if (typeof options.onHwState === 'function') {
              options.onHwState({ ok: hwDecodeInfo.ok, reason: hwDecodeInfo.reason, ts: hwDecodeInfo.ts });
            }
          }
        } catch {
          // body 不是合法 JSON 就忽略
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }

    // 渲染页加载时上报一次：这是判断 workbench 注入是否真的跑起来的直接证据
    if (pathname === '/diag') {
      note(`渲染页上报：${url.searchParams.get('event') || 'unknown'}`);
      sendJson(res, { ok: true });
      return;
    }

    if (pathname === '/state.json') {
      const s = getState();
      // 渲染页实测的硬解能力，一并下发（面板主要靠 webview 推送，这里给调试用）
      s.hwDecode = { ok: hwDecodeInfo.ok, reason: hwDecodeInfo.reason };
      sendJson(res, s);
      return;
    }

    if (pathname === '/manifest.json') {
      // 去掉绝对路径，避免把本机目录结构暴露给渲染页
      sendJson(
        res,
        getLibrary().map(({ dir, mediaPath, ...rest }) => rest)
      );
      return;
    }

    const engineMatch = /^\/engine\/([a-zA-Z0-9._-]+)$/.exec(pathname);
    if (engineMatch) {
      serveFile(path.join(assetsRoot, 'engine', engineMatch[1]), req, res);
      return;
    }

    const renderMatch = /^\/render\/(live\.(?:html|js|css))$/.exec(pathname);
    if (renderMatch) {
      if (renderMatch[1] === 'live.html') {
        // 注入脚本会把本 IDE 的 app 标识带在 URL 上。端口被另一个 IDE 的服务占着时
        // 回一个会 postMessage 的小页面，父页面据此立刻换端口 —— workbench 的 CSP
        // 不允许 fetch localhost，所以只能借 iframe 来区分「这个端口是不是我的」。
        const expect = url.searchParams.get('app');
        if (expect && appKey && expect !== appKey) {
          // 端口被另一个 IDE 的服务占着：返回一个会立刻 postMessage 的小页面，
          // 注入脚本收到 wrongApp 就能马上换端口，不用再等 4 秒超时。
          const body = Buffer.from(
            '<!doctype html><meta charset="utf-8"><script>' +
              "parent.postMessage({channel:'backgroundcover',type:'wrongApp',port:" +
              JSON.stringify(port || 0) +
              "},'*');" +
            '</script>',
            'utf8'
          );
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(body);
          return;
        }
        note('渲染页 live.html 被请求（注入已生效）');
        const page = readLivePage(assetsRoot);
        if (page) {
          const body = Buffer.from(page, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(body);
          return;
        }
      } else {
        note(`渲染页 ${renderMatch[1]} 被请求`);
      }
      serveFile(path.join(assetsRoot, 'render', renderMatch[1]), req, res, { noCache: true });
      return;
    }

    const analysisMatch = /^\/analysis\/([^/]+)$/.exec(pathname);
    if (analysisMatch) {
      let id;
      try {
        id = decodeURIComponent(analysisMatch[1]);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      const item = findItem(getLibrary, id);
      if (!item) {
        sendJson(res, { ok: false }, 404);
        return;
      }
      const result = await analyzeItem(item);
      sendJson(
        res,
        result ? { ok: true, lum: result.lum, variance: result.variance, p90: result.p90 } : { ok: false }
      );
      return;
    }

    const previewMatch = /^\/preview\/([^/]+)$/.exec(pathname);
    if (previewMatch) {
      let id;
      try {
        id = decodeURIComponent(previewMatch[1]);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      const item = findItem(getLibrary, id);
      if (!item) {
        res.writeHead(404).end('no preview');
        return;
      }
      if (item.preview || item.kind === 'video') {
        // 面板缩略图：?w=320 时返回 ffmpeg 缩放后的静态小图（缓存复用），
        // 不带参数仍给原始封面（悬停时换回动画 GIF）
        const width = parseInt(url.searchParams.get('w') || '', 10);
        if (Number.isFinite(width) && width >= 64) {
          const thumb = await ensureThumb(item, Math.min(width, 1280));
          if (thumb) {
            serveFile(thumb, req, res);
            return;
          }
        }
      }
      if (item.preview) {
        serveFile(item.preview, req, res);
        return;
      }
      // 没有封面图的视频就地抽一帧
      if (item.kind === 'video') {
        const thumb = await ensureVideoThumb(item);
        if (thumb) {
          serveFile(thumb, req, res);
          return;
        }
      }
      res.writeHead(404).end('no preview');
      return;
    }

    // 视频壁纸的独立音轨：原生 AAC 解不了的 IDE（VS Code）改播这个
    const audioMatch = /^\/audio\/([^/]+)$/.exec(pathname);
    if (audioMatch) {
      let id;
      try {
        id = decodeURIComponent(audioMatch[1]);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      const item = findItem(getLibrary, id);
      const src = item ? videoSourceOf(item) : null;
      if (!item || item.kind !== 'video' || !src) {
        res.writeHead(404).end('no audio');
        return;
      }
      const audio = await ensureAudio(item, src);
      if (!audio) {
        res.writeHead(404).end('no audio');
        return;
      }
      serveFile(audio, req, res);
      return;
    }

    // 清除某壁纸的所有代理缓存（用户在下拉框选"原视频"时调用）
    const proxyClearMatch = /^\/proxy\/([^/]+)\/clear$/.exec(pathname);
    if (proxyClearMatch) {
      let id;
      try {
        id = decodeURIComponent(proxyClearMatch[1]);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      const prefix = safeProxyId(id) + '-';
      let removed = 0;
      const dir = getProxyDir();
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(prefix) && f.endsWith('.mp4')) {
            try {
              fs.unlinkSync(path.join(dir, f));
              removed++;
            } catch {
              // 单个文件删不掉不影响其他
            }
          }
        }
      } catch {
        // 目录还没建
      }
      servedProxy.delete(id);
      sendJson(res, { state: 'cleared', removed });
      return;
    }

    // 代理：面板按钮点进来（手动触发），每次都可能启动后台生成；
    // 渲染页不会主动请求这个端点。
    const proxyMatch = /^\/proxy\/([^/]+)$/.exec(pathname);
    if (proxyMatch) {
      let id;
      try {
        id = decodeURIComponent(proxyMatch[1]);
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      const item = findItem(getLibrary, id);
      const src = item ? videoSourceOf(item) : null;
      if (!item || item.kind !== 'video' || !src) {
        sendJson(res, { state: 'none' });
        return;
      }
      // 面板可带 ?h=720 选目标画质；默认 1080
      let height = 1080;
      try {
        const u = new URL(req.url, 'http://x');
        const h = Number(u.searchParams.get('h'));
        if ([1080, 720, 480].includes(h)) height = h;
      } catch {
        // 解析失败用默认
      }
      const pstate = await proxyState(item, src, { generate: true, height });
      sendJson(
        res,
        pstate.state === 'ready'
          ? { state: 'ready', served: servedProxy.has(item.id), height: pstate.height }
          : { state: pstate.state, height: pstate.height }
      );
      return;
    }

    const filesMatch = /^\/wallpapers\/([^/]+)\/files\/(.*)$/.exec(pathname);
    if (filesMatch) {
      let id;
      let rel;
      try {
        id = decodeURIComponent(filesMatch[1]);
        rel = filesMatch[2]
          .split('/')
          .map((part) => decodeURIComponent(part))
          .join('/');
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      if (rel.includes('\0')) {
        res.writeHead(400).end('bad request');
        return;
      }
      const item = findItem(getLibrary, id);
      if (!item) {
        res.writeHead(404).end('unknown wallpaper');
        return;
      }
      // 导入的壁纸只暴露被选中的文件（手机包转换后是 scene.pkg + project.json），
      // 不允许翻同级目录；网页壁纸是整份目录（dirScoped），目录内的资源都要放行
      if (item.imported && !item.dirScoped) {
        const allowed = Array.isArray(item.files) ? item.files : [item.file];
        if (rel !== item.file && !allowed.includes(rel)) {
          res.writeHead(403).end('forbidden');
          return;
        }
      }
      // 只允许访问壁纸目录内部，任何 ../ 逃逸都拒绝
      const full = path.resolve(item.dir, rel.replace(/^\/+/, ''));
      if (!isInside(item.dir, full)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      // 网页壁纸改完要立刻生效：html / js / css 这类文本资源每次都重新验证，
      // 否则浏览器会拿 1 小时前的旧脚本（比如缺了音频挂载逻辑的那版）。
      // 图片、音视频仍走默认缓存，避免反复读盘。
      // 视频主文件：如果有缓存的 1080p 代理（用户手动生成过）就发代理，
      // 否则始终发原片。始终 no-store：浏览器别一直用 1 小时前的旧文件。
      if (item.kind === 'video' && item.file && full === path.resolve(item.dir, item.file)) {
        // 渲染页实测确认能硬解（src 带 hw=1）：直接发原片，不查代理、不生成代理，
        // 让原生 <video> 走 GPU 硬解。没带 hw=1 才走下方代理软解兜底。
        let hwDecode = false;
        try {
          const u = new URL(req.url, 'http://x');
          hwDecode = u.searchParams.get('hw') === '1';
        } catch {
          // 解析失败按不能硬解处理，走代理兜底
        }
        if (hwDecode) {
          servedProxy.delete(item.id);
          serveFile(full, req, res, { noCache: true });
          return;
        }
        const proxy = await findBestProxy(item, full);
        if (proxy && proxy.path) {
          servedProxy.add(item.id);
          serveFile(proxy.path, req, res, { noCache: true });
          return;
        }
        // VSCode 软解能力弱：没缓存就后台启动 720p 生成，这次先播原片；
        // 渲染页会轮询 /proxy/<id>?h=720 状态，ready 后自动切换
        if (isVSCodeHost()) {
          proxyState(item, full, { generate: true, height: 720 }).catch(() => {});
        }
        servedProxy.delete(item.id);
        serveFile(full, req, res, { noCache: true });
        return;
      }
      const refreshable = /\.(?:html?|js|mjs|css|json|svg)$/i.test(rel);
      serveFile(full, req, res, { noCache: refreshable });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}

function startServer(options) {
  const handler = createHandler(options);
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('internal error: ' + String(err && err.message ? err.message : err));
      } catch {
        // 响应已发出，忽略
      }
    });
  });

  // 关闭时不要挂住进程（扩展宿主退出时窗口可能已经没了）
  server.keepAliveTimeout = 5000;

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, '127.0.0.1');
  });
}

/**
 * 探测端口上是否已经有本扩展的服务，用于多窗口共享同一个服务实例。
 * 传了 appKey 时只认同一个 IDE 的服务，避免 Trae / VS Code 互相复用。
 */
function probeServer(port, appKey, timeoutMs = 1500) {
  if (typeof appKey === 'number') {
    timeoutMs = appKey;
    appKey = null;
  }
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (!value || !value.ok) {
              resolve(null);
              return;
            }
            // 老版本服务不带 app 字段：只有不校验时才认
            if (appKey && value.app !== appKey) {
              resolve(null);
              return;
            }
            resolve(value);
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

module.exports = { startServer, probeServer };

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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
function serveFile(file, req, res) {
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
      'Cache-Control': 'public, max-age=3600',
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

function createHandler({ getState, getLibrary, assetsRoot, onLog }) {
  const note = typeof onLog === 'function' ? onLog : () => {};

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
      sendJson(res, { ok: true, app: 'background-cover' });
      return;
    }

    // 渲染页加载时上报一次：这是判断 workbench 注入是否真的跑起来的直接证据
    if (pathname === '/diag') {
      note(`渲染页上报：${url.searchParams.get('event') || 'unknown'}`);
      sendJson(res, { ok: true });
      return;
    }

    if (pathname === '/state.json') {
      sendJson(res, getState());
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
      if (renderMatch[1] === 'live.html') note('渲染页 live.html 被请求（注入已生效）');
      serveFile(path.join(assetsRoot, 'render', renderMatch[1]), req, res);
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
      if (!item || !item.preview) {
        res.writeHead(404).end('no preview');
        return;
      }
      serveFile(item.preview, req, res);
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
      // 导入的壁纸只暴露被选中的那一个文件，不允许翻同级目录
      if (item.imported && rel !== item.file) {
        res.writeHead(403).end('forbidden');
        return;
      }
      // 只允许访问壁纸目录内部，任何 ../ 逃逸都拒绝
      const full = path.resolve(item.dir, rel.replace(/^\/+/, ''));
      if (!isInside(item.dir, full)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      serveFile(full, req, res);
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

/** 探测端口上是否已经有本扩展的服务，用于多窗口共享同一个服务实例。 */
function probeServer(port, timeoutMs = 1500) {
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
            resolve(value && value.app === 'background-cover' ? value : null);
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

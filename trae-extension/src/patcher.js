'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MARKER } = require('./config');

// VS Code 系（含 Trae）不同版本放过这个文件的目录，逐一探测而不是写死
const CANDIDATES = [
  'out/vs/code/electron-browser/workbench/workbench.html',
  'out/vs/code/electron-sandbox/workbench/workbench.html',
  'out/vs/code/electron-browser/workbench/workbench.esm.html',
  'out/vs/code/electron-sandbox/workbench/workbench.esm.html',
];

const END_TAG = `<!-- ${MARKER}-end -->`;
const START_RE = new RegExp(`<!-- ${MARKER}-start (\\S+) csp=(\\S+) -->`);

function findWorkbenchHtml(appRoot) {
  if (!appRoot) return null;
  for (const rel of CANDIDATES) {
    const file = path.join(appRoot, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function startTag(stamp, cspAdded) {
  return `<!-- ${MARKER}-start ${stamp} csp=${cspAdded.join('+') || 'none'} -->`;
}

/** 读回上一次注入时真的放宽了哪些 CSP 指令，移除时只还原这些。 */
function readPatchInfo(html) {
  const m = html.match(START_RE);
  if (!m) return null;
  return { stamp: m[1], cspAdded: m[2] === 'none' ? [] : m[2].split('+') };
}

function stripBlock(html) {
  return html.replace(
    new RegExp(`\\n?<!-- ${MARKER}-start [^>]*-->[\\s\\S]*?<!-- ${MARKER}-end -->`, 'g'),
    ''
  );
}

// 每条指令整段匹配（名字 + 取值列表到分号），避免命中别处的同名片段
function editDirective(html, directive, edit) {
  const re = new RegExp(`${directive}([^;]*)`);
  const m = re.exec(html);
  if (!m) return { html, changed: false, missing: true };
  const body = edit(m[1]);
  if (body === m[1]) return { html, changed: false, missing: false };
  const head = m[0].slice(0, m[0].length - m[1].length);
  const out = html.slice(0, m.index) + head + body + html.slice(m.index + m[0].length);
  return { html: out, changed: true, missing: false };
}

/**
 * workbench 页面要能加载我们的 iframe（frame-src 允许 127.0.0.1 任意端口）、
 * 执行注入的内联脚本（script-src 'unsafe-inline'）。
 *
 * Trae 的 workbench.html 默认已带这两项，正常情况下这里不会改动任何东西；
 * 其它 VS Code 构建若缺失，则只补缺失值，并把补过的记进注入块，移除时精确还原。
 */
function relaxCsp(html) {
  let out = html;
  const added = [];

  let r = editDirective(out, 'script-src', (body) =>
    body.includes(`'unsafe-inline'`) ? body : ` 'unsafe-inline'` + body
  );
  if (r.missing) {
    return { ok: false, reason: 'workbench.html 的 CSP 里没有 script-src，无法注入' };
  }
  out = r.html;
  if (r.changed) added.push('script');

  r = editDirective(out, 'frame-src', (body) =>
    body.includes('http://127.0.0.1:*') ? body : `${body.trim()} http://127.0.0.1:*`
  );
  if (r.missing) {
    // 没有 frame-src 时浏览器会回落到 default-src，注入无法工作，直接如实报错
    return { ok: false, reason: 'workbench.html 的 CSP 里没有 frame-src，无法加载渲染页' };
  }
  out = r.html;
  if (r.changed) added.push('frame');

  return { ok: true, html: out, added };
}

function revertCsp(html, cspAdded) {
  let out = html;
  if (cspAdded.includes('script')) {
    out = editDirective(out, 'script-src', (body) => body.replace(' \'unsafe-inline\'', '')).html;
  }
  if (cspAdded.includes('frame')) {
    out = editDirective(out, 'frame-src', (body) => body.replace(/\s+http:\/\/127\.0\.0\.1:\*/g, '')).html;
  }
  return out;
}

function safeStamp(stamp) {
  return String(stamp).replace(/[^A-Za-z0-9._-]/g, '_');
}

function backupPath(target, stamp) {
  return `${target}.${MARKER}-${safeStamp(stamp)}.bak`;
}

function writeAtomic(file, content) {
  const tmp = `${file}.${MARKER}-tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件清不掉也不影响主流程
    }
    throw err;
  }
}

/**
 * product.json 里登记了 workbench.html 的完整性校验值
 * （SHA-256 → base64，再去掉尾部的 `=`）。
 */
function checksumOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64').replace(/=/g, '');
}

/**
 * 校验清单里的键是相对 `out/` 的 posix 路径（product.json 的写法：
 * vs/code/electron-browser/workbench/workbench.html），个别构建也可能相对 appRoot，两种都算。
 */
function candidateKeys(appRoot, target) {
  return [
    path.relative(path.join(appRoot, 'out'), target).split(path.sep).join('/'),
    path.relative(appRoot, target).split(path.sep).join('/'),
  ];
}

function readProduct(appRoot) {
  const file = path.join(appRoot, 'product.json');
  if (!fs.existsSync(file)) return { ok: true, file, product: null };
  try {
    return { ok: true, file, product: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: `product.json 解析失败：${err.message}` };
  }
}

function writeProduct(file, product) {
  let text;
  try {
    const original = fs.readFileSync(file, 'utf8');
    text = JSON.stringify(product, null, '\t') + (original.endsWith('\n') ? '\n' : '');
  } catch {
    text = JSON.stringify(product, null, '\t') + '\n';
  }
  writeAtomic(file, text);
}

/**
 * 把 workbench.html 从校验清单里摘掉（直接删掉这个键）。
 *
 * 为什么不是“把校验值改成新内容的哈希”：`productService.checksums` 是主进程
 * 启动时读进内存的，之后无论重载窗口多少次都不会重读 product.json。于是改完
 * 文件后，当前会话里内存中仍是旧哈希，照样会弹“安装似乎损坏”。
 * 删掉键以后，校验清单里干脆没有这个文件，重启一次即永久生效，
 * 以后无论注入内容怎么变都不会再被校验。
 */
function detachChecksum(appRoot, target) {
  const read = readProduct(appRoot);
  if (!read.ok) return read;
  if (!read.product) return { ok: true, state: 'skipped' };

  const checksums = read.product.checksums;
  if (!checksums || typeof checksums !== 'object') return { ok: true, state: 'skipped' };

  const keys = candidateKeys(appRoot, target).filter((key) =>
    Object.prototype.hasOwnProperty.call(checksums, key)
  );
  if (!keys.length) return { ok: true, state: 'absent' };

  for (const key of keys) delete checksums[key];
  try {
    writeProduct(read.file, read.product);
  } catch (err) {
    return { ok: false, reason: `写入 product.json 失败：${err.message}${permissionHint(err)}` };
  }
  return { ok: true, state: 'detached' };
}

/** 移除注入时把校验项补回去：用还原后的真实内容算值，让两边重新自洽。 */
function attachChecksum(appRoot, target, content) {
  const read = readProduct(appRoot);
  if (!read.ok) return read;
  if (!read.product) return { ok: true, state: 'skipped' };

  const checksums = read.product.checksums;
  if (!checksums || typeof checksums !== 'object') return { ok: true, state: 'skipped' };

  const key = candidateKeys(appRoot, target)[0];
  const next = checksumOf(content);
  if (checksums[key] === next) return { ok: true, state: 'unchanged' };

  checksums[key] = next;
  try {
    writeProduct(read.file, read.product);
  } catch (err) {
    return { ok: false, reason: `写入 product.json 失败：${err.message}${permissionHint(err)}` };
  }
  return { ok: true, state: 'attached' };
}

function ensureBackup(target, stamp, pristine) {
  const bak = backupPath(target, stamp);
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, pristine, 'utf8');

  // 清掉旧版本留下的备份：它们对应的是已被覆盖的旧 workbench.html
  const dir = path.dirname(target);
  const base = path.basename(target);
  const keep = path.basename(bak);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${base}.${MARKER}-`) && name.endsWith('.bak') && name !== keep) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // 删不掉就算了，不影响注入
      }
    }
  }
}

function permissionHint(err) {
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    return ' 请以管理员身份启动 IDE，或给该文件写权限。';
  }
  return '';
}

/**
 * 先摘掉校验项，再落盘 html。
 *
 * 顺序很关键：校验项先没了，就不会出现“html 已改、清单还指着旧哈希”的中间态。
 * 万一 html 写入失败，把校验项按磁盘上的实际内容补回去，保持自洽。
 */
function commit(appRoot, target, text) {
  let before;
  try {
    before = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, reason: `读取 ${target} 失败：${err.message}${permissionHint(err)}` };
  }

  const detached = detachChecksum(appRoot, target);
  if (!detached.ok) return { ok: false, reason: detached.reason };

  try {
    writeAtomic(target, text);
  } catch (err) {
    attachChecksum(appRoot, target, before);
    return { ok: false, reason: `写入 ${target} 失败：${err.message}${permissionHint(err)}` };
  }

  return { ok: true, checksum: detached.state };
}

/** 还原时反过来：先按还原后的内容补回校验项，再落盘。 */
function restoreCommit(appRoot, target, text) {
  let before;
  try {
    before = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, reason: `读取 ${target} 失败：${err.message}${permissionHint(err)}` };
  }

  const attached = attachChecksum(appRoot, target, text);
  if (!attached.ok) return { ok: false, reason: attached.reason };

  try {
    writeAtomic(target, text);
  } catch (err) {
    attachChecksum(appRoot, target, before);
    return { ok: false, reason: `写入 ${target} 失败：${err.message}${permissionHint(err)}` };
  }

  return { ok: true, checksum: attached.state };
}

/**
 * 修复历史遗留状态：workbench.html 里有我们的注入块，但 product.json 里仍登记着
 * 它的校验值。这种情况每次启动都会弹“安装似乎损坏”，必须把校验项摘掉。
 */
function verifyChecksum(appRoot) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return { ok: true, state: 'skipped' };
  try {
    const html = fs.readFileSync(target, 'utf8');
    // 没注入过就不动校验清单，避免无谓地削弱 IDE 自身的完整性保护
    if (!readPatchInfo(html)) return { ok: true, state: 'skipped' };
    return detachChecksum(appRoot, target);
  } catch (err) {
    return { ok: false, reason: `读取 ${target} 失败：${err.message}` };
  }
}

/**
 * 把注入块写进 workbench.html。先剥掉自己上一次的注入再重新计算 CSP，
 * 避免重复注入时把「已经宽松」误记成「本次放宽」。
 */
function apply(appRoot, script, stamp) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) {
    return { ok: false, reason: '找不到 workbench.html（appRoot=' + appRoot + '）' };
  }

  let html;
  try {
    html = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, reason: `读取 ${target} 失败：${err.message}` };
  }

  const previous = readPatchInfo(html);
  const clean = revertCsp(stripBlock(html), previous ? previous.cspAdded : []);

  const relaxed = relaxCsp(clean);
  if (!relaxed.ok) return { ok: false, reason: relaxed.reason };
  let out = relaxed.html;

  const block = [
    startTag(safeStamp(stamp), relaxed.added),
    `<script>${script}</script>`,
    END_TAG,
    '</html>',
  ].join('\n');

  // 用 lastIndexOf 而不是 replace：replace 只认第一个 </html>，而真正的闭合标签是最后一个；
  // 字符串替换还会展开 $& 之类的占位符，生成代码不该被扫描。
  const at = out.lastIndexOf('</html>');
  if (at < 0) return { ok: false, reason: 'workbench.html 里没有 </html>' };
  out = out.slice(0, at) + block + out.slice(at + '</html>'.length);

  try {
    ensureBackup(target, stamp, clean);
  } catch (err) {
    return { ok: false, reason: `写入备份失败：${err.message}${permissionHint(err)}` };
  }

  // 改了 html 就必须把它的校验项从 product.json 里摘掉，否则 Trae 会提示安装损坏
  const result = commit(appRoot, target, out);
  if (!result.ok) return { ok: false, reason: result.reason };

  return { ok: true, target, checksum: result.checksum };
}

/** 只移除自己的注入块并还原自己放宽过的 CSP，不整文件覆盖。 */
function remove(appRoot) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return { ok: true, target: null };

  try {
    const html = fs.readFileSync(target, 'utf8');
    const info = readPatchInfo(html);
    if (info) {
      const restored = revertCsp(stripBlock(html), info.cspAdded);
      // 还原后把校验项按真实内容补回去，恢复成“未修改”的等价状态
      const result = restoreCommit(appRoot, target, restored);
      if (!result.ok) return { ok: false, reason: result.reason };
      const bak = backupPath(target, info.stamp);
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
    }
  } catch (err) {
    return { ok: false, reason: `还原失败：${err.message}${permissionHint(err)}` };
  }
  return { ok: true, target };
}

/** workbench.html 里只有当前构建（版本 + 端口）的注入块才算已注入。 */
function isPatched(appRoot, stamp) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return false;
  try {
    const info = readPatchInfo(fs.readFileSync(target, 'utf8'));
    return !!info && info.stamp === safeStamp(stamp);
  } catch {
    return false;
  }
}

module.exports = { apply, remove, isPatched, verifyChecksum, findWorkbenchHtml, MARKER };

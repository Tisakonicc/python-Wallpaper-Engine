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
// 注入脚本的修订号：只有运行时脚本本身发生必须更新 html 的变化时才加 1。
// 与扩展版本解耦，避免每次升级都重写 workbench.html（Trae 每次启动都会把
// product.json 的校验项补回来，反复重写只会陷入「提示完全重启」的循环）。
const RUNTIME_REV = '6';
const START_RE = new RegExp(`<!-- ${MARKER}-start (\\S+)(?: rev=(\\S+))? csp=(\\S+) -->`);

function findWorkbenchHtml(appRoot) {
  if (!appRoot) return null;
  for (const rel of CANDIDATES) {
    const file = path.join(appRoot, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function startTag(stamp, cspAdded) {
  return `<!-- ${MARKER}-start ${stamp} rev=${RUNTIME_REV} csp=${cspAdded.join('+') || 'none'} -->`;
}

/** 读回上一次注入时真的放宽了哪些 CSP 指令，移除时只还原这些。 */
function readPatchInfo(html) {
  const m = html.match(START_RE);
  if (!m) return null;
  return {
    stamp: m[1],
    rev: m[2] || '',
    cspAdded: m[3] === 'none' ? [] : m[3].split('+'),
  };
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
  // edit 函数可能 trim 过 body 首部的 whitespace，导致指令名和值粘在一起
  // （比如 "frame-src'self'" 被当成一个指令名），必须保证至少有一个空格
  const sep = (body.length && !/\s/.test(body.charAt(0))) ? ' ' : '';
  const out = html.slice(0, m.index) + head + sep + body + html.slice(m.index + m[0].length);
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

  let r = editDirective(out, 'script-src', (body) => {
    if (body.includes("'unsafe-inline'")) return body;
    // body 是指令名之后的内容（通常以 whitespace 开头），直接在首部加 'unsafe-inline' 即可
    return " 'unsafe-inline'" + body;
  });
  if (r.missing) {
    return { ok: false, reason: 'workbench.html 的 CSP 里没有 script-src，无法注入' };
  }
  out = r.html;
  if (r.changed) added.push('script');

  r = editDirective(out, 'frame-src', (body) => {
    if (body.includes('http://127.0.0.1:*')) return body;
    // 保留原有格式：body 通常以 whitespace 开头，直接追加即可
    return body.replace(/\s*$/, '') + ' http://127.0.0.1:*';
  });
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
    out = editDirective(out, 'script-src', (body) => body.replace(/\s+'unsafe-inline'/g, '')).html;
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
  if (!fs.existsSync(file)) return { ok: true, file, product: null, newline: true };
  try {
    const original = fs.readFileSync(file, 'utf8');
    // 记住原文件是否以换行结尾，写回时直接复用，避免为了这一位再读一遍 78 KB
    return { ok: true, file, product: JSON.parse(original), newline: original.endsWith('\n') };
  } catch (err) {
    return { ok: false, reason: `product.json 解析失败：${err.message}` };
  }
}

function writeProduct(file, product, newline) {
  const text = JSON.stringify(product, null, '\t') + (newline ? '\n' : '');
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
    writeProduct(read.file, read.product, read.newline);
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
    writeProduct(read.file, read.product, read.newline);
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

  // 第一次注入：只摘掉校验项，本次会话先不改 html。
  // 主进程在启动时就把 product.json 的校验清单读进了内存，本次会话里改 html
  // 必然对不上，启动约半分钟后 IDE 一定会弹一次“安装似乎损坏”。
  // 拆成“先摘校验项 → 完全重启 → 再写 html”两步，这条提示就永远不会出现。
  if (!previous) {
    const detached = detachChecksum(appRoot, target);
    if (!detached.ok) return { ok: false, reason: detached.reason };
    if (detached.state === 'detached') return { ok: true, staged: true, target };
  }

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
    } else {
      // 只走过第一步（摘校验项）、还没写入注入块：文件本身没动过，
      // 把校验项按原内容补回去，恢复成完整的“未修改”状态。
      const attached = attachChecksum(appRoot, target, html);
      if (!attached.ok) return { ok: false, reason: attached.reason };
    }
  } catch (err) {
    return { ok: false, reason: `还原失败：${err.message}${permissionHint(err)}` };
  }
  return { ok: true, target };
}

/**
 * 当前扩展是否处于「已卸载、等待删除」状态。
 *
 * 卸载（以及升级替换旧版本）时，IDE 会往 <extensions>/.obsolete 写一条
 * `"<publisher>.<name>-<version>": true`，真正的目录删除发生在下一次启动。
 * 禁用扩展、正常退出、重载窗口都不会写这个标记，所以它能精确区分「卸载」。
 *
 * @param {string} extensionPath 正在运行的扩展目录（context.extensionPath）
 * @returns {boolean}
 */
function isUninstallPending(extensionPath) {
  if (!extensionPath) return false;
  const dir = path.dirname(extensionPath);
  const name = path.basename(extensionPath);
  const file = path.join(dir, '.obsolete');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 文件不存在 / 解析失败：按「不是卸载」处理，宁可少清理也不要误还原
    return false;
  }
  if (!data || typeof data !== 'object') return false;

  const isMarked = (key) =>
    Object.keys(data).some((k) => k.toLowerCase() === key.toLowerCase() && !!data[k]);
  if (!isMarked(name)) return false;

  // 升级时 IDE 也会把旧版本目录标成 obsolete，但同时已经装好了新版本目录。
  // 只要还有同名、未被标记的版本目录在，就是升级而不是卸载：不要还原注入，
  // 否则每次升级都要重新走一遍“完全重启 + 重载窗口”。
  const prefix = name.replace(/-\d+\.\d+\.\d+.*$/, '');
  try {
    const siblings = fs.readdirSync(dir);
    for (const sibling of siblings) {
      if (sibling === name) continue;
      if (!sibling.startsWith(`${prefix}-`)) continue;
      if (!isMarked(sibling)) return false;
    }
  } catch {
    // 目录读不了就按卸载处理，保持原来的行为
  }
  return true;
}

/**
 * workbench.html 里有我们「当前修订号」的注入块才算已注入。
 *
 * 渲染页脚本（live.js）由本地服务按需下发，扩展升级后页面拿到的就是新脚本，
 * 不需要改写 workbench.html。只有注入脚本本身需要更新时才把 RUNTIME_REV 加 1，
 * 触发一次重写；这样普通升级不会再改写 html，也就不会反复提示重启。
 */
function isPatched(appRoot) {
  const target = findWorkbenchHtml(appRoot);
  if (!target) return false;
  try {
    const info = readPatchInfo(fs.readFileSync(target, 'utf8'));
    return !!info && info.rev === RUNTIME_REV;
  } catch {
    return false;
  }
}

/**
 * VS Code 给主窗口写死了 `autoplayPolicy: "user-gesture-required"`，
 * 背景 iframe 为了不挡编辑器点击是 pointer-events: none，永远拿不到用户手势，
 * 于是带音轨的壁纸会被自动播放策略拒绝，只能静音兜底。
 * Trae 用的是 `no-user-gesture-required`，所以同一个壁纸在 Trae 有声、VS Code 无声。
 *
 * 这里只改主窗口那一处（和 enableBlinkFeatures:"HighlightAPI" 相邻的唯一匹配），
 * 不碰其它窗口/离屏页面的策略。mainImpl.js 目前不在 product.json 校验清单里；
 * 万一将来被纳入，这里按和 workbench.html 相同的方式摘掉校验项。
 */
const AUTOPLAY_ON = 'autoplayPolicy:"user-gesture-required",enableBlinkFeatures:"HighlightAPI"';
const AUTOPLAY_OFF = 'autoplayPolicy:"no-user-gesture-required",enableBlinkFeatures:"HighlightAPI"';

function findMainWindowFile(appRoot) {
  if (!appRoot) return null;
  for (const rel of ['out/mainImpl.js', 'out/main.js']) {
    const file = path.join(appRoot, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function applyAutoplayPolicy(appRoot) {
  const target = findMainWindowFile(appRoot);
  if (!target) return { ok: true, state: 'skipped', reason: '找不到主进程入口' };

  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, reason: `读取 ${target} 失败：${err.message}${permissionHint(err)}` };
  }

  if (text.includes(AUTOPLAY_OFF)) return { ok: true, state: 'already', target };

  const count = text.split(AUTOPLAY_ON).length - 1;
  if (count !== 1) {
    return {
      ok: true,
      state: 'skipped',
      reason: `主窗口自动播放策略匹配到 ${count} 处，跳过`,
      target,
    };
  }

  const detached = detachChecksum(appRoot, target);
  if (!detached.ok) return { ok: false, reason: detached.reason };

  try {
    writeAtomic(target, text.replace(AUTOPLAY_ON, AUTOPLAY_OFF));
  } catch (err) {
    return { ok: false, reason: `写入 ${target} 失败：${err.message}${permissionHint(err)}` };
  }
  return { ok: true, state: 'patched', target };
}

function restoreAutoplayPolicy(appRoot) {
  const target = findMainWindowFile(appRoot);
  if (!target) return { ok: true, state: 'skipped' };

  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { ok: false, reason: `读取 ${target} 失败：${err.message}${permissionHint(err)}` };
  }
  if (!text.includes(AUTOPLAY_OFF)) return { ok: true, state: 'absent', target };

  const next = text.replace(AUTOPLAY_OFF, AUTOPLAY_ON);
  const read = readProduct(appRoot);
  const keys =
    read.ok && read.product && read.product.checksums
      ? candidateKeys(appRoot, target).filter((key) =>
          Object.prototype.hasOwnProperty.call(read.product.checksums, key)
        )
      : [];
  if (keys.length) {
    const attached = attachChecksum(appRoot, target, next);
    if (!attached.ok) return { ok: false, reason: attached.reason };
  }

  try {
    writeAtomic(target, next);
  } catch (err) {
    return { ok: false, reason: `写入 ${target} 失败：${err.message}${permissionHint(err)}` };
  }
  return { ok: true, state: 'restored', target };
}

module.exports = {
  apply,
  remove,
  isPatched,
  isUninstallPending,
  verifyChecksum,
  findWorkbenchHtml,
  applyAutoplayPolicy,
  restoreAutoplayPolicy,
  MARKER,
};

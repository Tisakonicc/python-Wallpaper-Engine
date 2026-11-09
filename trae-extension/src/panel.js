'use strict';

/**
 * 壁纸选择面板（webview）。
 *
 * 用户不想用命令面板，所以这里做一个带缩略图网格的可视化面板：
 * 顶部是当前壁纸 + 暂停/刷新/清除，下面是「壁纸 / 外观 / 播放」三个标签页。
 * 面板只负责展示与收集操作，真正的落盘（写配置、扫描、注入）都在扩展里做。
 */

const crypto = require('node:crypto');
const vscode = require('vscode');

const KIND_LABEL = {
  video: '视频',
  scene: '场景',
  web: '网页',
  image: '图片',
};

function nonce() {
  return crypto.randomBytes(16).toString('base64');
}

const STYLE = `
:root {
  color-scheme: light dark;
  --card-radius: 8px;
  --badge-video: #3b82f6;
  --badge-scene: #f59e0b;
  --badge-web: #a855f7;
  --badge-image: #10b981;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 8px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.app { display: flex; flex-direction: column; min-height: 100vh; padding: 14px 16px 0; gap: 12px; }

.current {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  border-radius: 10px;
  background: var(--vscode-sideBar-background, rgba(128,128,128,.08));
}
.current .thumb {
  width: 96px; height: 54px; flex: 0 0 auto;
  border-radius: 6px; overflow: hidden;
  background: rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.current .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.current .meta { min-width: 0; flex: 1 1 auto; }
.current .meta .title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.current .meta .sub { margin-top: 3px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.actions { display: flex; gap: 8px; flex: 0 0 auto; }

button {
  font: inherit;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.ghost {
  color: var(--vscode-foreground);
  background: transparent;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
}
button.ghost:hover { background: rgba(128,128,128,.14); }
button:disabled { opacity: .45; cursor: default; }

.tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  border-radius: 8px;
  overflow: hidden;
}
.tab {
  background: transparent;
  color: var(--vscode-foreground);
  border: 0;
  border-radius: 0;
  padding: 9px 0;
  font-weight: 600;
}
.tab:hover { background: rgba(128,128,128,.12); }
.tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.tab.active:hover { background: var(--vscode-button-hoverBackground); }

.page { display: flex; flex-direction: column; gap: 12px; }
.page[hidden] { display: none; }

.toolbar { display: flex; gap: 8px; align-items: center; }
input[type="search"], select {
  font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 6px;
  padding: 6px 9px;
  outline: none;
}
input[type="search"] { flex: 1 1 auto; min-width: 0; }
select { flex: 0 0 auto; }
.count { flex: 0 0 auto; font-size: 12px; color: var(--vscode-descriptionForeground); }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 10px;
}
.card {
  position: relative;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
  border-radius: var(--card-radius);
  overflow: hidden;
  cursor: pointer;
  background: rgba(0,0,0,.2);
  padding: 0;
  text-align: left;
}
.card:hover { border-color: var(--vscode-focusBorder, #007fd4); }
.card.current { border-color: var(--vscode-focusBorder, #007fd4); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4) inset; }
.card .shot {
  position: relative;
  aspect-ratio: 16 / 10;
  background: linear-gradient(140deg, rgba(80,80,90,.5), rgba(20,20,26,.85));
}
.card .shot img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.badge {
  position: absolute;
  top: 6px; left: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.4;
  color: #fff;
  background: rgba(0,0,0,.6);
}
.badge.video { background: var(--badge-video); }
.badge.scene { background: var(--badge-scene); }
.badge.web { background: var(--badge-web); }
.badge.image { background: var(--badge-image); }
.card .name {
  display: block;
  padding: 6px 8px 8px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card .del {
  position: absolute;
  top: 5px; right: 5px;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 10px;
  background: rgba(0,0,0,.62);
  color: #fff;
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  transition: opacity .12s;
}
.card:hover .del { opacity: 1; }
.card .del:hover { background: rgba(200,40,40,.9); }
.empty {
  padding: 28px 8px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

.field { display: flex; flex-direction: column; gap: 6px; }
.field .row { display: flex; justify-content: space-between; font-size: 12px; color: var(--vscode-descriptionForeground); }
.field input[type="range"] { width: 100%; accent-color: var(--vscode-button-background); }
.field .hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
.check { display: flex; gap: 8px; align-items: center; }

.status {
  margin-top: auto;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 0 4px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.status .text { flex: 1 1 auto; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let state = null;
let filterKind = '';
let keyword = '';
const timers = {};

function post(message) { vscode.postMessage(message); }

function fmtPercent(value) { return Math.round(value * 100) + '%'; }

function kindLabel(kind) { return ({ video: '视频', scene: '场景', web: '网页', image: '图片' })[kind] || kind; }

function renderHeader() {
  const cur = state && state.current;
  const thumb = document.getElementById('curThumb');
  const title = document.getElementById('curTitle');
  const sub = document.getElementById('curSub');
  const toggle = document.getElementById('btnToggle');

  if (!cur) {
    thumb.innerHTML = '';
    thumb.textContent = '无';
    title.textContent = '未选择壁纸';
    sub.textContent = '从下方挑选一个壁纸即可应用';
    toggle.disabled = true;
    toggle.textContent = '暂停';
    return;
  }

  thumb.innerHTML = '';
  if (cur.thumb) {
    const img = document.createElement('img');
    img.src = cur.thumb;
    img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.textContent = kindLabel(cur.kind);
  }

  title.textContent = cur.title;
  sub.textContent = kindLabel(cur.kind) + ' · ' + (state.enabled ? '播放中' : '已关闭');
  toggle.disabled = false;
  toggle.textContent = state.enabled ? '暂停' : '继续';
}

function visibleItems() {
  const items = (state && state.items) || [];
  const kw = keyword.trim().toLowerCase();
  return items.filter((item) => {
    if (filterKind && item.kind !== filterKind) return false;
    if (!kw) return true;
    return String(item.title).toLowerCase().includes(kw) || String(item.id).includes(kw);
  });
}

function renderGrid() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');
  grid.innerHTML = '';

  const items = visibleItems();
  count.textContent = items.length + ' / ' + ((state && state.items.length) || 0);

  const hasLibrary = state && state.items && state.items.length;
  empty.hidden = items.length > 0;
  empty.textContent = hasLibrary ? '没有匹配的壁纸' : '没有找到 Wallpaper Engine 壁纸，请确认已在 Steam 创意工坊订阅';

  for (const item of items) {
    const card = document.createElement('button');
    card.className = 'card' + (state.current && state.current.id === item.id ? ' current' : '');
    card.title = item.description || item.title;
    card.addEventListener('click', () => post({ type: 'apply', id: item.id }));

    const shot = document.createElement('div');
    shot.className = 'shot';
    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      img.loading = 'lazy';
      shot.appendChild(img);
    }
    const badge = document.createElement('span');
    badge.className = 'badge ' + item.kind;
    badge.textContent = kindLabel(item.kind);
    shot.appendChild(badge);

    // 导入的条目可以单独移除；Steam 壁纸不提供删除
    if (item.imported) {
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.title = '移除此导入项（不删除源文件）';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        post({ type: 'removeImport', id: item.id });
      });
      shot.appendChild(del);
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.title;

    card.appendChild(shot);
    card.appendChild(name);
    grid.appendChild(card);
  }
}

function syncControls() {
  const pairs = [
    ['opacity', 'opacity'],
    ['scrim', 'scrim'],
    ['blur', 'blur'],
    ['saturate', 'saturate'],
  ];
  for (const [key, id] of pairs) {
    const input = document.getElementById(id);
    const value = document.getElementById(id + 'Value');
    if (!input || !value) continue;
    input.value = String(state[key]);
    value.textContent = key === 'blur' ? state[key] + ' px' : key === 'saturate' ? String(state[key]) : fmtPercent(state[key]);
  }
  document.getElementById('fit').value = state.fit;
  document.getElementById('fps').value = String(state.fps);
  document.getElementById('pauseOnBlur').checked = !!state.pauseOnBlur;
}

function renderStatus() {
  const text = document.getElementById('statusText');
  const reload = document.getElementById('btnReload');
  const reapply = document.getElementById('btnReapply');
  if (state.patched) {
    text.textContent = '背景层已注入（v' + state.version + '）。若刚注入或更新版本，请点“重载窗口”。';
    reload.hidden = false;
    reapply.hidden = true;
  } else {
    text.textContent = '背景层尚未注入。点“重新注入”后会提示重载窗口。';
    reload.hidden = true;
    reapply.hidden = false;
  }
}

function renderAll() {
  if (!state) return;
  renderHeader();
  renderGrid();
  syncControls();
  renderStatus();
}

document.getElementById('search').addEventListener('input', (event) => {
  keyword = event.target.value;
  renderGrid();
});

document.getElementById('kind').addEventListener('change', (event) => {
  filterKind = event.target.value;
  renderGrid();
});

document.getElementById('btnImport').addEventListener('click', () => post({ type: 'import' }));
document.getElementById('btnToggle').addEventListener('click', () => post({ type: 'toggle' }));
document.getElementById('btnRefresh').addEventListener('click', () => post({ type: 'refresh' }));
document.getElementById('btnClear').addEventListener('click', () => post({ type: 'clear' }));
document.getElementById('btnReload').addEventListener('click', () => post({ type: 'reload' }));
document.getElementById('btnReapply').addEventListener('click', () => post({ type: 'reapply' }));
document.getElementById('btnRemove').addEventListener('click', () => post({ type: 'removePatch' }));
document.getElementById('btnSteamRoot').addEventListener('click', () => post({ type: 'settings' }));

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    for (const page of document.querySelectorAll('.page')) {
      page.hidden = page.id !== 'page-' + tab.dataset.tab;
    }
  });
}

function bindRange(id) {
  const input = document.getElementById(id);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    const label = document.getElementById(id + 'Value');
    if (label) label.textContent = id === 'blur' ? value + ' px' : id === 'saturate' ? String(value) : fmtPercent(value);
    clearTimeout(timers[id]);
    timers[id] = setTimeout(() => post({ type: 'visual', key: id, value: value }), 120);
  });
}

bindRange('opacity');
bindRange('scrim');
bindRange('blur');
bindRange('saturate');

document.getElementById('saturate').addEventListener('input', (event) => {
  document.getElementById('saturateValue').textContent = Number(event.target.value).toFixed(2);
});

document.getElementById('fit').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'fit', value: event.target.value });
});
document.getElementById('fps').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'fps', value: Number(event.target.value) });
});
document.getElementById('pauseOnBlur').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'pauseOnBlur', value: event.target.checked });
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'state') return;
  state = data.state;
  renderAll();
});

post({ type: 'ready' });
`;

function html(state) {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; img-src ${state.cspSource} data: http://127.0.0.1:*; script-src 'nonce-${n}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Background-Wallpaper-Engine</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <header class="current">
    <div class="thumb" id="curThumb">无</div>
    <div class="meta">
      <div class="title" id="curTitle">未选择壁纸</div>
      <div class="sub" id="curSub">从下方挑选一个壁纸即可应用</div>
    </div>
    <div class="actions">
      <button id="btnToggle" disabled>暂停</button>
      <button class="ghost" id="btnRefresh">刷新</button>
      <button class="ghost" id="btnClear">清除</button>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab active" data-tab="wallpapers">壁纸</button>
    <button class="tab" data-tab="appearance">外观</button>
    <button class="tab" data-tab="playback">播放</button>
  </nav>

  <section class="page" id="page-wallpapers">
    <div class="toolbar">
      <button id="btnImport">导入…</button>
      <input type="search" id="search" placeholder="搜索壁纸标题…" />
      <select id="kind">
        <option value="">全部</option>
        <option value="video">视频</option>
        <option value="scene">场景</option>
        <option value="web">网页</option>
        <option value="image">图片</option>
      </select>
      <span class="count" id="count"></span>
    </div>
    <div class="grid" id="grid"></div>
    <div class="empty" id="empty" hidden></div>
  </section>

  <section class="page" id="page-appearance" hidden>
    <div class="field">
      <div class="row"><span>不透明度</span><span id="opacityValue"></span></div>
      <input type="range" id="opacity" min="0" max="1" step="0.01" />
      <div class="hint">越低越能看清代码，越高壁纸越明显。</div>
    </div>
    <div class="field">
      <div class="row"><span>压暗</span><span id="scrimValue"></span></div>
      <input type="range" id="scrim" min="0" max="1" step="0.01" />
      <div class="hint">壁纸与文字之间的黑色遮罩，画面很亮时调高更好读。</div>
    </div>
    <div class="field">
      <div class="row"><span>模糊</span><span id="blurValue"></span></div>
      <input type="range" id="blur" min="0" max="40" step="1" />
    </div>
    <div class="field">
      <div class="row"><span>饱和度</span><span id="saturateValue"></span></div>
      <input type="range" id="saturate" min="0" max="3" step="0.05" />
    </div>
    <div class="field">
      <div class="row"><span>缩放方式</span></div>
      <select id="fit">
        <option value="cover">铺满（裁切多余部分）</option>
        <option value="contain">完整显示（可能留边）</option>
        <option value="fill">拉伸铺满</option>
      </select>
    </div>
  </section>

  <section class="page" id="page-playback" hidden>
    <div class="field">
      <div class="row"><span>场景 / 网页壁纸帧率</span></div>
      <select id="fps">
        <option value="30">30 帧</option>
        <option value="60">60 帧</option>
      </select>
      <div class="hint">视频壁纸按视频原生帧率播放，不受此项影响。</div>
    </div>
    <div class="check">
      <input type="checkbox" id="pauseOnBlur" />
      <label for="pauseOnBlur">窗口失焦时暂停播放</label>
    </div>
  </section>

  <footer class="status">
    <span class="text" id="statusText">正在读取状态…</span>
    <button class="ghost" id="btnSteamRoot">Steam 目录</button>
    <button id="btnReapply" hidden>重新注入</button>
    <button id="btnReload" hidden>重载窗口</button>
    <button class="ghost" id="btnRemove">移除注入</button>
  </footer>
</div>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}

class WallpaperPanel {
  /**
   * @param {import('vscode').ExtensionContext} context
   * @param {{
   *   snapshot: () => object,
   *   apply: (id: string) => Promise<void>,
   *   toggle: () => Promise<void>,
   *   clear: () => Promise<void>,
   *   refresh: () => Promise<void>,
   *   visual: (key: string, value: unknown) => Promise<void>,
   *   reload: () => void,
   *   reapply: () => Promise<void>,
   *   removePatch: () => Promise<void>,
   *   settings: () => void,
   * }} handlers
   */
  constructor(context, handlers) {
    this.context = context;
    this.handlers = handlers;
    this.panel = null;
  }

  show() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.push();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'backgroundWallpaperEngine.panel',
      'Background-Wallpaper-Engine',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    this.panel.webview.html = html({ cspSource: this.panel.webview.cspSource });
    this.push();
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const handlers = this.handlers;
    const run = (fn) => Promise.resolve(fn()).then(() => this.push());

    switch (message.type) {
      case 'ready':
        this.push();
        break;
      case 'apply':
        run(() => handlers.apply(String(message.id)));
        break;
      case 'toggle':
        run(handlers.toggle);
        break;
      case 'clear':
        run(handlers.clear);
        break;
      case 'refresh':
        run(handlers.refresh);
        break;
      case 'import':
        run(handlers.importMedia);
        break;
      case 'removeImport':
        run(() => handlers.removeImport(String(message.id)));
        break;
      case 'visual':
        run(() => handlers.visual(String(message.key), message.value));
        break;
      case 'reload':
        handlers.reload();
        break;
      case 'reapply':
        run(handlers.reapply);
        break;
      case 'removePatch':
        run(handlers.removePatch);
        break;
      case 'settings':
        handlers.settings();
        break;
      default:
        break;
    }
  }

  push() {
    if (!this.panel) return;
    try {
      this.panel.webview.postMessage({ type: 'state', state: this.handlers.snapshot() });
    } catch {
      // 面板已关闭
    }
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}

module.exports = { WallpaperPanel, KIND_LABEL };

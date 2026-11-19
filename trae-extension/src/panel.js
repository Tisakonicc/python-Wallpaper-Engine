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
  color-scheme: dark;
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
.current .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
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
select { flex: 0 0 auto; color-scheme: dark; }
select option {
  background: var(--vscode-dropdown-background, #252526);
  color: var(--vscode-dropdown-foreground, #cccccc);
}
/* 自定义下拉框：避开 Windows 原生 select 选中项白底白字的问题 */
.custom-select { position: relative; width: 100%; }
.custom-select-trigger {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 6px; padding: 6px 9px; cursor: pointer; user-select: none;
  color: var(--vscode-input-foreground);
}
.custom-select-trigger:hover { border-color: var(--vscode-focusBorder, #007fd4); }
.custom-select-arrow { font-size: 10px; opacity: .7; flex-shrink: 0; }
.custom-select-options {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 1000;
  background: var(--vscode-dropdown-background, #252526);
  border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,.35));
  border-radius: 6px; max-height: 220px; overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
}
.custom-select-option {
  padding: 7px 10px; cursor: pointer; color: var(--vscode-dropdown-foreground, #cccccc);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.custom-select-option:hover,
.custom-select-option.selected {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}
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
  /* 离屏卡片跳过渲染与 GIF 解码，滚动时才处理视口附近的几张 */
  content-visibility: auto;
  contain-intrinsic-size: 158px 132px;
}
.card:hover { border-color: var(--vscode-focusBorder, #007fd4); }
.card.current { border-color: var(--vscode-focusBorder, #007fd4); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4) inset; }
.card .shot {
  position: relative;
  aspect-ratio: 16 / 10;
  background: linear-gradient(140deg, rgba(80,80,90,.5), rgba(20,20,26,.85));
}
.card .shot img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.card .shot video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
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
.card .exp {
  position: absolute;
  top: 5px; left: 5px;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 10px;
  background: rgba(0,0,0,.62);
  font-size: 13px; line-height: 1; color: #fff;
  opacity: 0;
  transition: opacity .12s;
}
.card:hover .exp { opacity: 1; }
.card .exp:hover { background: rgba(45,126,247,.95); }
.empty {
  padding: 28px 8px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

.field { display: flex; flex-direction: column; gap: 6px; }
.field .row { display: flex; justify-content: space-between; font-size: 12px; color: var(--vscode-descriptionForeground); }
.field input[type="range"] { width: 100%; accent-color: var(--vscode-button-background); }
.field input[type="number"] { width: 72px; }
.field .range-row { display: flex; gap: 10px; align-items: center; }
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
.hw-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  border: 1px solid transparent;
  flex: 0 0 auto;
}
.hw-badge.probing {
  color: var(--vscode-descriptionForeground);
  background: rgba(140,140,140,.16);
  border-color: rgba(140,140,140,.35);
  animation: hw-pulse 1.6s ease-in-out infinite;
}
.hw-badge.hw {
  color: #6ee7b7;
  background: rgba(16,185,129,.18);
  border-color: rgba(16,185,129,.5);
}
.hw-badge.sw {
  color: #fcd34d;
  background: rgba(245,158,11,.18);
  border-color: rgba(245,158,11,.5);
}
@keyframes hw-pulse {
  0%, 100% { opacity: .5; }
  50% { opacity: 1; }
}
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

/**
 * 填封面：有静态封面就用 img；没有封面图、或封面加载失败的视频
 * （主要是外部导入的视频）退而用 video 取首帧当封面。
 */
function fillCover(container, kind, thumb, src) {
  const addVideo = () => {
    if (kind !== 'video' || !src) return false;
    const video = document.createElement('video');
    // #t=0.1 让浏览器跳到第 0.1 秒并画出那一帧，充当封面
    video.src = src + '#t=0.1';
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    // 部分容器对 URL 片段不敏感，元数据就绪后再显式定位一次，确保画出首帧
    video.addEventListener('loadedmetadata', () => {
      try {
        if (video.currentTime < 0.05) video.currentTime = 0.1;
      } catch (err) {}
    });
    container.appendChild(video);
    return true;
  };

  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    // 缩略图可能几十张（Steam 的 preview.gif 常常近 1MB），
    // 一次性全部解码会让滚动明显掉帧；交给浏览器按视口惰性加载。
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      // 小图生成失败（ffmpeg 不可用等）就退回原始封面，别留个黑洞
      if (img.dataset.fallback && !img.dataset.retried) {
        img.dataset.retried = '1';
        img.src = img.dataset.fallback;
        return;
      }
      img.remove();
      addVideo();
    });
    container.appendChild(img);
    return true;
  }
  return addVideo();
}

// 顶部封面同样只在壁纸变了才重建，避免每条状态消息都重新拉一次 GIF
let headerThumbKey = '';

function renderHeader() {
  const cur = state && state.current;
  const thumb = document.getElementById('curThumb');
  const title = document.getElementById('curTitle');
  const sub = document.getElementById('curSub');
  const toggle = document.getElementById('btnToggle');
  const exportBtn = document.getElementById('btnExport');

  if (!cur) {
    headerThumbKey = '';
    thumb.innerHTML = '';
    thumb.textContent = '无';
    title.textContent = '未选择壁纸';
    sub.textContent = '从下方挑选一个壁纸即可应用';
    toggle.disabled = true;
    toggle.textContent = '暂停';
    exportBtn.disabled = true;
    return;
  }

  const key = [cur.id, cur.thumb, cur.src].join('|');
  if (key !== headerThumbKey) {
    headerThumbKey = key;
    thumb.innerHTML = '';
    if (!fillCover(thumb, cur.kind, cur.thumb, cur.src)) {
      thumb.textContent = kindLabel(cur.kind);
    }
  }

  title.textContent = cur.title;
  sub.textContent = kindLabel(cur.kind) + ' · ' + (state.enabled ? '播放中' : '已关闭');
  toggle.disabled = false;
  toggle.textContent = state.enabled ? '暂停' : '继续';
  // 只有导入的 .mpkg / .pkg 才有可分享的场景包
  exportBtn.disabled = !cur.exportable;
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

// 网格内容没变时不重建 DOM：重建会让所有 <img> 重新请求、GIF 从头解码，
// 面板收到一条状态消息就卡一下。
let gridSignature = '';

function renderGrid() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');

  const items = visibleItems();
  const currentId = state && state.current ? state.current.id : '';
  count.textContent = items.length + ' / ' + ((state && state.items.length) || 0);

  const hasLibrary = state && state.items && state.items.length;
  empty.hidden = items.length > 0;
  empty.textContent = hasLibrary ? '没有匹配的壁纸' : '没有找到 Wallpaper Engine 壁纸，请确认已在 Steam 创意工坊订阅';

  const signature = items.map((item) => item.id + ':' + item.kind).join(',');
  if (signature === gridSignature) {
    // 只是切换了当前壁纸：改个类名就够
    for (const card of grid.children) {
      card.classList.toggle('current', card.dataset.id === currentId);
    }
    return;
  }
  gridSignature = signature;
  grid.innerHTML = '';

  for (const item of items) {
    const card = document.createElement('button');
    card.className = 'card' + (currentId === item.id ? ' current' : '');
    card.dataset.id = item.id;
    card.title = item.description || item.title;
    card.addEventListener('click', () => post({ type: 'apply', id: item.id }));

    const shot = document.createElement('div');
    shot.className = 'shot';
    // 卡片默认用服务端缩好的 320px 静态小图（几十 KB，解码便宜）；
    // 鼠标移上去再换回原始封面，GIF 动画只在真正关注的那张上跑。
    const small = item.thumb ? item.thumb + '?w=320' : '';
    fillCover(shot, item.kind, small, item.src);
    const cover = shot.querySelector('img');
    if (cover && item.thumb && item.kind !== 'video') {
      if (small !== item.thumb) cover.dataset.fallback = item.thumb;
      card.addEventListener(
        'mouseenter',
        () => {
          cover.src = item.thumb;
        },
        { once: true }
      );
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

    // 导入的场景包可以导出成可分享的 scene.pkg（画面 + 音乐自包含）
    if (item.exportable) {
      const exp = document.createElement('span');
      exp.className = 'exp';
      exp.textContent = '⇩';
      exp.title = '导出（场景为 pkg，视频/图片为原文件，网页为整份目录）';
      exp.addEventListener('click', (event) => {
        event.stopPropagation();
        post({ type: 'exportImport', id: item.id });
      });
      shot.appendChild(exp);
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
    ['surfaceOpacity', 'surfaceOpacity'],
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
  const fpsInput = document.getElementById('fpsInput');
  if (fpsInput) fpsInput.value = String(state.fps);
  const fpsValue = document.getElementById('fpsValue');
  if (fpsValue) fpsValue.textContent = state.fps + ' 帧';
  document.getElementById('pauseOnBlur').checked = !!state.pauseOnBlur;
  const autoContrast = document.getElementById('autoContrast');
  if (autoContrast) autoContrast.checked = state.autoContrast === true;
  const textContrast = document.getElementById('textContrast');
  if (textContrast) textContrast.checked = state.textContrast === true;
  const music = document.getElementById('music');
  if (music) music.checked = !state.muted;
  const volume = document.getElementById('volume');
  if (volume) volume.value = String(state.volume);
  const volumeValue = document.getElementById('volumeValue');
  if (volumeValue) volumeValue.textContent = fmtPercent(state.volume);

  // 音乐下拉框：只有当前壁纸自带多首音乐时才显示
  const trackField = document.getElementById('musicTrackField');
  const trackSelect = document.getElementById('musicTrack');
  const trackHint = trackField && trackField.querySelector('.hint');
  const trackValueEl = trackSelect && trackSelect.querySelector('.custom-select-value');
  const trackOptionsEl = trackSelect && trackSelect.querySelector('.custom-select-options');
  const options = (state.current && state.current.musicOptions) || [];
  if (trackField && trackSelect) {
    if (options.length) {
      trackField.hidden = false;
      // 签名带上壁纸 id 和属性名，换壁纸时一定重建，避免沿用上一张的列表
      const sig =
        (state.current && state.current.id) + '#' + ((state.current && state.current.musicKey) || '') + '|' +
        options.map((o) => o.value + '|' + o.label).join(',');
      if (trackSelect.dataset.sig !== sig) {
        trackOptionsEl.innerHTML = '';
        for (const opt of options) {
          const el = document.createElement('div');
          el.className = 'custom-select-option';
          el.dataset.value = opt.value;
          el.textContent = opt.label;
          trackOptionsEl.appendChild(el);
        }
        trackSelect.dataset.sig = sig;
      }
      const wanted = String(state.musicTrack || '');
      const hasValue = options.some((o) => o.value === wanted);
      const picked = options.find((o) => o.value === wanted);
      if (trackValueEl) trackValueEl.textContent = picked ? picked.label : '选择音乐…';
      // 高亮当前选中项
      trackOptionsEl.querySelectorAll('.custom-select-option').forEach((el) => {
        el.classList.toggle('selected', el.dataset.value === wanted);
      });
      if (trackHint) trackHint.textContent = '共 ' + options.length + ' 首';
      // 切换到新壁纸后，若旧的曲目值不在新壁纸的选项里，自动清空配置，
      // 避免把上一张壁纸的音乐选择错误地套到当前壁纸上。
      if (wanted && !hasValue) {
        post({ type: 'visual', key: 'musicTrack', value: '' });
      }
    } else {
      // 当前壁纸没有音乐选项：隐藏并把列表清空，避免残留上一张壁纸的曲目
      trackField.hidden = true;
      trackSelect.dataset.sig = '';
      trackOptionsEl.innerHTML = '';
      if (trackValueEl) trackValueEl.textContent = '选择音乐…';
    }
  }

  // 壁纸轮播
  const slideshow = document.getElementById('slideshow');
  if (slideshow) slideshow.checked = !!state.slideshow;
  const intervalField = document.getElementById('slideshowIntervalField');
  if (intervalField) intervalField.hidden = !state.slideshow;
  const ssRange = document.getElementById('slideshowInterval');
  const ssNum = document.getElementById('slideshowIntervalInput');
  const ssValue = document.getElementById('slideshowIntervalValue');
  const iv = Math.max(1, Math.min(120, Number(state.slideshowInterval) || 10));
  if (ssRange) ssRange.value = String(iv);
  if (ssNum) ssNum.value = String(iv);
  if (ssValue) ssValue.textContent = iv + ' 分钟';

  // 当前壁纸生成代理按钮
  const cur = state && state.current;
  const btn = document.getElementById('btnGenerateProxy');
  const statusEl = document.getElementById('proxyStatus');
  const heightSel = document.getElementById('proxyHeight');
  const showBtn = !!(cur && cur.kind === 'video');
  if (btn) btn.hidden = !showBtn;
  if (heightSel) heightSel.hidden = !showBtn;
  if (statusEl) {
    statusEl.hidden = !showBtn;
    if (showBtn) {
      statusEl.textContent = '当前壁纸：' + cur.title + '（视频）';
    }
  }
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

// 硬解探测超时兜底：渲染页没连上 / probe 卡住时，不要让「检测中」徽章无限闪烁。
// 探测一旦出结果就清掉定时器；10 秒还没结果就停在稳定态，连上后自动恢复。
let hwProbeTimedOut = false;
let hwProbeTimer = null;
function renderHwBadge() {
  const el = document.getElementById('hwBadge');
  if (!el) return;
  const hw = state.hwDecode || {};
  const resolved = hw.ok === true || hw.ok === false;
  if (resolved) {
    if (hwProbeTimer) { clearTimeout(hwProbeTimer); hwProbeTimer = null; }
    hwProbeTimedOut = false;
  } else if (!hwProbeTimer && !hwProbeTimedOut) {
    hwProbeTimer = setTimeout(() => { hwProbeTimedOut = true; renderHwBadge(); }, 10000);
  }
  let text = '检测中';
  let cls = 'hw-badge probing';
  if (hw.ok === true) {
    text = '硬解';
    cls = 'hw-badge hw';
  } else if (hw.ok === false) {
    text = '软解';
    cls = 'hw-badge sw';
  } else if (hwProbeTimedOut) {
    text = '—';
    cls = 'hw-badge';
  }
  el.textContent = text;
  el.className = cls;
  el.title = hw.ok === false && hw.reason
    ? ('当前软解：' + hw.reason)
    : (hwProbeTimedOut ? '硬解探测无响应（背景未连上时会这样，重载窗口后恢复）' : '');
}

function renderAll() {
  if (!state) return;
  renderHeader();
  renderGrid();
  syncControls();
  renderStatus();
  renderHwBadge();
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
document.getElementById('btnExport').addEventListener('click', () => post({ type: 'exportCurrent' }));
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
bindRange('surfaceOpacity');
bindRange('saturate');

document.getElementById('saturate').addEventListener('input', (event) => {
  document.getElementById('saturateValue').textContent = Number(event.target.value).toFixed(2);
});

document.getElementById('fit').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'fit', value: event.target.value });
});

// 帧率：滑块与数字框双向同步
const fpsRange = document.getElementById('fps');
const fpsNum = document.getElementById('fpsInput');
function setFps(value) {
  let n = Math.round(Number(value));
  if (!Number.isFinite(n)) n = 60;
  n = Math.max(1, Math.min(144, n));
  fpsRange.value = String(n);
  fpsNum.value = String(n);
  const fpsValue = document.getElementById('fpsValue');
  if (fpsValue) fpsValue.textContent = n + ' 帧';
  clearTimeout(timers.fps);
  timers.fps = setTimeout(() => post({ type: 'visual', key: 'fps', value: n }), 120);
}
fpsRange.addEventListener('input', () => setFps(fpsRange.value));
fpsNum.addEventListener('change', () => setFps(fpsNum.value));
fpsNum.addEventListener('input', () => {
  // 输入时即时同步滑块显示，但只在 change 时提交
  let n = Number(fpsNum.value);
  if (Number.isFinite(n)) fpsRange.value = String(Math.max(1, Math.min(144, Math.round(n))));
});

document.getElementById('pauseOnBlur').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'pauseOnBlur', value: event.target.checked });
});

document.getElementById('autoContrast').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'autoContrast', value: event.target.checked });
});

document.getElementById('textContrast').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'textContrast', value: event.target.checked });
});

// 壁纸自带音乐：开关直接写 muted，音量拖动实时生效
document.getElementById('music').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'muted', value: !event.target.checked });
});

const volumeRange = document.getElementById('volume');
volumeRange.addEventListener('input', () => {
  const value = Number(volumeRange.value);
  const label = document.getElementById('volumeValue');
  if (label) label.textContent = fmtPercent(value);
  clearTimeout(timers.volume);
  timers.volume = setTimeout(() => post({ type: 'visual', key: 'volume', value: value }), 120);
});

// 背景音乐自定义下拉框：点击展开，选中后发给后端写配置
(function setupMusicSelect() {
  const wrap = document.getElementById('musicTrack');
  const trigger = wrap.querySelector('.custom-select-trigger');
  const optionsEl = wrap.querySelector('.custom-select-options');
  function close() { optionsEl.hidden = true; }
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    optionsEl.hidden = !optionsEl.hidden;
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); optionsEl.hidden = !optionsEl.hidden; }
    if (e.key === 'Escape') close();
  });
  optionsEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    post({ type: 'visual', key: 'musicTrack', value: String(opt.dataset.value) });
    close();
  });
  document.addEventListener('click', close);
})();

// 壁纸轮播开关
document.getElementById('slideshow').addEventListener('change', (event) => {
  post({ type: 'visual', key: 'slideshow', value: event.target.checked });
});

document.getElementById('btnGenerateProxy').addEventListener('click', () => {
  const cur = state && state.current;
  const port = state && state.port;
  if (!cur || cur.kind !== 'video' || !port) return;
  const statusEl = document.getElementById('proxyStatus');
  const btn = document.getElementById('btnGenerateProxy');
  const sel = document.getElementById('proxyHeight');
  const height = sel && sel.value ? Number(sel.value) : 1080;
  if (btn) btn.disabled = true;

  // 选"原视频"：清除该壁纸所有代理缓存，让 server 直接发原片
  if (height === 0) {
    if (statusEl) statusEl.textContent = '正在清除代理缓存…';
    fetch('http://127.0.0.1:' + port + '/proxy/' + encodeURIComponent(cur.id) + '/clear', { method: 'POST', cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (statusEl) statusEl.textContent = '已清除 ' + (data.removed || 0) + ' 份代理，下次进入壁纸用原片。';
        if (btn) btn.disabled = false;
      })
      .catch(() => {
        if (statusEl) statusEl.textContent = '清除失败，请确认本地服务已启动。';
        if (btn) btn.disabled = false;
      });
    return;
  }

  if (statusEl) statusEl.textContent = '正在后台生成 ' + height + 'p 代理…（关掉面板也会继续）';
  fetch('http://127.0.0.1:' + port + '/proxy/' + encodeURIComponent(cur.id) + '?h=' + height, { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (statusEl) {
        if (data.state === 'ready') statusEl.textContent = height + 'p 代理已就绪，下次进入壁纸自动切换。';
        else if (data.state === 'pending') statusEl.textContent = height + 'p 生成中，首次进入壁纸后会自动切换。';
        else statusEl.textContent = '当前壁纸分辨率不需要 ' + height + 'p 代理（源片已不超过该画质）。';
      }
      if (btn) btn.disabled = false;
    })
    .catch(() => {
      if (statusEl) statusEl.textContent = '触发失败，请确认本地服务已启动。';
      if (btn) btn.disabled = false;
    });
});

// 轮播间隔：滑块与数字框双向同步
const ssRange = document.getElementById('slideshowInterval');
const ssNum = document.getElementById('slideshowIntervalInput');
function setSlideshowInterval(value) {
  let n = Math.round(Number(value));
  if (!Number.isFinite(n)) n = 10;
  n = Math.max(1, Math.min(120, n));
  ssRange.value = String(n);
  ssNum.value = String(n);
  const label = document.getElementById('slideshowIntervalValue');
  if (label) label.textContent = n + ' 分钟';
  clearTimeout(timers.slideshowInterval);
  timers.slideshowInterval = setTimeout(() => post({ type: 'visual', key: 'slideshowInterval', value: n }), 300);
}
ssRange.addEventListener('input', () => setSlideshowInterval(ssRange.value));
ssNum.addEventListener('change', () => setSlideshowInterval(ssNum.value));
ssNum.addEventListener('input', () => {
  let n = Number(ssNum.value);
  if (Number.isFinite(n)) ssRange.value = String(Math.max(1, Math.min(120, Math.round(n))));
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
  content="default-src 'none'; style-src 'unsafe-inline'; img-src ${state.cspSource} data: http://127.0.0.1:*; connect-src http://127.0.0.1:*; media-src http://127.0.0.1:*; script-src 'nonce-${n}';" />
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
      <button class="ghost" id="btnExport" disabled title="导出当前场景包为 scene.pkg（分享用）">导出</button>
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
    <div class="check">
      <input type="checkbox" id="autoContrast" />
      <label for="autoContrast">自动对比度（按壁纸亮度自动压暗 / 提亮）</label>
    </div>
    <div class="hint" style="margin:-6px 0 12px">默认关闭。开启后“压暗”滑块不生效；亮画面自动压暗、画面杂乱时轻微模糊，浅色主题则自动提亮。</div>
    <div class="check">
      <input type="checkbox" id="textContrast" />
      <label for="textContrast">文字增强（前景更亮 / 更深 + 字形阴影）</label>
    </div>
    <div class="hint" style="margin:-6px 0 12px">默认关闭。只改文字前景色与阴影，不改语法高亮的配色；对编辑器、终端、文件树有效，网页 / 聊天面板内部的文字由它自己绘制，改不到。</div>
    <div class="field">
      <div class="row"><span>模糊</span><span id="blurValue"></span></div>
      <input type="range" id="blur" min="0" max="40" step="1" />
    </div>
    <div class="field">
      <div class="row"><span>面板底衬</span><span id="surfaceOpacityValue"></span></div>
      <input type="range" id="surfaceOpacity" min="0" max="1" step="0.05" />
      <div class="hint">侧栏、聊天面板、底部面板的不透明底。文字压在亮画面上看不清时调高，0 为纯壁纸。</div>
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
      <div class="row"><span>场景 / 网页壁纸帧率</span><span id="fpsValue"></span></div>
      <div class="range-row">
        <input type="range" id="fps" min="1" max="144" step="1" />
        <input type="number" id="fpsInput" min="1" max="144" step="1" />
      </div>
      <div class="hint">视频壁纸按视频原生帧率播放，不受此项影响。</div>
    </div>
    <div class="check">
      <input type="checkbox" id="music" />
      <label for="music">播放壁纸自带背景音乐</label>
    </div>
    <div class="field" id="musicTrackField" hidden>
      <div class="row"><span>背景音乐</span></div>
      <div class="custom-select" id="musicTrack">
        <div class="custom-select-trigger" tabindex="0">
          <span class="custom-select-value">选择音乐…</span>
          <span class="custom-select-arrow">▾</span>
        </div>
        <div class="custom-select-options" hidden></div>
      </div>
      <div class="hint">部分场景 / 网页壁纸自带多首音乐，在这里切换。</div>
    </div>
    <div class="field">
      <div class="row"><span>音乐音量</span><span id="volumeValue"></span></div>
      <input type="range" id="volume" min="0" max="1" step="0.01" />
      <div class="hint">仅对带音轨的视频 / 场景壁纸生效；系统拒绝有声自动播放时会自动静音播放画面。</div>
    </div>
    <div class="check">
      <input type="checkbox" id="pauseOnBlur" />
      <label for="pauseOnBlur">窗口失焦时暂停播放</label>
    </div>
    <div class="check">
      <input type="checkbox" id="slideshow" />
      <label for="slideshow">壁纸轮播（自动切换）</label>
    </div>
    <div class="field" id="slideshowIntervalField" hidden>
      <div class="row"><span>轮播间隔</span><span id="slideshowIntervalValue"></span></div>
      <div class="range-row">
        <input type="range" id="slideshowInterval" min="1" max="120" step="1" />
        <input type="number" id="slideshowIntervalInput" min="1" max="120" step="1" />
      </div>
      <div class="hint">每隔指定分钟自动切换到下一张壁纸。</div>
    </div>
    <hr class="sep" />
    <div class="row">
      <span>视频卡顿缓解</span>
    </div>
    <div class="hint">高分辨率视频铺充满窗口时解码容易跟不上，选好目标画质后点按钮为当前壁纸生成代理（缓存到 D 盘）。下次进入壁纸会自动使用已生成的最佳代理（1080 &gt; 720 &gt; 480）；选「原视频」会清除所有代理直接用原片。</div>
    <div class="row" id="proxyRow">
      <select id="proxyHeight" title="目标画质">
        <option value="1080" selected>1080p</option>
        <option value="720">720p</option>
        <option value="480">480p</option>
        <option value="0">原视频（清除代理）</option>
      </select>
      <button class="ghost" id="btnGenerateProxy" hidden>应用</button>
      <span class="hint" id="proxyStatus" hidden></span>
    </div>
  </section>

  <footer class="status">
    <span id="hwBadge" class="hw-badge probing" title="">检测中</span>
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
   *   exportScene: (id: string) => Promise<void>,
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
      case 'exportImport':
        run(() => handlers.exportScene(String(message.id)));
        break;
      case 'exportCurrent':
        run(() => handlers.exportScene(''));
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

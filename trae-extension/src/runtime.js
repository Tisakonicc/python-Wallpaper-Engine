'use strict';

/**
 * 注入 workbench.html 的脚本。
 *
 * 职责只有两件事：
 *   1. 在窗口最底层挂一个全屏 iframe，真正的壁纸渲染发生在 iframe 里
 *      （独立文档、独立 CSP，Scene/Web 的 WebGL 与网页壁纸互不干扰）；
 *   2. 根据 iframe 回报的状态切换「UI 透明」样式，并转发窗口焦点事件。
 *
 * 壁纸切换、透明度、压暗、模糊、帧率等全部由 iframe 轮询本地服务完成，
 * 因此改设置不需要重写 workbench.html，也不需要重载窗口。
 */

const CSS = `
#backgroundcover-frame {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  border: 0;
  margin: 0;
  padding: 0;
  z-index: 0;
  pointer-events: none;
  background: transparent;
  display: block;
}

.monaco-workbench {
  position: relative;
  z-index: 2;
  -webkit-font-smoothing: antialiased;
}

html.backgroundcover-on,
html.backgroundcover-on body {
  background: transparent !important;
}

html.backgroundcover-on .monaco-workbench {
  background: transparent !important;
}

html.backgroundcover-on .monaco-workbench .part,
html.backgroundcover-on .monaco-workbench .part > .content,
html.backgroundcover-on .monaco-workbench .editor-group-container,
html.backgroundcover-on .monaco-workbench .editor-container,
html.backgroundcover-on .monaco-workbench .split-view-view,
html.backgroundcover-on .monaco-workbench .pane-body,
html.backgroundcover-on .monaco-workbench .title.tabs,
html.backgroundcover-on .monaco-workbench .tabs-container,
html.backgroundcover-on .monaco-workbench .monaco-editor,
html.backgroundcover-on .monaco-workbench .monaco-editor .margin,
html.backgroundcover-on .monaco-workbench .monaco-editor-background,
html.backgroundcover-on .monaco-workbench .terminal-wrapper,
html.backgroundcover-on .monaco-workbench .xterm-screen,
html.backgroundcover-on .monaco-workbench .composite,
html.backgroundcover-on .monaco-workbench .monaco-pane-view,
html.backgroundcover-on .monaco-workbench .monaco-pane-view .pane,
html.backgroundcover-on .monaco-workbench .monaco-pane-view .pane > .pane-header,
html.backgroundcover-on .monaco-workbench .monaco-list,
html.backgroundcover-on .monaco-workbench .monaco-list .monaco-list-rows,
html.backgroundcover-on .monaco-workbench .monaco-tl-contents,
html.backgroundcover-on .monaco-workbench .webview,
html.backgroundcover-on .monaco-workbench .webview-overlay-content,
html.backgroundcover-on .monaco-workbench .webview-container,
html.backgroundcover-on .monaco-workbench .part.auxiliarybar iframe,
html.backgroundcover-on .monaco-workbench .part.panel iframe,
html.backgroundcover-on .monaco-workbench .part.sidebar iframe {
  background-color: transparent !important;
}

/* 新版浮动面板布局：pane 的底色在更高优先级上带 !important，需要同权重压过 */
html.backgroundcover-on .monaco-workbench.floating-panels > .monaco-grid-view,
html.backgroundcover-on .monaco-workbench.modern-ui :is(.part.sidebar, .part.auxiliarybar, .part.panel) .monaco-pane-view .pane,
html.backgroundcover-on .monaco-workbench.modern-ui :is(.part.sidebar, .part.auxiliarybar, .part.panel) .monaco-pane-view .pane > .pane-header,
html.backgroundcover-on .monaco-workbench.modern-ui .part.editor .title.tabs > .tabs-and-actions-container {
  background-color: transparent !important;
}

/* 空编辑器上的 VS Code/IDE 水印在壁纸上会像杂质，直接隐藏 */
html.backgroundcover-on .monaco-workbench .editor-group-watermark .letterpress {
  display: none !important;
}

/* 浮层必须保持不透明，否则悬停提示/补全在动态画面上无法阅读 */
html.backgroundcover-on .monaco-workbench .suggest-widget,
html.backgroundcover-on .monaco-workbench .monaco-hover,
html.backgroundcover-on .monaco-workbench .quick-input-widget,
html.backgroundcover-on .monaco-workbench .monaco-menu,
html.backgroundcover-on .monaco-workbench .notifications-toasts,
html.backgroundcover-on .monaco-workbench .notification-toast,
html.backgroundcover-on .monaco-workbench .sticky-widget,
html.backgroundcover-on .monaco-workbench .editor-widget.find-widget {
  background-color: var(--vscode-editorWidget-background) !important;
}
`.trim();

/**
 * @param {{ports: number[], version: string}} options
 * @returns {string} 可以直接放进 <script> 的脚本文本
 */
function buildScript(options) {
  const payload = JSON.stringify({
    ports: options.ports,
    version: options.version,
    css: CSS,
  }).replace(/</g, '\\u003c');

  return `(function () {
  var CFG = ${payload};
  var FRAME_ID = 'backgroundcover-frame';
  var STYLE_ID = 'backgroundcover-style';
  var CHANNEL = 'background-cover';

  function boot() {
    var root = document.documentElement;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CFG.css;
      (document.head || root).appendChild(style);
    }

    var frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.title = 'background cover';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('allow', 'autoplay');

    var attempt = 0;
    var MAX_ATTEMPTS = 40;   // 约 70 秒：扩展宿主（本地服务）可能比窗口晚很多才起来
    var ready = false;
    var activePort = 0;
    var retryTimer = null;

    // 本地服务可能在 32123 / 32124 / 32125 中的任意一个端口上，
    // 注入脚本不在编译期绑定端口，而是轮询候选端口直到打通。
    function currentPort() {
      var ports = CFG.ports && CFG.ports.length ? CFG.ports : [32123];
      return ports[attempt % ports.length];
    }

    function frameUrl() {
      return 'http://127.0.0.1:' + currentPort() + '/render/live.html?v=' +
        encodeURIComponent(CFG.version) + '&a=' + attempt;
    }

    function mount() {
      ensureStyle();
      var host = document.body || root;
      if (frame.parentNode !== host) {
        host.insertBefore(frame, host.firstChild);
      }
    }

    // 重试是刚需：窗口加载 workbench.html 的时刻往往早于扩展宿主启动本地服务，
    // 首次加载会被拒连；Chromium 不会自动重试，不重试就会一直黑着。
    // 起步要快（200ms）：窗口页面通常只比本地服务早几百毫秒，
    // 用 1.2 秒起步会让背景白等好几秒。
    var DELAYS = [200, 300, 500, 800, 1200, 1800, 2500];

    function retryLater() {
      if (ready || retryTimer || attempt >= MAX_ATTEMPTS) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        if (ready) return;
        attempt += 1;
        mount();
        frame.src = frameUrl();
      }, DELAYS[Math.min(attempt, DELAYS.length - 1)]);
    }

    function post(payload) {
      try {
        if (frame.contentWindow) frame.contentWindow.postMessage(payload, '*');
      } catch (e) { /* iframe 还没就绪 */ }
    }

    var focused = true;
    var lastEnabled = null;
    var lastPong = Date.now();

    function postFocus() {
      post({ channel: CHANNEL, type: 'focus', focused: focused && !document.hidden });
    }

    function apply(next) {
      var on = !!(next && next.enabled);
      if (on === lastEnabled) return;
      lastEnabled = on;
      // 刻意不隐藏 iframe：隐藏后 WebGL 画布会以 0 尺寸初始化，
      // 再显示时容易出现画面不铺满。关闭态时渲染页自身是透明的，保留没有代价。
      if (on) root.classList.add('backgroundcover-on');
      else root.classList.remove('backgroundcover-on');
    }

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow) return;
      var data = event.data;
      if (!data || data.channel !== CHANNEL) return;
      if (data.type === 'pong') {
        lastPong = Date.now();
        return;
      }
      if (data.type !== 'state') return;
      lastPong = Date.now();
      // 渲染页能回话就说明本地服务通了，锁定这个端口并停止重试
      ready = true;
      activePort = currentPort();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      apply(data.state);
    });

    // 点击 webview / 聊天面板时父页面也会收到 blur，但那是「焦点进了子 frame」，
    // 不是切走了应用；用 activeElement 区分，避免误暂停。
    function focusIsInChildFrame() {
      var el = document.activeElement;
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      return tag === 'IFRAME' || tag === 'WEBVIEW';
    }

    var blurTimer = null;
    window.addEventListener('blur', function () {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(function () {
        if (focusIsInChildFrame()) return;
        if (!document.hasFocus()) {
          focused = false;
          postFocus();
        }
      }, 200);
    });

    window.addEventListener('focus', function () {
      clearTimeout(blurTimer);
      focused = true;
      postFocus();
    });

    document.addEventListener('visibilitychange', function () {
      // 窗口在后台时定时器会被浏览器节流，恢复可见时重置计时，避免误判成“文档已死”
      lastPong = Date.now();
      postFocus();
    });
    frame.addEventListener('load', function () {
      postFocus();
      // load 事件在服务拒连时也会触发，所以要接着安排下一次重试
      retryLater();
    });
    setTimeout(postFocus, 500);
    setTimeout(postFocus, 2000);

    // 每 4 秒做三件事：
    //   1. workbench 重排 body 把 iframe 挤掉 → 重新挂回；
    //   2. 给渲染页发 ping，确认它的文档还活着；
    //   3. 连续 12 秒没有回话 → 说明 iframe 文档已经死了（切换主题、渲染进程崩溃时都会出现），
    //      直接换一个 src 重新加载。只检查 DOM 里还有没有这个元素是发现不了这种故障的。
    setInterval(function () {
      if (document.hidden) {
        lastPong = Date.now();
        return;
      }
      if (!document.getElementById(FRAME_ID)) {
        mount();
        if (!ready) {
          attempt += 1;
          frame.src = frameUrl();
        }
        return;
      }
      if (!ready) return;
      post({ channel: CHANNEL, type: 'ping' });
      if (Date.now() - lastPong > 12000) {
        lastPong = Date.now();
        ready = false;
        attempt += 1;
        frame.src = frameUrl();
      }
    }, 4000);

    frame.src = frameUrl();
    mount();

    window.__backgroundCover = {
      frame: frame,
      post: post,
      reload: function () {
        ready = false;
        attempt += 1;
        frame.src = frameUrl();
      },
      state: function () {
        return {
          enabled: lastEnabled,
          focused: focused,
          ready: ready,
          attempt: attempt,
          port: activePort,
        };
      },
    };
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();`;
}

module.exports = { buildScript, CSS };

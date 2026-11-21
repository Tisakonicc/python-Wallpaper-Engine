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

/* 阅读底衬：侧栏 / 辅助栏（聊天）/ 底部面板加一层主题色半透明底，
   文字就不用直接压在壁纸的高光上。0 = 完全透明，1 = 完全遮住壁纸。 */
html.backgroundcover-on .monaco-workbench :is(.part.sidebar, .part.auxiliarybar, .part.panel),
html.backgroundcover-on .monaco-workbench :is(.part.sidebar, .part.auxiliarybar, .part.panel) > .content,
html.backgroundcover-on .monaco-workbench :is(.part.sidebar, .part.auxiliarybar, .part.panel) .composite,
html.backgroundcover-on .monaco-workbench :is(.part.sidebar, .part.auxiliarybar, .part.panel) .monaco-pane-view,
html.backgroundcover-on .monaco-workbench :is(.part.sidebar, .part.auxiliarybar, .part.panel) .monaco-pane-view .pane,
html.backgroundcover-on .monaco-workbench :is(.part.sidebar, .part.auxiliarybar, .part.panel) .monaco-pane-view .pane > .pane-header,
html.backgroundcover-on .monaco-workbench .part.panel .terminal-wrapper {
  background-color: color-mix(
    in srgb,
    var(--vscode-sideBar-background, #1e1e1e) calc(var(--bgcover-surface, 0) * 100%),
    transparent
  ) !important;
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

/* 文字增强：壁纸在背后时把前景色推向纯黑 / 纯白，并给字形加同色系阴影。
   只改前景变量，不动语法高亮的 token 颜色，避免整套配色错乱。
   明暗由渲染页上报的 themeKind 决定（backgroundcover-dark / -light），
   不依赖 body 上是否有 vs-dark / vs-light：新版 VS Code 的 DOM 层级和类名
   与早期不同，按 body 类名匹配会让文字增强完全不生效。
   变量写在 html 上，任何使用 var(--vscode-*) 的组件都会继承到。
   文字增强只改前景色与字形阴影，不自动加底衬；侧栏/面板的底衬强度
   完全由「底衬强度」滑块控制（默认 0 = 纯壁纸），需要时自行调高。 */
html.backgroundcover-on.backgroundcover-text.backgroundcover-dark,
html.backgroundcover-on.backgroundcover-text.backgroundcover-dark .monaco-workbench {
  --vscode-foreground: #ffffff;
  --vscode-descriptionForeground: #dcdcdc;
  --vscode-editor-foreground: #f2f2f2;
  --vscode-sideBar-foreground: #f5f5f5;
  --vscode-sideBarSectionHeader-foreground: #ffffff;
  --vscode-activityBar-foreground: #ffffff;
  --vscode-activityBar-inactiveForeground: #d0d0d0;
  --vscode-titleBar-activeForeground: #ffffff;
  --vscode-titleBar-inactiveForeground: #d0d0d0;
  --vscode-tab-activeForeground: #ffffff;
  --vscode-tab-inactiveForeground: #c8c8c8;
  --vscode-panelTitle-activeForeground: #ffffff;
  --vscode-panelTitle-inactiveForeground: #cfcfcf;
  --vscode-menu-foreground: #ffffff;
  --vscode-input-foreground: #ffffff;
  --vscode-terminal-foreground: #f2f2f2;
  --vscode-statusBar-foreground: #ffffff;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-inactiveSelectionForeground: #ffffff;
  --vscode-breadcrumb-foreground: #dcdcdc;
}

html.backgroundcover-on.backgroundcover-text.backgroundcover-light,
html.backgroundcover-on.backgroundcover-text.backgroundcover-light .monaco-workbench {
  --vscode-foreground: #0b0b0b;
  --vscode-descriptionForeground: #2b2b2b;
  --vscode-editor-foreground: #111111;
  --vscode-sideBar-foreground: #111111;
  --vscode-sideBarSectionHeader-foreground: #000000;
  --vscode-activityBar-foreground: #111111;
  --vscode-activityBar-inactiveForeground: #3a3a3a;
  --vscode-titleBar-activeForeground: #111111;
  --vscode-titleBar-inactiveForeground: #3a3a3a;
  --vscode-tab-activeForeground: #111111;
  --vscode-tab-inactiveForeground: #3a3a3a;
  --vscode-panelTitle-activeForeground: #111111;
  --vscode-panelTitle-inactiveForeground: #3a3a3a;
  --vscode-menu-foreground: #111111;
  --vscode-input-foreground: #111111;
  --vscode-terminal-foreground: #111111;
  --vscode-statusBar-foreground: #111111;
  --vscode-list-activeSelectionForeground: #111111;
  --vscode-list-inactiveSelectionForeground: #111111;
  --vscode-breadcrumb-foreground: #2b2b2b;
}

/* 前景文字强制推向纯白/纯黑（!important 绕过主题可能的内联覆盖）。
   注意：不碰 .monaco-editor .view-lines 的 color，只给它加阴影，避免破坏语法高亮 token。 */
html.backgroundcover-on.backgroundcover-text.backgroundcover-dark .monaco-workbench :is(
  .monaco-list-row,
  .monaco-list-row .label,
  .monaco-list-row .label-name,
  .monaco-tl-contents,
  .explorer-folders-view,
  .outline-tree,
  .pane-header,
  .pane-header .title,
  .tabs-container,
  .tab,
  .statusbar,
  .statusbar-item,
  .breadcrumbs,
  .breadcrumb-item
) {
  color: #ffffff !important;
}

html.backgroundcover-on.backgroundcover-text.backgroundcover-dark .monaco-workbench :is(
  .monaco-editor .view-lines,
  .monaco-list-row,
  .pane-header,
  .tabs-container,
  .statusbar,
  .breadcrumbs,
  .terminal-wrapper
) {
  text-shadow:
    0 1px 1px rgba(0, 0, 0, 0.95),
    0 0 3px rgba(0, 0, 0, 0.9),
    0 0 7px rgba(0, 0, 0, 0.7),
    0 0 12px rgba(0, 0, 0, 0.45);
}

/* 非代码区文字加细描边：字形边缘在壁纸的高光/暗部都能立住 */
html.backgroundcover-on.backgroundcover-text.backgroundcover-dark .monaco-workbench :is(
  .monaco-list-row,
  .pane-header,
  .tabs-container,
  .statusbar,
  .breadcrumbs
) {
  -webkit-text-stroke: 0.3px rgba(0, 0, 0, 0.35);
}

html.backgroundcover-on.backgroundcover-text.backgroundcover-light .monaco-workbench :is(
  .monaco-list-row,
  .monaco-list-row .label,
  .monaco-list-row .label-name,
  .monaco-tl-contents,
  .explorer-folders-view,
  .outline-tree,
  .pane-header,
  .pane-header .title,
  .tabs-container,
  .tab,
  .statusbar,
  .statusbar-item,
  .breadcrumbs,
  .breadcrumb-item
) {
  color: #000000 !important;
}

html.backgroundcover-on.backgroundcover-text.backgroundcover-light .monaco-workbench :is(
  .monaco-editor .view-lines,
  .monaco-list-row,
  .pane-header,
  .tabs-container,
  .statusbar,
  .breadcrumbs,
  .terminal-wrapper
) {
  text-shadow:
    0 1px 1px rgba(255, 255, 255, 0.95),
    0 0 3px rgba(255, 255, 255, 0.9),
    0 0 7px rgba(255, 255, 255, 0.7),
    0 0 12px rgba(255, 255, 255, 0.45);
}

html.backgroundcover-on.backgroundcover-text.backgroundcover-light .monaco-workbench :is(
  .monaco-list-row,
  .pane-header,
  .tabs-container,
  .statusbar,
  .breadcrumbs
) {
  -webkit-text-stroke: 0.3px rgba(255, 255, 255, 0.4);
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
 * @param {{ports: number[], version: string, app?: string}} options
 * @returns {string} 可以直接放进 <script> 的脚本文本
 */
function buildScript(options) {
  const payload = JSON.stringify({
    ports: options.ports,
    version: options.version,
    app: options.app || '',
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
    // 同一端口连续加载失败（load 了但没有 boot）的次数：
    // 常见原因是窗口先于扩展宿主加载完、服务还没开始监听，直接换端口反而绕远路。
    var quickFails = 0;

    // 本地服务可能在 32123 / 32124 … 中的任意一个端口上，注入脚本不在编译期绑定端口。
    // 同时开着 Trae 和 VS Code 时两边都会抢 32123，直接按顺序连会连到对方的服务上，
    // 渲染页于是去读对方的 /state.json（换壁纸没反应、画面停住）。
    // workbench 的 CSP 不允许 fetch 到 127.0.0.1（connect-src 只有 'self' https: ws:），
    // 没法先探活，所以改成：请求带上本 IDE 的 app 标识，对方的服务直接回 404；
    // 页面加载后收不到 state 就换下一个候选端口。
    var ports = CFG.ports && CFG.ports.length ? CFG.ports : [32123];
    // 记住上一次真正连通的端口：同一个 IDE 下次打开窗口直接先连它，
    // 不用每次都从候选列表第一个开始试（另一个 IDE 可能正占着那个端口）。
    // 存在 workbench 页面的 localStorage 里，不需要改写注入脚本。
    var PORT_KEY = 'backgroundcover.port';
    try {
      var savedPort = Number(window.localStorage.getItem(PORT_KEY));
      if (savedPort && ports.indexOf(savedPort) >= 0) {
        ports = [savedPort].concat(
          ports.filter(function (port) { return port !== savedPort; })
        );
      }
    } catch (err) {
      // localStorage 不可用时忽略，按原顺序探测
    }
    var portIndex = 0;
    var verifyTimer = null;
    // 900ms 太短：扩展宿主（本地服务）忙的时候，上一次导航还没提交就被下一次 src
    // 覆盖，渲染页始终来不及执行，表现为背景一直不出现。留够时间让文档真正跑起来。
    var VERIFY_MS = 4000;
    // 已经确认是「别的 IDE 的服务」或「端口不通」的端口，本轮启动先跳过，
    // 避免 Trae 每次都先去撞另一个 IDE 占着的 32123。
    var deadPorts = {};
    // boot 已到但 state 还没到：说明端口选对了，只是服务还在准备，不能再等 4 秒就换端口。
    var bootWait = false;

    function targetPort() {
      return ports[portIndex % ports.length];
    }

    // 诊断信标：workbench 的 CSP 里 connect-src / img-src 都不含 127.0.0.1，
    // 用 fetch 或 <img> 上报都会被打回；只有 frame-src 放行了本地端口，
    // 所以拿一个隐藏 iframe 当上报通道。
    var beaconFrame = null;
    function beacon(event) {
      try {
        if (!beaconFrame) {
          beaconFrame = document.createElement('iframe');
          beaconFrame.id = 'backgroundcover-beacon';
          beaconFrame.setAttribute('aria-hidden', 'true');
          beaconFrame.style.cssText =
            'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
          (document.body || root).appendChild(beaconFrame);
        }
        beaconFrame.src =
          'http://127.0.0.1:' + (activePort || ports[0]) + '/diag?event=' + encodeURIComponent(event);
      } catch (err) {
        // 上报失败不影响背景本身
      }
    }

    function frameUrl(port) {
      return 'http://127.0.0.1:' + port + '/render/live.html?v=' +
        encodeURIComponent(CFG.version) +
        '&app=' + encodeURIComponent(CFG.app || '') +
        '&a=' + attempt;
    }

    function load() {
      if (ready || attempt >= MAX_ATTEMPTS) return;
      activePort = targetPort();
      sawBoot = false;
      bootWait = false;
      mount();
      beacon('nav-a' + attempt + '-p' + activePort);
      frame.src = frameUrl(activePort);
      scheduleVerify();
    }

    /** 找下一个没被标记为「别的 IDE / 不通」的端口。 */
    function nextLivePortIndex(from) {
      var now = Date.now();
      for (var step = 1; step < ports.length; step += 1) {
        var idx = (from + step) % ports.length;
        var deadAt = deadPorts[ports[idx]] || 0;
        if (!deadAt || now - deadAt > 30000) return idx;
      }
      // 所有候选都被标记过：清空后从头再来，避免一直空转
      deadPorts = {};
      return (from + 1) % ports.length;
    }

    /** 放弃当前端口：换下一个候选端口重新加载。 */
    function advance() {
      if (ready) return;
      clearTimeout(verifyTimer);
      verifyTimer = null;
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS) {
        shutdown();
        return;
      }
      portIndex = nextLivePortIndex(portIndex);
      quickFails = 0;
      bootWait = false;
      load();
    }

    /**
     * 扩展已经不在了（卸载 / 禁用 / 换到另一个 IDE）：把注入留下的东西清干净。
     * 只删自己创建的节点与样式，不碰 workbench 的任何原有结构；
     * 之后不再重试，避免卸载后在后台空转。
     */
    function shutdown() {
      clearTimeout(verifyTimer);
      verifyTimer = null;
      if (beaconFrame && beaconFrame.parentNode) beaconFrame.parentNode.removeChild(beaconFrame);
      beaconFrame = null;
      try {
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      } catch (err) {
        // iframe 已被外部移除
      }
      var style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
      root.classList.remove('backgroundcover-on');
    }

    /** 换了 src 之后，短时间内没有 state 回来就认为这个端口不是本 IDE 的服务。 */
    function scheduleVerify(delay) {
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(function () {
        verifyTimer = null;
        if (ready) return;
        // 已经收到 boot：端口确定是本 IDE 的，只是 /state 还没准备好（例如库还在扫描）。
        // 这时换端口只会绕远路，再给 15 秒；仍无 state 才继续探测。
        if (sawBoot && !bootWait) {
          bootWait = true;
          beacon('boot-slow-a' + attempt);
          scheduleVerify(15000);
          return;
        }
        advance();
      }, delay || VERIFY_MS);
    }

    function markReady() {
      ready = true;
      clearTimeout(verifyTimer);
      verifyTimer = null;
      deadPorts = {};
      bootWait = false;
    }

    function mount() {
      ensureStyle();
      var host = document.body || root;
      if (frame.parentNode !== host) {
        host.insertBefore(frame, host.firstChild);
      }
    }

    function post(payload) {
      try {
        if (frame.contentWindow) frame.contentWindow.postMessage(payload, '*');
      } catch (e) { /* iframe 还没就绪 */ }
    }

    var focused = true;
    var lastEnabled = null;
    var lastSurface = null;
    var lastText = null;
    var lastLight = null;
    var lastPong = Date.now();
    // 渲染页脚本的第一条语句就会发 boot：收到它才说明这次导航的文档真的执行了。
    // load 事件早于消息投递，所以要单独记一个标记来区分「端口不对」和「页面还活着」。
    var sawBoot = false;

    function postFocus() {
      // hidden 单独上报：渲染页在 iframe 里读不到 workbench 的可见性，
      // 最小化时靠它立即静音（失焦不影响播放）。
      post({
        channel: CHANNEL,
        type: 'focus',
        focused: focused && !document.hidden,
        hidden: !!document.hidden,
      });
    }

    function apply(next) {
      // 底衬强度与开关无关，随时可调，所以先于「开关没变」的早退处理
      var surface = next && typeof next.surface === 'number' ? next.surface : 0;
      if (surface !== lastSurface) {
        lastSurface = surface;
        root.style.setProperty('--bgcover-surface', String(surface));
      }

      // 文字增强：提亮 / 加深前景并加字形阴影
      var text = !!(next && next.textContrast);
      if (text !== lastText) {
        lastText = text;
        if (text) root.classList.add('backgroundcover-text');
        else root.classList.remove('backgroundcover-text');
      }

      // 明暗主题：用扩展侧上报的 themeKind 决定文字增强是提亮还是加深。
      // 1=浅色 2=深色 3=高对比深色 4=高对比浅色。
      var kind = next && typeof next.themeKind === 'number' ? next.themeKind : 2;
      var light = kind === 1 || kind === 4;
      if (light !== lastLight) {
        lastLight = light;
        if (light) {
          root.classList.add('backgroundcover-light');
          root.classList.remove('backgroundcover-dark');
        } else {
          root.classList.add('backgroundcover-dark');
          root.classList.remove('backgroundcover-light');
        }
      }

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
      // 渲染页脚本第一条语句就会发 boot：收不到说明脚本根本没执行。
      // 旧导航的 boot 可能比新导航晚到，带序号时只认当前 attempt。
      if (data.type === 'boot') {
        if (data.a != null && String(data.a) !== String(attempt)) return;
        sawBoot = true;
        beacon('frame-boot-a' + attempt);
        return;
      }
      // 渲染页发现这个端口的主人是另一个 IDE：标记后立刻换端口，不再干等 4 秒。
      // 带 port 的新版服务会校验端口，避免旧导航的迟到消息误伤当前端口。
      if (data.type === 'wrongApp') {
        if (data.port && Number(data.port) !== activePort) return;
        deadPorts[activePort] = Date.now();
        beacon('wrong-app-p' + activePort);
        advance();
        return;
      }
      if (data.type !== 'state') return;
      lastPong = Date.now();
      // 渲染页能回话就说明连对了服务，锁定这个端口并停止换端口
      markReady();
      try {
        window.localStorage.setItem(PORT_KEY, String(activePort));
      } catch (err) {
        // 存储不可用时忽略
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
      // visibilitychange 触发时 document.hidden 已经变了，立刻同步状态
      if (document.hidden && focused) {
        focused = false;
        postFocus();
      } else if (!document.hidden && !focused && document.hasFocus()) {
        focused = true;
        postFocus();
      } else {
        postFocus();
      }
    });

    // 定期健康检查：blur 事件在 Windows 上不总是可靠触发
    // （Win+Tab / Alt+Tab / 点击其他程序的瞬间切换，浏览器可能来不及派发 blur）。
    // 每 1 秒主动查一次 document.hasFocus() + document.hidden，
    // 保证 focused 变量总能跟上真实状态。blur/focus 事件已经能覆盖大多数情况，
    // 这里只是兜底，没必要每秒唤醒两次。
    var lastPostedHidden = document.hidden;
    setInterval(function () {
      var actuallyFocused = document.hasFocus() && !document.hidden;
      if (actuallyFocused !== focused || document.hidden !== lastPostedHidden) {
        focused = actuallyFocused;
        lastPostedHidden = document.hidden;
        postFocus();
      }
    }, 1000);

    frame.addEventListener('load', function () {
      postFocus();
      if (ready || sawBoot) return;
      // 能走到 load 说明文档已经加载完成：内联的 live.js 按定义已经执行过，
      // boot 也早于 load 发出。此时还没收到 boot，说明这次导航没拿到真正的渲染页
      // （服务还没监听 / 端口属于别的进程）。先在同一端口快速重试，
      // 服务刚启动是最常见的情况；连续两次不行才换端口。
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(function () {
        verifyTimer = null;
        if (ready || sawBoot) return;
        if (quickFails < 2) {
          quickFails += 1;
          load();
        } else {
          advance();
        }
      }, 400);
    });
    setTimeout(postFocus, 500);
    setTimeout(postFocus, 2000);

    // 每 4 秒做三件事：
    //   1. workbench 重排 body 把 iframe 挤掉 → 重新挂回；
    //   2. 给渲染页发 ping，确认它的文档还活着；
    //   3. 连续 20 秒没有回话 → 说明 iframe 文档已经死了（切换主题、渲染进程崩溃时都会出现），
    //      直接换一个 src 重新加载。只检查 DOM 里还有没有这个元素是发现不了这种故障的。
    // 阈值从 12 秒放宽到 20 秒：解码 4K 视频时渲染进程偶尔会忙到几十毫秒才回包，
    // 阈值太窄会把正常的高负载误判成假死，反而触发一次重载、画面跳回开头。
    setInterval(function () {
      if (document.hidden) {
        lastPong = Date.now();
        return;
      }
      if (!document.getElementById(FRAME_ID)) {
        mount();
        if (!ready) {
          attempt += 1;
          load();
        }
        return;
      }
      if (!ready) return;
      post({ channel: CHANNEL, type: 'ping' });
      if (Date.now() - lastPong > 20000) {
        lastPong = Date.now();
        ready = false;
        attempt += 1;
        quickFails = 0;
        load();
      }
    }, 4000);

    beacon('runtime-boot');
    mount();
    load();

    window.__backgroundCover = {
      frame: frame,
      post: post,
      reload: function () {
        ready = false;
        attempt += 1;
        quickFails = 0;
        load();
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

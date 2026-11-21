'use strict';

/**
 * 背景渲染页：运行在 workbench 页面最底层的 iframe 里。
 *
 * 它自己轮询本地服务的 /state.json，所以壁纸、透明度、压暗、模糊、帧率的
 * 修改都能原地生效，不需要重载 IDE 窗口。
 *
 * 三类壁纸的渲染方式：
 *   - video：原生 <video>，解码不占 WebGL，4K 视频也更省
 *   - image：原生 <img>（gif / webp / apng 由浏览器驱动）
 *   - scene / web：交给 webwallgl（WebGL2 / 网页壁纸 shim）
 * 任一渲染路径失败都会退回静态预览图，背景不会变成空白。
 */

(function () {
  var CHANNEL = 'background-cover';

  // 第一条语句就回报父窗口：只要父窗口收到了，就说明这个脚本真的执行了。
  // 之前排查黑屏时，页面能加载但脚本没有任何下文，靠这条能区分「没执行」和「执行后出错」。
  try {
    window.parent.postMessage({
      channel: CHANNEL,
      type: 'boot',
      // 回带注入脚本的导航序号：父页面用它丢掉上一次导航迟到的 boot
      a: new URLSearchParams(location.search).get('a'),
    }, '*');
  } catch (err) {
    // 父窗口已关闭
  }
  var POLL_MS = 600;    // 稳定后：0.6 秒一次（/state.json 只有几毫秒，切换壁纸更跟手）
  var FAST_MS = 250;    // 启动阶段：本地服务/壁纸状态可能还没就绪，先密集轮询
  var FAST_WINDOW = 12000;

  var media = document.getElementById('media');
  var scrim = document.getElementById('scrim');
  var hint = document.getElementById('hint');

  var state = null;      // 最近一次 /state.json
  var current = null;    // { id, kind, inst, video, img, poster }
  var focused = true;    // 父窗口（IDE）是否聚焦
  // 父窗口（workbench）上报的隐藏状态。iframe 与 workbench 不同源，直接读
  // window.top.document.hidden 会被拦；最小化时它可能比本帧的 document.hidden
  // 更早、更准地变 true，所以两边都作为判断依据。
  var parentHidden = null;
  var destroyed = false;
  var startedAt = Date.now();
  // 硬解能力：null=探测中，true=可用（直接发原片走硬解），false=不可用（走代理软解兜底）。
  // 优先由 MediaCapabilities 的 powerEfficient 判断，旧内核才退回 WebCodecs 实测。
  var hwState = null;
  var hwReason = '';
  var hwProbeStarted = false;

  // 把关键事件写进扩展的输出面板，出问题时能直接看出卡在哪一步
  var diagSent = {};
  function diag(event) {
    try {
      fetch('/diag?event=' + encodeURIComponent(event), { cache: 'no-store' }).catch(function () {});
    } catch (err) {
      // 忽略
    }
  }
  function diagOnce(event) {
    if (diagSent[event]) return;
    diagSent[event] = true;
    diag(event);
  }

  /**
   * 硬解能力探测。
   *
   * 目标：判断当前 Chromium 渲染进程能不能用 GPU 硬解 H.264，能就让服务端发原片
   * （原生 <video> 走硬解），不能才退回 720p 代理软解。
   *
   * 首选 navigator.mediaCapabilities.decodingInfo：它由浏览器自己维护解码能力表，
   * 直接返回 powerEfficient——true 表示会走 GPU / 专用解码器，false 表示软件解码。
   * 比塞一段自造 H.264 样本让 WebCodecs 去解更可靠：样本的 profile / 分辨率 /
   * description 只要有一项不被当前后端接受，就会误判成「软解」。
   *
   * WebCodecs 仅作为旧 Electron 没有 MediaCapabilities 时的兜底。
   */
  var MC_PROFILES = [
    {
      contentType: 'video/mp4; codecs="avc1.640028"',
      width: 1920,
      height: 1080,
      bitrate: 8000000,
      framerate: 30
    },
    {
      contentType: 'video/mp4; codecs="avc1.4D401F"',
      width: 1280,
      height: 720,
      bitrate: 4000000,
      framerate: 30
    }
  ];

  // WebCodecs 兜底样本：16x16 Constrained Baseline，SPS(7)+PPS(8)+IDR(5)，Annex-B。
  var HW_PROBE_H264_B64 =
    'AAAAAWdCwArd7ARAAAADAEAAAAyDxIngAAAAAWjODyyAAAABZYiEBLyYoAA4o4A=';

  function hwB64ToBytes(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 按 Annex-B 起始码（00 00 00 01 / 00 00 01）切出每个 NALU，返回 {type, data}
  function hwSplitNalus(bytes) {
    var nalus = [];
    var n = bytes.length;
    var i = 0;
    while (i + 3 < n) {
      if (!(bytes[i] === 0 && bytes[i + 1] === 0 &&
        (bytes[i + 2] === 1 || (bytes[i + 3] === 1 && bytes[i + 2] === 0)))) {
        i++;
        continue;
      }
      var prefix = bytes[i + 2] === 1 ? 3 : 4;
      var start = i + prefix;
      // 找下一个起始码
      var j = start;
      while (j + 3 < n) {
        if (bytes[j] === 0 && bytes[j + 1] === 0 &&
          (bytes[j + 2] === 1 || (bytes[j + 3] === 1 && bytes[j + 2] === 0))) break;
        j++;
      }
      var end = j;
      while (end > start && bytes[end - 1] === 0) end--;
      if (end > start) {
        var nal = bytes.subarray(start, end);
        nalus.push({ type: nal[0] & 0x1f, data: nal });
      }
      i = end;
    }
    return nalus;
  }

  function hwHex(b) {
    var s = (b & 0xff).toString(16);
    return s.length < 2 ? '0' + s : s;
  }

  // 从 SPS 解析 profile_idc / constraint_flags / level_idc，拼 avc1.PPCCLL
  function hwParseAvc1Codec(sps) {
    if (!sps || sps.length < 4) return 'avc1.42c00a';
    return 'avc1.' + hwHex(sps[1]) + hwHex(sps[2]) + hwHex(sps[3]);
  }

  // MediaCapabilities：按浏览器自己的解码能力表判断是否硬件加速。
  // 返回 null 表示当前环境没有这个 API，交给 WebCodecs 兜底。
  function probeMediaCapabilities() {
    if (!navigator.mediaCapabilities ||
      typeof navigator.mediaCapabilities.decodingInfo !== 'function') {
      return null;
    }
    var sawSoftware = false;
    var chain = Promise.resolve(null);
    MC_PROFILES.forEach(function (profile) {
      chain = chain.then(function (hit) {
        if (hit) return hit;
        return navigator.mediaCapabilities
          .decodingInfo({ type: 'file', video: profile })
          .then(function (info) {
            if (!info || !info.supported) return null;
            if (info.powerEfficient) return { ok: true, reason: 'power-efficient' };
            sawSoftware = true;
            return null;
          })
          .catch(function () { return null; });
      });
    });
    return chain.then(function (hit) {
      if (hit) return hit;
      return { ok: false, reason: sawSoftware ? 'software-only' : 'media-cap-unsupported' };
    });
  }

  function probeHwDecodeOnce() {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(false, 'timeout'); }, 2500);
      function finish(ok, reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: !!ok, reason: reason });
      }

      function webCodecsProbe() {
        if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
          finish(false, 'no-webcodecs');
          return;
        }
        var sps = null, pps = null, idr = null;
        try {
          var nalus = hwSplitNalus(hwB64ToBytes(HW_PROBE_H264_B64));
          for (var k = 0; k < nalus.length; k++) {
            if (nalus[k].type === 7) sps = nalus[k].data;
            else if (nalus[k].type === 8) pps = nalus[k].data;
            else if (nalus[k].type === 5) idr = nalus[k].data;
          }
        } catch (e) {
          finish(false, 'parse-sample:' + (e && e.message));
          return;
        }
        if (!sps || !pps || !idr) { finish(false, 'no-nalus'); return; }
        var codec = hwParseAvc1Codec(sps);

        // 先过 isConfigSupported：prefer-hardware 明确不支持就直接判负，省得白建解码器
        var checkSupported = VideoDecoder.isConfigSupported
          ? VideoDecoder.isConfigSupported({ codec: codec, hardwareAcceleration: 'prefer-hardware' })
          : Promise.resolve({ supported: true });
        checkSupported.then(function (r) {
          if (!r || !r.supported) { finish(false, 'isConfig-no'); return; }
          try {
            var dec = new VideoDecoder({
              output: function (frame) {
                // 产出首帧即认定硬解路径可用（prefer-hardware 下能出帧说明硬件后端活着）
                try { frame.close(); } catch (e) {}
                finish(true, 'webcodecs-decoded');
              },
              error: function (e) {
                finish(false, 'decoder-error:' + (e && e.message));
              },
            });
            dec.configure({
              codec: codec,
              codedWidth: 16,
              codedHeight: 16,
              hardwareAcceleration: 'prefer-hardware',
              // 不给 description：chunk 直接用整条 Annex-B 样本（SPS+PPS+IDR），
              // Chromium 会从流里解析参数，兼容性最好，不依赖 {SPS,PPS} 非标准扩展
            });
            // 整个样本就是合法的 Annex-B 访问单元（已用 ffmpeg 验证可解出真实帧），
            // 直接作为一个 key chunk 喂入即可
            dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: hwB64ToBytes(HW_PROBE_H264_B64) }));
            dec.flush().catch(function () {});
          } catch (e) {
            finish(false, 'configure-throw:' + (e && e.message));
          }
        }).catch(function (e) {
          finish(false, 'isConfig-throw:' + (e && e.message));
        });
      }

      var viaMediaCapabilities = probeMediaCapabilities();
      if (viaMediaCapabilities) {
        viaMediaCapabilities.then(function (res) {
          if (res) finish(res.ok, res.reason);
          else webCodecsProbe();
        });
        return;
      }
      webCodecsProbe();
    });
  }

  function startHwProbe() {
    if (hwProbeStarted) return;
    hwProbeStarted = true;
    probeHwDecodeOnce().then(function (res) {
      hwState = res.ok ? true : false;
      hwReason = res.reason || '';
      reportHwState();
      // 探测出能硬解，且当前正在播视频：把 src 换成带 hw=1 的原片，跳过代理
      if (res.ok && current && current.kind === 'video' && current.video) {
        applyHwSource();
      }
    });
  }

  // 扩展宿主重启不会重新加载这个页面，探测结果会随着服务重启丢失。
  // 定期把缓存结果再报一次，面板就能从「未连接」恢复成硬解 / 软解。
  function reportHwState() {
    if (hwState === null) return;
    diagReport({ step: 'hw-probe', ok: hwState, reason: hwReason, cached: true });
  }

  // 给当前视频 src 加上 hw=1，让服务端发原片（走硬解）。
  // 仅在探测确认能硬解后调用；改 src 会触发 pause→reload，已有的 listener 会恢复播放。
  function applyHwSource() {
    if (!current || !current.video) return;
    stopProxyWatcher(); // 切到原片后不再需要代理轮询
    try {
      var v = current.video;
      var u = new URL(v.src, location.href);
      if (u.searchParams.get('hw') === '1') return;
      u.searchParams.set('hw', '1');
      u.searchParams.set('_hw', String(Date.now())); // 破缓存，确保重新请求
      v.src = u.toString();
      diagReport({ step: 'hw-switch-source' });
    } catch (e) {
      // ignore
    }
  }

  /** 场景 / 网页壁纸才需要 1MB 的 WebGL 运行时，别让视频/图片壁纸陪它一起等。 */
  var enginePromise = null;

  function loadEngine() {
    if (window.WebWallGL) return Promise.resolve(window.WebWallGL);
    if (enginePromise) return enginePromise;
    enginePromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/engine/webwallgl.global.min.js';
      script.onload = function () {
        if (window.WebWallGL) resolve(window.WebWallGL);
        else reject(new Error('WebWallGL 未挂到 window'));
      };
      script.onerror = function () {
        reject(new Error('渲染核心加载失败'));
      };
      document.head.appendChild(script);
    });
    return enginePromise;
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  // null 而不是 false：首轮即使壁纸是关闭状态，也要回一条消息给父页面，
  // 父页面才知道「渲染页已加载、本地服务通了」，从而停止重试加载 iframe。
  var reportedEnabled = null;
  var reportedSurface = null;
  var reportedText = null;
  var reportedKind = null;

  /**
   * 只在真正有画面时告诉父页面「可以透明了」。
   * 如果一拿到 state 就解锁 UI，场景包解码那几百毫秒会露出窗口底色，
   * 表现为一次黑屏闪烁；等首帧就绪再切，观感干净得多。
   */
  function report(enabled) {
    enabled = !!enabled;
    // 底衬强度、文字增强、明暗主题一起上报，父页面据此设置 CSS 变量 / 类名
    var surface = state && typeof state.surface === 'number' ? state.surface : 0;
    var text = !!(state && state.textContrast);
    var kind = state && typeof state.themeKind === 'number' ? state.themeKind : 2;
    if (enabled === reportedEnabled && surface === reportedSurface &&
      text === reportedText && kind === reportedKind) return;
    reportedEnabled = enabled;
    reportedSurface = surface;
    reportedText = text;
    reportedKind = kind;
    try {
      window.parent.postMessage(
        {
          channel: CHANNEL,
          type: 'state',
          state: { enabled: enabled, surface: surface, textContrast: text, themeKind: kind },
        },
        '*'
      );
    } catch (err) {
      // 父窗口已关闭
    }
  }

  function markReady() {
    report(true);
  }

  function showHint(text) {
    hint.textContent = text;
    hint.hidden = false;
  }

  function hideHint() {
    hint.hidden = true;
    hint.textContent = '';
  }

  function joinUrl(base, rel) {
    var parts = String(rel || '').split('/').filter(Boolean);
    return base + '/' + parts.map(encodeURIComponent).join('/');
  }

  function fitCss(fit) {
    if (fit === 'contain') return 'contain';
    if (fit === 'fill') return 'fill';
    return 'cover';
  }

  function fitWwgl(fit) {
    if (fit === 'contain') return 'contain';
    if (fit === 'fill') return 'stretch';
    return 'cover';
  }

  var lastVisuals = '';

  // 壁纸亮度分析：由本地服务用 ffmpeg 缩成 32×18 灰度算出来，结果很轻，按 id 缓存
  var analysisCache = {};

  function ensureAnalysis(id) {
    if (!id) return null;
    if (Object.prototype.hasOwnProperty.call(analysisCache, id)) return analysisCache[id];
    analysisCache[id] = null;   // 请求中
    fetch('/analysis/' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        analysisCache[id] = data && data.ok ? data : { lum: null };
        lastVisuals = '';   // 让下一轮重新计算
        if (state) applyVisuals(state);
      })
      .catch(function () { analysisCache[id] = { lum: null }; });
    return null;
  }

  /**
   * 自动对比度：保证「背景亮度」落在与主题匹配的区间。
   * 深色主题把背景压到 0.2 左右；浅色主题提亮到 0.82 左右（用白色遮罩）。
   * 画面越花（方差大）越需要模糊，削弱局部高对比。
   */
  function autoContrastOf(next) {
    if (!next.autoContrast || !current || !current.id) return null;
    var a = ensureAnalysis(current.id);
    if (!a || typeof a.lum !== 'number') return null;

    var light = next.themeKind === 1 || next.themeKind === 4;
    var value = 0;
    var white = false;

    if (light) {
      // 浅色主题：整体亮度不够就用白色遮罩提亮
      var lightTarget = 0.82;
      if (a.lum < lightTarget) {
        value = clamp((lightTarget - a.lum) / Math.max(0.2, 1 - a.lum), 0, 0.75);
        white = true;
      }
    } else {
      // 深色主题：按亮部（p90）计算，别让大片暗背景把水花、灯光这些高光稀释掉
      var bright = typeof a.p90 === 'number' ? a.p90 : a.lum;
      var darkTarget = 0.28;
      if (bright > darkTarget) {
        value = clamp(1 - darkTarget / Math.max(0.05, bright), 0, 0.85);
      }
    }

    return { scrim: value, white: white, blur: clamp((a.variance || 0) * 30, 0, 3) };
  }

  function applyVisuals(next) {
    var opacity = clamp(next.opacity, 0, 1);
    var blur = clamp(next.blur, 0, 40);
    var saturate = clamp(next.saturate, 0, 3);
    var dark = clamp(next.scrim, 0, 1);

    var auto = autoContrastOf(next);
    if (auto) {
      dark = auto.scrim;
      blur = clamp(blur + auto.blur, 0, 40);
    }

    var key = opacity + '|' + blur + '|' + saturate + '|' + dark + '|' + next.fit + '|' + (auto && auto.white ? 'w' : 'b');
    // 每 1.5 秒轮询一次状态；值没变就不要再写样式，
    // 否则全屏视频图层会跟着反复重绘，表现为偶发掉帧
    if (key === lastVisuals) return;
    lastVisuals = key;

    var filters = [];
    if (blur > 0) filters.push('blur(' + blur + 'px)');
    if (saturate !== 1) filters.push('saturate(' + saturate + ')');

    media.style.opacity = String(opacity);
    media.style.filter = filters.length ? filters.join(' ') : 'none';
    scrim.style.background = (auto && auto.white ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + dark + ')';
    document.documentElement.style.setProperty('--bgcover-fit', fitCss(next.fit));
  }

  function destroyCurrent() {
    cancelFade();  // 换壁纸 / 销毁时清理残留的 fade 定时器
    if (current) {
      if (current.inst) {
        try {
          current.inst.destroy();
        } catch (err) {
          // 渲染器已失效
        }
      }
      if (current.video) {
        try {
          current.video.pause();
          current.video.removeAttribute('src');
          current.video.load();
        } catch (err) {
          // 元素已被移除
        }
      }
      if (current.audio) {
        try {
          current.audio.pause();
          current.audio.removeAttribute('src');
          current.audio.load();
        } catch (err) {
          // 元素已被移除
        }
      }
    }
    current = null;
    wanted = null;
    media.textContent = '';
    hideHint();
  }

  /**
   * 顶层窗口是否不可见（最小化 / 切到别的虚拟桌面）。
   *
   * 注意只看「隐藏」，不看「失焦」：桌面可见时点图标、拖动图标会短暂失焦，
   * 那时候壁纸不该停。
   */
  function pageHidden() {
    if (document.hidden) return true;
    if (parentHidden === true) return true;
    try {
      if (window.top && window.top.document && window.top.document.hidden) return true;
    } catch (err) {
      // iframe 跨源，拿不到顶层状态
    }
    return false;
  }

  function shouldPlay() {
    // 只按「窗口是否被隐藏」判断（最小化 / 切到别的虚拟桌面）。
    // 之前用「窗口失焦」判断，点一下 IDE 里的浮窗、弹层或切到别的程序，
    // 主窗口就失去焦点，音乐立刻静止；而壁纸本来就该持续播放。
    // pauseOnBlur 关闭时连最小化都不停。
    return !!(
      state &&
      state.enabled &&
      state.wallpaper &&
      (!state.pauseOnBlur || !pageHidden())
    );
  }

  /** 上一次同步后的播放意图；状态没变就不再碰播放器，避免每轮轮询都打断解码。 */
  var wanted = null;

  // 可见性防抖：刚切回可见时先等一小会儿再恢复播放。可见性在最小化 / 被完全
  // 遮挡之间偶尔会来回抖，立刻起播就会变成一小段一小段的断续声。
  // 用「第一次确认可见的时刻」而不是「上次隐藏的时刻」计时：隐藏期间定时器会被
  // 节流到 1 秒甚至 1 分钟一次，按上一次隐藏时间算会失效。
  var wasHidden = false;
  var visibleAt = 0;
  var resumeTimer = null;

  /**
   * 暂停前 / 恢复时的音量过渡（只用于恢复）：先起播，再从 0 渐回目标音量，
   * 避免音频刚恢复时咔嗒一声。
   *
   * 暂停方向不再走定时器：窗口隐藏后 Chromium 会把定时器降到 1 秒甚至 1 分钟
   * 一次，靠定时器收尾的 pause 会被无限推迟，声音就一直断断续续地漏出来。
   */
  var fadeTimer = null;
  function cancelFade() {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  }
  function fadeInAfterResume(getVol, setVol, targetVol, resumeNow, duration) {
    cancelFade();
    var steps = Math.max(2, Math.round((duration || 120) / 16));
    var step = 0;
    setVol(0);
    resumeNow();
    fadeTimer = setInterval(function () {
      step++;
      var t = step / steps;
      setVol(targetVol * t);  // 从 0 线性升到 targetVol
      if (step >= steps) {
        clearInterval(fadeTimer);
        fadeTimer = null;
        setVol(targetVol);
      }
    }, 16);
  }

  /**
   * WebAudio 上下文登记。
   *
   * 场景壁纸的音乐不一定是 <audio>，可能直接走 WebAudio；窗口隐藏后
   * 引擎自己重新起播的话，光靠 inst.pause() 拦不住。这里把页面（以及网页壁纸
   * 的 iframe）里创建过的 AudioContext 都记下来，隐藏时统一 suspend，
   * 恢复时再 resume，作为最后一道保险。
   */
  var audioContexts = [];
  function trackAudioContext(ctx) {
    if (!ctx) return;
    for (var i = 0; i < audioContexts.length; i++) {
      if (audioContexts[i] === ctx) return;
    }
    audioContexts.push(ctx);
  }
  function hookAudioContext(win) {
    hookOneAudioContext(win, 'AudioContext');
    hookOneAudioContext(win, 'webkitAudioContext');
  }
  function hookOneAudioContext(win, name) {
    try {
      var Orig = win[name];
      if (typeof Orig !== 'function' || Orig.__bgweHooked) return;
      var Wrapped = function (opts) {
        var ctx = opts === undefined ? new Orig() : new Orig(opts);
        try {
          trackAudioContext(ctx);
          // 隐藏期间新建的上下文直接挂起，等恢复播放时再 resume
          if (!shouldPlay()) {
            var p = ctx.suspend();
            if (p && p.catch) p.catch(function () {});
          }
        } catch (err) {}
        return ctx;
      };
      try { Wrapped.prototype = Orig.prototype; } catch (err) {}
      Wrapped.__bgweHooked = true;
      win[name] = Wrapped;
    } catch (err) {
      // 只读属性或跨域，忽略
    }
  }
  /**
   * 隐藏期间禁止媒体起播：直接改写 HTMLMediaElement.prototype.play。
   *
   * 很多网页壁纸/场景壁纸自己在定时器里反复调 play()（自动播放重试、切歌、
   * visibilitychange 回调），只靠外部轮询去 pause 会变成「播一下、停一下」的
   * 断续声。改原型能在执行前就挡掉，并且返回一个已 resolve 的 Promise，
   * 壁纸的重试逻辑也会因此停下来。
   */
  function hookMediaPlay(win, isPaused) {
    try {
      var proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
      if (!proto || typeof proto.play !== 'function' || proto.__bgwePlayHooked) return;
      var orig = proto.play;
      proto.play = function () {
        if (isPaused()) {
          try {
            this.volume = 0;
            this.muted = true;
            this.pause();
          } catch (err) {}
          return win.Promise ? win.Promise.resolve() : undefined;
        }
        return orig.apply(this, arguments);
      };
      proto.__bgwePlayHooked = true;
    } catch (err) {
      // 原型只读时忽略，仍靠事件兜底
    }
  }

  function syncAudioContexts(pause) {
    for (var i = 0; i < audioContexts.length; i++) {
      var ctx = audioContexts[i];
      try {
        if (pause) {
          if (ctx.state === 'running') {
            var p = ctx.suspend();
            if (p && p.catch) p.catch(function () {});
          }
        } else if (ctx.state === 'suspended') {
          var r = ctx.resume();
          if (r && r.catch) r.catch(function () {});
        }
      } catch (err) {
        // 上下文已关闭
      }
    }
  }

  /**
   * 暂停：立即静音 + 暂停，不依赖定时器。
   *
   * 窗口隐藏后 Chromium 会把页面定时器节流到 1 秒甚至 1 分钟一次，
   * 之前「先淡出、由定时器回调里再 pause」的写法会被无限推迟，
   * 最小化后声音还会零碎地响一阵。先把音量归零再 pause 同样不会爆音。
   */
  function silenceCurrent() {
    if (!current) return;
    if (current.video) {
      try { current.video.volume = 0; current.video.muted = true; } catch (err) {}
      try { current.video.pause(); } catch (err) {}
    }
    if (current.audio) {
      try { current.audio.volume = 0; current.audio.muted = true; } catch (err) {}
      try { current.audio.pause(); } catch (err) {}
    }
    if (current.inst) {
      try { current.inst.setVolume(0); } catch (err) {}
      try { current.inst.pause(); } catch (err) {}
    }
    syncAudioContexts(true);
  }

  /**
   * 原生音轨能力探测。
   * VS Code 的 Electron 不带 AAC 解码器：mp4 的视频轨能解，音频轨却是哑的，
   * 同一支壁纸在 Trae 里有声、在 VS Code 里没有。
   *
   * canPlayType 在这里不可靠——VS Code 的 Electron 也会对 mp4a.40.2 返回
   * "maybe"，但真的喂进去还是静音。所以用 URL 里的 app= 参数区分宿主：
   * Trae → 走原生（已经验证能出声）；VS Code → mp4/mov/m4v 一律走 Opus 代理。
   */
  var nativeAudio = null;
  function hasNativeAudio(file) {
    var name = String(file || '').toLowerCase();
    // webm / ogv / mkv 用的是免专利音频，Chromium 一定支持
    if (!/\.(mp4|m4v|mov)$/.test(name)) {
      diagReport({ step: 'hasNativeAudio', file: name, result: true, reason: 'non-mp4' });
      return true;
    }
    if (nativeAudio !== null) {
      diagReport({ step: 'hasNativeAudio', file: name, result: nativeAudio, reason: 'cached' });
      return nativeAudio;
    }
    try {
      var host = new URLSearchParams(location.search).get('app') || '';
      var isVSCode = /Code\.exe|Microsoft VS Code/i.test(host);
      if (isVSCode) {
        nativeAudio = false;
        diagReport({ step: 'hasNativeAudio', file: name, result: false, reason: 'vscode-aac-no', host: host });
      } else {
        // 非 VS Code 仍走 canPlayType 做兜底判断
        var probe = document.createElement('video');
        var type = probe.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
        nativeAudio = type === 'probably' || type === 'maybe';
        diagReport({ step: 'hasNativeAudio', file: name, result: nativeAudio, reason: 'canPlayType', host: host, canPlayType: type });
      }
    } catch (err) {
      // 探测不了就按支持处理，保持原来的行为
      nativeAudio = true;
      diagReport({ step: 'hasNativeAudio', file: name, result: true, reason: 'catch-default', err: String(err && err.message || err) });
    }
    return nativeAudio;
  }

  /** 独立音轨起播；被系统拦截只记诊断，不影响画面 */
  function playAudio(audio) {
    if (!shouldPlay()) return;
    var promise;
    try {
      promise = audio.play();
    } catch (err) {
      diag('audio-play-throw');
      return;
    }
    if (promise && promise.catch) {
      promise.catch(function () {
        diagOnce('audio-play-rejected');
      });
    }
  }

  /**
   * 原生音轨不可用时，给视频挂一条独立的 <audio>。
   * 视频本身始终静音，声音由这条音轨负责；两者都是 loop，偏差由 syncAudioClock 拉回。
   */
  // VSCode 专属：server 在后台自动生成 720p 代理。这里轮询代理状态，
  // ready 且当前还没用上（served=false）时重新加载视频，让 server 改发代理文件。
  // 切换只发生一次；served=true 或壁纸换掉后停止轮询。
  var proxyWatcherTimer = null;
  function stopProxyWatcher() {
    if (proxyWatcherTimer) {
      clearInterval(proxyWatcherTimer);
      proxyWatcherTimer = null;
    }
  }
  function startProxyWatcher(w) {
    stopProxyWatcher();
    // 已确认能硬解：不需要代理，直接发原片走硬解
    if (hwState === true) return;
    if (!w || !w.id) return;
    var id = w.id;
    var ticks = 0;
    proxyWatcherTimer = setInterval(function () {
      ticks++;
      if (ticks > 60 || !current || current.id !== id || !current.video) {
        clearInterval(proxyWatcherTimer);
        proxyWatcherTimer = null;
        return;
      }
      fetch('/proxy/' + encodeURIComponent(id) + '?h=720', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (data.state === 'ready' && data.served) {
            clearInterval(proxyWatcherTimer);
            proxyWatcherTimer = null;
            return;
          }
          if (data.state === 'ready' && !data.served) {
            clearInterval(proxyWatcherTimer);
            proxyWatcherTimer = null;
            diagReport({ step: 'proxy-auto-switch', id: id });
            try {
              var v = current.video;
              var url = new URL(v.src, location.href);
              url.searchParams.set('_proxy', String(Date.now()));
              v.src = url.toString();
              // 改 src 会触发 pause → 已有 listener 会在 300ms 后调 syncPlayback 恢复播放；
              // 音频进度由 syncAudioClock 自动对齐
            } catch (err) {}
          }
        })
        .catch(function () {});
    }, 5000);
  }

  function attachAudioFallback(w, next) {
    if (!w.audio) return;
    var muted = !!next.muted;
    var audio = document.createElement('audio');
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = muted ? 0 : clamp(next.volume, 0, 1);
    audio.muted = muted;
    diagReport({
      step: 'canPlayType',
      oggOpus: audio.canPlayType('audio/ogg; codecs="opus"'),
      oggVorbis: audio.canPlayType('audio/ogg; codecs="vorbis"'),
      ogg: audio.canPlayType('audio/ogg'),
      mp3: audio.canPlayType('audio/mpeg'),
      wav: audio.canPlayType('audio/wav'),
      aac: audio.canPlayType('audio/aac'),
      m4a: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      webm: audio.canPlayType('audio/webm; codecs="opus"'),
      audioSrc: String(w.audio || '').slice(0, 80),
    });
    audio.addEventListener('error', function () {
      diagReport({
        step: 'audio-fallback-error',
        err: audio.error ? audio.error.code : null,
        errMsg: audio.error ? String(audio.error.message || '') : '',
        src: String(audio.currentSrc || audio.src || '').slice(0, 80),
        ready: audio.readyState,
        net: audio.networkState,
      });
    });
    audio.src = w.audio;
    // 兜底：隐藏期间音轨被任何代码（含浏览器恢复）重新起播，立刻压回去
    audio.addEventListener('play', function () {
      if (!shouldPlay()) {
        try { audio.volume = 0; audio.muted = true; } catch (err) {}
        try { audio.pause(); } catch (err) {}
      }
    });
    current.audio = audio;
    diagOnce('audio-fallback');
    startProxyWatcher(w);
  }

  /**
   * 视频播放：有声被系统拦截时自动退回静音，保证画面永远不黑。
   *
   * Chrome 规定「没有用户手势时给正在播放的视频解除静音」会直接把视频暂停，
   * 之前为解锁声音去抬升背景层层级、抢点击，结果连编辑器点击都被挡住。
   * 现在不做任何手势拦截，只按目标音频状态播放，失败就静音继续。
   */
  function playVideo(video) {
    // 隐藏期间一律不许起播：否则会漏出一小段声音再被暂停，听起来就是断断续续
    if (!shouldPlay()) return;
    var promise = video.play();
    if (!promise || !promise.catch) return;
    promise.catch(function () {
      if (video.muted) {
        diag('play-rejected');
        return;
      }
      video.muted = true;
      diagOnce('audio-blocked');
      var retry = video.play();
      if (retry && retry.catch) {
        retry.catch(function () {
          diag('play-rejected');
        });
      }
    });
  }

  function syncPlayback() {
    if (!current) return;
    var play = shouldPlay();

    var hidden = pageHidden();
    if (hidden) {
      wasHidden = true;
    } else if (wasHidden) {
      wasHidden = false;
      visibleAt = Date.now();
    }

    // 刚切回可见时先等一拍再恢复，避免可见性抖动造成断续声。
    // pauseOnBlur 关闭时本来就允许后台播放，不做这个延迟。
    if (play && state && state.pauseOnBlur && visibleAt && Date.now() - visibleAt < 350) {
      if (!resumeTimer) {
        resumeTimer = setTimeout(function () {
          resumeTimer = null;
          syncPlayback();
        }, 380);
      }
      play = false;
    }

    // 网页壁纸的音频活在 iframe 里，引擎的 pause 管不到它，
    // 必须按当前是否该播放，自己把里面的媒体停掉 / 起播。
    if (current.kind === 'web' && state) {
      syncWebAudio(!!state.muted, clamp(state.volume, 0, 1), !play);
    }

    if (wanted === play) return;
    wanted = play;

    var muted = !!(state && state.muted);
    var targetVol = muted ? 0 : clamp(state && state.volume ? state.volume : 0.6, 0, 1);

    if (play) {
      // 恢复播放：先起播，再把音量从 0 拉回目标值（避免音频刚恢复时咔嗒一声）
      // 但如果 muted 或 targetVol=0，直接 resume 就好，不用 fade-in
      if (current.inst) {
        try { current.inst.resume(); } catch (err) {}
        try { current.inst.setVolume(targetVol); } catch (err) {}
      }
      syncAudioContexts(false);
      if (current.video) {
        current.video.volume = targetVol;
        // 独立音轨接管声音时，视频始终静音，避免同一段音频播两遍
        current.video.muted = current.audioFallback ? true : muted || targetVol <= 0;
        playVideo(current.video);
      }
      if (current.audio) {
        current.audio.volume = targetVol;
        current.audio.muted = muted || targetVol <= 0;
        if (current.video) {
          // 恢复播放时先把音轨对齐到视频当前进度
          var drift = Math.abs(current.audio.currentTime - current.video.currentTime);
          if (drift > 0.4 || current.audio.ended) {
            try {
              current.audio.currentTime = current.video.currentTime;
            } catch (err) {
              // 音轨还没加载完，下一轮再对
            }
          }
        }
        if (current.audio.paused) playAudio(current.audio);
      }
      if (!muted && targetVol > 0.01) {
        fadeInAfterResume(
          function () { return targetVol; },
          function (v) {
            if (current && current.inst) try { current.inst.setVolume(v); } catch (err) {}
            if (current && current.video) current.video.volume = v;
          },
          targetVol,
          function () {
            // 已经在上面 resume / playVideo 过了，这里不需要再调
          },
          120
        );
      }
    } else {
      cancelFade();
      silenceCurrent();
    }
  }

  var lastAudio = null;

  // 诊断上报：把 iframe 内音频的运行时状态送回本地服务落盘（D:\TraeData\...\diag.log）
  var diagSentCount = 0;
  var diagLastAt = {};
  var diagLastSrc = '';
  function diagReport(payload) {
    // iframe 重载后重置配额，避免旧页面把次数用完导致后续不再上报
    if (payload && payload.frameSrc && payload.frameSrc !== diagLastSrc) {
      diagLastSrc = payload.frameSrc;
      diagSentCount = 0;
      diagLastAt = {};
    }
    var step = payload && payload.step || '_';
    var now = Date.now();
    // 不同 step 各自节流：audio 每秒一条（最多的），其他 step 事件性地放行
    var throttle = step === 'audio' ? 1000 : 50;
    if (now - (diagLastAt[step] || 0) < throttle) return;
    if (diagSentCount > 400 && step !== 'audio') {
      // 到上限了也要放行关键控制事件，不能丢
    } else {
      diagSentCount++;
    }
    diagLastAt[step] = now;
    try {
      payload.at = now;
      payload.page = location.href;
      navigator.sendBeacon('/diag/report', JSON.stringify(payload));
      // 同时写到顶层 title，方便用无头浏览器直接 dump 出结果
      document.title = ('diag ' + payload.step +
        ' count=' + (payload.count === undefined ? '-' : payload.count) +
        ' clock=' + (payload.clock === undefined ? '-' : payload.clock) +
        ' a0=' + JSON.stringify((payload.items && payload.items[0]) || null) +
        ' res=' + (payload.resources ? payload.resources.slice(-3).join(' | ') : '-')).slice(0, 420);
    } catch (err) {
      // 忽略
    }
  }

  /**
   * 引擎给网页壁纸建的 iframe 只带 sandbox="allow-scripts"，origin 不透明：
   * 既拿不到自动播放权限（没声音），父页面也进不去改音量。
   * 引擎的 webSandbox 参数在部分路径下不生效，这里直接在元素上补权限并重载一次。
   * 补完带 allow-same-origin，下一轮就不会再动它。
   */
  function unlockWebFrame() {
    if (!current || current.kind !== 'web') return;
    var frame = media.querySelector('iframe');
    if (!frame) return;

    // 先补 sandbox：它只在导航时生效，必须赶在改 src 之前设置
    var sandbox = frame.getAttribute('sandbox');
    var okSandbox = sandbox !== null && sandbox.indexOf('allow-same-origin') >= 0;
    if (!okSandbox && !frame.__bgweUnlockTried) {
      frame.__bgweUnlockTried = true;
      try {
        frame.setAttribute('sandbox', sandbox ? sandbox + ' allow-same-origin' : 'allow-scripts allow-same-origin');
        // 自动播放权限单独声明，双保险
        frame.setAttribute('allow', 'autoplay');
        diagOnce('web-frame-unlocked');
      } catch (err) {
        // 忽略：补不上就只能继续无音，不影响画面
      }
    }

    // 再改地址（触发一次导航，用上刚补的 sandbox），同时强制 HTML 回源，
    // 否则浏览器会拿 1 小时前的缓存页面，里面的 <script> 还指着旧的 main.js。
    try {
      var src = frame.getAttribute('src') || '';
      if (src && src.indexOf('about:') !== 0 && src.indexOf('__bgwe=') < 0) {
        frame.setAttribute('src', src + (src.indexOf('?') >= 0 ? '&' : '?') + '__bgwe=' + Date.now());
      }
    } catch (err) {
      // 忽略
    }
  }

  /**
   * 网页壁纸自适应降载。
   *
   * 网页壁纸跑在同源 iframe 里，canvas 通常按 devicePixelRatio 放大，再叠加全屏
   * blur / mix-blend-mode。核显 + 200% 缩放下很容易把 GPU 填满，连带 IDE 一起卡。
   * 这里包一层 iframe 的 requestAnimationFrame：
   *   - 统计真实帧率；
   *   - 连续两轮低于 45fps：把 devicePixelRatio 固定为 1 并触发 resize，canvas 像素降到 1/4；
   *   - 仍低于 38fps：再把 rAF 限到约 30fps。
   * 只降不升，避免画质来回跳；换壁纸 / 重载页面后重新判断。
   */
  function tuneWebPerf(win) {
    if (!win || win.__bgwePerf) return;
    var rawRaf = win.requestAnimationFrame;
    if (typeof rawRaf !== 'function') return;

    var perf = {
      frames: 0,
      windowStart: performance.now(),
      low: 0,
      veryLow: 0,
      reducedDpr: false,
      dprFailed: false,
      throttled: false,
      lastTs: 0,
      lastFrameTs: 0,
      timer: 0,
    };
    try {
      win.__bgwePerf = perf;
    } catch (err) {
      return;
    }

    win.requestAnimationFrame = function (cb) {
      return rawRaf.call(win, function tick(ts) {
        // 限到约 30fps：不足 32ms 就继续等下一帧，不执行壁纸的回调。
        // 同一帧的多个回调（ts 相同）要一起放行，避免多个 rAF 循环互相饿死。
        if (perf.throttled && perf.lastTs && ts !== perf.lastTs && ts - perf.lastTs < 32) {
          rawRaf.call(win, tick);
          return;
        }
        perf.lastTs = ts;
        // 同一帧里的多个 rAF 回调时间戳相同，只算一帧，避免多循环把 fps 算高
        if (ts !== perf.lastFrameTs) {
          perf.frames += 1;
          perf.lastFrameTs = ts;
        }
        cb(ts);
      });
    };

    perf.timer = setInterval(function () {
      var doc;
      try {
        doc = win.document;
      } catch (err) {
        doc = null;
      }
      // iframe 已导航或换壁纸：停止旧窗口的监控
      if (!doc || win.__bgwePerf !== perf) {
        clearInterval(perf.timer);
        return;
      }
      var now = performance.now();
      // 窗口隐藏 / 暂停期间浏览器本来就会限帧，不能据此判断画面卡
      if (!shouldPlay()) {
        perf.frames = 0;
        perf.windowStart = now;
        perf.low = 0;
        perf.veryLow = 0;
        return;
      }
      var fps = perf.frames * 1000 / Math.max(1, now - perf.windowStart);
      perf.frames = 0;
      perf.windowStart = now;

      if (fps < 45) perf.low += 1;
      else perf.low = 0;
      if (fps < 38) perf.veryLow += 1;
      else perf.veryLow = 0;

      if (!perf.reducedDpr && !perf.dprFailed && perf.low >= 2) {
        var dpr = 1;
        try {
          dpr = Number(win.devicePixelRatio) || 1;
        } catch (err) {
          dpr = 1;
        }
        if (dpr > 1) {
          try {
            Object.defineProperty(win, 'devicePixelRatio', {
              configurable: true,
              get: function () { return 1; },
            });
            perf.reducedDpr = true;
            perf.low = 0;
            perf.veryLow = 0;
            perf.frames = 0;
            perf.windowStart = performance.now();
            win.dispatchEvent(new win.Event('resize'));
            diagReport({ step: 'web-perf', mode: 'dpr1', fps: Math.round(fps) });
          } catch (err) {
            perf.dprFailed = true;
            diagReport({ step: 'web-perf-dpr-fail', err: err && err.name, fps: Math.round(fps) });
          }
        }
      }

      if (!perf.throttled && perf.veryLow >= 2) {
        perf.throttled = true;
        diagReport({ step: 'web-perf', mode: '30fps', fps: Math.round(fps) });
      }
    }, 2000);
  }

  /**
   * 网页壁纸跑在同源 iframe 里，自己用 <audio> 或 new Audio() 播音频，
   * 引擎的 setVolume() 管不到它。这里直接接管 iframe 内的媒体元素：
   *   1) 覆盖 iframe 的 Audio 构造器，接住脚本自己创建的音频；
   *   2) 扫描 DOM 里已有的 audio/video，并用 MutationObserver 跟进新增节点。
   * 跨源（iframe 带 sandbox）时访问会抛错，直接放弃，不影响画面。
   */
  function syncWebAudio(muted, volume, pause) {
    if (!current || current.kind !== 'web') return;
    var frame = media.querySelector('iframe');
    if (!frame) return;

    var win, doc;
    try {
      win = frame.contentWindow;
      doc = win && win.document;
    } catch (err) {
      diagReport({
        step: 'cross-origin',
        sandbox: frame.getAttribute('sandbox'),
        frameSrc: frame.getAttribute('src'),
        err: err && err.name,
      });
      return;
    }
    if (!doc || !doc.body) {
      diagReport({
        step: 'no-body',
        sandbox: frame.getAttribute('sandbox'),
        frameSrc: frame.getAttribute('src'),
      });
      return;
    }

    var wanted = { muted: !!muted, volume: volume, pause: !!pause };
    try {
      win.__bgweAudio = wanted;
    } catch (err) {
      return;
    }

    // 同一个 iframe 只挂一次；掉帧时会自动降 DPR / 限帧
    tuneWebPerf(win);

    function applyOne(el) {
      try {
        // 清理上一次残留的 fade 定时器（状态变了或新元素进来）
        if (el.__bgweFadeTimer) { clearInterval(el.__bgweFadeTimer); el.__bgweFadeTimer = null; }

        if (pause) {
          // 暂停要立刻做完：窗口最小化后 iframe 里的定时器同样会被节流，
          // 之前先 fade-out、再由定时器回调 pause，pause 会被推迟很久，
          // 声音就会一段一段地漏出来。先归零再 pause 一样不会爆音。
          try {
            el.volume = 0;
            el.muted = true;
            el.pause();
          } catch (err) {}
        } else {
          // 恢复播放：先起播，再把音量拉回目标值（fade-in 避免咔嗒）
          el.muted = wanted.muted || wanted.volume <= 0;
          if (el.paused && wanted.volume > 0.01 && !wanted.muted) {
            try {
              el.volume = 0;
              var playPromise = el.play();
              if (playPromise && playPromise.catch) playPromise.catch(function () {});
              var fromVol = wanted.volume;
              var steps = 8;  // 8 × 16ms = 128ms fade-in
              var step = 0;
              el.__bgweFadeTimer = setInterval(function () {
                step++;
                var t = step / steps;
                try { el.volume = fromVol * t; } catch (err) {}
                if (step >= steps) {
                  clearInterval(el.__bgweFadeTimer);
                  el.__bgweFadeTimer = null;
                  try { el.volume = fromVol; } catch (err) {}
                }
              }, 16);
              return;
            } catch (err) {
              // play 被拦截（系统策略），退回静音
              try { el.muted = true; } catch (err) {}
            }
          }
          try {
            el.volume = wanted.volume;
            el.muted = wanted.muted || wanted.volume <= 0;
          } catch (err) {}
        }
      } catch (err) {
        // 个别元素是只读的媒体（比如流），忽略
      }
    }

    if (!win.__bgweAudioHooked) {
      win.__bgweAudioHooked = true;

      try {
        var OrigAudio = win.Audio;
        if (OrigAudio) {
          win.Audio = function (src) {
            var a = new OrigAudio(src);
            var st = win.__bgweAudio;
            if (st) {
              try {
                a.volume = st.volume;
                a.muted = st.muted || st.volume <= 0;
                if (st.pause) a.pause();
              } catch (err) {
                // 忽略
              }
            }
            (win.__bgweAudios || (win.__bgweAudios = [])).push(a);
            return a;
          };
          try {
            win.Audio.prototype = OrigAudio.prototype;
          } catch (err) {
            // 忽略
          }
        }
      } catch (err) {
        // 覆盖失败就只依赖 DOM 扫描
      }

      // 壁纸脚本可能自己调 play()（切歌、定时重播、页面自己的可见性回调）。
      // 直接改原型上的 play，让「隐藏期间禁止播放」在执行前就生效。
      hookMediaPlay(win, function () {
        var st = win.__bgweAudio;
        return !!(st && st.pause);
      });

      // 兜底：任何漏网的起播（未经过原型、或是被浏览器恢复）都立刻压回去
      try {
        var onPlayWhilePaused = function (e) {
          var st = win.__bgweAudio;
          if (!st || !st.pause) return;
          try {
            e.target.volume = 0;
            e.target.muted = true;
            e.target.pause();
          } catch (err) {}
        };
        win.addEventListener('play', onPlayWhilePaused, true);
        win.addEventListener('playing', onPlayWhilePaused, true);
      } catch (err) {
        // 忽略
      }

      // iframe 自己建的 WebAudio 上下文也登记进来，隐藏时统一 suspend
      hookAudioContext(win);

      try {
        new win.MutationObserver(function () {
          var st = win.__bgweAudio || wanted;
          var list = doc.querySelectorAll('audio, video');
          for (var i = 0; i < list.length; i++) {
            try {
              list[i].volume = st.volume;
              list[i].muted = st.muted || st.volume <= 0;
              if (st.pause && !list[i].paused) list[i].pause();
            } catch (err) {
              // 忽略
            }
          }
        }).observe(doc, { childList: true, subtree: true });
      } catch (err) {
        // 忽略
      }
    }

    var nodes = doc.querySelectorAll('audio, video');
    for (var i = 0; i < nodes.length; i++) applyOne(nodes[i]);

    // 不在 DOM 里的音频（脚本 new Audio 出来的）也从这里补齐
    var created = win.__bgweAudios || [];
    for (var j = 0; j < created.length; j++) applyOne(created[j]);

    // 诊断：把 iframe 内音频的真实状态送回本地服务，便于定位为什么没声
    var items = [];
    for (var k = 0; k < nodes.length; k++) {
      var el = nodes[k];
      items.push({
        tag: el.tagName,
        paused: !!el.paused,
        t: Number(el.currentTime.toFixed(2)),
        ready: el.readyState,
        net: el.networkState,
        vol: Number(el.volume.toFixed(2)),
        muted: !!el.muted,
        err: el.error ? el.error.code : null,
        src: String(el.currentSrc || el.src || '').split('/').pop(),
      });
    }

    var first = nodes[0];
    var playState = 'none';
    if (pause) {
      // 失焦或壁纸被暂停时不要重新起播，交给 applyOne 停掉
      playState = 'paused';
    } else if (first && first.paused) {
      try {
        var pr = first.play();
        playState = 'pending';
        if (pr && pr.then) {
          pr.then(function () {
            diagReport({ step: 'play-ok' });
          }).catch(function (e) {
            diagReport({ step: 'play-reject', name: e && e.name, msg: String((e && e.message) || '') });
          });
        }
      } catch (e) {
        playState = 'throw:' + (e && e.name);
      }
    } else if (first) {
      playState = 'playing';
    }

    if (!win.__bgweErrHooked) {
      win.__bgweErrHooked = true;
      try {
        win.addEventListener('error', function (e) {
          diagReport({
            step: 'iframe-error',
            msg: String(e.message || ''),
            file: String(e.filename || '').split('/').pop(),
            line: e.lineno,
          });
        });
        win.addEventListener('unhandledrejection', function (e) {
          diagReport({
            step: 'iframe-reject',
            msg: String((e.reason && e.reason.message) || e.reason || ''),
          });
        });
      } catch (e) {
        // 忽略
      }
    }

    diagReport({
      step: 'audio',
      sandbox: frame.getAttribute('sandbox'),
      frameSrc: frame.getAttribute('src'),
      hidden: doc.hidden,
      visibility: doc.visibilityState,
      count: nodes.length,
      created: created.length,
      play: playState,
      // 判断 iframe 里的脚本到底跑没跑：时钟是 main.js 写的，还是 --:-- 就说明没执行
      ready: doc.readyState,
      bodyChildren: doc.body ? doc.body.children.length : -1,
      clock: String((doc.getElementById('clockTime') || {}).textContent || ''),
      scripts: Array.prototype.map.call(doc.querySelectorAll('script[src]'), function (s) {
        return s.getAttribute('src');
      }),
      resources: win.performance
        ? win.performance.getEntriesByType('resource').slice(-10).map(function (e) {
            return e.name.split('/').slice(-2).join('/') + ' size=' + e.transferSize + ' dur=' + Math.round(e.duration);
          })
        : [],
      items: items,
    });
  }

  // iframe 建得比状态轮询晚，或页面稍后才创建音频；低频重扫一次即可
  setInterval(function () {
    if (!current || current.kind !== 'web' || !state) return;
    unlockWebFrame();
    syncWebAudio(!!state.muted, clamp(state.volume, 0, 1), !shouldPlay());
  }, 1000);

  /**
   * 壁纸自带音乐：开关与音量在现有播放器上原地生效，
   * 不重建壁纸、不打断解码，也就不会触发重载提示。
   */
  function applyAudio(next) {
    var muted = !!next.muted;
    var volume = clamp(next.volume, 0, 1);
    var play = shouldPlay();

    // 网页壁纸的音频在 iframe 里，先于下面的「值没变就返回」处理。
    // 必须把「是否该播放」一起传进去：之前这里丢了 pause 参数，每轮轮询都会
    // 按「该播放」把 iframe 里的音频重新拉起来，和 1 秒一次的暂停交替，
    // 最小化后就变成了断断续续的音乐声。
    syncWebAudio(muted, volume, !play);
    syncAudioContexts(!play);

    var key = (muted ? 1 : 0) + '|' + volume;
    if (key === lastAudio) return;
    lastAudio = key;

    if (current && current.video) {
      var video = current.video;
      // 隐藏期间保持静音并把音量归零，任何途径再起播都不会出声音
      video.volume = play ? volume : 0;
      video.muted = current.audioFallback ? true : (!play || muted || volume <= 0);
      // 解除静音会让浏览器暂停已播放的视频；这里补一次播放，失败自动退回静音
      if (play && !video.muted && video.paused) playVideo(video);
    }

    if (current && current.audio) {
      current.audio.volume = play ? volume : 0;
      current.audio.muted = !play || muted || volume <= 0;
      if (play && !current.audio.muted && current.audio.paused) {
        playAudio(current.audio);
      }
    }

    if (current && current.inst) {
      try {
        // webwallgl 实例的音量必须走 setVolume()，直接改 volume 属性不生效。
        // 隐藏期间不能把音量写回目标值，否则引擎自己恢复播放就会漏声。
        current.inst.setVolume(play && !muted ? volume : 0);
      } catch (err) {
        // 渲染器还没就绪，下一次状态轮询再试
      }
      if (!play) {
        try { current.inst.pause(); } catch (err) {}
      }
    }
  }

  /**
   * 场景 / 网页壁纸自带的多首音乐：把用户选中的曲目值下发给壁纸脚本。
   * 空串表示不覆盖（沿用壁纸默认值）。
   *
   * 场景壁纸走 webwallgl 的 setProperties，值变了才下发。
   *
   * 网页壁纸必须每轮状态轮询都重新投递：引擎在 iframe load 时会用 project.json
   * 里的默认属性再覆盖一次，只投递一次会被打回默认曲目；另外注入桥在注入完成前
   * 也会丢消息。这里同时调引擎接口（顺带更新引擎记住的属性，下次 load 用新值）
   * 和页面自己的 wallpaperPropertyListener（壁纸侧同值会提前返回，重复调用无害）。
   */
  var lastMusicTrack = null;
  var lastMusicDiag = '';
  function applyMusicTrack(next) {
    if (!current || !current.inst) {
      lastMusicTrack = null;
      return;
    }
    // 最小化期间不再重复下发曲目：网页壁纸这条路径是每轮轮询都投递的，
    // 有些壁纸收到属性就重载音频，和暂停交替起来就成了断断续续的歌声。
    // 恢复可见后下一轮轮询会自然补上。
    if (!shouldPlay()) return;
    var value = next && next.musicTrack != null ? String(next.musicTrack) : '';
    // 属性名不固定：场景壁纸通常叫 music，网页壁纸可能是 bgmTrack 等。
    // 当前壁纸没有音乐下拉框时 musicKey 为空，这时不要下发，避免误改同名其它属性。
    var key = next && next.musicKey ? String(next.musicKey) : '';
    if (!key) return;

    if (current.kind === 'web') {
      if (!value) return; // 空串：沿用壁纸自己 project.json 里的默认曲目
      var frame = null;
      var direct = false;
      try {
        frame = media.querySelector('iframe');
        var win = frame && frame.contentWindow;
        var listener = win && win.wallpaperPropertyListener;
        if (listener && typeof listener.applyUserProperties === 'function') {
          var props1 = {};
          props1[key] = { value: value };
          listener.applyUserProperties(props1);
          direct = true;
        }
      } catch (err) {
        // 跨源或还没加载好，下一轮再试
      }
      try {
        var props2 = {};
        props2[key] = value;
        current.inst.setProperties(props2);
      } catch (err) {
        // 引擎还没就绪，下一轮再试
      }
      // 同一个值只记一次诊断，避免刷屏
      if (lastMusicDiag !== key + '=' + value) {
        lastMusicDiag = key + '=' + value;
        var audioSrc = '';
        try {
          var fdoc = frame && frame.contentDocument;
          var au = fdoc && fdoc.querySelector('audio');
          audioSrc = au ? String(au.getAttribute('src') || '') : 'no-audio';
        } catch (err) {
          audioSrc = 'err:' + (err && err.name);
        }
        diagReport({
          step: 'music-apply',
          kind: current.kind,
          key: key,
          value: value,
          direct: direct,
          hasFrame: !!frame,
          audioSrc: audioSrc,
        });
      }
      return;
    }

    if (value === lastMusicTrack) return;
    lastMusicTrack = value;
    if (!value) return;
    try {
      var props = {};
      props[key] = value;
      current.inst.setProperties(props);
    } catch (err) {
      lastMusicTrack = null;
    }
  }

  /**
   * 独立音轨和视频是两个解码器，各自 loop，循环点会慢慢错开。
   * 每轮状态轮询（约 600ms）检查一次，偏差超过 0.4 秒就拉回视频进度。
   */
  function syncAudioClock() {
    if (!current || !current.audio || !current.video) return;
    var audio = current.audio;
    var video = current.video;
    if (audio.paused || video.paused) return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.4) {
      try {
        audio.currentTime = video.currentTime;
      } catch (err) {
        // 音轨还没可 seek，下一轮再对
      }
    }
  }

  /** 渲染失败时退回静态预览图，至少保留氛围与色彩。 */
  function fallback(w) {
    if (!current || current.id !== w.id) return;
    diag('fallback-' + (w.kind || '?') + (w.preview ? '-with-preview' : '-no-preview'));

    if (current.inst) {
      try {
        current.inst.destroy();
      } catch (err) {
        // 忽略
      }
    }
    if (current.video) {
      try {
        current.video.pause();
        current.video.removeAttribute('src');
        current.video.load();
      } catch (err) {
        // 忽略
      }
    }
    if (current.audio) {
      try {
        current.audio.pause();
        current.audio.removeAttribute('src');
        current.audio.load();
      } catch (err) {
        // 忽略
      }
    }

    media.textContent = '';
    current.inst = null;
    current.video = null;
    current.audio = null;
    current.audioFallback = false;
    current.img = null;
    current.poster = null;

    if (w.preview) {
      var img = document.createElement('img');
      img.decoding = 'async';
      img.addEventListener('load', function () {
        if (current && current.id === w.id) markReady();
      });
      img.src = w.preview;
      media.appendChild(img);
      current.img = img;
    } else {
      // 连预览图都没有：如实回到不透明 UI，避免留下一个空图层
      report(false);
    }
    showHint('壁纸渲染失败，已显示静态预览');
  }

  /**
   * 视频 / 场景在解码出首帧前先铺一张静态预览，
   * 让背景「立刻出现」，而不是等大文件缓冲完才亮。
   */
  function addPoster(w) {
    if (!w.preview) return null;
    var img = document.createElement('img');
    img.className = 'poster';
    img.decoding = 'async';
    img.addEventListener('load', function () {
      if (current && current.id === w.id) markReady();
    });
    img.src = w.preview;
    media.appendChild(img);
    return img;
  }

  function dropPoster(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function build(next) {
    destroyCurrent();
    var w = next.wallpaper;
    diagReport({ step: 'build', wp: w.id, kind: w.kind });
    current = {
      id: w.id,
      kind: w.kind,
      fps: Number(next.fps) || 60,
      inst: null,
      video: null,
      audio: null,
      audioFallback: false,
      img: null,
      poster: null,
    };

    if (w.kind === 'video') {
      current.poster = addPoster(w);
      var video = document.createElement('video');
      var fallbackAudio = !hasNativeAudio(w.file || 'loop.mp4') && !!w.audio;
      // 隐藏期间新建的视频同样从静音开始，避免挂上去那一瞬间先响一下再被暂停
      var startMuted = fallbackAudio || !shouldPlay() || !!next.muted || clamp(next.volume, 0, 1) <= 0;
      video.muted = startMuted;
      video.volume = clamp(next.volume, 0, 1);
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('playsinline', '');
      if (startMuted) video.setAttribute('muted', '');
      video.setAttribute('disablepictureinpicture', '');
      if (w.preview) video.poster = w.preview;
      var src = joinUrl(w.base, w.file || 'loop.mp4');
      // 已确认能硬解：给 src 加 hw=1，服务端直接发原片，不生成/不使用代理
      if (hwState === true) {
        try {
          var u = new URL(src, location.href);
          u.searchParams.set('hw', '1');
          src = u.pathname + u.search;
        } catch (e) {
          // URL 构造失败就用原始 src，不影响播放
        }
      }
      video.src = src;
      diagReport({
        step: 'video-build',
        file: w.file,
        src: src.substr(0, 120),
        hasNativeAudio: hasNativeAudio(w.file || 'loop.mp4'),
        fallbackAudio: fallbackAudio,
        startMuted: startMuted,
        mutedCfg: !!next.muted,
        volume: clamp(next.volume, 0, 1),
      });
      video.addEventListener('loadeddata', function () {
        if (current && current.id === w.id) markReady();
      });
      video.addEventListener('playing', function () {
        if (current && current.id === w.id) {
          setTimeout(function () {
            if (current && current.id === w.id) dropPoster(current.poster);
          }, 500);
          diagReport({ step: 'video-playing', t: Number(video.currentTime.toFixed(2)), size: video.videoWidth + 'x' + video.videoHeight, muted: !!video.muted });
          diagOnce('video-playing');
          // 起播 3 秒后回报一次音频解码状态：
          // decoded 一直是 0 说明这个 IDE 的 Electron 解不出音轨，
          // 用来确认「无声」到底是解码问题还是自动播放被拦。
          setTimeout(function () {
            if (!current || current.video !== video) return;
            try {
              navigator.sendBeacon(
                '/diag/report',
                JSON.stringify({
                  step: 'video-audio',
                  file: w.file,
                  muted: !!video.muted,
                  volume: Number(video.volume.toFixed(2)),
                  decoded:
                    typeof video.webkitAudioDecodedByteCount === 'number'
                      ? video.webkitAudioDecodedByteCount
                      : -1,
                  fallback: !!current.audioFallback,
                  audio: current.audio
                    ? {
                        paused: !!current.audio.paused,
                        t: Number(current.audio.currentTime.toFixed(1)),
                        vol: Number(current.audio.volume.toFixed(2)),
                        muted: !!current.audio.muted,
                        ready: current.audio.readyState,
                        net: current.audio.networkState,
                        err: current.audio.error ? current.audio.error.code : null,
                        src: String(current.audio.currentSrc || current.audio.src || '').split('/').pop().slice(0, 60),
                        bufEnd: current.audio.buffered && current.audio.buffered.length ? Number(current.audio.buffered.end(current.audio.buffered.length - 1).toFixed(1)) : 0,
                        docHidden: !!document.hidden,
                        docVis: document.visibilityState,
                      }
                    : null,
                  size: video.videoWidth + 'x' + video.videoHeight,
                })
              );
            } catch (err) {
              // 上报失败不影响播放
            }
          }, 3000);
        }
      });
      video.addEventListener('error', function () {
        diag('video-error-' + (video.error ? video.error.code : '?'));
        fallback(w);
      });
      // 系统休眠、GPU 进程重启等会让媒体管线被打断并自行暂停；
      // 只要还处于「应该播放」的状态就恢复，避免画面停在某一帧让人以为卡死
      video.addEventListener('pause', function () {
        if (current && current.video === video && shouldPlay()) {
          wanted = false;
          setTimeout(syncPlayback, 300);
        }
      });
      // 反向兜底：窗口隐藏期间，浏览器的自动播放恢复、换 src 后的自动起播等
      // 都可能让视频自己又播起来。这里立刻压回去，避免漏出一小段声音。
      video.addEventListener('play', function () {
        if (!shouldPlay()) {
          wanted = false;
          try { video.volume = 0; video.muted = true; } catch (err) {}
          try { video.pause(); } catch (err) {}
        }
      });
      media.appendChild(video);
      current.video = video;
      current.audioFallback = fallbackAudio;
      if (fallbackAudio) attachAudioFallback(w, next);
      syncPlayback();
      return;
    }

    if (w.kind === 'image') {
      var img = document.createElement('img');
      img.decoding = 'async';
      img.src = joinUrl(w.base, w.file);
      img.addEventListener('load', function () {
        if (current && current.id === w.id) markReady();
      });
      img.addEventListener('error', function () {
        fallback(w);
      });
      media.appendChild(img);
      current.img = img;
      return;
    }

    current.poster = addPoster(w);

    loadEngine()
      .then(function (api) {
        if (destroyed || !current || current.id !== w.id) return null;
        return api.mount(media, {
          source: api.httpSource(w.base),
          fit: fitWwgl(next.fit),
          fps: Number(next.fps) || 60,
          // 场景 / 网页壁纸自带音乐：音量与静音都交给引擎处理。
          // 窗口隐藏时以静音起播，避免挂载瞬间漏出一小段声音。
          muted: !!next.muted || !shouldPlay(),
          volume: shouldPlay() ? clamp(next.volume, 0, 1) : 0,
          autoplay: true,
          // 网页壁纸默认用 sandbox="allow-scripts"，origin 不透明：自动播放拿不到
          // 权限，音量控制也进不去 iframe。'legacy' 改为 allow-same-origin，
          // 同源后音频才能正常播放并被 applyAudio 接管。
          webSandbox: 'legacy',
          onError: function (err) {
            console.warn('[background-cover] mount error:', err);
            fallback(w);
          },
        });
      })
      .then(function (inst) {
        if (!inst) return;
        if (destroyed || !current || current.id !== w.id) {
          try {
            inst.destroy();
          } catch (err) {
            // 忽略
          }
          return;
        }
        current.inst = inst;
        syncPlayback();
        markReady();
        // 画布已经出画，撤掉静态预览（留一点时间避免闪一下）
        setTimeout(function () {
          if (current && current.id === w.id) dropPoster(current.poster);
        }, 200);
      })
      .catch(function (err) {
        console.warn('[background-cover] mount failed:', err);
        if (current && current.id === w.id) {
          fallback(w);
          showHint('渲染核心加载失败，已显示静态预览');
        }
      });
  }

  function setState(next) {
    var prevEnabled = !!(state && state.enabled && state.wallpaper);
    state = next;

    if (!next.enabled || !next.wallpaper) {
      diagReport({ step: 'setState-skip', reason: !next.enabled ? 'disabled' : 'no-wallpaper' });
      report(false);
      destroyCurrent();
      return;
    }

    applyVisuals(next);
    applyAudio(next);
    var id = next.wallpaper.id;
    var fpsChanged = current && current.fps !== (Number(next.fps) || 60);
    var rebuilding =
      !current ||
      current.id !== id ||
      (fpsChanged && current.kind !== 'video' && current.kind !== 'image');

    diagReport({
      step: 'setState-decide',
      rebuilding: !!rebuilding,
      hasCurrent: !!current,
      currentId: current ? current.id : null,
      newId: id,
      fpsChanged: !!fpsChanged,
    });

    if (rebuilding) {
      // 换了壁纸：清掉上一张记住的曲目，否则两张壁纸曲目值相同就不会再下发
      lastMusicTrack = null;
      lastMusicDiag = '';
      // 首帧就绪后由 loadeddata / mount / 预览图加载回调再解锁父页面，
      // 避免场景包解码期间露出窗口底色
      build(next);
    } else {
      applyMusicTrack(next);
      report(true);
      if (current.inst) {
        try {
          current.inst.setFit(fitWwgl(next.fit));
        } catch (err) {
          // 渲染器还没就绪，下一次状态轮询会再试
        }
      }
      syncPlayback();
    }
    syncAudioClock();

    // 从关闭切回打开时，避免上一次的静态预览残留
    if (!prevEnabled) hideHint();
  }

  var pollTimer = null;

  function schedule(delay) {
    if (destroyed) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  /**
   * 刚打开窗口时，扩展可能还没来得及扫描壁纸库，/state.json 会先返回
   * 「没有壁纸」。这段窗口期用 250ms 密集轮询，稳定后回落 1.5s，
   * 避免用户盯着空背景等一两秒。
   */
  function nextDelay(json) {
    if (!json) return Date.now() - startedAt < FAST_WINDOW ? FAST_MS : POLL_MS;
    if (json.enabled && json.wallpaper) return POLL_MS;
    // 已经选好壁纸但扩展还没扫描完库：继续密集轮询，别让首帧多等 1.5 秒
    if (json.enabled && json.wallpaperId) return FAST_MS;
    return Date.now() - startedAt < FAST_WINDOW ? FAST_MS : POLL_MS;
  }

  function poll() {
    if (destroyed) return;
    fetch('/state.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        diagReport({ step: 'state-fetch', wp: json && json.wallpaper ? json.wallpaper.id + '(' + json.wallpaper.kind + ')' : null, enabled: !!json.enabled });
        diagReport({ step: 'about-to-call-setState', wp: json && json.wallpaper ? json.wallpaper.id : null });
        try {
          setState(json);
        } catch (err) {
          diagReport({ step: 'setState-crash', msg: String(err && err.message || err), stack: String(err && err.stack || '').slice(0, 200) });
        }
        schedule(nextDelay(json));
      })
      .catch(function (err) {
        diagReport({ step: 'state-fetch-fail', msg: String(err && err.message || err) });
        schedule(nextDelay(null));
      });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    // 父页面用它判断这个文档还活着；渲染进程崩溃时不会再有回话，父页面据此重挂 iframe
    if (data.type === 'ping') {
      try {
        window.parent.postMessage({ channel: CHANNEL, type: 'pong' }, '*');
      } catch (err) {
        // 父窗口已关闭
      }
      return;
    }
    if (data.type === 'focus') {
      focused = !!data.focused;
      // workbench 直接上报可见性：最小化时它比本帧的 document.hidden 更可靠。
      // 只认隐藏，不认失焦——桌面可见时点 / 拖图标不能停音乐。
      if (typeof data.hidden === 'boolean' && data.hidden !== parentHidden) {
        parentHidden = data.hidden;
        if (parentHidden) wasHidden = true;
      }
      syncPlayback();
    }
  });

  document.addEventListener('visibilitychange', function () {
    syncPlayback();
    if (!document.hidden) poll();
  });

  // 主动焦点健康检查：
  // 1) 尝试直接查顶层 Trae 窗口的焦点状态（live.js 在 iframe 里，跨域可能被拦，
  //    那就退回到 runtime.js 传来的 focused 变量）；
  // 2) 不依赖 runtime.js 的 postMessage 也能及时调 syncPlayback，
  //    覆盖 blur 事件未触发、Chrome suspend AudioContext 但画面还在跑的场景。
  setInterval(function () {
    var topFocused = null;
    try {
      // iframe 跨域，直接碰 window.top.document 会抛 DOMException，吞掉就好
      topFocused = !!(window.top && window.top.document && window.top.document.hasFocus
        && window.top.document.hasFocus() && !window.top.document.hidden);
    } catch (err) {
      // 跨域拦截，拿不到顶层焦点状态，忽略
    }
    // 有直接检测结果就优先用，没有就用 runtime.js 传来的 focused
    var effectiveFocused = topFocused !== null ? topFocused : focused;
    if (effectiveFocused !== focused) {
      focused = effectiveFocused;
    }
    // 定期再调一次 syncPlayback：哪怕 focused 没变，pauseOnBlur 配置变了也要立刻生效
    syncPlayback();
  }, 300);

  window.addEventListener('beforeunload', function () {
    destroyed = true;
    destroyCurrent();
  });

  // 给扩展日志留一条「渲染页确实跑起来了」的证据，便于排查注入是否生效
  diag('live-loaded');

  // 尽早探测硬解能力：能硬解就让服务端发原片，不能才走代理软解。
  // 结果缓存到 hwState，build 视频时据此决定 src 是否带 hw=1。
  startHwProbe();

  // 扩展宿主重启 / 服务切换端口后，服务端状态会归零；定期重报一次缓存结果。
  // 15 秒足够让面板从「未连接」自动恢复，又不会给 diag.log 造成明显体积。
  setInterval(reportHwState, 15000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) reportHwState();
  });

  // 接管本帧的 AudioContext 构造器（场景壁纸的 WebAudio 音乐由此登记），
  // 必须在加载渲染核心之前完成。媒体元素的 play() 同样先接管：
  // 场景壁纸的声音图层是引擎自己创建、自己定时起播的，只靠轮询 pause 会断续。
  hookAudioContext(window);
  hookMediaPlay(window, function () { return !shouldPlay(); });

  /**
   * 同时开着 Trae / VS Code 时，两边的本地服务都监听 127.0.0.1，端口可能撞上。
   * 父页面会在 URL 里带上它所属 IDE 的标识，这里和服务端 /health 对一次，
   * 对不上就告诉父页面「这个端口不是你的」，让它换下一个 —— 否则会一直读
   * 另一个 IDE 的 /state.json，表现为换壁纸没反应、画面卡住。
   */
  function verifyOwner() {
    var expect = '';
    try {
      expect = new URLSearchParams(location.search).get('app') || '';
    } catch (err) {
      return Promise.resolve(true);
    }
    if (!expect) return Promise.resolve(true);

    return fetch('/health?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (json) {
        if (json && json.app === expect) return true;
        try {
          window.parent.postMessage({ channel: CHANNEL, type: 'wrongApp' }, '*');
        } catch (err) {
          // 父窗口已关闭
        }
        return false;
      })
      .catch(function () {
        return true;
      });
  }

  verifyOwner().then(function (ok) {
    diagReport({ step: 'owner-check', ok: !!ok });
    if (ok) poll();
  });
})();

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
  var POLL_MS = 1500;   // 稳定后：1.5 秒一次
  var FAST_MS = 250;    // 启动阶段：本地服务/壁纸状态可能还没就绪，先密集轮询
  var FAST_WINDOW = 4000;

  var media = document.getElementById('media');
  var scrim = document.getElementById('scrim');
  var hint = document.getElementById('hint');

  var state = null;      // 最近一次 /state.json
  var current = null;    // { id, kind, inst, video, img, poster }
  var focused = true;    // 父窗口（IDE）是否聚焦
  var destroyed = false;
  var startedAt = Date.now();

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

  /**
   * 只在真正有画面时告诉父页面「可以透明了」。
   * 如果一拿到 state 就解锁 UI，场景包解码那几百毫秒会露出窗口底色，
   * 表现为一次黑屏闪烁；等首帧就绪再切，观感干净得多。
   */
  function report(enabled) {
    enabled = !!enabled;
    if (enabled === reportedEnabled) return;
    reportedEnabled = enabled;
    try {
      window.parent.postMessage(
        { channel: CHANNEL, type: 'state', state: { enabled: enabled } },
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

  function applyVisuals(next) {
    var opacity = clamp(next.opacity, 0, 1);
    var blur = clamp(next.blur, 0, 40);
    var saturate = clamp(next.saturate, 0, 3);

    var filters = [];
    if (blur > 0) filters.push('blur(' + blur + 'px)');
    if (saturate !== 1) filters.push('saturate(' + saturate + ')');

    media.style.opacity = String(opacity);
    media.style.filter = filters.length ? filters.join(' ') : 'none';
    scrim.style.background = 'rgba(0,0,0,' + clamp(next.scrim, 0, 1) + ')';
    document.documentElement.style.setProperty('--bgcover-fit', fitCss(next.fit));
  }

  function destroyCurrent() {
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
    }
    current = null;
    media.textContent = '';
    hideHint();
  }

  function shouldPlay() {
    return !!(
      state &&
      state.enabled &&
      state.wallpaper &&
      (!state.pauseOnBlur || focused) &&
      !document.hidden
    );
  }

  function syncPlayback() {
    if (!current) return;
    var play = shouldPlay();

    if (current.inst) {
      try {
        if (play) current.inst.resume();
        else current.inst.pause();
      } catch (err) {
        // 渲染器还没就绪
      }
    }

    if (current.video) {
      if (play) {
        var promise = current.video.play();
        if (promise && promise.catch) promise.catch(function () {});
      } else {
        current.video.pause();
      }
    }
  }

  /** 渲染失败时退回静态预览图，至少保留氛围与色彩。 */
  function fallback(w) {
    if (!current || current.id !== w.id) return;

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

    media.textContent = '';
    current.inst = null;
    current.video = null;
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
    current = { id: w.id, kind: w.kind, fps: Number(next.fps) || 60, inst: null, video: null, img: null, poster: null };

    if (w.kind === 'video') {
      current.poster = addPoster(w);

      var video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('disablepictureinpicture', '');
      // 有预览图就当 poster 用：视频第一帧出来之前不会露出一块黑
      if (w.preview) video.poster = w.preview;
      video.src = joinUrl(w.base, w.file || 'loop.mp4');
      video.addEventListener('loadeddata', function () {
        if (current && current.id === w.id) markReady();
      });
      video.addEventListener('playing', function () {
        if (current && current.id === w.id) dropPoster(current.poster);
      });
      video.addEventListener('error', function () {
        fallback(w);
      });
      media.appendChild(video);
      current.video = video;
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
          autoplay: true,
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
      report(false);
      destroyCurrent();
      return;
    }

    applyVisuals(next);
    var id = next.wallpaper.id;
    var fpsChanged = current && current.fps !== (Number(next.fps) || 60);
    var rebuilding =
      !current ||
      current.id !== id ||
      (fpsChanged && current.kind !== 'video' && current.kind !== 'image');

    if (rebuilding) {
      // 首帧就绪后由 loadeddata / mount / 预览图加载回调再解锁父页面，
      // 避免场景包解码期间露出窗口底色
      build(next);
    } else {
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
    var ready = json && json.wallpaper && json.enabled;
    if (ready) return POLL_MS;
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
        setState(json);
        schedule(nextDelay(json));
      })
      .catch(function (err) {
        // 扩展服务暂时不可达（例如宿主窗口正在切换）：保留当前画面，不闪成空白
        console.warn('[background-cover] state fetch failed:', err);
        schedule(nextDelay(null));
      });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === 'focus') {
      focused = !!data.focused;
      syncPlayback();
    }
  });

  document.addEventListener('visibilitychange', function () {
    syncPlayback();
    if (!document.hidden) poll();
  });

  window.addEventListener('beforeunload', function () {
    destroyed = true;
    destroyCurrent();
  });

  // 给扩展日志留一条「渲染页确实跑起来了」的证据，便于排查注入是否生效
  try {
    fetch('/diag?event=live-loaded', { cache: 'no-store' }).catch(function () {});
  } catch (err) {
    // 忽略
  }

  poll();
})();

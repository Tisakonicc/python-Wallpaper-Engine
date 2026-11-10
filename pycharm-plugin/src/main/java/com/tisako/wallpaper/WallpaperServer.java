package com.tisako.wallpaper;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * 本地静态服务：只监听 127.0.0.1 的随机端口，给内嵌浏览器提供背景页、面板页和媒体流。
 * 视频需要 Range 支持（Chromium 会先发 bytes=0- 探测），所以这里实现了 206。
 */
public final class WallpaperServer {

    /** 背景页需要的一次快照。 */
    public static final class Snapshot {
        public final WallpaperEntry entry;
        public final int opacity;
        public final String fit;
        public final int blur;
        public final int scrim;
        public final int posX;
        public final boolean enabled;
        public final String currentId;

        public Snapshot(WallpaperEntry entry, int opacity, String fit, int blur, int scrim, int posX, boolean enabled, String currentId) {
            this.entry = entry;
            this.opacity = opacity;
            this.fit = fit;
            this.blur = blur;
            this.scrim = scrim;
            this.posX = posX;
            this.enabled = enabled;
            this.currentId = currentId;
        }
    }

    /** 与主服务的桥接，避免服务端反向依赖 Swing 状态。 */
    public interface Actions {
        List<WallpaperEntry> entries();

        Snapshot snapshot();

        void apply(String id);

        void toggle();

        void rescan();

        /** 弹系统文件框导入本地视频 / 图片（异步，在 EDT 上执行）。 */
        void importLocal();

        /** 更新背景参数（面板上的滑块调用）。 */
        void updateSettings(int opacity, int blur, int scrim, int posX, String fit);

    }

    private final Actions actions;
    private HttpServer server;
    private int port = -1;

    public WallpaperServer(Actions actions) {
        this.actions = actions;
    }

    public synchronized int port() throws IOException {
        if (server == null) {
            HttpServer created = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
            created.createContext("/", this::handle);
            created.setExecutor(Executors.newFixedThreadPool(3, runnable -> {
                Thread thread = new Thread(runnable, "wallpaper-bg-server");
                thread.setDaemon(true);
                return thread;
            }));
            created.start();
            server = created;
            port = created.getAddress().getPort();
        }
        return port;
    }

    public synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
            port = -1;
        }
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            switch (path) {
                case "/", "/bg.html" -> sendBackgroundPage(exchange);
                case "/panel.html" -> sendPanelPage(exchange);
                case "/state.json" -> sendState(exchange);
                case "/apply" -> {
                    actions.apply(parseQuery(exchange.getRequestURI().getRawQuery()).get("id"));
                    sendText(exchange, 200, "ok");
                }
                case "/toggle" -> {
                    actions.toggle();
                    sendText(exchange, 200, "ok");
                }
                case "/rescan" -> {
                    actions.rescan();
                    sendText(exchange, 200, "ok");
                }
                case "/import" -> {
                    actions.importLocal();
                    sendText(exchange, 200, "ok");
                }
                case "/settings/update" -> {
                    Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
                    int opacity = parseInt(query.get("opacity"), 70);
                    int blur = parseInt(query.get("blur"), 0);
                    int scrim = parseInt(query.get("scrim"), 45);
                    int posX = parseInt(query.get("posx"), 50);
                    actions.updateSettings(opacity, blur, scrim, posX, query.get("fit"));
                    sendText(exchange, 200, "ok");
                }
                case "/media" -> sendFile(exchange, false);
                case "/preview" -> sendFile(exchange, true);
                case "/health" -> sendText(exchange, 200, "ok");
                default -> sendText(exchange, 404, "not found");
            }
        } catch (Exception err) {
            try {
                sendText(exchange, 500, String.valueOf(err));
            } catch (IOException ignored) {
            }
        } finally {
            exchange.close();
        }
    }

    // ---------- 页面 ----------

    private void sendBackgroundPage(HttpExchange exchange) throws IOException {
        Snapshot state = actions.snapshot();
        String fit = state.fit == null ? "cover" : state.fit;
        int opacity = Math.max(10, Math.min(100, state.opacity));
        // 压暗层有下限，保证 UI 文字在亮色壁纸上也可读
        double scrim = Math.max(0.4, (100 - opacity) / 100.0 * 0.9);
        int blur = Math.max(0, Math.min(30, state.blur));

        String media = "";
        String previewUrl = "";
        WallpaperEntry entry = state.entry;
        if (entry != null) {
            if (entry.preview != null) previewUrl = "/preview?id=" + encode(entry.id);
            if (entry.media != null && !"scene".equals(entry.kind) && !"web".equals(entry.kind)) {
                String url = "/media?id=" + encode(entry.id);
                // JCEF 对部分视频编码（H.264 等）支持不稳，先给 poster 静帧，
                // 解码失败再整体回退成预览图，避免整屏死黑
                String poster = previewUrl.isEmpty() ? "" : " poster=\"" + previewUrl + "\"";
                media = "video".equals(entry.kind)
                        ? "<video id=\"m\" src=\"" + url + "\"" + poster + " autoplay loop muted playsinline onerror=\"fallback()\"></video>"
                        : "<img id=\"m\" src=\"" + url + "\" alt=\"\" onerror=\"fallback()\">";
            } else if (!previewUrl.isEmpty()) {
                // 场景 / 网页壁纸暂不支持实时渲染，先显示缩略图
                media = "<img id=\"m\" src=\"" + previewUrl + "\" alt=\"\" onerror=\"fallback()\">";
            }
        }

        String html = """
                <!doctype html>
                <html><head><meta charset="utf-8"><style>
                html, body { margin: 0; height: 100%%; overflow: hidden;
                             background: linear-gradient(160deg, #23242e, #121318); }
                video, img { width: 100vw; height: 100vh; object-fit: %s; display: block;
                             filter: blur(%dpx); }
                .scrim { position: fixed; inset: 0; background: rgba(0,0,0,%.2f); pointer-events: none; }
                </style></head><body>
                %s
                <div class="scrim"></div>
                <script>
                var fellBack = false;
                function fallback() {
                  if (fellBack) return;
                  fellBack = true;
                  var m = document.getElementById('m');
                  if (!m) return;
                  var p = '%s';
                  if (p) { m.outerHTML = '<img id="m" src="' + p + '">'; }
                  else { m.remove(); }
                }
                // H.264 解码失败时 video 不一定触发 error，只是停在黑屏；
                // 2.5 秒后仍拿不到画面尺寸就按失败处理
                setTimeout(function() {
                  var v = document.querySelector('video');
                  if (v && (v.videoWidth === 0 || v.readyState === 0)) fallback();
                }, 2500);
                </script>
                </body></html>
                """.formatted(fit, blur, scrim, media, previewUrl);
        sendHtml(exchange, html);
    }

    private void sendPanelPage(HttpExchange exchange) throws IOException {
        sendHtml(exchange, PANEL_HTML);
    }

    private static final String PANEL_HTML = """
            <!doctype html>
            <html><head><meta charset="utf-8"><style>
            body { margin: 0; background: #1e1e24; color: #ddd; font: 12px system-ui;
                   display: flex; flex-direction: column; height: 100vh; }
            header { display: flex; gap: 8px; align-items: center; padding: 8px 10px;
                     border-bottom: 1px solid #333; flex: 0 0 auto; }
            h1 { font-size: 13px; margin: 0; flex: 1; white-space: nowrap;
                 overflow: hidden; text-overflow: ellipsis; }
            button { background: #3b82f6; color: #fff; border: 0; border-radius: 5px;
                     padding: 4px 10px; cursor: pointer; font: inherit; }
            button.ghost { background: transparent; border: 1px solid #555; }
            .ctrl { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
                    border-bottom: 1px solid #333; flex: 0 0 auto; background: #232329; }
            .row { display: flex; align-items: center; gap: 8px; }
            .row label { width: 74px; color: #aaa; flex: 0 0 auto; }
            .row input[type=range] { flex: 1; accent-color: #3b82f6; }
            .row .val { width: 38px; text-align: right; color: #9ecbff; flex: 0 0 auto; }
            .row select { flex: 1; background: #2a2a33; color: #ddd; border: 1px solid #444;
                          border-radius: 4px; padding: 3px 6px; font: inherit; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
                    gap: 8px; padding: 10px; overflow: auto; flex: 1 1 auto;
                    align-items: start; align-content: start; }
            .card { border: 1px solid #333; border-radius: 7px; overflow: hidden;
                    cursor: pointer; background: #000; align-self: start; }
            .card:hover { border-color: #3b82f6; }
            .card.cur { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6; }
            .card img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; }
            .card .s { position: relative; aspect-ratio: 16/10; background: #2a2a33; }
            .card .s img { position: absolute; inset: 0; }
            .card .b { position: absolute; top: 4px; left: 4px; background: #3b82f6; color: #fff;
                       font-size: 10px; padding: 1px 5px; border-radius: 3px; }
            .card .t { padding: 4px 6px; font-size: 11px; white-space: nowrap;
                       overflow: hidden; text-overflow: ellipsis; }
            .empty { padding: 24px; color: #888; text-align: center; grid-column: 1 / -1; }
            </style></head><body>
            <header><h1 id="cur">壁纸背景</h1>
            <button class="ghost" id="imp">导入</button>
            <button class="ghost" id="rf">刷新</button><button id="tg">…</button></header>
            <div class="ctrl">
              <div class="row"><label>不透明度</label>
                <input type="range" id="op" min="10" max="100" step="5"><span class="val" id="opv"></span></div>
              <div class="row"><label>背景虚化</label>
                <input type="range" id="bl" min="0" max="60" step="2"><span class="val" id="blv"></span></div>
              <div class="row"><label>代码区压暗</label>
                <input type="range" id="sc" min="0" max="100" step="5"><span class="val" id="scv"></span></div>
              <div class="row"><label>水平位置</label>
                <input type="range" id="px" min="0" max="100" step="5"><span class="val" id="pxv"></span></div>
              <div class="row"><label>填充方式</label>
                <select id="ft">
                  <option value="contain">适应窗口（完整显示）</option>
                  <option value="cover">铺满窗口（裁掉边缘）</option>
                  <option value="stretch">拉伸铺满</option>
                </select></div>
            </div>
            <div class="grid" id="grid"></div>
            <script>
            const K = { video: '视频', image: '图片', scene: '场景', web: '网页' };
            let busy = false;

            function paintControls(s) {
              document.getElementById('op').value = s.opacity;
              document.getElementById('opv').textContent = s.opacity + '%';
              document.getElementById('bl').value = s.blur;
              document.getElementById('blv').textContent = s.blur + 'px';
              document.getElementById('sc').value = s.scrim;
              document.getElementById('scv').textContent = s.scrim + '%';
              document.getElementById('px').value = s.posX;
              document.getElementById('pxv').textContent = s.posX + '%';
              document.getElementById('ft').value = s.fit || 'contain';
            }

            async function load(refreshControls) {
              const s = await (await fetch('/state.json?t=' + Date.now())).json();
              document.getElementById('tg').textContent = s.enabled ? '关闭' : '启用';
              document.getElementById('cur').textContent = s.current || '未选择壁纸';
              if (refreshControls) paintControls(s);
              const g = document.getElementById('grid');
              g.innerHTML = '';
              for (const e of s.entries) {
                const c = document.createElement('div');
                c.className = 'card' + (e.id === s.currentId ? ' cur' : '');
                c.innerHTML = '<div class="s">' +
                  (e.hasPreview ? '<img src="/preview?id=' + encodeURIComponent(e.id) + '&t=' + Date.now() + '">' : '') +
                  '<span class="b">' + (K[e.kind] || e.kind) + '</span></div><div class="t"></div>';
                c.querySelector('.t').textContent = e.title;
                c.onclick = async () => { await fetch('/apply?id=' + encodeURIComponent(e.id)); load(true); };
                g.appendChild(c);
              }
              if (!s.entries.length) {
                g.innerHTML = '<div class="empty">没有找到壁纸：去 Steam 创意工坊订阅，' +
                  '或点右上角「导入」选择本地视频 / 图片</div>';
              }
            }

            async function push() {
              if (busy) return;
              busy = true;
              const op = document.getElementById('op').value;
              const bl = document.getElementById('bl').value;
              const sc = document.getElementById('sc').value;
              const px = document.getElementById('px').value;
              const ft = document.getElementById('ft').value;
              document.getElementById('opv').textContent = op + '%';
              document.getElementById('blv').textContent = bl + 'px';
              document.getElementById('scv').textContent = sc + '%';
              document.getElementById('pxv').textContent = px + '%';
              await fetch('/settings/update?opacity=' + op + '&blur=' + bl + '&scrim=' + sc + '&posx=' + px + '&fit=' + ft);
              busy = false;
            }
            let pushTimer = null;
            function pushSoon() { clearTimeout(pushTimer); pushTimer = setTimeout(push, 220); }

            document.getElementById('op').oninput = pushSoon;
            document.getElementById('bl').oninput = pushSoon;
            document.getElementById('sc').oninput = pushSoon;
            document.getElementById('px').oninput = pushSoon;
            document.getElementById('ft').onchange = push;
            document.getElementById('tg').onclick = async () => { await fetch('/toggle'); load(true); };
            document.getElementById('rf').onclick = async () => { await fetch('/rescan'); load(true); };
            document.getElementById('imp').onclick = async () => {
              await fetch('/import');
              setTimeout(() => load(false), 1500);
              setTimeout(() => load(true), 4000);
            };
            load(true);
            setInterval(() => load(false), 5000);
            </script></body></html>
            """;

    // ---------- 数据 ----------

    private void sendState(HttpExchange exchange) throws IOException {
        Snapshot snapshot = actions.snapshot();
        List<WallpaperEntry> entries = actions.entries();
        StringBuilder json = new StringBuilder(4096);
        json.append("{\"enabled\":").append(snapshot.enabled)
                .append(",\"currentId\":").append(quote(snapshot.currentId))
                .append(",\"opacity\":").append(snapshot.opacity)
                .append(",\"blur\":").append(snapshot.blur)
                .append(",\"scrim\":").append(snapshot.scrim)
                .append(",\"posX\":").append(snapshot.posX)
                .append(",\"fit\":").append(quote(snapshot.fit))
                .append(",\"current\":").append(quote(snapshot.entry == null ? "" : snapshot.entry.title))
                .append(",\"entries\":[");
        boolean first = true;
        for (WallpaperEntry entry : entries) {
            if (!first) json.append(',');
            first = false;
            json.append("{\"id\":").append(quote(entry.id))
                    .append(",\"title\":").append(quote(entry.title))
                    .append(",\"kind\":").append(quote(entry.kind))
                    .append(",\"imported\":").append(entry.imported)
                    .append(",\"hasPreview\":").append(entry.preview != null)
                    .append("}");
        }
        json.append("]}");
        byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().add("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static String quote(String value) {
        if (value == null) return "\"\"";
        StringBuilder out = new StringBuilder(value.length() + 8);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> out.append(ch < 0x20 ? " " : ch);
            }
        }
        out.append('"');
        return out.toString();
    }

    // ---------- 文件流 ----------

    private void sendFile(HttpExchange exchange, boolean previewOnly) throws IOException {
        Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
        String id = query.get("id");
        WallpaperEntry entry = null;
        for (WallpaperEntry candidate : actions.entries()) {
            if (candidate.id.equals(id)) {
                entry = candidate;
                break;
            }
        }
        if (entry == null) {
            sendText(exchange, 404, "no such wallpaper");
            return;
        }
        Path file = previewOnly ? entry.preview : entry.media;
        if (file == null || !Files.isRegularFile(file)) {
            sendText(exchange, 404, "no media");
            return;
        }

        long size = Files.size(file);
        String range = exchange.getRequestHeaders().getFirst("Range");
        long start = 0;
        long end = size - 1;
        boolean partial = false;

        if (range != null && range.startsWith("bytes=")) {
            String spec = range.substring("bytes=".length()).trim();
            int dash = spec.indexOf('-');
            try {
                if (dash > 0) {
                    start = Long.parseLong(spec.substring(0, dash));
                    if (dash + 1 < spec.length()) end = Long.parseLong(spec.substring(dash + 1));
                } else if (dash == 0 && spec.length() > 1) {
                    // bytes=-500 表示最后 500 字节
                    start = Math.max(0, size - Long.parseLong(spec.substring(1)));
                }
                end = Math.min(end, size - 1);
                if (start > end) start = 0;
                partial = true;
            } catch (NumberFormatException ignored) {
                start = 0;
                end = size - 1;
                partial = false;
            }
        }

        long length = end - start + 1;
        exchange.getResponseHeaders().add("Content-Type", contentType(file));
        exchange.getResponseHeaders().add("Accept-Ranges", "bytes");
        exchange.getResponseHeaders().add("Cache-Control", "no-store");
        if (partial) {
            exchange.getResponseHeaders().add("Content-Range", "bytes " + start + "-" + end + "/" + size);
        }
        exchange.sendResponseHeaders(partial ? 206 : 200, length);

        try (RandomAccessFile raf = new RandomAccessFile(file.toFile(), "r");
             OutputStream out = exchange.getResponseBody()) {
            raf.seek(start);
            byte[] buffer = new byte[64 * 1024];
            long remaining = length;
            while (remaining > 0) {
                int read = raf.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                if (read < 0) break;
                out.write(buffer, 0, read);
                remaining -= read;
            }
        }
    }

    private static String contentType(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".mp4")) return "video/mp4";
        if (name.endsWith(".webm")) return "video/webm";
        if (name.endsWith(".mov")) return "video/quicktime";
        if (name.endsWith(".m4v")) return "video/x-m4v";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".avif")) return "image/avif";
        if (name.endsWith(".bmp")) return "image/bmp";
        return "image/jpeg";
    }

    private static void sendHtml(HttpExchange exchange, String html) throws IOException {
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "text/html; charset=utf-8");
        exchange.getResponseHeaders().add("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static void sendText(HttpExchange exchange, int status, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static int parseInt(String raw, int fallback) {
        if (raw == null || raw.isBlank()) return fallback;
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException err) {
            return fallback;
        }
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> result = new HashMap<>();
        if (raw == null || raw.isEmpty()) return result;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            result.put(URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return result;
    }

    private static String encode(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}

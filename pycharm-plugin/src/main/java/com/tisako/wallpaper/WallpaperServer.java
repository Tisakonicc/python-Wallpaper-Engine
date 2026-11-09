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
        public final boolean enabled;
        public final String currentId;

        public Snapshot(WallpaperEntry entry, int opacity, String fit, int blur, boolean enabled, String currentId) {
            this.entry = entry;
            this.opacity = opacity;
            this.fit = fit;
            this.blur = blur;
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
        double scrim = (100 - opacity) / 100.0 * 0.9;
        int blur = Math.max(0, Math.min(30, state.blur));

        String media = "";
        WallpaperEntry entry = state.entry;
        if (entry != null) {
            if (entry.media != null && !"scene".equals(entry.kind) && !"web".equals(entry.kind)) {
                String url = "/media?id=" + encode(entry.id);
                media = "video".equals(entry.kind)
                        ? "<video src=\"" + url + "\" autoplay loop muted playsinline></video>"
                        : "<img src=\"" + url + "\" alt=\"\">";
            } else if (entry.preview != null) {
                // 场景 / 网页壁纸暂不支持实时渲染，先显示缩略图
                media = "<img src=\"/preview?id=" + encode(entry.id) + "\" alt=\"\">";
            }
        }

        String html = """
                <!doctype html>
                <html><head><meta charset="utf-8"><style>
                html, body { margin: 0; height: 100%%; overflow: hidden; background: #000; }
                video, img { width: 100vw; height: 100vh; object-fit: %s; display: block;
                             filter: blur(%dpx); }
                .scrim { position: fixed; inset: 0; background: rgba(0,0,0,%.2f); pointer-events: none; }
                </style></head><body>
                %s
                <div class="scrim"></div>
                </body></html>
                """.formatted(fit, blur, scrim, media);
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
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
                    gap: 8px; padding: 10px; overflow: auto; }
            .card { border: 1px solid #333; border-radius: 7px; overflow: hidden;
                    cursor: pointer; background: #000; }
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
            <button class="ghost" id="rf">刷新</button><button id="tg">…</button></header>
            <div class="grid" id="grid"></div>
            <script>
            const K = { video: '视频', image: '图片', scene: '场景', web: '网页' };
            async function load() {
              const s = await (await fetch('/state.json?t=' + Date.now())).json();
              document.getElementById('tg').textContent = s.enabled ? '关闭' : '启用';
              document.getElementById('cur').textContent = s.current || '未选择壁纸';
              const g = document.getElementById('grid');
              g.innerHTML = '';
              for (const e of s.entries) {
                const c = document.createElement('div');
                c.className = 'card' + (e.id === s.currentId ? ' cur' : '');
                c.innerHTML = '<div class="s">' +
                  (e.hasPreview ? '<img src="/preview?id=' + encodeURIComponent(e.id) + '&t=' + Date.now() + '">' : '') +
                  '<span class="b">' + (K[e.kind] || e.kind) + '</span></div><div class="t"></div>';
                c.querySelector('.t').textContent = e.title;
                c.onclick = async () => { await fetch('/apply?id=' + encodeURIComponent(e.id)); load(); };
                g.appendChild(c);
              }
              if (!s.entries.length) {
                g.innerHTML = '<div class="empty">没有找到壁纸：去 Steam 创意工坊订阅，' +
                  '或在 设置 → 工具 → 壁纸背景 里导入本地文件</div>';
              }
            }
            document.getElementById('tg').onclick = async () => { await fetch('/toggle'); load(); };
            document.getElementById('rf').onclick = async () => { await fetch('/rescan'); load(); };
            load();
            setInterval(load, 5000);
            </script></body></html>
            """;

    // ---------- 数据 ----------

    private void sendState(HttpExchange exchange) throws IOException {
        Snapshot snapshot = actions.snapshot();
        List<WallpaperEntry> entries = actions.entries();
        StringBuilder json = new StringBuilder(4096);
        json.append("{\"enabled\":").append(snapshot.enabled)
                .append(",\"currentId\":").append(quote(snapshot.currentId))
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

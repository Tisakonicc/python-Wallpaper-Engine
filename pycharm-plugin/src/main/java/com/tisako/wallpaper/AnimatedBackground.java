package com.tisako.wallpaper;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.Nullable;

import javax.imageio.ImageIO;
import javax.swing.Timer;
import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * 实验性动态背景：先把视频抽成图片帧缓存到 D 盘，再用 Swing Timer 轮播。
 *
 * <p>路线 A：帧内容写入同一块画布，由 {@link LiveBackgroundPainter} 直接参与平台透明合成。
 * 不再逐帧创建背景变换，也不经过平台 ImagePainter 的全窗口缩放缓存。
 *
 * <p>为什么不让 JCodec 实时解码：本机壁纸常见 2K/4K，JCodec 顺序解码远达不到 10fps；
 * 预抽帧把解码成本挪到首次启用时，动画帧率只受图片读取和平台绘制限制。
 */
final class AnimatedBackground implements Disposable {

    private static final Logger LOG = Logger.getInstance(AnimatedBackground.class);

    /** 原型固定 10fps。 */
    private static final int FPS = 10;
    /** 抽帧宽度；面板更大时会放大，先优先帧率。 */
    private static final int FRAME_WIDTH = 1280;
    /** 最多抽 1 分钟，避免长视频把磁盘写满（10fps × 60s = 600 帧）。 */
    private static final int MAX_FRAMES = FPS * 60;

    enum State { OFF, PREPARING, PLAYING, UNAVAILABLE }

    private final WallpaperService service;

    private volatile State state = State.OFF;
    private volatile String detail = "";
    private volatile List<Path> frames = List.of();
    private volatile int frameCount;

    private Timer timer;
    private int index;
    private LiveBackgroundPainter current;
    private FrameBackground.JFrameHolder holder;

    /** 合成线程与 EDT 之间的画布交接：显示中 / 待显示 / 可写入。 */
    private final Object frameLock = new Object();
    private BufferedImage shownBuffer;
    private BufferedImage readyBuffer;
    private BufferedImage freeBuffer;
    private Thread composeThread;
    private volatile boolean composing;

    /** 合成参数由 EDT 快照，合成线程只读。 */
    private volatile int composeWidth;
    private volatile int composeHeight;
    private volatile Rectangle composeScrim;
    private volatile String composeFit = "contain";
    private volatile int composeScrimPercent;
    private volatile int composePosX;
    private volatile float composeAlpha = 0.9f;

    private String activeKey = "";
    private volatile String prepareKey = "";
    private volatile Thread prepareThread;
    private volatile Process prepareProcess;
    private final Set<String> failed = ConcurrentHashMap.newKeySet();

    private long statsStart;
    private int statsTicks;
    private long statsNanos;

    private static Path cacheRootDir;
    private static boolean ffmpegChecked;
    private static String ffmpegPath;

    AnimatedBackground(WallpaperService service) {
        this.service = service;
    }

    /** 给面板显示的简短状态。 */
    String statusText() {
        return switch (state) {
            case OFF -> "";
            case PREPARING -> "正在生成动态帧…";
            case PLAYING -> "播放中 · " + frameCount + " 帧 · 实测日志见 idea.log";
            case UNAVAILABLE -> detail.isBlank() ? "动态背景不可用" : detail;
        };
    }

    String stateName() {
        return state.name().toLowerCase(java.util.Locale.ROOT);
    }

    int frameCount() {
        return frameCount;
    }

    /**
     * 尝试让动画接管背景。
     *
     * @return true 表示动画已经在播放，调用方不要再安装静态背景；
     *         false 表示暂时用静态画面（生成帧中或不可用）
     */
    boolean start(@Nullable WallpaperEntry entry, @Nullable FrameBackground.JFrameHolder frame) {
        if (entry == null || entry.media == null || !"video".equals(entry.kind)
                || !VideoFrame.supports(entry.media) || !Files.isRegularFile(entry.media)) {
            stop();
            return false;
        }
        String key = key(entry.media);
        if (state == State.PLAYING && key.equals(activeKey)) {
            FrameBackground.JFrameHolder previous = holder;
            if (current == null || previous == null || frame == null || previous.panel == frame.panel) {
                holder = frame;
                return true;
            }
            // 多窗口场景中承载面板变了，旧 Painter 只属于原面板，不能拿着新画布继续用。
            stop();
        }
        if (state == State.PREPARING && key.equals(prepareKey)) {
            holder = frame;
            return false;
        }
        stop();
        holder = frame;
        if (failed.contains(key)) {
            state = State.UNAVAILABLE;
            detail = "动态背景不可用，已回退静态";
            activeKey = key;
            return false;
        }
        Path dir = cacheDir(key);
        List<Path> cached = cachedFrames(dir, key);
        if (!cached.isEmpty()) {
            activeKey = key;
            frames = cached;
            frameCount = cached.size();
            startTicker();
            return true;
        }
        prepare(entry.media, key, dir);
        return false;
    }

    void stop() {
        if (timer != null) {
            timer.stop();
            timer = null;
        }
        disposeCurrent();
        frames = List.of();
        frameCount = 0;
        index = 0;
        activeKey = "";
        prepareKey = "";
        state = State.OFF;
        detail = "";
        holder = null;
        composing = false;
        Thread composer = composeThread;
        composeThread = null;
        if (composer != null) composer.interrupt();
        synchronized (frameLock) {
            shownBuffer = null;
            readyBuffer = null;
            freeBuffer = null;
        }
        cancelPrepare();
    }

    @Override
    public void dispose() {
        stop();
    }

    // ---------- 播放 ----------

    private void startTicker() {
        state = State.PLAYING;
        detail = "";
        index = 0;
        statsStart = System.nanoTime();
        statsTicks = 0;
        statsNanos = 0;
        composing = true;
        Thread composer = new Thread(this::composeLoop, "wallpaper-animation-compose");
        composer.setDaemon(true);
        composer.setPriority(Thread.NORM_PRIORITY - 1);
        composeThread = composer;
        composer.start();
        timer = new Timer(1000 / FPS, e -> tick());
        timer.setCoalesce(true);
        timer.setInitialDelay(0);
        timer.start();
        LOG.info("动态背景轮播已启动（自建 Painter）：" + frameCount + " 帧，" + FPS
                + "fps，缓存=" + cacheDir(activeKey));
    }

    /** 后台合成：解码 JPEG、缩放、烘焙不透明度都放这里，EDT 每帧只剩一次画布替换。 */
    private void composeLoop() {
        while (composing) {
            long started = System.nanoTime();
            try {
                composeOnce();
            } catch (InterruptedException err) {
                Thread.currentThread().interrupt();
                return;
            } catch (Throwable err) {
                LOG.warn("动态背景合成失败", err);
            }
            long spent = (System.nanoTime() - started) / 1_000_000L;
            long wait = 1000L / FPS - spent;
            if (wait > 0) {
                try {
                    Thread.sleep(wait);
                } catch (InterruptedException err) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private void composeOnce() throws InterruptedException {
        int width = composeWidth;
        int height = composeHeight;
        List<Path> list = frames;
        if (width < 400 || height < 300 || list.isEmpty()) {
            Thread.sleep(30);
            return;
        }
        BufferedImage target;
        synchronized (frameLock) {
            target = freeBuffer;
            freeBuffer = null;
            // 首帧时三块都为空；之后显示中的画布不会再交回来，所以只要没有待显示的，
            // 就必须补一块新缓冲，否则合成线程会一直空转、画面停住不动。
            if (target == null && readyBuffer == null) {
                target = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            }
        }
        if (target == null) {
            Thread.sleep(8);
            return;
        }
        if (target.getWidth() != width || target.getHeight() != height) {
            target = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        }
        // 平台整窗重绘只有 3~4 fps，若按 10fps 的真实时长取帧，每次更新都要跳过 2~3 帧，
        // 观感就是又跳又快。这里每次只前进一帧：运动连续，代价是播放速度随实际帧率变慢。
        index = (index + 1) % list.size();
        int frameIndex = index;
        BufferedImage source;
        try {
            source = ImageIO.read(list.get(frameIndex).toFile());
        } catch (IOException err) {
            source = null;
        }
        if (source == null) return;
        // 动态模式不逐帧虚化：盒式模糊在 2K 下每帧几十毫秒，会直接吃掉帧率
        FrameBackground.renderInto(target, source, composeFit, composeScrim,
                composeScrimPercent, composePosX, composeAlpha);
        synchronized (frameLock) {
            if (readyBuffer != null) freeBuffer = readyBuffer;
            readyBuffer = target;
        }
    }

    private void tick() {
        WallpaperService.Settings settings = service.settings();
        FrameBackground.JFrameHolder frame = holder;
        if (!settings.enabled || !settings.animationEnabled || frames.isEmpty()
                || frame == null || frame.panel == null) {
            stop();
            return;
        }
        int width = frame.panel.getWidth();
        int height = frame.panel.getHeight();
        if (width < 400 || height < 300 || !frame.panel.isShowing()) return;

        long started = System.nanoTime();
        composeWidth = width;
        composeHeight = height;
        composeFit = settings.fit;
        composeScrimPercent = settings.scrim;
        composePosX = settings.posX;
        composeAlpha = Math.max(0.05f, Math.min(1f, settings.opacity / 100f));
        composeScrim = service.editorRect(frame);

        BufferedImage next;
        synchronized (frameLock) {
            next = readyBuffer;
            if (next != null) {
                readyBuffer = null;
                if (freeBuffer == null) freeBuffer = shownBuffer;
                shownBuffer = next;
            }
        }
        if (next == null) return;

        try {
            if (current == null) {
                current = LiveBackgroundPainter.install(frame.panel, next,
                        painter -> ApplicationManager.getApplication().invokeLater(() -> painterFailed(painter)));
                LOG.info("自建 Painter 已安装：" + width + "x" + height + "，复用背景画布");
            } else {
                current.setCanvas(next);
            }
        } catch (Exception err) {
            String key = activeKey;
            stop();
            failed.add(key);
            activeKey = key;
            state = State.UNAVAILABLE;
            detail = "自建 Painter 不可用，已回退静态";
            LOG.warn("自建 Painter 安装失败，回退静态背景", err);
            service.apply();
            return;
        }
        current.requestRepaint();

        statsNanos += System.nanoTime() - started;
        statsTicks++;
        if (statsTicks >= 100) {
            long elapsed = System.nanoTime() - statsStart;
            long fps = elapsed <= 0 ? 0 : statsTicks * 1_000_000_000L / elapsed;
            long[] paint = current == null ? new long[]{0, 0} : current.drainPaintStats();
            LOG.info("动态背景实测：" + fps + " fps，发布 " + (statsNanos / statsTicks / 1_000_000)
                    + " ms/帧，绘制 " + (paint[1] / statsTicks / 1_000_000)
                    + " ms/帧（" + (paint[0] / statsTicks) + " 次贴图），缓存 " + frameCount + " 帧");
            statsStart = System.nanoTime();
            statsTicks = 0;
            statsNanos = 0;
        }
    }

    /** 绘制阶段的反射调用也可能因平台内部变化失败，不能只留下一块没有背景的变换。 */
    private void painterFailed(LiveBackgroundPainter painter) {
        if (current != painter) return;
        String key = activeKey;
        stop();
        failed.add(key);
        activeKey = key;
        state = State.UNAVAILABLE;
        detail = "自建 Painter 绘制失败，已回退静态";
        service.apply();
    }

    private void disposeCurrent() {
        if (current != null) {
            current.dispose();
            current = null;
            // 移除全局变换后，把最后一帧擦掉；切回静态图时会立即再绘制一次。
            FrameBackground.JFrameHolder frame = holder;
            if (frame != null && frame.panel != null) frame.panel.repaint();
        }
    }

    // ---------- 抽帧 ----------

    private void prepare(Path source, String key, Path dir) {
        state = State.PREPARING;
        detail = "";
        prepareKey = key;
        activeKey = key;
        Thread thread = new Thread(() -> extract(source, key, dir), "wallpaper-animation-frames");
        thread.setDaemon(true);
        thread.setPriority(Thread.NORM_PRIORITY - 1);
        prepareThread = thread;
        thread.start();
    }

    private void extract(Path source, String key, Path dir) {
        try {
            String ffmpeg = ffmpegPath();
            if (ffmpeg == null) {
                fail(key, "未找到 ffmpeg，动态背景不可用");
                return;
            }
            deleteTree(dir);
            Files.createDirectories(dir);
            ProcessBuilder builder = new ProcessBuilder(
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-i", source.toString(),
                    "-an",
                    "-vf", "fps=" + FPS + ",scale=" + FRAME_WIDTH + ":-2:flags=bicubic",
                    "-frames:v", String.valueOf(MAX_FRAMES),
                    "-q:v", "4",
                    dir.resolve("f%05d.jpg").toString());
            builder.redirectErrorStream(true);
            Process process = builder.start();
            prepareProcess = process;
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            int code = process.waitFor();
            prepareProcess = null;
            if (!key.equals(prepareKey)) return;

            if (code != 0) {
                fail(key, "ffmpeg 失败：" + tail(output));
                return;
            }
            List<Path> made = listFrames(dir);
            if (made.isEmpty()) {
                fail(key, "没有生成动态帧");
                return;
            }
            Files.writeString(dir.resolve("done.txt"), key, StandardCharsets.UTF_8);
            LOG.info("动态帧已生成：" + made.size() + " 帧 -> " + dir);
            ApplicationManager.getApplication().invokeLater(() -> {
                if (!key.equals(prepareKey)) return;
                prepareKey = "";
                state = State.OFF;
                service.apply();
            });
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
        } catch (Throwable err) {
            fail(key, "生成动态帧失败：" + err.getMessage());
        } finally {
            if (prepareThread == Thread.currentThread()) prepareThread = null;
        }
    }

    private void fail(String key, String message) {
        failed.add(key);
        if (!key.equals(prepareKey)) return;
        prepareKey = "";
        state = State.UNAVAILABLE;
        detail = message;
        LOG.info("动态背景不可用：" + message);
    }

    private void cancelPrepare() {
        Process process = prepareProcess;
        prepareProcess = null;
        if (process != null) process.destroyForcibly();
        Thread thread = prepareThread;
        prepareThread = null;
        if (thread != null) thread.interrupt();
    }

    // ---------- 缓存 ----------

    private static String key(Path file) {
        try {
            return file.toAbsolutePath() + "|" + Files.size(file) + "|" + Files.getLastModifiedTime(file).toMillis();
        } catch (Throwable err) {
            return file.toAbsolutePath().toString();
        }
    }

    private static Path cacheDir(String key) {
        String hash = Integer.toHexString(key.hashCode());
        return cacheRoot().resolve("v1-" + hash + "-" + FPS + "fps-" + FRAME_WIDTH + "w");
    }

    private static Path cacheRoot() {
        Path root = cacheRootDir;
        if (root != null) return root;
        Path d = Paths.get("D:/WallpaperEngineFrames");
        try {
            if (Files.isDirectory(Paths.get("D:/"))) {
                Files.createDirectories(d);
                cacheRootDir = d;
                return d;
            }
        } catch (Throwable ignored) {
        }
        Path fallback = Paths.get(System.getProperty("java.io.tmpdir"), "WallpaperEngineFrames");
        try {
            Files.createDirectories(fallback);
        } catch (Throwable ignored) {
        }
        cacheRootDir = fallback;
        return fallback;
    }

    private static List<Path> cachedFrames(Path dir, String key) {
        Path done = dir.resolve("done.txt");
        if (!Files.isRegularFile(done)) return List.of();
        try {
            if (!key.equals(Files.readString(done, StandardCharsets.UTF_8).trim())) return List.of();
        } catch (Throwable err) {
            return List.of();
        }
        return listFrames(dir);
    }

    private static List<Path> listFrames(Path dir) {
        List<Path> result = new ArrayList<>();
        if (!Files.isDirectory(dir)) return result;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "f*.jpg")) {
            for (Path path : stream) result.add(path);
        } catch (Throwable err) {
            return List.of();
        }
        result.sort(Comparator.comparing(path -> path.getFileName().toString()));
        return result;
    }

    private static void deleteTree(Path dir) {
        if (!Files.exists(dir)) return;
        try (Stream<Path> stream = Files.walk(dir)) {
            stream.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private static synchronized String ffmpegPath() {
        if (ffmpegChecked) return ffmpegPath;
        ffmpegChecked = true;
        List<String> candidates = new ArrayList<>();
        String custom = System.getenv("WPE_FFMPEG");
        if (custom != null && !custom.isBlank()) candidates.add(custom);
        candidates.add("ffmpeg");
        candidates.add("D:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe");
        for (String candidate : candidates) {
            try {
                Process process = new ProcessBuilder(candidate, "-version").redirectErrorStream(true).start();
                process.getInputStream().readAllBytes();
                if (process.waitFor(3, TimeUnit.SECONDS) && process.exitValue() == 0) {
                    ffmpegPath = candidate;
                    LOG.info("动态背景使用 ffmpeg：" + candidate);
                    return candidate;
                }
                process.destroyForcibly();
            } catch (Throwable ignored) {
            }
        }
        LOG.info("动态背景未找到 ffmpeg");
        return null;
    }

    private static String tail(String output) {
        String text = output == null ? "" : output.trim().replace('\n', ' ');
        return text.length() <= 240 ? text : "…" + text.substring(text.length() - 240);
    }
}

package com.tisako.wallpaper;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.imageio.ImageIO;
import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JPanel;
import java.awt.Component;
import java.awt.Image;
import java.awt.Window;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 应用级服务：扫描壁纸、启动本地服务、把壁纸铺到整个 IDE 窗口。
 *
 * <p>背景采用平台自带的背景图机制（{@link com.intellij.openapi.wm.impl.IdeBackgroundUtil}），
 * 它会把界面内容按透明度绘制，因此项目树 / 工具栏 / 编辑器都能透出背景，而且
 * <b>不需要修改任何组件的 opaque 或背景色</b>。关闭时只要 dispose 掉背景对象，
 * 平台自然恢复原样 —— 这是本插件「禁用即还原」的实现基础。
 */
@State(name = "BackgroundWallpaperEngine", storages = @Storage("background-wallpaper-engine.xml"))
public final class WallpaperService implements PersistentStateComponent<WallpaperService.Settings>, Disposable {

    private static final Logger LOG = Logger.getInstance(WallpaperService.class);

    /** 背景图不透明度的默认值（0~100）。 */
    private static final int DEFAULT_OPACITY = 70;

    public static final class Settings {
        public boolean enabled = true;
        public String wallpaperId = "";
        /** 背景图不透明度 0~100。 */
        public int opacity = DEFAULT_OPACITY;
        public String fit = "contain";
        /** 是否已把 0.9.8 自动改成的「铺满」还原回「完整显示」。 */
        public boolean fitReverted;
        public int blur = 0;
        /** 代码区额外压暗的比例 0~100，越大文字背后越暗。 */
        public int scrim = 45;
        /** 水平位置 0~100：50 居中，0 贴左，100 贴右。 */
        public int posX = 50;
        public List<String> imports = new ArrayList<>();
    }

    private Settings settings = new Settings();
    private List<WallpaperEntry> entries = List.of();
    private final WallpaperServer server;
    private Disposable background;
    /** 服务已释放后，后台解码回调不要再碰界面。 */
    private volatile boolean disposed;
    /** 已挂尺寸监听的面板，窗口大小变化后要按新尺寸重渲染画布。 */
    private JPanel hookedPanel;
    private java.awt.event.ComponentAdapter resizeHook;
    private javax.swing.Timer resizeTimer;
    /** 面板尺寸还没就绪时的重试次数。 */
    private int sizeRetries;

    public WallpaperService() {
        server = new WallpaperServer(new WallpaperServer.Actions() {
            @Override
            public List<WallpaperEntry> entries() {
                return WallpaperService.this.entries();
            }

            @Override
            public WallpaperServer.Snapshot snapshot() {
                return WallpaperService.this.snapshot();
            }

            @Override
            public void apply(String id) {
                applyWallpaper(id);
            }

            @Override
            public void toggle() {
                setEnabled(!settings.enabled);
            }

            @Override
            public void rescan() {
                WallpaperService.this.reload();
            }

            @Override
            public void importLocal() {
                WallpaperService.this.importLocal();
            }

            @Override
            public void updateSettings(int opacity, int blur, int scrim, int posX, String fit) {
                WallpaperService.this.updateSettings(opacity, blur, scrim, posX, fit);
            }
        });
    }

    public static WallpaperService getInstance() {
        return ApplicationManager.getApplication().getService(WallpaperService.class);
    }

    public Settings settings() {
        return settings;
    }

    public List<WallpaperEntry> entries() {
        if (entries.isEmpty()) rescan();
        return entries;
    }

    public synchronized void rescan() {
        entries = WallpaperLibrary.scan(settings.imports == null ? List.of() : settings.imports);
        if (findEntry(settings.wallpaperId) == null) {
            settings.wallpaperId = entries.isEmpty() ? "" : entries.get(0).id;
        }
        LOG.info("壁纸扫描完成，共 " + entries.size() + " 个");
    }

    public void applyWallpaper(String id) {
        if (id == null || id.isEmpty()) return;
        settings.wallpaperId = id;
        apply();
    }

    public int ensureServerPort() throws IOException {
        return server.port();
    }

    public void onStartup() {
        if (!settings.enabled) return;
        rescan();
        apply();
    }

    public void setEnabled(boolean enabled) {
        settings.enabled = enabled;
        apply();
    }

    public void reload() {
        rescan();
        apply();
    }

    public void importLocal() {
        ApplicationManager.getApplication().invokeLater(() -> {
            FileChooserDescriptor descriptor = new FileChooserDescriptor(true, false, false, false, false, true)
                    .withTitle("选择视频或图片")
                    .withFileFilter(file -> {
                        String name = file.getName().toLowerCase();
                        return name.endsWith(".mp4") || name.endsWith(".webm") || name.endsWith(".mov")
                                || name.endsWith(".m4v") || name.endsWith(".gif") || name.endsWith(".png")
                                || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp")
                                || name.endsWith(".bmp") || name.endsWith(".avif");
                    });
            VirtualFile[] files = FileChooser.chooseFiles(descriptor, null, null);
            if (files.length == 0) return;
            if (settings.imports == null) settings.imports = new ArrayList<>();
            for (VirtualFile file : files) {
                String path = file.getPath();
                if (!settings.imports.contains(path)) settings.imports.add(path);
            }
            rescan();
            LOG.info("导入本地壁纸 " + files.length + " 个");
            String last = files[files.length - 1].getPath();
            for (WallpaperEntry entry : entries) {
                if (entry.imported && entry.media != null && entry.media.toString().equals(last)) {
                    applyWallpaper(entry.id);
                    break;
                }
            }
        });
    }

    /** 面板滑块调用：改参数后立即重画背景（模糊较重时会稍慢，属正常）。 */
    public void updateSettings(int opacity, int blur, int scrim, int posX, String fit) {
        settings.opacity = Math.max(10, Math.min(100, opacity));
        settings.blur = Math.max(0, Math.min(60, blur));
        settings.scrim = Math.max(0, Math.min(100, scrim));
        settings.posX = Math.max(0, Math.min(100, posX));
        if (fit != null && !fit.isBlank()) settings.fit = fit;
        apply();
    }

    public void apply() {
        ApplicationManager.getApplication().invokeLater(this::applyNow);
    }

    private void applyNow() {
        if (disposed) return;
        // 顺带把本地服务拉起来：面板要读 /state.json，也方便外部调试
        try {
            server.port();
        } catch (IOException err) {
            LOG.warn("本地服务启动失败", err);
        }
        clearBackground();
        if (!settings.enabled) {
            LOG.info("壁纸已关闭，界面恢复原样");
            return;
        }
        if (entries.isEmpty()) rescan();
        WallpaperEntry entry = findEntry(settings.wallpaperId);
        if (entry == null) {
            LOG.info("没有可用的壁纸，跳过");
            return;
        }
        FrameBackground.JFrameHolder holder = findFrame();
        if (holder == null) {
            LOG.warn("找不到 IDE 主窗口，暂不设置背景");
            return;
        }
        ensureResizeHook(holder);

        // 面板还在布局中时别急着画：这时拿到的不是最终尺寸，画布比例和面板对不上，
        // 平台按 SCALE（cover 语义）缩放时会再裁一次 —— 就是「先中裁，过一会才全屏」。
        if (holder.panel.getWidth() < 400 || holder.panel.getHeight() < 300) {
            if (sizeRetries < 8) {
                sizeRetries++;
                LOG.info("面板尺寸未就绪（" + holder.panel.getWidth() + "x" + holder.panel.getHeight() + "），120ms 后重试");
                scheduleApply(120);
                return;
            }
        }
        sizeRetries = 0;

        // 视频：静态显示真实画面；GIF 也只取第一帧，不做动图播放
        Image still = loadStill(entry);
        if (still == null) {
            LOG.warn("壁纸没有可用的图片：" + entry.title);
            return;
        }

        int opacity = Math.max(10, Math.min(100, settings.opacity));
        java.awt.Rectangle scrimRect = editorRect(holder);
        int renderedWidth = holder.panel.getWidth();
        int renderedHeight = holder.panel.getHeight();
        LOG.info("代码区矩形=" + scrimRect + " 面板=" + renderedWidth + "x" + renderedHeight);
        FrameBackground frame = new FrameBackground();
        frame.show(holder, still, opacity / 100f, Math.max(0, settings.blur), effectiveFit(entry),
                scrimRect, Math.max(0, Math.min(100, settings.scrim)), Math.max(0, Math.min(100, settings.posX)));
        background = frame;
        // 渲染期间布局又变了（启动时窗口还在铺开）：立刻按新尺寸再来一次，不用等去抖
        if (holder.panel.getWidth() != renderedWidth || holder.panel.getHeight() != renderedHeight) {
            LOG.info("渲染期间尺寸变化：" + renderedWidth + "x" + renderedHeight + " → "
                    + holder.panel.getWidth() + "x" + holder.panel.getHeight() + "，重渲染");
            apply();
            return;
        }
        // 启动时编辑器往往还没显示，算不出代码区矩形；延迟重试几次补上压暗
        if (scrimRect == null && settings.scrim > 0 && scrimRetries < 5) {
            scrimRetries++;
            javax.swing.Timer retry = new javax.swing.Timer(1500, e -> {
                ((javax.swing.Timer) e.getSource()).stop();
                apply();
            });
            retry.setRepeats(false);
            retry.start();
        } else if (scrimRect != null) {
            scrimRetries = 0;
        }
        LOG.info("壁纸已应用：" + entry.title + "（" + entry.kind + "，不透明度 " + opacity + "%，虚化 " + settings.blur + "）");
    }

    /** 延迟一段时间后重新应用（面板尺寸还在变化时用）。 */
    private void scheduleApply(int delayMs) {
        javax.swing.Timer timer = new javax.swing.Timer(delayMs, e -> {
            ((javax.swing.Timer) e.getSource()).stop();
            apply();
        });
        timer.setRepeats(false);
        timer.start();
    }

    /** 有没有可用的真实画面（视频 / 真实图片），而不是只有方形预览图。 */
    private static boolean hasRealMedia(WallpaperEntry entry) {
        return VideoFrame.supports(entry.media) || WallpaperLibrary.isImage(entry.media);
    }

    /**
     * 实际使用的填充方式。
     *
     * <p>场景 / 网页壁纸在 PyCharm 里只能拿到 preview.jpg —— 它本身就是从原图居中裁出的方形图。
     * 对它用「完整显示」会在左右留出大片黑边，看起来像没铺满；这种情况按「铺满」处理，
     * 观感更接近 Wallpaper Engine 里的效果。
     */
    private String effectiveFit(WallpaperEntry entry) {
        String fit = settings.fit == null ? "contain" : settings.fit;
        if ("contain".equals(fit) && !hasRealMedia(entry)) return "cover";
        return fit;
    }

    /** 静态图：视频项目解真实画面，图片项目用真实图片文件，其余才用预览图。 */
    @Nullable
    private Image loadStill(WallpaperEntry entry) {
        if (VideoFrame.supports(entry.media)) {
            BufferedImage cached = VideoFrame.cached(entry.media);
            if (cached != null) return cached;
            // 4K 视频用 JCodec 解首帧要数秒，放后台做；解码期间先用 preview.jpg 顶着
            VideoFrame.decodeAsync(entry.media, frame ->
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (!disposed) apply();
                    }));
        }

        // 图片项目同样不能用 preview.jpg：Wallpaper Engine 的预览图是方形居中裁切图，
        // 铺到宽屏窗口上会被放大再裁一次，看起来就像"图片被裁剪"。
        if (WallpaperLibrary.isImage(entry.media)) {
            Image image = readImage(entry.media);
            if (image != null) return image;
        }
        if (entry.preview != null && !entry.preview.equals(entry.media)) {
            return readImage(entry.preview);
        }
        return readImage(entry.media);
    }

    @Nullable
    private static Image readImage(@Nullable Path path) {
        if (path == null || !Files.isRegularFile(path)) return null;
        try {
            return ImageIO.read(path.toFile());
        } catch (IOException err) {
            LOG.warn("读取壁纸图片失败：" + path, err);
            return null;
        }
    }

    /** 编辑器可视区域在 contentPane 坐标系里的矩形，用于只压暗代码区。 */
    @Nullable
    private java.awt.Rectangle editorRect(FrameBackground.JFrameHolder holder) {
        try {
            com.intellij.openapi.editor.Editor[] editors = com.intellij.openapi.editor.EditorFactory.getInstance().getAllEditors();
            if (editors.length == 0) return null;
            java.awt.Component content = editors[0].getContentComponent();
            if (!(content instanceof javax.swing.JComponent jc) || !jc.isShowing()) return null;
            java.awt.Point p = javax.swing.SwingUtilities.convertPoint(jc, 0, 0, holder.panel);
            java.awt.Rectangle r = jc.getVisibleRect();
            // 编辑器滚动后组件原点可能在视口之外，必须加上可视区自身的偏移
            return new java.awt.Rectangle(p.x + r.x, p.y + r.y, Math.max(1, r.width), Math.max(1, r.height));
        } catch (Throwable err) {
            LOG.warn("计算编辑器区域失败", err);
            return null;
        }
    }

    private void clearBackground() {
        if (background != null) {
            background.dispose();
            background = null;
        }
    }

    @Nullable
    private static FrameBackground.JFrameHolder findFrame() {
        for (Window window : Window.getWindows()) {
            if (window instanceof JFrame frame && frame.isShowing()
                    && frame.getClass().getName().contains("IdeFrame")) {
                Component content = frame.getContentPane();
                if (content instanceof JPanel panel) {
                    return new FrameBackground.JFrameHolder(frame, panel);
                }
            }
        }
        return null;
    }

    private WallpaperServer.Snapshot snapshot() {
        WallpaperEntry entry = findEntry(settings.wallpaperId);
        return new WallpaperServer.Snapshot(
                entry,
                settings.opacity,
                settings.fit,
                settings.blur,
                settings.scrim,
                settings.posX,
                settings.enabled,
                entry == null ? "" : entry.id
        );
    }

    /**
     * 面板尺寸变化时按新尺寸重渲染画布。画布比例和面板不一致时画面会变形 / 错位，
     * 启动时面板尺寸未就绪（拿到 0 或小尺寸）也靠这个事件补一次正确的渲染。
     * 拖动窗口边框会连续触发，300ms 去抖避免反复重绘。
     */
    private void ensureResizeHook(FrameBackground.JFrameHolder holder) {
        if (holder.panel == hookedPanel) return;
        if (hookedPanel != null && resizeHook != null) {
            hookedPanel.removeComponentListener(resizeHook);
        }
        hookedPanel = holder.panel;
        resizeHook = new java.awt.event.ComponentAdapter() {
            @Override
            public void componentResized(java.awt.event.ComponentEvent e) {
                if (resizeTimer == null) {
                    resizeTimer = new javax.swing.Timer(300, ev -> apply());
                    resizeTimer.setRepeats(false);
                }
                resizeTimer.restart();
            }
        };
        hookedPanel.addComponentListener(resizeHook);
    }

    @Nullable
    private WallpaperEntry findEntry(String id) {
        if (id == null) return null;
        for (WallpaperEntry entry : entries) {
            if (entry.id.equals(id)) return entry;
        }
        return null;
    }

    private boolean warned;
    /** 代码区矩形算不到时的重试次数，避免无限重排。 */
    private int scrimRetries;

    private void warnOnce(String message) {
        if (warned) return;
        warned = true;
        NotificationGroupManager.getInstance()
                .getNotificationGroup("WallpaperEngine")
                .createNotification("壁纸背景", message, NotificationType.WARNING)
                .notify(null);
    }

    @Override
    public @Nullable Settings getState() {
        return settings;
    }

    @Override
    public void loadState(@NotNull Settings state) {
        this.settings = state;
        if (this.settings.imports == null) this.settings.imports = new ArrayList<>();
        if (this.settings.opacity <= 0) this.settings.opacity = DEFAULT_OPACITY;
        if (this.settings.fit == null || this.settings.fit.isBlank()) this.settings.fit = "contain";
        // 0.9.8 曾把默认值强制改成「铺满」，这里还原一次；之后用户自己选的保持不变
        if (!this.settings.fitReverted) {
            if ("cover".equals(this.settings.fit)) this.settings.fit = "contain";
            this.settings.fitReverted = true;
        }
    }

    @Override
    public void dispose() {
        disposed = true;
        if (resizeTimer != null) {
            resizeTimer.stop();
            resizeTimer = null;
        }
        if (hookedPanel != null && resizeHook != null) {
            hookedPanel.removeComponentListener(resizeHook);
        }
        resizeHook = null;
        hookedPanel = null;
        clearBackground();
        server.stop();
    }
}

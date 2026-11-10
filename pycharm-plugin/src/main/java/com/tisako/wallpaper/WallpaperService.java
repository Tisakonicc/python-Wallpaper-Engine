package com.tisako.wallpaper;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.HighlighterColors;
import com.intellij.openapi.editor.impl.EditorImpl;
import com.intellij.openapi.editor.colors.EditorColors;
import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.editor.colors.EditorColorsScheme;
import com.intellij.openapi.editor.event.EditorFactoryEvent;
import com.intellij.openapi.editor.event.EditorFactoryListener;
import com.intellij.openapi.editor.markup.TextAttributes;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.util.registry.Registry;
import com.intellij.openapi.util.registry.RegistryValue;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JLayeredPane;
import javax.swing.JRootPane;
import javax.swing.Timer;
import java.awt.Canvas;
import java.awt.Color;
import java.awt.Component;
import java.awt.Container;
import java.awt.Window;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 应用级服务：负责扫描壁纸、启动本地服务、把内嵌浏览器塞到 IDE 主窗口的最底层。
 *
 * <p>关键点（也是之前一直不生效的原因）：
 * <ol>
 *   <li>JLayeredPane 在同一层里是「后加的画在上面」。contentPane 已经占用了
 *       {@link JLayeredPane#FRAME_CONTENT_LAYER}，所以壁纸层必须放到**更低的层**
 *       （FRAME_CONTENT_LAYER - 1），否则会把整个 IDE 盖住。</li>
 *   <li>光垫到下面还不够：Swing 里不透明的组件会先用背景色把自己整块盖掉。
 *       因此要把 rootPane / contentPane / 编辑器所在的容器链都设为非不透明，
 *       并把编辑器默认背景色改成带 alpha 的颜色，壁纸才透得出来。</li>
 * </ol>
 */
@State(name = "BackgroundWallpaperEngine", storages = @Storage("background-wallpaper-engine.xml"))
public final class WallpaperService implements PersistentStateComponent<WallpaperService.Settings>, Disposable {

    private static final Logger LOG = Logger.getInstance(WallpaperService.class);

    /** 编辑器文字底色的 alpha：越低壁纸越明显，越高文字越清晰。 */
    private static final int EDITOR_ALPHA = 170;

    /** 壁纸层要比 contentPane 所在层更低，保证画在它下面。 */
    private static final Integer WALLPAPER_LAYER = JLayeredPane.FRAME_CONTENT_LAYER - 1;

    public static final class Settings {
        public boolean enabled = true;
        public String wallpaperId = "";
        public int opacity = 70;
        public String fit = "cover";
        public int blur = 0;
        public List<String> imports = new ArrayList<>();
    }

    private Settings settings = new Settings();
    private List<WallpaperEntry> entries = List.of();
    private final WallpaperServer server;

    private JBCefBrowser browser;
    private JComponent view;
    private JLayeredPane host;
    /** 实际承载壁纸层的容器（IdeRootPane，即 contentPane）。 */
    private JComponent mount;
    /** 挂载点策略：composite = 编辑器容器底部；framelayer = 编辑区分层窗格；
     *  editor = 编辑器区顶层容器；content = contentPane 内最底层。 */
    private String mountMode = "composite";
    private final ComponentAdapter hostResizeListener = new ComponentAdapter() {
        @Override
        public void componentResized(ComponentEvent event) {
            layoutView();
        }
    };

    /** 被改过背景色的编辑器组件，卸载时逐个还原（组件, 原色）。 */
    private final List<Component> tintedComponents = new ArrayList<>();
    private final List<Color> tintedColors = new ArrayList<>();
    /** 被透明化过的容器链，卸载时还原原背景色。 */
    private final List<Component> chainComponents = new ArrayList<>();
    private final List<Color> chainColors = new ArrayList<>();
    /** 被改过背景色的 Editor，卸载时还原。 */
    private final List<Editor> tintedEditors = new ArrayList<>();
    /** 目标编辑器背景色（带 alpha），心跳时用它校验是否被主题改回去。 */
    private Color targetEditorColor;
    /** 诊断用：把壁纸层换成品红色块，用来判断「层级/透明」是否正常。 */
    private boolean debugSolid;
    /** 当前挂载的是不是诊断色块（用来判断需不需要重新挂载）。 */
    private boolean mountedSolid;
    /** 诊断：把色块挂到最上层。 */
    private boolean onTop;
    private final List<Color> tintedEditorColors = new ArrayList<>();
    private Color savedContentBackground;
    private Boolean savedRootOpaque;
    private Boolean savedContentOpaque;
    private boolean editorsHooked;
    private Timer keepAlive;

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
            public void toggleDebugSolid() {
                WallpaperService.this.toggleDebugSolid();
            }

            @Override
            public String screenshot() {
                return WallpaperService.this.screenshot();
            }

            @Override
            public String probe() {
                return WallpaperService.this.probe();
            }

            @Override
            public void toggleSolidOnTop() {
                WallpaperService.this.toggleSolidOnTop();
            }

            @Override
            public String tree() {
                return WallpaperService.this.tree();
            }

            @Override
            public void setMountMode(String mode) {
                WallpaperService.this.setMountMode(mode);
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

    /** 面板/设置页选壁纸的入口。 */
    public void applyWallpaper(String id) {
        if (id == null || id.isEmpty()) return;
        settings.wallpaperId = id;
        apply();
    }

    public int ensureServerPort() throws IOException {
        return server.port();
    }

    /** IDE 启动后调用一次。 */
    public void onStartup() {
        if (!settings.enabled) return;
        hookEditors();
        rescan();
        apply();
    }

    public void setEnabled(boolean enabled) {
        settings.enabled = enabled;
        apply();
    }

    /** 设置变更后重新扫描并重新加载背景页。 */
    public void reload() {
        rescan();
        apply();
    }

    /** 面板上的「导入」：弹系统文件框选本地视频/图片，导入后直接应用。 */
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

            // 应用最后一个导入的，和 Trae 版行为一致
            String last = files[files.length - 1].getPath();
            for (WallpaperEntry entry : entries) {
                if (entry.imported && entry.media != null && entry.media.toString().equals(last)) {
                    applyWallpaper(entry.id);
                    break;
                }
            }
        });
    }

    public void apply() {
        ApplicationManager.getApplication().invokeLater(this::applyNow);
    }

    private void applyNow() {
        if (!settings.enabled) {
            detach();
            return;
        }
        if (!JBCefApp.isSupported()) {
            warnOnce("当前环境不支持 JCEF（设置 → 搜索 jcef，确认 ide.browser.jcef.enabled 已开启），壁纸背景无法显示。");
            return;
        }
        // JCEF 默认创建原生窗口（重量级），会永远盖在 IDE 界面上；
        // 离屏渲染（OSR）模式下它才是普通轻量组件，可以垫在 UI 下面
        ensureOsr();
        if (entries.isEmpty()) rescan();
        try {
            int port = server.port();
            if (ensureView() == null) return;
            if (debugSolid || browser == null) {
                LOG.info("诊断色块已挂载（不加载页面）");
                return;
            }
            String url = "http://127.0.0.1:" + port + "/bg.html?t=" + System.currentTimeMillis();
            browser.loadURL(url);
            LOG.info("背景页已加载：" + url);
        } catch (IOException err) {
            LOG.warn("本地服务启动失败", err);
            warnOnce("壁纸背景：本地服务启动失败（" + err.getMessage() + "）");
        }
    }

    private void hookEditors() {
        if (editorsHooked) return;
        editorsHooked = true;
        EditorFactory.getInstance().addEditorFactoryListener(new EditorFactoryListener() {
            @Override
            public void editorCreated(@NotNull EditorFactoryEvent event) {
                if (!settings.enabled) return;
                if (view != null && mount != null && view.getParent() == mount) {
                    // 新打开的编辑器是后创建的组件，不在首次透明化处理范围内，补一下
                    makeEditorTransparent(event.getEditor());
                    tintEditorBackground(EDITOR_ALPHA);
                    layoutView();
                    mount.repaint();
                    return;
                }
                apply();
            }
        }, this);
    }

    private JComponent ensureView() {
        JFrame frame = findIdeFrame();
        if (frame == null) {
            LOG.warn("找不到 IDE 主窗口，暂不挂载背景");
            return view;
        }
        JLayeredPane layered = frame.getLayeredPane();
        JComponent container = resolveMount(frame);
        if (container == null) {
            LOG.warn("找不到可用的挂载容器（mode=" + mountMode + "）");
            return null;
        }

        if (view != null && mount == container && view.getParent() == container && mountedSolid == debugSolid) {
            layoutView();
            return view;
        }

        detach();

        if (debugSolid) {
            view = solidDebugView();
        } else {
            browser = new JBCefBrowser();
            view = browser.getComponent();
        }

        // 双保险：注册表设置如果来得太晚（JCEF 已初始化），浏览器仍是原生窗口。
        // 原生窗口垫不到 UI 下面，会把整个 IDE 盖住——宁可不挂载也不能盖界面。
        if (containsHeavyweight(view)) {
            LOG.warn("JCEF 为原生窗口模式（OSR 未生效），本次不挂载背景层");
            detach();
            warnOnce("壁纸背景需要离屏渲染模式：已自动开启 ide.browser.jcef.osr.enabled，完全重启 PyCharm 后生效。");
            return null;
        }

        host = layered;
        mount = container;
        mountedSolid = debugSolid;
        // 挂到容器的最底层（索引 0）；容器自己刷底色发生在孩子之前，所以壁纸天然压在底色之上
        if (container instanceof JLayeredPane layeredContainer) {
            layeredContainer.add(view, onTop ? JLayeredPane.MODAL_LAYER : Integer.valueOf(-30001));
        } else {
            container.add(view, onTop ? container.getComponentCount() : 0);
        }
        container.addComponentListener(hostResizeListener);

        // 关键：让窗口与编辑器链既「不覆盖壁纸」又「不留下残影」
        makeWindowTranslucent(frame);
        for (Editor editor : EditorFactory.getInstance().getAllEditors()) {
            makeEditorTransparent(editor);
        }
        tintEditorBackground(EDITOR_ALPHA);
        layoutView();
        layered.revalidate();
        layered.repaint();

        LOG.info("壁纸层已挂载：layer=" + WALLPAPER_LAYER + " 窗口=" + frame.getClass().getSimpleName()
                + " 尺寸=" + layered.getWidth() + "x" + layered.getHeight()
                + " 组件=" + dumpTree(view));

        startKeepAlive();
        return view;
    }

    /** 诊断层：纯色块，用来区分「壁纸层被挡住」和「JCEF 没渲染」。 */
    private static JComponent solidDebugView() {
        javax.swing.JPanel panel = new javax.swing.JPanel(new java.awt.BorderLayout());
        panel.setOpaque(true);
        panel.setBackground(new Color(236, 0, 140));
        javax.swing.JLabel label = new javax.swing.JLabel("WALLPAPER DEBUG LAYER", javax.swing.SwingConstants.CENTER);
        label.setForeground(Color.WHITE);
        label.setFont(label.getFont().deriveFont(java.awt.Font.BOLD, 40f));
        panel.add(label, java.awt.BorderLayout.CENTER);
        return panel;
    }

    /** 截取 IDE 主窗口到临时 PNG，返回路径；用于自动化验收。必须在 EDT 上绘制。 */
    public String screenshot() {
        final String[] result = { "error: screenshot did not run" };
        try {
            ApplicationManager.getApplication().invokeAndWait(() -> result[0] = screenshotOnEdt());
        } catch (Throwable err) {
            LOG.warn("诊断截图调度失败", err);
            return "error: " + err;
        }
        return result[0];
    }

    private String screenshotOnEdt() {
        try {
            if (host == null) return "error: no host";
            int w = mount == null ? 0 : mount.getWidth();
            int h = mount == null ? 0 : mount.getHeight();
            java.awt.image.BufferedImage image = new java.awt.image.BufferedImage(
                    Math.max(1, w), Math.max(1, h), java.awt.image.BufferedImage.TYPE_INT_ARGB);
            java.awt.Graphics2D g = image.createGraphics();
            mount.paint(g);
            g.dispose();
            java.nio.file.Path out = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"), "wallpaper-shot.png");
            javax.imageio.ImageIO.write(image, "png", out.toFile());
            LOG.info("诊断截图已保存：" + out);
            return out.toString();
        } catch (Throwable err) {
            LOG.warn("诊断截图失败", err);
            return "error: " + err;
        }
    }

    /** 根据策略解析挂载容器。 */
    @Nullable
    private JComponent resolveMount(JFrame frame) {
        if ("composite".equals(mountMode)) {
            // 必须取「当前编辑器自己的」父容器：有多个编辑器时树里会有多个
            // EditorCompositePanel，取错一个就会盖住别的区域
            Editor editor = anyEditor();
            if (editor == null) return null;
            Component node = editor.getContentComponent();
            while (node != null) {
                String name = node.getClass().getSimpleName();
                if ("EditorCompositePanel".equals(name) || "PanelWithFloatingToolbar".equals(name)) {
                    return node instanceof JComponent jc ? jc : null;
                }
                node = node.getParent();
            }
            return null;
        }
        if ("framelayer".equals(mountMode)) {
            // 编辑器区域那个分层窗格：只覆盖编辑区，最不容易影响别的 UI
            Component found = findBySimpleName(frame, "FrameLayeredPane");
            return found instanceof JComponent jc ? jc : null;
        }
        if ("editor".equals(mountMode)) {
            Editor editor = anyEditor();
            if (editor == null) return null;
            Component node = editor.getComponent();
            Component parent = node.getParent();
            // 一路向上，找到「父容器是分层窗格或 contentPane」的那个顶层容器
            while (parent != null && parent != frame.getLayeredPane() && parent != frame.getContentPane()) {
                node = parent;
                parent = parent.getParent();
            }
            return node instanceof JComponent jc ? jc : null;
        }
        Component content = frame.getContentPane();
        return content instanceof JComponent jc ? jc : null;
    }

    /** 运行时切换挂载策略：content = contentPane；editor = 编辑器顶层容器。 */
    public void setMountMode(String mode) {
        mountMode = mode == null || mode.isBlank() ? "content" : mode.trim();
        LOG.info("挂载点切换为 " + mountMode);
        ApplicationManager.getApplication().invokeLater(() -> {
            detach();
            mountedSolid = false;
            applyNow();
        });
    }

    /** 输出组件树，用于确定壁纸应该挂在哪一层。 */
    public String tree() {
        final String[] result = {"error: tree did not run"};
        try {
            ApplicationManager.getApplication().invokeAndWait(
                    () -> result[0] = DebugProbe.tree(findIdeFrame()));
        } catch (Throwable err) {
            return "error: " + err;
        }
        return result[0];
    }

    /** 切换「色块挂到最上层」，用来区分「被遮挡」和「根本没挂上」。 */
    public void toggleSolidOnTop() {
        debugSolid = true;
        onTop = !onTop;
        LOG.info("诊断置顶=" + onTop);
        ApplicationManager.getApplication().invokeLater(() -> {
            detach();
            mountedSolid = false;
            applyNow();
        });
    }

    /** 报告壁纸层状态与指定坐标上最深的组件，用于定位遮挡来源。 */
    public String probe() {
        final String[] result = {"error: probe did not run"};
        try {
            ApplicationManager.getApplication().invokeAndWait(() -> {
                int layer = onTop ? JLayeredPane.MODAL_LAYER : WALLPAPER_LAYER;
                result[0] = DebugProbe.describe(findIdeFrame(), mount, view, layer);
            });
        } catch (Throwable err) {
            return "error: " + err;
        }
        return result[0];
    }

    /** 切换诊断色块，供 Tools 菜单动作调用。 */
    public void toggleDebugSolid() {
        debugSolid = !debugSolid;
        LOG.info("诊断模式：" + (debugSolid ? "纯色块" : "正常壁纸"));
        ApplicationManager.getApplication().invokeLater(() -> {
            detach();
            mountedSolid = false;
            applyNow();
        });
    }

    /**
     * 壁纸是整窗最底层，而上面所有面板都变成非不透明后，Swing 不再自动擦除旧像素。
     * 静态壁纸时低频重绘一次，避免拖动窗口后留下残影。
     */
    private void startKeepAlive() {
        stopKeepAlive();
        keepAlive = new Timer(3000, event -> {
            if (host == null) return;
            // 只做「发现被改回去才纠正」，不再整窗重绘 —— 700ms 全窗重绘会让界面明显闪烁
            enforceTransparency();
        });
        keepAlive.setRepeats(true);
        keepAlive.start();
    }

    /** 幂等地维持「窗口与编辑器半透明」，被别的插件改回去时自动纠正。 */
    private void enforceTransparency() {
        JFrame frame = findIdeFrame();
        if (frame == null) return;
        // 容器可能把自己的子组件重新排序，把壁纸又顶到上面去
        layoutView();
        JRootPane root = frame.getRootPane();
        if (root.isOpaque()) root.setOpaque(false);
        Component content = frame.getContentPane();
        if (content instanceof JComponent jc) {
            if (jc.isOpaque()) jc.setOpaque(false);
            if (jc.getBackground() != null && jc.getBackground().getAlpha() != 0) {
                jc.setBackground(new Color(0, 0, 0, 0));
            }
        }
        if (targetEditorColor == null) return;
        for (Editor editor : EditorFactory.getInstance().getAllEditors()) {
            if (editor.isDisposed() || !(editor instanceof EditorImpl impl)) continue;
            // 主题/编辑器配置可能把 viewport、scrollPane 又设回不透明，这里一并纠正
            makeEditorTransparent(editor);
            Color current = impl.getBackgroundColor();
            if (current == null
                    || current.getAlpha() != targetEditorColor.getAlpha()
                    || (current.getRGB() & 0xFFFFFF) != (targetEditorColor.getRGB() & 0xFFFFFF)) {
                impl.setBackgroundColor(targetEditorColor);
            }
        }
    }

    private void stopKeepAlive() {
        if (keepAlive != null) {
            keepAlive.stop();
            keepAlive = null;
        }
    }

    /** 窗口本身必须透明，否则 rootPane 会先刷一层不透明底色，把壁纸整块盖掉。 */
    private void makeWindowTranslucent(JFrame frame) {
        JRootPane root = frame.getRootPane();
        if (savedRootOpaque == null) savedRootOpaque = root.isOpaque();
        if (root.isOpaque()) root.setOpaque(false);

        Component content = frame.getContentPane();
        if (content instanceof JComponent component) {
            if (savedContentOpaque == null) {
                savedContentOpaque = component.isOpaque();
                savedContentBackground = component.getBackground();
            }
            // IdeRootPane 可能自己刷底色，先关不透明再把底色清成全透明
            component.setOpaque(false);
            component.setBackground(new Color(0, 0, 0, 0));
        }
        LOG.info("窗口透明化：rootOpaque=" + root.isOpaque()
                + " contentOpaque=" + (content instanceof JComponent jc && jc.isOpaque()));
    }

    private void restoreWindowOpacity(JFrame frame) {
        if (frame == null) return;
        JRootPane root = frame.getRootPane();
        if (savedRootOpaque != null) root.setOpaque(savedRootOpaque);
        Component content = frame.getContentPane();
        if (content instanceof JComponent component) {
            if (savedContentOpaque != null) component.setOpaque(savedContentOpaque);
            if (savedContentBackground != null) component.setBackground(savedContentBackground);
        }
        savedRootOpaque = null;
        savedContentOpaque = null;
        savedContentBackground = null;
    }

    /** 开启 JCEF 离屏渲染。必须在 JCEF 初始化（第一次创建浏览器）之前设置才来得及。 */
    private static void ensureOsr() {
        try {
            RegistryValue osr = Registry.get("ide.browser.jcef.osr.enabled");
            if (!osr.asBoolean()) {
                osr.setValue(true);
                LOG.info("已开启 JCEF 离屏渲染（ide.browser.jcef.osr.enabled=true），重启后生效");
            }
        } catch (Throwable err) {
            LOG.warn("设置 JCEF OSR 失败", err);
        }
    }

    /** 组件树里含 Canvas 之类的重量级原生表面时，垫不到 Swing UI 下面。 */
    private static boolean containsHeavyweight(Component component) {
        if (component instanceof Canvas) return true;
        if (component instanceof Container container) {
            for (Component child : container.getComponents()) {
                if (containsHeavyweight(child)) return true;
            }
        }
        return false;
    }

    /** 打印组件树（类名 + 是否轻量），用于排查层级问题。 */
    private static String dumpTree(Component component) {
        StringBuilder sb = new StringBuilder();
        dumpTree(component, sb, 0);
        return sb.toString();
    }

    private static void dumpTree(Component component, StringBuilder sb, int depth) {
        if (depth > 6) return;
        if (sb.length() > 0) sb.append(" > ");
        sb.append(component.getClass().getSimpleName())
                .append(component.isLightweight() ? "[轻]" : "[重]");
        if (component instanceof Container container) {
            for (Component child : container.getComponents()) {
                dumpTree(child, sb, depth + 1);
            }
        }
    }

    private void layoutView() {
        if (view != null && mount != null) {
            view.setBounds(0, 0, mount.getWidth(), mount.getHeight());
            view.setVisible(true);
            // 有些容器（ToolWindowPane 等）会自己重排子组件，把壁纸顶到最上层。
            // 这里强制把它的 z 序压回 0（最先绘制 = 在最底下）。
            if (!onTop && !(mount instanceof JLayeredPane) && mount.getComponentZOrder(view) != 0) {
                mount.setComponentZOrder(view, 0);
            }
        }
    }

    /**
     * 让编辑器露出背后的壁纸。
     *
     * <p>编辑器画背景用的既不是 colors scheme 的 TEXT 属性，也不完全是组件的 {@code getBackground()}：
     * {@code EditorImpl} 自己维护一份背景色（{@code getBackgroundColor()} / {@code updateOpaque()}），
     * 所以必须走 {@link Editor#setBackgroundColor(java.awt.Color)}。传入带 alpha 的颜色时，
     * 平台会把编辑器组件标记成非不透明，填色才会和下层壁纸混合。
     */
    private void tintEditorBackground(int alpha) {
        EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
        Color base = scheme.getDefaultBackground();
        Color translucent = withAlpha(base, alpha);
        targetEditorColor = translucent;
        for (Editor editor : EditorFactory.getInstance().getAllEditors()) {
            if (editor.isDisposed()) continue;
            if (!tintedEditors.contains(editor)) {
                tintedEditors.add(editor);
                tintedEditorColors.add(editor instanceof EditorImpl impl ? impl.getBackgroundColor() : null);
                tintComponent(editor.getComponent(), translucent);
                tintComponent(editor.getContentComponent(), translucent);
            }
            if (editor instanceof EditorImpl impl) impl.setBackgroundColor(translucent);
        }
        LOG.info("编辑器透明化：alpha=" + alpha
                + " 编辑器数=" + tintedEditors.size()
                + " 背景色=" + (tintedEditors.isEmpty() ? "-" : String.valueOf(tintedEditors.get(0) instanceof EditorImpl impl ? impl.getBackgroundColor() : null)));
        EditorFactory.getInstance().refreshAllEditors();
    }

    private void tintComponent(@Nullable JComponent component, Color color) {
        if (component == null) return;
        if (!tintedComponents.contains(component)) {
            tintedComponents.add(component);
            tintedColors.add(component.getBackground());
            component.setOpaque(false);
        }
        component.setBackground(color);
    }

    private void restoreEditorBackground() {
        for (int i = 0; i < tintedEditors.size(); i++) {
            Editor editor = tintedEditors.get(i);
            if (editor.isDisposed()) continue;
            try {
                if (editor instanceof EditorImpl impl) impl.setBackgroundColor(tintedEditorColors.get(i));
            } catch (Throwable ignored) {
            }
        }
        tintedEditors.clear();
        tintedEditorColors.clear();
        for (int i = 0; i < tintedComponents.size(); i++) {
            Component component = tintedComponents.get(i);
            if (component instanceof JComponent jc) {
                jc.setBackground(tintedColors.get(i));
                jc.setOpaque(true);
                jc.repaint();
            }
        }
        tintedComponents.clear();
        tintedColors.clear();
        for (int i = 0; i < chainComponents.size(); i++) {
            if (chainComponents.get(i) instanceof JComponent jc && chainColors.get(i) != null) {
                jc.setBackground(chainColors.get(i));
                jc.repaint();
            }
        }
        chainComponents.clear();
        chainColors.clear();
        EditorFactory.getInstance().refreshAllEditors();
    }

    private void detach() {
        stopKeepAlive();
        if (mount != null && view != null && view.getParent() == mount) {
            mount.remove(view);
            mount.removeComponentListener(hostResizeListener);
            mount.repaint();
        }
        if (browser != null) {
            browser.dispose();
            browser = null;
        }
        view = null;
        if (host != null) {
            JFrame frame = findIdeFrame();
            restoreWindowOpacity(frame);
        }
        host = null;
        mount = null;
        restoreEditorBackground();
    }

    private WallpaperServer.Snapshot snapshot() {
        WallpaperEntry entry = findEntry(settings.wallpaperId);
        return new WallpaperServer.Snapshot(
                entry,
                settings.opacity,
                settings.fit,
                settings.blur,
                settings.enabled,
                entry == null ? "" : entry.id
        );
    }

    @Nullable
    private WallpaperEntry findEntry(String id) {
        if (id == null) return null;
        for (WallpaperEntry entry : entries) {
            if (entry.id.equals(id)) return entry;
        }
        return null;
    }

    /** 按类名（simpleName）在组件树里找第一个匹配的组件。 */
    @Nullable
    private static Component findBySimpleName(@Nullable Component root, String simpleName) {
        if (root == null) return null;
        if (simpleName.equals(root.getClass().getSimpleName())) return root;
        if (root instanceof Container container) {
            for (Component child : container.getComponents()) {
                Component hit = findBySimpleName(child, simpleName);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    @Nullable
    private static Editor anyEditor() {
        Editor[] editors = EditorFactory.getInstance().getAllEditors();
        return editors.length == 0 ? null : editors[0];
    }

    @Nullable
    private static JFrame findIdeFrame() {
        for (Window window : Window.getWindows()) {
            if (window instanceof JFrame frame
                    && frame.isShowing()
                    && frame.getClass().getName().contains("IdeFrame")) {
                return frame;
            }
        }
        return null;
    }

    /**
     * 把一个编辑器的组件链全部设为非不透明。
     *
     * <p>必须从 {@code getContentComponent()}（最里层的文本组件）开始往上走：
     * 编辑器实际的层级是 EditorComponentImpl → JBViewport → MyScrollPane → …，
     * 从 {@code getComponent()} 起走会漏掉 viewport 和 scroll pane 这两层，
     * 而它们默认不透明，壁纸就是被它们挡住的。
     */
    private void makeEditorTransparent(@Nullable Editor editor) {
        if (editor == null || editor.isDisposed() || host == null) return;
        Component content = editor.getContentComponent();
        if (content != null) makeTransparentChain(content, host);
        makeTransparentChain(editor.getComponent(), host);
    }

    /**
     * 把 node 到 stop 之间的容器设为非不透明，并把背景色改成全透明。
     *
     * <p>有些组件不看 {@code isOpaque()}，在 paintComponent 里直接用 {@code getBackground()}
     * 刷一层底色（IDEA 的 splitter / 编辑器容器就是这样），只设 opaque=false 挡不住；
     * 把背景色换成 alpha=0 才能让这次填充变成空操作。
     */
    private void makeTransparentChain(Component node, Component stop) {
        while (node != null && node != stop) {
            if (node instanceof JComponent component) {
                if (!chainComponents.contains(component)) {
                    chainComponents.add(component);
                    chainColors.add(component.getBackground());
                }
                if (component.isOpaque()) component.setOpaque(false);
                Color background = component.getBackground();
                if (background != null && background.getAlpha() != 0) {
                    component.setBackground(new Color(0, 0, 0, 0));
                }
            }
            node = node.getParent();
        }
    }

    private static Color withAlpha(Color color, int alpha) {
        if (color == null) return new Color(0, 0, 0, alpha);
        return new Color(color.getRed(), color.getGreen(), color.getBlue(), alpha);
    }

    private boolean warned;

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
    }

    @Override
    public void dispose() {
        stopKeepAlive();
        detach();
        server.stop();
    }
}

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
import com.intellij.openapi.editor.colors.EditorColors;
import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.editor.colors.EditorColorsScheme;
import com.intellij.openapi.editor.markup.TextAttributes;
import com.intellij.openapi.editor.event.EditorFactoryEvent;
import com.intellij.openapi.editor.event.EditorFactoryListener;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.JComponent;
import javax.swing.JLayeredPane;
import java.awt.Color;
import java.awt.Component;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 应用级服务：负责扫描壁纸、启动本地服务、把内嵌浏览器塞到编辑器区域的底层。
 *
 * 背景层放在编辑器所在 JLayeredPane 的最底层，然后把「编辑器 → 该 JLayeredPane」之间的容器
 * 全部设为非不透明，并把编辑器默认背景色改成半透明，这样壁纸就能从编辑器下面透出来。
 */
@State(name = "BackgroundWallpaperEngine", storages = @Storage("background-wallpaper-engine.xml"))
public final class WallpaperService implements PersistentStateComponent<WallpaperService.Settings>, Disposable {

    private static final Logger LOG = Logger.getInstance(WallpaperService.class);

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
    private TextAttributes savedText;
    private Color savedGutter;
    private boolean editorsHooked;
    private int attachAttempts;

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
        if (entries.isEmpty()) rescan();
        try {
            int port = server.port();
            if (ensureView() == null) return;
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
                if (view != null && host != null && view.getParent() == host) {
                    layoutView();
                    return;
                }
                apply();
            }
        }, this);
    }

    private JComponent ensureView() {
        Editor editor = anyEditor();
        if (editor == null) return view;

        JLayeredPane layered = findLayeredPane(editor.getComponent());
        if (layered == null) {
            LOG.warn("找不到编辑器所在的 JLayeredPane，无法挂载背景");
            return view;
        }

        if (view != null && host == layered) {
            layoutView();
            return view;
        }

        detach();

        browser = new JBCefBrowser();
        view = browser.getComponent();
        host = layered;

        LOG.info("挂载背景层到 " + layered.getClass().getName()
                + " bounds=" + layered.getBounds() + " layout=" + layered.getLayout());

        // 背景层放在最底部，编辑器区域整体叠在它上面
        host.add(view, Integer.valueOf(0));
        host.addComponentListener(new ComponentAdapter() {
            @Override
            public void componentResized(ComponentEvent event) {
                layoutView();
            }
        });
        layoutView();
        host.revalidate();
        host.repaint();

        // 容器首次还没布局出来时宽是 0，延后重试一次，避免 0x0 的背景层
        if (host.getWidth() == 0 && attachAttempts++ < 5) {
            ApplicationManager.getApplication().invokeLater(() -> {
                ApplicationManager.getApplication().invokeLater(this::layoutView);
            });
        }

        // 让壁纸能透出来：把编辑器到 layeredPane 之间的容器全部改为非不透明
        Component node = editor.getComponent();
        while (node != null && node != host) {
            if (node instanceof JComponent component) component.setOpaque(false);
            node = node.getParent();
        }
        tintEditorBackground(200);
        return view;
    }

    private void layoutView() {
        if (view != null && host != null) {
            view.setBounds(0, 0, host.getWidth(), host.getHeight());
        }
    }

    /**
     * 编辑器文字区的背景色来自默认文本属性（HighlighterColors.TEXT）的底色，
     * 把它换成带 alpha 的颜色，壁纸就能从编辑器下面透出来。
     */
    private void tintEditorBackground(int alpha) {
        EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
        if (savedText == null) {
            savedText = scheme.getAttributes(HighlighterColors.TEXT);
            savedGutter = scheme.getColor(EditorColors.GUTTER_BACKGROUND);
        }

        Color base = savedText != null && savedText.getBackgroundColor() != null
                ? savedText.getBackgroundColor()
                : scheme.getDefaultBackground();
        TextAttributes text = savedText == null ? new TextAttributes() : savedText.clone();
        text.setBackgroundColor(withAlpha(base, alpha));
        scheme.setAttributes(HighlighterColors.TEXT, text);
        if (savedGutter != null) scheme.setColor(EditorColors.GUTTER_BACKGROUND, withAlpha(savedGutter, alpha));
        EditorFactory.getInstance().refreshAllEditors();
    }

    private void restoreEditorBackground() {
        if (savedText == null) return;
        EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
        scheme.setAttributes(HighlighterColors.TEXT, savedText);
        if (savedGutter != null) scheme.setColor(EditorColors.GUTTER_BACKGROUND, savedGutter);
        savedText = null;
        savedGutter = null;
        EditorFactory.getInstance().refreshAllEditors();
    }

    private void detach() {
        if (host != null && view != null) {
            host.remove(view);
            host.repaint();
        }
        if (browser != null) {
            browser.dispose();
            browser = null;
        }
        view = null;
        host = null;
        attachAttempts = 0;
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

    @Nullable
    private static Editor anyEditor() {
        Editor[] editors = EditorFactory.getInstance().getAllEditors();
        return editors.length == 0 ? null : editors[0];
    }

    @Nullable
    private static JLayeredPane findLayeredPane(Component component) {
        for (Component node = component; node != null; node = node.getParent()) {
            if (node instanceof JLayeredPane layered) return layered;
        }
        return null;
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
        server.stop();
    }
}

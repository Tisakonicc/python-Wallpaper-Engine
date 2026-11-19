package com.tisako.wallpaper;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.ui.AbstractPainter;
import com.intellij.openapi.ui.Painter;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.Graphics2DDelegate;
import com.intellij.util.ui.JBSwingUtilities;
import com.intellij.util.ui.UIUtil;

import javax.swing.JComponent;
import javax.swing.JPanel;
import java.awt.AlphaComposite;
import java.awt.Component;
import java.awt.Composite;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GraphicsConfiguration;
import java.awt.Image;
import java.awt.Rectangle;
import java.awt.Transparency;
import java.awt.image.BufferedImage;
import java.awt.image.VolatileImage;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.function.BiFunction;
import java.util.function.Consumer;

/**
 * 路线 A：自建 Painter，直接绘制可变的 BufferedImage，不经过 ImagePainter 的缩放缓存。
 *
 * <p>安装部分仍复用平台的 PainterHelper / MyGraphics，因此项目树、编辑器和工具栏的
 * 透明合成方式与静态背景完全一致；区别只是每次换帧不再创建背景变换和全窗口缓存图。
 * PainterHelper 与 MyGraphics 是包私有实现类，所以仅在安装边界使用反射。
 */
final class LiveBackgroundPainter extends AbstractPainter implements Disposable {

    private static final Logger LOG = Logger.getInstance(LiveBackgroundPainter.class);

    private final JPanel panel;
    private final Disposable owner;
    private final Object helper;
    private final Method wrap;
    private final Consumer<LiveBackgroundPainter> failureHandler;

    private BufferedImage canvas;
    private boolean transformFailed;
    private boolean disposed;

    /**
     * 平台会在每个组件的每次填充时调用 executePaint，一次整窗重绘会有上千次。
     * 直接贴 BufferedImage 是软件合成，单次便宜但累计很重；这里每帧把画布拷进一张
     * 与屏幕兼容的 VolatileImage，后面的贴图走加速路径。
     */
    private VolatileImage cache;
    private GraphicsConfiguration cacheConfig;
    private int cacheWidth;
    private int cacheHeight;
    private long cacheVersion = -1;
    private volatile long version;

    private long paintNanos;
    private long paintCalls;

    private LiveBackgroundPainter(JPanel panel, BufferedImage canvas, Disposable owner,
                                  Object helper, Method wrap,
                                  Consumer<LiveBackgroundPainter> failureHandler) {
        this.panel = panel;
        this.canvas = canvas;
        this.owner = owner;
        this.helper = helper;
        this.wrap = wrap;
        this.failureHandler = failureHandler;
    }

    static LiveBackgroundPainter install(JPanel panel, BufferedImage canvas,
                                         Consumer<LiveBackgroundPainter> failureHandler) throws Exception {
        Class<?> helperClass = Class.forName("com.intellij.openapi.wm.impl.PainterHelper");
        Constructor<?> constructor = helperClass.getDeclaredConstructor(JComponent.class);
        constructor.setAccessible(true);
        Object helper = constructor.newInstance(panel);

        Method addPainter = helperClass.getDeclaredMethod("addPainter", Painter.class, Component.class);
        addPainter.setAccessible(true);
        Method clear = helperClass.getDeclaredMethod("clear");
        clear.setAccessible(true);

        Class<?> graphicsClass = Class.forName("com.intellij.openapi.wm.impl.IdeBackgroundUtil$MyGraphics");
        Method wrap = graphicsClass.getDeclaredMethod("wrap", Graphics.class, helperClass, JComponent.class);
        wrap.setAccessible(true);

        Disposable owner = Disposer.newDisposable("wallpaper-live-painter");
        Disposer.register(owner, () -> clearHelper(helper, clear));
        try {
            LiveBackgroundPainter painter = new LiveBackgroundPainter(
                    panel, canvas, owner, helper, wrap, failureHandler);
            addPainter.invoke(helper, painter, panel);

            BiFunction<JComponent, Graphics2D, Graphics2D> transform = painter::wrapGraphics;
            Disposable global = JBSwingUtilities.addGlobalCGTransform(transform);
            Disposer.register(owner, global);
            return painter;
        } catch (Exception err) {
            Disposer.dispose(owner);
            throw err;
        }
    }

    private Graphics2D wrapGraphics(JComponent target, Graphics2D graphics) {
        if (disposed || transformFailed || !UIUtil.isAncestor(panel, target)) return graphics;
        try {
            return (Graphics2D) wrap.invoke(null, graphics, helper, target);
        } catch (ReflectiveOperationException | RuntimeException err) {
            transformFailed = true;
            LOG.warn("自建 Painter 包装绘图上下文失败，准备回退静态背景", err);
            failureHandler.accept(this);
            return graphics;
        }
    }

    private static void clearHelper(Object helper, Method clear) {
        try {
            clear.invoke(helper);
        } catch (ReflectiveOperationException | RuntimeException err) {
            LOG.warn("释放自建 Painter 失败", err);
        }
    }

    /** 平台 ImagePainter 同样始终参与合成；否则一次 paint 后其他组件就画不到背景。 */
    @Override
    public boolean needsRepaint() {
        return !disposed;
    }

    @Override
    public void executePaint(Component component, Graphics2D graphics) {
        BufferedImage image = canvas;
        if (image == null || disposed) return;
        int width = component.getWidth();
        int height = component.getHeight();
        if (width <= 0 || height <= 0) return;

        // 平台传进来的是 MyGraphics 包装：它的 drawImage/fillRect 会再次触发 runAllPainters，
        // 在包装上绘制会无限递归直到 StackOverflowError。平台自己的 ImagePainter 用不透明
        // VolatileImage 落在跳过分支，所以没暴露；这里必须解包到原始 Graphics2D 再画。
        Graphics2D target = unwrap(graphics);

        long started = System.nanoTime();
        VolatileImage ready = prepare(target.getDeviceConfiguration(), image, width, height);
        Image source = ready != null ? ready : image;
        // 平台已经把绘图上下文裁剪到本次填充的区域，只贴裁剪区内的小块。
        Rectangle clip = target.getClipBounds();
        int x = 0;
        int y = 0;
        int w = width;
        int h = height;
        if (clip != null) {
            x = Math.max(0, clip.x);
            y = Math.max(0, clip.y);
            w = Math.min(width, clip.x + clip.width) - x;
            h = Math.min(height, clip.y + clip.height) - y;
        }
        if (w <= 0 || h <= 0) return;
        if (x + w > source.getWidth(null) || y + h > source.getHeight(null)) {
            x = 0;
            y = 0;
            w = width;
            h = height;
        }
        // 画布的不透明度已经烘焙进像素，这里直接覆盖：一次整窗重绘要贴几十次，
        // 半透明合成在软件渲染下会让每帧多出几百毫秒。
        Composite old = target.getComposite();
        target.setComposite(AlphaComposite.Src);
        try {
            target.drawImage(source, x, y, x + w, y + h, x, y, x + w, y + h, null);
        } finally {
            target.setComposite(old);
        }
        paintNanos += System.nanoTime() - started;
        paintCalls++;
    }

    /** 把当前画布同步到可加速的 VolatileImage；每帧最多重画一次，其余都是贴图。 */
    private VolatileImage prepare(GraphicsConfiguration config, BufferedImage image, int width, int height) {
        if (config == null) return null;
        try {
            if (cache == null || cacheConfig != config || cacheWidth != width || cacheHeight != height) {
                cache = config.createCompatibleVolatileImage(width, height, Transparency.OPAQUE);
                cacheConfig = config;
                cacheWidth = width;
                cacheHeight = height;
                cacheVersion = -1;
            }
            if (cacheVersion != version || cache.contentsLost()) {
                Graphics2D copy = cache.createGraphics();
                try {
                    copy.setComposite(AlphaComposite.Src);
                    copy.drawImage(image, 0, 0, width, height, null);
                } finally {
                    copy.dispose();
                }
                cacheVersion = version;
            }
            return cache.contentsLost() ? null : cache;
        } catch (RuntimeException err) {
            cache = null;
            cacheVersion = -1;
            return null;
        }
    }

    /** 取走本轮的绘制统计（调用次数 / 总耗时），用于判断瓶颈在绘制还是换帧。 */
    long[] drainPaintStats() {
        long[] stats = {paintCalls, paintNanos};
        paintCalls = 0;
        paintNanos = 0;
        return stats;
    }

    private static Graphics2D unwrap(Graphics2D graphics) {
        Graphics2D current = graphics;
        while (current instanceof Graphics2DDelegate delegate) {
            Graphics2D next = delegate.getDelegate();
            if (next == null || next == current) break;
            current = next;
        }
        return current;
    }

    void setCanvas(BufferedImage canvas) {
        this.canvas = canvas;
        // 画布是同一块内存、只改像素，靠版本号通知缓存重画
        this.version++;
    }

    /** 帧内容已经在 EDT 上写进同一画布，这里只通知平台重绘。 */
    void requestRepaint() {
        if (!disposed) setNeedsRepaint(true, panel);
    }

    @Override
    public void dispose() {
        if (disposed) return;
        disposed = true;
        canvas = null;
        Disposer.dispose(owner);
    }
}

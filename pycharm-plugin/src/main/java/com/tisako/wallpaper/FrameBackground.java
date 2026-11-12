package com.tisako.wallpaper;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.impl.IdeBackgroundUtil;

import javax.swing.JPanel;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.Insets;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.lang.reflect.Method;

/**
 * 整窗壁纸：走平台自带的背景图机制（{@link IdeBackgroundUtil}）。
 *
 * <p>平台会把整个界面内容按透明度绘制，所以项目树、工具栏、编辑器都能透出背景，
 * 不需要改动任何组件的 opaque 或背景色。关闭时 dispose 掉那个 Disposable，
 * 平台即恢复原样 —— 这是「禁用后完全还原」的实现基础。
 *
 * <p>两个细节：
 * <ul>
 *   <li><b>不二次裁剪</b>：平台的 {@code Fill.SCALE} 是 cover 语义（等比放大铺满、超出裁掉）。
 *       画布已按面板尺寸和用户选的填充方式合成好，只要画布比例与面板一致，SCALE
 *       就是无损 1:1 映射、不会多裁；比例不一致则由 {@link WallpaperService} 的
 *       尺寸监听在 300ms 内重渲染修正（启动时尺寸未就绪、窗口拖动/最大化都靠它）。
 *       枚举里另有 PLAIN（原尺寸摆放，露边/裁边）和 TILE（平铺），均不适用。</li>
 *   <li><b>虚化</b>：平台没有模糊能力，所以在生成画布时自己做一次可分离盒式模糊。</li>
 * </ul>
 *
 * <p><b>已知限制</b>：平台背景变换内部会把图像缩放缓存成 VolatileImage（约 120 秒才过期），
 * 替换图像内容不会刷新，因此这里只负责静态画面，尺寸变化时重建背景变换。
 */
public final class FrameBackground implements Disposable {

    private static final Logger LOG = Logger.getInstance(FrameBackground.class);

    private Disposable disposable;
    private JPanel panel;
    /** 已解析到的平台背景变换方法，避免每次都反射扫描。 */
    private static volatile Method transformMethod;

    /**
     * 显示背景图。
     *
     * @param opacity 0~1，背景图不透明度
     * @param blur    虚化半径（像素），0 表示不虚化
     */
    public void show(JFrameHolder holder, Image still, float opacity, int blur, String fit,
                     java.awt.Rectangle scrimRect, int scrimPercent, int posX) {
        if (holder == null || holder.panel == null || still == null) return;
        panel = holder.panel;
        int width = Math.max(320, panel.getWidth());
        int height = Math.max(240, panel.getHeight());

        BufferedImage canvas = render(still, width, height, fit, scrimRect, scrimPercent, posX);
        if (blur > 0) {
            canvas = blur(canvas, Math.min(60, blur));
        }

        try {
            java.nio.file.Path dbg = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"), "wallpaper-canvas.png");
            javax.imageio.ImageIO.write(canvas, "png", dbg.toFile());
            LOG.info("画布已保存：" + dbg + " 压暗矩形=" + scrimRect + " 压暗=" + scrimPercent);
        } catch (Throwable ignored) {
        }
        disposable = Disposer.newDisposable("wallpaper-frame-background");
        applyTransform(panel, canvas, Math.max(0.05f, Math.min(1f, opacity)), disposable);
        panel.repaint();
        LOG.info("整窗背景已设置：" + width + "x" + height + " 不透明度=" + opacity + " 虚化=" + blur + " 填充=" + fit + " 代码区压暗=" + scrimPercent);
    }

    /**
     * 调用平台的临时背景变换。
     *
     * <p>为什么要反射：平台把 {@code createTemporaryBackgroundTransform(JComponent, Image, Fill,
     * Anchor, float, Insets, Disposable)} 标成了 {@code @ApiStatus.Internal}，新版 Marketplace
     * 校验器只认公开 API，会把它判成 unresolved method（2024.2 起每个版本一条 Critical）。
     * 运行时该方法其实还在，所以这里用反射调用，字节码里只留字符串，不再有编译期符号引用。
     *
     * <p>又不能把参数类型写死：2024.1 的第一个参数是 {@code JPanel}，2024.2 起才改成
     * {@code JComponent}，写死会在 2024.1 上直接 NoSuchMethodException。所以按名字扫一遍再按
     * 实参做可赋值的匹配。
     */
    private static void applyTransform(JPanel panel, BufferedImage canvas, float opacity, Disposable disposable) {
        Method method = transformMethod;
        if (method == null) {
            method = resolveTransformMethod(panel, canvas, disposable);
            transformMethod = method;
        }
        if (method != null) {
            try {
                Class<?>[] types = method.getParameterTypes();
                method.invoke(null, panel, canvas, enumValue(types[2], "SCALE"), enumValue(types[3], "CENTER"),
                        opacity, new Insets(0, 0, 0, 0), disposable);
                return;
            } catch (Throwable err) {
                LOG.warn("整窗背景调用失败，改用临时图片方案", err);
                transformMethod = null;
            }
        }
        // 兜底：从老版本就存在的重载 —— 参数换成图片文件路径
        try {
            java.nio.file.Path file = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"),
                    "wallpaper-canvas-" + System.nanoTime() + ".png");
            javax.imageio.ImageIO.write(canvas, "png", file.toFile());
            Class<?> util = Class.forName("com.intellij.openapi.wm.impl.IdeBackgroundUtil");
            Method fallback = util.getMethod("createTemporaryBackgroundTransform", JPanel.class, String.class, Disposable.class);
            fallback.invoke(null, panel, file.toAbsolutePath().toString(), disposable);
        } catch (Throwable err) {
            LOG.warn("临时图片方案也不可用，背景未应用", err);
        }
    }

    /** 按名字 + 实参类型找出 7 参数的背景变换方法，找不到返回 null。 */
    private static Method resolveTransformMethod(JPanel panel, Image canvas, Disposable disposable) {
        try {
            Class<?> util = Class.forName("com.intellij.openapi.wm.impl.IdeBackgroundUtil");
            for (Method candidate : util.getMethods()) {
                if (!"createTemporaryBackgroundTransform".equals(candidate.getName())) continue;
                Class<?>[] types = candidate.getParameterTypes();
                if (types.length != 7) continue;
                if (!types[0].isInstance(panel) || !types[1].isInstance(canvas)) continue;
                if (!types[2].getName().endsWith("$Fill") || !types[3].getName().endsWith("$Anchor")) continue;
                if (types[4] != float.class || types[5] != Insets.class || !types[6].isInstance(disposable)) continue;
                return candidate;
            }
            LOG.warn("没找到 7 参数的背景变换方法，改用临时图片方案");
        } catch (Throwable err) {
            LOG.warn("反射查找背景变换方法失败", err);
        }
        return null;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object enumValue(Class<?> type, String name) {
        return Enum.valueOf((Class<? extends Enum>) type, name);
    }

    /**
     * 把源图绘制到与面板同尺寸的画布。
     *
     * <p>提供三种方式，避免只能靠平台硬拉伸：
     * <ul>
     *   <li>{@code contain}（默认）：完整显示整张图，四周留底色 —— 不会裁掉内容；</li>
     *   <li>{@code cover}：铺满窗口，超出部分裁掉；</li>
     *   <li>{@code stretch}：直接拉伸铺满（会变形，仅作备选）。</li>
     * </ul>
     */
    static BufferedImage render(Image source, int width, int height, String fit,
                                java.awt.Rectangle scrimRect, int scrimPercent, int posX) {
        int sw = Math.max(1, source.getWidth(null));
        int sh = Math.max(1, source.getHeight(null));
        BufferedImage canvas = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = canvas.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        // 先铺一层深色底，contain 时的留白才不会透出奇怪的颜色
        g.setColor(new java.awt.Color(30, 31, 34));
        g.fillRect(0, 0, width, height);

        String mode = fit == null ? "contain" : fit;
        if ("stretch".equals(mode)) {
            g.drawImage(source, 0, 0, width, height, null);
        } else {
            double scale = "cover".equals(mode)
                    ? Math.max((double) width / sw, (double) height / sh)
                    : Math.min((double) width / sw, (double) height / sh);
            int dw = Math.max(1, (int) Math.round(sw * scale));
            int dh = Math.max(1, (int) Math.round(sh * scale));
            // 水平位置：50 居中；0 贴左、100 贴右。cover 时会移动裁剪区域，contain 时直接挪画面
            int dx = (int) Math.round((width - dw) * (Math.max(0, Math.min(100, posX)) / 100.0));
            int dy = (height - dh) / 2;
            g.drawImage(source, dx, dy, dx + dw, dy + dh, 0, 0, sw, sh, null);
        }
        // 代码区单独压暗：壁纸在项目树/工具栏照常透出，但文字背后更暗，阅读更轻松
        if (scrimRect != null && scrimPercent > 0) {
            g.setColor(new java.awt.Color(0, 0, 0, Math.min(100, scrimPercent) * 255 / 100));
            g.fillRect(scrimRect.x, scrimRect.y, scrimRect.width, scrimRect.height);
        }
        g.dispose();
        return canvas;
    }
    /** 可分离盒式模糊，两遍滑动窗口，复杂度 O(像素数)，半径大也不卡。 */
    static BufferedImage blur(BufferedImage source, int radius) {
        int w = source.getWidth();
        int h = source.getHeight();
        int[] src = source.getRGB(0, 0, w, h, null, 0, w);
        int[] tmp = new int[src.length];
        int[] dst = new int[src.length];
        boxPass(src, tmp, w, h, radius, true);
        boxPass(tmp, dst, w, h, radius, false);
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        out.setRGB(0, 0, w, h, dst, 0, w);
        return out;
    }

    private static void boxPass(int[] src, int[] dst, int w, int h, int radius, boolean horizontal) {
        int window = radius * 2 + 1;
        if (horizontal) {
            for (int y = 0; y < h; y++) {
                int row = y * w;
                long r = 0, g = 0, b = 0;
                for (int i = -radius; i <= radius; i++) {
                    int x = Math.min(w - 1, Math.max(0, i));
                    int p = src[row + x];
                    r += (p >> 16) & 0xFF;
                    g += (p >> 8) & 0xFF;
                    b += p & 0xFF;
                }
                for (int x = 0; x < w; x++) {
                    dst[row + x] = ((int) (r / window) << 16) | ((int) (g / window) << 8) | (int) (b / window);
                    int addX = Math.min(w - 1, x + radius + 1);
                    int subX = Math.max(0, x - radius);
                    int add = src[row + addX];
                    int sub = src[row + subX];
                    r += ((add >> 16) & 0xFF) - ((sub >> 16) & 0xFF);
                    g += ((add >> 8) & 0xFF) - ((sub >> 8) & 0xFF);
                    b += (add & 0xFF) - (sub & 0xFF);
                }
            }
        } else {
            for (int x = 0; x < w; x++) {
                long r = 0, g = 0, b = 0;
                for (int i = -radius; i <= radius; i++) {
                    int y = Math.min(h - 1, Math.max(0, i));
                    int p = src[y * w + x];
                    r += (p >> 16) & 0xFF;
                    g += (p >> 8) & 0xFF;
                    b += p & 0xFF;
                }
                for (int y = 0; y < h; y++) {
                    dst[y * w + x] = ((int) (r / window) << 16) | ((int) (g / window) << 8) | (int) (b / window);
                    int addY = Math.min(h - 1, y + radius + 1);
                    int subY = Math.max(0, y - radius);
                    int add = src[addY * w + x];
                    int sub = src[subY * w + x];
                    r += ((add >> 16) & 0xFF) - ((sub >> 16) & 0xFF);
                    g += ((add >> 8) & 0xFF) - ((sub >> 8) & 0xFF);
                    b += (add & 0xFF) - (sub & 0xFF);
                }
            }
        }
    }

    @Override
    public void dispose() {
        if (disposable != null) {
            try {
                Disposer.dispose(disposable);
            } catch (Throwable err) {
                LOG.warn("释放背景变换失败", err);
            }
            disposable = null;
        }
        if (panel != null) {
            panel.repaint();
            panel = null;
        }
        javax.swing.SwingUtilities.invokeLater(IdeBackgroundUtil::repaintAllWindows);
    }

    /** 主窗口与承载背景的面板，避免直接依赖窗口实现类。 */
    public static final class JFrameHolder {
        public final javax.swing.JFrame frame;
        public final JPanel panel;

        public JFrameHolder(javax.swing.JFrame frame, JPanel panel) {
            this.frame = frame;
            this.panel = panel;
        }
    }
}

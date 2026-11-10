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

/**
 * 整窗壁纸：走平台自带的背景图机制（{@link IdeBackgroundUtil#createTemporaryBackgroundTransform}）。
 *
 * <p>平台会把整个界面内容按透明度绘制，所以项目树、工具栏、编辑器都能透出背景，
 * 不需要改动任何组件的 opaque 或背景色。关闭时 dispose 掉那个 Disposable，
 * 平台即恢复原样 —— 这是「禁用后完全还原」的实现基础。
 *
 * <p>两个细节：
 * <ul>
 *   <li><b>不拉伸</b>：平台的 {@code Fill.SCALE} 会把图硬拉满整个面板。这里先按 cover 规则
 *       把源图居中裁成与面板同比例，再交给平台缩放，画面就不会变形。</li>
 *   <li><b>虚化</b>：平台没有模糊能力，所以在生成画布时自己做一次可分离盒式模糊。</li>
 * </ul>
 *
 * <p><b>已知限制</b>：平台背景变换在创建时就把图像快照下来，替换图像内容不会刷新，
 * 因此只支持静态画面（视频壁纸取预览帧）。
 */
public final class FrameBackground implements Disposable {

    private static final Logger LOG = Logger.getInstance(FrameBackground.class);

    private Disposable disposable;
    private JPanel panel;

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
        IdeBackgroundUtil.createTemporaryBackgroundTransform(
                panel,
                canvas,
                IdeBackgroundUtil.Fill.SCALE,
                IdeBackgroundUtil.Anchor.CENTER,
                Math.max(0.05f, Math.min(1f, opacity)),
                new Insets(0, 0, 0, 0),
                disposable);
        panel.repaint();
        LOG.info("整窗背景已设置：" + width + "x" + height + " 不透明度=" + opacity + " 虚化=" + blur + " 填充=" + fit + " 代码区压暗=" + scrimPercent);
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
    private static BufferedImage render(Image source, int width, int height, String fit,
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
    private static BufferedImage blur(BufferedImage source, int radius) {
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

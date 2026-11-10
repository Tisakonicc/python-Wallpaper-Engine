package com.tisako.wallpaper;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.impl.IdeBackgroundUtil;

import javax.swing.JPanel;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.Insets;
import java.awt.image.BufferedImage;

/**
 * 整窗壁纸：走平台自带的背景图机制（{@link IdeBackgroundUtil#createTemporaryBackgroundTransform}）。
 *
 * <p>平台会把整个界面内容按透明度绘制，所以项目树、工具栏、编辑器都能透出背景，
 * 不需要改动任何组件的 opaque 或背景色。关闭时 dispose 掉那个 Disposable，
 * 平台即恢复原样 —— 这是「禁用后完全还原」的实现基础。
 *
 * <p><b>已知限制</b>：平台的背景变换在创建时就会把图像快照下来，替换 canvas 内容不会刷新，
 * 因此这里只支持静态画面（视频壁纸取它的预览帧）。
 */
public final class FrameBackground implements Disposable {

    private static final Logger LOG = Logger.getInstance(FrameBackground.class);

    private Disposable disposable;
    private JPanel panel;

    /**
     * 显示背景图。
     *
     * @param opacity 0~1，背景图不透明度
     */
    public void show(JFrameHolder holder, Image still, float opacity) {
        if (holder == null || holder.panel == null || still == null) return;
        panel = holder.panel;
        int width = Math.max(320, panel.getWidth());
        int height = Math.max(240, panel.getHeight());
        BufferedImage canvas = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = canvas.createGraphics();
        g.drawImage(still, 0, 0, width, height, null);
        g.dispose();

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
        LOG.info("整窗背景已设置：" + width + "x" + height + " 不透明度=" + opacity);
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
        // 让整个窗口重绘一次，确保回到原始主题外观
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

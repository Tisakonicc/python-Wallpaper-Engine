package com.tisako.wallpaper;

import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.SwingUtilities;
import java.awt.Component;
import java.awt.Container;

/** 诊断工具：打印壁纸层状态、组件树，以及指定坐标上最深的组件及其不透明性链。 */
public final class DebugProbe {

    private DebugProbe() {
    }

    public static String describe(JFrame frame, JComponent mount, JComponent view, int layer) {
        StringBuilder sb = new StringBuilder(2048);
        sb.append("frame=").append(frame == null ? "null" : frame.getClass().getName()).append('\n');
        sb.append("mount=").append(mount == null ? "null" : mount.getClass().getName()).append('\n');
        if (mount != null) {
            sb.append("mountSize=").append(mount.getWidth()).append('x').append(mount.getHeight()).append('\n');
            sb.append("mountChildren=").append(mount.getComponentCount()).append('\n');
            sb.append("mountOpaque=").append(mount.isOpaque())
                    .append(" mountBg=").append(mount.getBackground()).append('\n');
            sb.append("layer=").append(layer).append('\n');
            if (view != null) {
                sb.append("view=").append(view.getClass().getSimpleName())
                        .append(" bounds=").append(view.getBounds())
                        .append(" visible=").append(view.isVisible())
                        .append(" showing=").append(view.isShowing())
                        .append(" parentIsMount=").append(view.getParent() == mount)
                        .append(" zIndex=").append(mount.getComponentZOrder(view))
                        .append('\n');
            }
        }
        int[][] points = {{900, 600}, {700, 400}, {1000, 300}};
        for (int[] p : points) {
            Component c = frame == null ? null : SwingUtilities.getDeepestComponentAt(frame, p[0], p[1]);
            sb.append("p=").append(p[0]).append(',').append(p[1])
                    .append(" comp=").append(c == null ? "null" : c.getClass().getSimpleName()).append('\n');
            int depth = 0;
            for (Component cur = c; cur != null && depth < 18; cur = cur.getParent(), depth++) {
                sb.append("  ").append(cur.getClass().getSimpleName())
                        .append(" opaque=").append(cur.isOpaque())
                        .append(" bg=").append(cur.getBackground())
                        .append('\n');
            }
        }
        return sb.toString();
    }

    /** 打印窗口的组件树（类名、bounds、是否不透明、z 序），用于确定挂载点。 */
    public static String tree(JFrame frame) {
        if (frame == null) return "null frame";
        StringBuilder sb = new StringBuilder(8192);
        sb.append("=== frame children ===\n");
        dump(frame.getLayeredPane(), sb, 0, 7);
        sb.append("=== contentPane ===\n");
        dump(frame.getContentPane(), sb, 0, 5);
        return sb.toString();
    }

    private static void dump(Component component, StringBuilder sb, int depth, int maxDepth) {
        if (component == null || depth > maxDepth) return;
        String indent = "  ".repeat(depth);
        String z = "";
        Container parent = component.getParent();
        if (parent != null) z = " z=" + parent.getComponentZOrder(component);
        sb.append(indent)
                .append(component.getClass().getSimpleName())
                .append(" bounds=").append(component.getBounds().x).append(',').append(component.getBounds().y)
                .append(' ').append(component.getBounds().width).append('x').append(component.getBounds().height)
                .append(" opaque=").append(component.isOpaque())
                .append(z)
                .append('\n');
        if (component instanceof Container container) {
            for (Component child : container.getComponents()) {
                dump(child, sb, depth + 1, maxDepth);
            }
        }
    }
}

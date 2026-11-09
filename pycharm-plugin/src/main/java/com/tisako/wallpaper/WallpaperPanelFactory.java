package com.tisako.wallpaper;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;

/** 右侧工具窗口「壁纸」：和 Trae 版一样的缩略图网格面板（JCEF + 本地网页）。 */
public final class WallpaperPanelFactory implements ToolWindowFactory {

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow window) {
        Content content;
        if (!JBCefApp.isSupported()) {
            content = ContentFactory.getInstance().createContent(
                    new JBLabel("当前环境不支持 JCEF，无法显示壁纸面板。"), "", false);
            window.getContentManager().addContent(content);
            return;
        }
        try {
            int port = WallpaperService.getInstance().ensureServerPort();
            JBCefBrowser browser = new JBCefBrowser("http://127.0.0.1:" + port + "/panel.html");
            content = ContentFactory.getInstance().createContent(browser.getComponent(), "", false);
            content.setDisposer(browser);
        } catch (Exception err) {
            content = ContentFactory.getInstance().createContent(
                    new JBLabel("壁纸服务启动失败：" + err.getMessage()), "", false);
        }
        window.getContentManager().addContent(content);
    }
}

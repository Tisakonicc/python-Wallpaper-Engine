package com.tisako.wallpaper;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import org.jetbrains.annotations.NotNull;

/** Tools → 壁纸背景 → 快速开关。 */
public final class ToggleWallpaperAction extends AnAction {

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        WallpaperService service = WallpaperService.getInstance();
        service.setEnabled(!service.settings().enabled);
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        boolean on = WallpaperService.getInstance().settings().enabled;
        event.getPresentation().setText(on ? "关闭壁纸背景" : "启用壁纸背景");
    }
}

package com.tisako.wallpaper;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/** Tools → 壁纸背景 → 打开设置页。 */
public final class OpenSettingsAction extends AnAction {

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getProject();
        if (project == null) return;
        ShowSettingsUtil.getInstance().showSettingsDialog(project, WallpaperConfigurable.class);
    }
}

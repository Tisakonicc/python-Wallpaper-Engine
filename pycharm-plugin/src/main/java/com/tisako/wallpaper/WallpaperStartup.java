package com.tisako.wallpaper;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import org.jetbrains.annotations.NotNull;

/** IDE 打开项目后，如果壁纸是开启状态就把背景装上。 */
public final class WallpaperStartup implements StartupActivity.DumbAware {

    @Override
    public void runActivity(@NotNull Project project) {
        WallpaperService.getInstance().onStartup();
    }
}

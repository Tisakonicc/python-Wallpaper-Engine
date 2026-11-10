package com.tisako.wallpaper;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import org.jetbrains.annotations.NotNull;

/**
 * 诊断动作：把壁纸层换成品红色块。
 *
 * <p>用来区分两种失败原因：色块能透出来，说明层级和透明化都没问题，问题在 JCEF 渲染；
 * 色块也看不到，说明还有不透明的组件盖在上面（多半是主题类插件）。
 */
public final class DebugSolidAction extends AnAction {

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        WallpaperService.getInstance().toggleDebugSolid();
    }
}

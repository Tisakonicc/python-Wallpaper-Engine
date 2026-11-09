package com.tisako.wallpaper;

import java.nio.file.Path;

/** 一个壁纸条目：要么来自 Steam 创意工坊，要么来自本地导入。 */
public final class WallpaperEntry {
    public final String id;
    public final String title;
    /** video / image / scene / web */
    public final String kind;
    /** 实际可播放的文件；场景和网页壁纸留空（当前版本回落到缩略图）。 */
    public final Path media;
    /** 缩略图，可能为 null。 */
    public final Path preview;
    public final boolean imported;

    public WallpaperEntry(String id, String title, String kind, Path media, Path preview, boolean imported) {
        this.id = id;
        this.title = title;
        this.kind = kind;
        this.media = media;
        this.preview = preview;
        this.imported = imported;
    }

    /** 用于在设置页的下拉框里显示。 */
    @Override
    public String toString() {
        String label = switch (kind) {
            case "video" -> "视频";
            case "image" -> "图片";
            case "scene" -> "场景";
            case "web" -> "网页";
            default -> kind;
        };
        return title + "（" + label + (imported ? "·导入" : "") + "）";
    }
}

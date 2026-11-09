package com.tisako.wallpaper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 扫描 Steam Wallpaper Engine 的壁纸库（appid 431960），并把用户导入的本地文件合并进来。
 * 逻辑和 VS Code 扩展里的一致：注册表找 Steam → 读 libraryfolders.vdf 找其它库 → 遍历 workshop 目录。
 */
public final class WallpaperLibrary {

    private static final Set<String> VIDEO_EXT = Set.of(".mp4", ".webm", ".mov", ".m4v");
    private static final Set<String> IMAGE_EXT = Set.of(".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif");

    private static final Pattern TYPE = Pattern.compile("\"type\"\\s*:\\s*\"([^\"]*)\"");
    private static final Pattern FILE = Pattern.compile("\"file\"\\s*:\\s*\"([^\"]*)\"");
    private static final Pattern PREVIEW = Pattern.compile("\"preview\"\\s*:\\s*\"([^\"]*)\"");
    private static final Pattern TITLE = Pattern.compile("\"title\"\\s*:\\s*\"([^\"]*)\"");
    private static final Pattern VDF_PATH = Pattern.compile("\"path\"\\s+\"([^\"]+)\"");
    private static final Pattern REG_STEAM = Pattern.compile("SteamPath\\s+REG_SZ\\s+(.+)");

    private WallpaperLibrary() {
    }

    public static List<WallpaperEntry> scan(List<String> imports) {
        List<WallpaperEntry> out = new ArrayList<>();
        for (Path root : steamRoots()) {
            Path content = root.resolve("steamapps").resolve("workshop").resolve("content").resolve("431960");
            if (!Files.isDirectory(content)) continue;
            try (DirectoryStream<Path> dirs = Files.newDirectoryStream(content)) {
                for (Path dir : dirs) {
                    if (!Files.isDirectory(dir)) continue;
                    WallpaperEntry entry = fromWorkshopDir(dir);
                    if (entry != null) out.add(entry);
                }
            } catch (IOException ignored) {
                // 某个库读不出来就跳过，不影响其它库
            }
        }
        out.sort(Comparator.comparing(e -> e.title.toLowerCase(Locale.ROOT)));

        // 导入的条目排在前面，方便一眼找到刚加进来的
        List<WallpaperEntry> imported = new ArrayList<>();
        for (String path : imports) {
            WallpaperEntry entry = fromImportedFile(path);
            if (entry != null) imported.add(entry);
        }
        imported.addAll(out);
        return imported;
    }

    public static WallpaperEntry byId(List<WallpaperEntry> entries, String id) {
        for (WallpaperEntry entry : entries) {
            if (entry.id.equals(id)) return entry;
        }
        return entries.isEmpty() ? null : entries.get(0);
    }

    private static WallpaperEntry fromWorkshopDir(Path dir) {
        String json = readText(dir.resolve("project.json"));
        String type = group(TYPE, json);
        String declared = group(FILE, json);
        String declaredPreview = group(PREVIEW, json);

        Path media = null;
        if (declared != null && !declared.isBlank()) {
            Path candidate = dir.resolve(declared);
            if (Files.isRegularFile(candidate)) media = candidate;
        }
        if (media == null) media = firstWith(dir, VIDEO_EXT);
        if (media == null) media = firstWith(dir, IMAGE_EXT);

        Path preview = null;
        if (declaredPreview != null && !declaredPreview.isBlank()) {
            Path candidate = dir.resolve(declaredPreview);
            if (Files.isRegularFile(candidate)) preview = candidate;
        }
        if (preview == null) {
            for (String name : new String[]{"preview.jpg", "preview.png", "preview.gif", "preview.webp"}) {
                Path candidate = dir.resolve(name);
                if (Files.isRegularFile(candidate)) {
                    preview = candidate;
                    break;
                }
            }
        }
        if (preview == null && media != null && IMAGE_EXT.contains(ext(media))) preview = media;

        if (media == null && preview == null) return null;

        String id = dir.getFileName().toString();
        String title = group(TITLE, json);
        if (title == null || title.isBlank()) title = id;

        return new WallpaperEntry(id, title, detectKind(dir, type, media), media, preview, false);
    }

    private static WallpaperEntry fromImportedFile(String raw) {
        Path path;
        try {
            path = Paths.get(raw);
        } catch (RuntimeException err) {
            return null;
        }
        if (!Files.isRegularFile(path)) return null;
        String ext = ext(path);
        boolean image = IMAGE_EXT.contains(ext);
        String title = path.getFileName().toString();
        int dot = title.lastIndexOf('.');
        if (dot > 0) title = title.substring(0, dot);
        String id = "local-" + Integer.toHexString(raw.toLowerCase(Locale.ROOT).hashCode());
        return new WallpaperEntry(id, title, image ? "image" : "video", path, image ? path : null, true);
    }

    private static String detectKind(Path dir, String type, Path media) {
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        String ext = media == null ? "" : ext(media);
        if ("web".equals(t)) return "web";
        if ("scene".equals(t)) return "scene";
        if ("video".equals(t)) return IMAGE_EXT.contains(ext) ? "image" : "video";
        if (IMAGE_EXT.contains(ext)) return "image";
        if (VIDEO_EXT.contains(ext)) return "video";
        if (Files.isRegularFile(dir.resolve("index.html"))) return "web";
        if (Files.isRegularFile(dir.resolve("scene.pkg"))) return "scene";
        return "video";
    }

    private static String ext(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase(Locale.ROOT);
    }

    private static Path firstWith(Path dir, Set<String> extensions) {
        try (DirectoryStream<Path> files = Files.newDirectoryStream(dir)) {
            for (Path file : files) {
                if (Files.isRegularFile(file) && extensions.contains(ext(file))) return file;
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    private static String group(Pattern pattern, String text) {
        if (text == null) return null;
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String readText(Path file) {
        try {
            return Files.isRegularFile(file) ? Files.readString(file, StandardCharsets.UTF_8) : null;
        } catch (IOException err) {
            return null;
        }
    }

    private static List<Path> steamRoots() {
        LinkedHashSet<Path> roots = new LinkedHashSet<>();
        addRoot(roots, registrySteamPath());
        for (String guess : new String[]{
                "C:/Program Files (x86)/Steam",
                "C:/Program Files/Steam",
                "D:/Steam",
                "E:/Steam",
                "F:/Steam"
        }) {
            addRoot(roots, guess);
        }

        // 其它磁盘上的库都登记在每个库根的 libraryfolders.vdf 里
        for (Path root : new ArrayList<>(roots)) {
            Path vdf = root.resolve("steamapps").resolve("libraryfolders.vdf");
            if (!Files.isRegularFile(vdf)) continue;
            Matcher matcher = VDF_PATH.matcher(readText(vdf) == null ? "" : readText(vdf));
            while (matcher.find()) addRoot(roots, matcher.group(1).replace("\\\\", "\\"));
        }
        return new ArrayList<>(roots);
    }

    private static void addRoot(LinkedHashSet<Path> roots, String raw) {
        if (raw == null || raw.isBlank()) return;
        try {
            Path path = Paths.get(raw.trim().replace("\\\\", "\\"));
            if (Files.isDirectory(path)) roots.add(path.toAbsolutePath().normalize());
        } catch (RuntimeException ignored) {
        }
    }

    private static String registrySteamPath() {
        try {
            Process process = new ProcessBuilder("reg", "query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath")
                    .redirectErrorStream(true)
                    .start();
            StringBuilder text = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line).append('\n');
            }
            process.waitFor();
            Matcher matcher = REG_STEAM.matcher(text);
            return matcher.find() ? matcher.group(1).trim() : null;
        } catch (IOException | InterruptedException err) {
            return null;
        }
    }
}

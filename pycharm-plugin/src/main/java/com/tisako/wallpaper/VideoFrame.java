package com.tisako.wallpaper;

import com.intellij.openapi.diagnostic.Logger;
import org.jcodec.api.FrameGrab;
import org.jcodec.common.io.NIOUtils;
import org.jcodec.common.io.SeekableByteChannel;
import org.jcodec.common.model.Picture;
import org.jcodec.scale.AWTUtil;

import java.awt.image.BufferedImage;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 取视频壁纸的真实首帧。
 *
 * <p>Wallpaper Engine 的 {@code preview.jpg} 是 1024×1024 的方形居中裁切图（通常只剩脸部特写），
 * 直接拿来铺满宽屏窗口会被放大再裁一次，看起来"裁剪特别严重"。视频项目里真正的画面在
 * mp4 里，所以用纯 Java 的 JCodec 解出首帧，比例和构图才和 Trae 端一致。
 *
 * <p>解码结果按路径缓存；解码失败（如 WebM/VP9 等 JCodec 不支持的编码）返回 null，
 * 调用方回退到 preview.jpg。
 */
final class VideoFrame {

    private static final Logger LOG = Logger.getInstance(VideoFrame.class);

    private static final Set<String> SUPPORTED = Set.of(".mp4", ".m4v", ".mov");
    private static final Map<String, BufferedImage> CACHE = new ConcurrentHashMap<>();
    private static final Set<String> FAILED = ConcurrentHashMap.newKeySet();
    /** 正在后台解码的路径，避免重复起线程。 */
    private static final Set<String> PENDING = ConcurrentHashMap.newKeySet();

    private VideoFrame() {
    }

    static boolean supports(Path path) {
        if (path == null) return false;
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        int dot = name.lastIndexOf('.');
        return dot > 0 && SUPPORTED.contains(name.substring(dot));
    }

    /** 已解码过的首帧；没有则返回 null。 */
    static BufferedImage cached(Path path) {
        return path == null ? null : CACHE.get(path.toAbsolutePath().toString());
    }

    /**
     * 后台解码首帧，完成后在回调里把结果交回调用方。
     *
     * <p>4K 视频用 JCodec 解一帧要数秒，绝不能在 EDT 上做，否则切壁纸时整个 IDE 卡住。
     */
    static void decodeAsync(Path path, java.util.function.Consumer<BufferedImage> callback) {
        if (!supports(path)) return;
        String key = path.toAbsolutePath().toString();
        BufferedImage done = CACHE.get(key);
        if (done != null) {
            callback.accept(done);
            return;
        }
        if (FAILED.contains(key) || !PENDING.add(key)) return;
        Thread worker = new Thread(() -> {
            try {
                BufferedImage image = firstFrame(path);
                if (image != null) callback.accept(image);
            } finally {
                PENDING.remove(key);
            }
        }, "wallpaper-video-frame");
        worker.setDaemon(true);
        worker.start();
    }

    static BufferedImage firstFrame(Path path) {
        if (!supports(path)) return null;
        String key = path.toAbsolutePath().toString();
        BufferedImage cached = CACHE.get(key);
        if (cached != null || FAILED.contains(key)) return cached;

        SeekableByteChannel channel = null;
        try {
            channel = NIOUtils.readableChannel(path.toFile());
            FrameGrab grab = FrameGrab.createFrameGrab(channel);
            // 取 1.5 秒处的画面：很多视频第 0 帧是黑场片头，静态显示会像"没加载"
            try {
                grab.seekToSecondPrecise(1.5);
            } catch (Throwable ignored) {
                // 短视频或没有索引时退回首帧
            }
            Picture picture = grab.getNativeFrame();
            if (picture == null) {
                FAILED.add(key);
                return null;
            }
            BufferedImage image = AWTUtil.toBufferedImage(picture);
            CACHE.put(key, image);
            LOG.info("已解码视频首帧：" + path.getFileName() + " " + image.getWidth() + "x" + image.getHeight());
            return image;
        } catch (Throwable err) {
            FAILED.add(key);
            LOG.info("视频首帧解码失败，回退预览图：" + path.getFileName() + "（" + err.getMessage() + "）");
            return null;
        } finally {
            NIOUtils.closeQuietly(channel);
        }
    }
}

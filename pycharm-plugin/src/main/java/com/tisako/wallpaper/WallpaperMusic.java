package com.tisako.wallpaper;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import org.jcodec.codecs.aac.AACDecoder;
import org.jcodec.codecs.mpa.Mp3Decoder;
import org.jcodec.common.AudioDecoder;
import org.jcodec.common.Codec;
import org.jcodec.common.DemuxerTrack;
import org.jcodec.common.DemuxerTrackMeta;
import org.jcodec.common.SeekableDemuxerTrack;
import org.jcodec.common.io.NIOUtils;
import org.jcodec.common.io.SeekableByteChannel;
import org.jcodec.common.model.AudioBuffer;
import org.jcodec.common.model.Packet;
import org.jcodec.containers.mp4.demuxer.MP4Demuxer;
import org.jetbrains.annotations.Nullable;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.SourceDataLine;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * 视频壁纸自带的背景音乐。
 *
 * <p>画面走平台静态背景，声音单独用 JCodec 把 mp4 里的音轨（AAC / MP3）解成 PCM，
 * 再交给 Java Sound 播放。解码在线程里顺序进行，不把整个文件读进内存；
 * 播完一轮会回到开头继续循环，和 Wallpaper Engine 里视频循环的观感一致。
 *
 * <p>音量 / 静音在写入 PCM 时逐样本平滑过渡，避免直接切换音量产生「咔」的爆音。
 * 只支持 mp4 / m4v / mov；webm 等 JCodec 解不了的容器会安静地跳过。
 */
final class WallpaperMusic implements Disposable {

    private static final Logger LOG = Logger.getInstance(WallpaperMusic.class);

    /** 默认音量 0~100。 */
    static final int DEFAULT_VOLUME = 60;
    /** 每样本向目标音量逼近的比例，约 10ms 完成过渡。 */
    private static final float RAMP = 0.002f;

    private volatile String currentKey = "";
    /** 没有音轨 / 解码失败的文件，避免每次应用壁纸都重试。 */
    private volatile String silentKey = "";
    private volatile boolean muted;
    private volatile int volume = DEFAULT_VOLUME;
    /** 当前播放线程；置空即为停止，线程自己也靠它判断是否被换掉。 */
    private volatile Thread worker;
    private volatile SourceDataLine line;
    /** 当前增益，只由播放线程读写。 */
    private float gain;

    /** 视频壁纸才有音轨可播。 */
    static boolean canPlay(@Nullable WallpaperEntry entry) {
        return entry != null && "video".equals(entry.kind)
                && entry.media != null && Files.isRegularFile(entry.media)
                && VideoFrame.supports(entry.media);
    }

    /**
     * 切换到指定视频的音轨；同一个文件重复调用不会重启播放。
     * 没有音轨的文件会被记住，直到换了别的壁纸再回来才会重试。
     */
    synchronized void play(@Nullable Path file) {
        if (file == null || !VideoFrame.supports(file) || !Files.isRegularFile(file)) {
            LOG.info("壁纸音乐跳过：文件不可播放 " + file);
            stop();
            return;
        }
        String key = file.toAbsolutePath().toString();
        Thread active = worker;
        if (active != null && key.equals(currentKey)) return;
        if (active == null && key.equals(silentKey)) return;
        stop();
        currentKey = key;
        Path target = file.toAbsolutePath();
        Thread thread = new Thread(() -> run(target, key), "wallpaper-music");
        thread.setDaemon(true);
        thread.setPriority(Thread.NORM_PRIORITY - 1);
        worker = thread;
        thread.start();
    }

    synchronized void stop() {
        Thread thread = worker;
        worker = null;
        currentKey = "";
        if (thread != null) thread.interrupt();
        SourceDataLine out = line;
        line = null;
        // 关闭输出会立刻打断正在阻塞的 write，播放线程随即退出
        closeLine(out);
    }

    void setVolume(int value) {
        volume = Math.max(0, Math.min(100, value));
    }

    void setMuted(boolean value) {
        muted = value;
    }

    @Override
    public void dispose() {
        stop();
    }

    // ---------- 播放线程 ----------

    private void run(Path file, String key) {
        SeekableByteChannel channel = null;
        SourceDataLine out = null;
        boolean exhausted = false;
        try {
            channel = NIOUtils.readableChannel(file.toFile());
            MP4Demuxer demuxer = MP4Demuxer.createMP4Demuxer(channel);
            DemuxerTrack track = pickAudioTrack(demuxer);
            if (track == null) {
                silentKey = key;
                LOG.info("壁纸没有可播放的音轨：" + file.getFileName());
                return;
            }
            DemuxerTrackMeta meta = track.getMeta();
            AudioDecoder decoder = createDecoder(meta);
            if (decoder == null) {
                silentKey = key;
                LOG.info("不支持的壁纸音频编码：" + meta.getCodec() + "（" + file.getFileName() + "）");
                return;
            }

            AudioFormat format = null;
            int emptyLoops = 0;
            while (Thread.currentThread() == worker) {
                Packet packet = track.nextFrame();
                if (packet == null) {
                    // 连续两轮都读不到数据就认为没有可播内容，避免 seek 后空转
                    if (++emptyLoops > 1) {
                        exhausted = true;
                        break;
                    }
                    // 播完一轮回到开头；重建解码器清掉上一轮的重叠窗状态，接缝才不会带杂音
                    if (!(track instanceof SeekableDemuxerTrack seekable) || !seekable.gotoFrame(0)) {
                        exhausted = true;
                        break;
                    }
                    decoder = createDecoder(meta);
                    if (decoder == null) {
                        exhausted = true;
                        break;
                    }
                    continue;
                }
                emptyLoops = 0;
                AudioBuffer audio = decoder.decodeFrame(packet.getData(), null);
                if (audio == null) continue;
                if (!audio.getFormat().isSigned()) {
                    // 无符号 PCM 交给 Java Sound 播放会变成噪声，直接当作不支持
                    silentKey = key;
                    break;
                }
                if (format == null) {
                    format = toJavaFormat(audio.getFormat());
                    out = openLine(format);
                    line = out;
                    gain = muted ? 0f : volume / 100f;
                    LOG.info("壁纸音乐开始播放：" + file.getFileName() + "，"
                            + (int) format.getSampleRate() + "Hz " + format.getChannels() + "ch，音量="
                            + volume + (muted ? "（静音）" : "") + "，增益=" + gain);
                }
                // 输出设备刚打开时可能已经被 stop() 换掉，别再往旧管线里塞数据
                if (Thread.currentThread() != worker) break;
                byte[] pcm = toBytes(audio.getData());
                if (pcm.length == 0) continue;
                applyGain(pcm, format);
                out.write(pcm, 0, pcm.length);
            }
        } catch (Throwable err) {
            if (worker == Thread.currentThread()) {
                silentKey = key;
                LOG.info("壁纸音乐播放失败：" + file.getFileName() + "（" + err.getMessage() + "）");
            }
        } finally {
            closeLine(out);
            NIOUtils.closeQuietly(channel);
            if (worker == Thread.currentThread()) {
                if (exhausted) silentKey = key;
                worker = null;
                currentKey = "";
            }
        }
    }

    @Nullable
    private static DemuxerTrack pickAudioTrack(MP4Demuxer demuxer) {
        List<? extends DemuxerTrack> tracks = demuxer.getAudioTracks();
        if (tracks == null) return null;
        for (DemuxerTrack track : tracks) {
            DemuxerTrackMeta meta = track.getMeta();
            if (meta == null) continue;
            if (meta.getCodec() == Codec.AAC || meta.getCodec() == Codec.MP3) return track;
        }
        return null;
    }

    @Nullable
    private static AudioDecoder createDecoder(DemuxerTrackMeta meta) {
        try {
            if (meta.getCodec() == Codec.MP3) return new Mp3Decoder();
            if (meta.getCodec() != Codec.AAC) return null;
            ByteBuffer specific = meta.getCodecPrivate();
            return specific == null ? null : new AACDecoder(specific);
        } catch (Throwable err) {
            LOG.info("创建音频解码器失败：" + err.getMessage());
            return null;
        }
    }

    private static AudioFormat toJavaFormat(org.jcodec.common.AudioFormat format) {
        return new AudioFormat(format.getSampleRate(), format.getSampleSizeInBits(),
                format.getChannels(), format.isSigned(), format.isBigEndian());
    }

    private static SourceDataLine openLine(AudioFormat format) throws Exception {
        SourceDataLine out = AudioSystem.getSourceDataLine(format);
        out.open(format, Math.max(16 * 1024, format.getFrameSize() * 4096));
        out.start();
        return out;
    }

    private static byte[] toBytes(ByteBuffer data) {
        ByteBuffer source = data.duplicate();
        byte[] pcm = new byte[source.remaining()];
        source.get(pcm);
        return pcm;
    }

    /**
     * 按当前音量缩放 16-bit 小端 PCM。音量变化逐样本逼近目标值，
     * 直接乘新音量会让波形出现台阶，听起来就是「咔」的一声。
     */
    private void applyGain(byte[] pcm, AudioFormat format) {
        float target = muted ? 0f : volume / 100f;
        if (format.getSampleSizeInBits() != 16 || format.isBigEndian()) {
            // 非 16-bit 小端（极少见）不做缩放，至少不破坏音频数据
            gain = target;
            return;
        }
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            gain += (target - gain) * RAMP;
            int sample = (short) ((pcm[i] & 0xFF) | (pcm[i + 1] << 8));
            int scaled = Math.round(sample * gain);
            if (scaled > 32767) scaled = 32767;
            else if (scaled < -32768) scaled = -32768;
            pcm[i] = (byte) scaled;
            pcm[i + 1] = (byte) (scaled >> 8);
        }
    }

    private static void closeLine(@Nullable SourceDataLine out) {
        if (out == null) return;
        try {
            out.stop();
            out.flush();
            out.close();
        } catch (Throwable ignored) {
        }
    }
}

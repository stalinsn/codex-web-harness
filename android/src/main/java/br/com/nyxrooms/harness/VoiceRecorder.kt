package br.com.nyxrooms.harness

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/** AAC/MP4 voice note recorder (the server transcribes audio/mp4 locally). */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    var startedAt = 0L
        private set
    val recording get() = recorder != null

    fun start() {
        stopQuietly()
        val target = File(context.cacheDir, "voz-${System.currentTimeMillis()}.m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(44100)
            r.setAudioEncodingBitRate(64000)
            r.setMaxDuration(180_000)
            r.setOutputFile(target.absolutePath)
            r.prepare()
            r.start()
        } catch (failure: Exception) {
            r.release(); target.delete(); throw failure
        }
        recorder = r; file = target; startedAt = System.currentTimeMillis()
    }

    /** 0..1 input level for the on-screen meter. */
    fun level(): Float = runCatching { (recorder?.maxAmplitude ?: 0) / 32767f }.getOrDefault(0f).coerceIn(0f, 1f)

    /** Stops and returns the recorded file (null if too short or failed). */
    fun stop(): File? {
        val r = recorder ?: return null
        val ok = runCatching { r.stop() }.isSuccess
        r.release(); recorder = null
        val result = file; file = null
        if (!ok || result == null || result.length() < 2000) { result?.delete(); return null }
        return result
    }

    fun stopQuietly() { runCatching { recorder?.stop() }; recorder?.release(); recorder = null; file?.delete(); file = null }
}

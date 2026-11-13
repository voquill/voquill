package com.voquill.mobile.notes

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/**
 * Records a meeting note as ADTS AAC segments (16 kHz mono, 32 kbps) with
 * AudioRecord + MediaCodec. ADTS frames are self-contained, so a file stays
 * usable up to its last frame when the process is killed.
 *
 * Segments roll over to a new file (same directory, new UUID) at
 * `maxSegmentMs` or `maxSegmentBytes`, between two encoded frames, so nothing is lost at the
 * boundary. At `maxNoteMs` capture pauses with reason `limit`; a failed
 * write ends the session with reason `write_failed`, keeping what was
 * written. Capture runs on its own thread; the public API is main-thread.
 * A process singleton so [NoteRecorderService] (notification actions),
 * [NoteRecorderChannel] (Dart) and the keyboard see the same session.
 */
object NoteRecorder {
    private const val TAG = "NoteRecorder"
    private const val SAMPLE_RATE = 16000
    private const val SAMPLES_PER_FRAME = 1024
    private const val BIT_RATE = 32000
    const val MIN_FREE_BYTES = 20L * 1024 * 1024

    /** Notified on the main thread when the recorder changes state by itself. */
    var onStateChanged: ((Map<String, Any>) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Object()
    private var session: Session? = null

    var isSyncActive = false
        private set

    private class Session(
        val noteId: String,
        var segmentId: String,
        val directory: File,
        var output: FileOutputStream,
        val priorElapsedMs: Long,
        val maxSegmentMs: Long,
        val maxSegmentBytes: Long,
        val maxNoteMs: Long,
    ) {
        var segmentFrames = 0L
        var segmentBytes = 0L
        var sessionFrames = 0L
        var isPaused = false
        var isStopping = false
        var thread: Thread? = null
    }

    val isActive: Boolean get() = synchronized(lock) { session != null }
    val isCapturing: Boolean get() = synchronized(lock) { session?.isPaused == false }
    val activeNoteId: String? get() = synchronized(lock) { session?.noteId }
    val isRecordingPaused: Boolean get() = synchronized(lock) { session?.isPaused == true }

    fun freeBytes(path: String): Long = File(path).let { if (it.isDirectory) it else it.parentFile }?.usableSpace ?: Long.MAX_VALUE

    @SuppressLint("MissingPermission")
    fun start(
        context: Context,
        noteId: String,
        segmentId: String,
        path: String,
        priorElapsedMs: Long,
        maxSegmentMs: Long,
        maxSegmentBytes: Long,
        maxNoteMs: Long,
    ) {
        check(!isActive) { "A meeting is already recording" }
        check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            "Microphone permission missing"
        }
        val file = File(path)
        if (freeBytes(file.parent ?: path) < MIN_FREE_BYTES) throw LowStorageException()

        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuffer, SAMPLES_PER_FRAME * 2 * 8),
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("The microphone could not be opened")
        }
        val codec = createEncoder()
        val output = try {
            FileOutputStream(file)
        } catch (e: IOException) {
            record.release()
            codec.release()
            throw e
        }
        try {
            record.startRecording()
        } catch (e: Exception) {
            record.release()
            codec.release()
            output.close()
            throw e
        }
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            record.release()
            codec.release()
            output.close()
            throw IllegalStateException("The microphone is in use")
        }

        val newSession = Session(noteId, segmentId, file.parentFile!!, output, priorElapsedMs, maxSegmentMs, maxSegmentBytes, maxNoteMs)
        synchronized(lock) { session = newSession }
        newSession.thread = Thread({ capture(context.applicationContext, newSession, record, codec) }, "NoteRecorder").apply { start() }
        NoteRecorderService.update(context)
    }

    fun pause(context: Context): Map<String, Any>? {
        synchronized(lock) {
            session?.isPaused = true
            lock.notifyAll()
        }
        NoteRecorderService.update(context)
        return state()
    }

    fun resume(context: Context): Map<String, Any>? {
        val current = synchronized(lock) { session } ?: return null
        if (freeBytes(current.directory.path) < MIN_FREE_BYTES) throw LowStorageException()
        synchronized(lock) {
            current.isPaused = false
            lock.notifyAll()
        }
        NoteRecorderService.update(context)
        return state()
    }

    /** Stops capture and closes the file before returning. */
    fun stop(context: Context): Map<String, Any>? {
        val final = state()
        val current = synchronized(lock) {
            val s = session
            s?.isStopping = true
            session = null
            lock.notifyAll()
            s
        }
        current?.thread?.join(3000)
        NoteRecorderService.update(context)
        return final
    }

    fun state(reason: String? = null): Map<String, Any>? = synchronized(lock) { session?.let { stateMap(it, reason) } }

    private fun stateMap(session: Session, reason: String?): Map<String, Any> {
        val map = mutableMapOf<String, Any>(
            "noteId" to session.noteId,
            "segmentId" to session.segmentId,
            "isPaused" to session.isPaused,
            "segmentElapsedMs" to framesToMs(session.segmentFrames),
        )
        if (reason != null) map["reason"] = reason
        return map
    }

    /** Audio of the whole note so far, for the notification chronometer. */
    fun totalElapsedMs(): Long = synchronized(lock) {
        session?.let { it.priorElapsedMs + framesToMs(it.sessionFrames) } ?: 0L
    }

    fun setSyncActive(context: Context, active: Boolean) {
        isSyncActive = active
        NoteRecorderService.update(context)
    }

    /** Pause/resume from the notification; Dart hears about it afterwards. */
    fun toggleFromNotification(context: Context) {
        try {
            if (isRecordingPaused) resume(context) else pause(context)
        } catch (e: Exception) {
            Log.w(TAG, "Toggle from notification failed", e)
        }
        state("user")?.let { onStateChanged?.invoke(it) }
    }

    private fun framesToMs(frames: Long): Long = frames * SAMPLES_PER_FRAME * 1000 / SAMPLE_RATE

    private fun createEncoder(): MediaCodec {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, SAMPLES_PER_FRAME * 2 * 4)
        }
        return MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
            configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            start()
        }
    }

    private fun adtsHeader(frameLength: Int): ByteArray {
        val length = frameLength + 7
        val profile = 1 // AAC LC (object type 2) - 1
        val rateIndex = 8 // 16 kHz
        val channels = 1
        return byteArrayOf(
            0xFF.toByte(),
            0xF1.toByte(),
            ((profile shl 6) or (rateIndex shl 2) or (channels shr 2)).toByte(),
            (((channels and 3) shl 6) or (length shr 11)).toByte(),
            ((length shr 3) and 0xFF).toByte(),
            (((length and 7) shl 5) or 0x1F).toByte(),
            0xFC.toByte(),
        )
    }

    /** Capture thread: PCM → encoder → ADTS frames, with rollover and limits. */
    private fun capture(context: Context, session: Session, record: AudioRecord, codec: MediaCodec) {
        val pcm = ByteArray(SAMPLES_PER_FRAME * 2)
        val info = MediaCodec.BufferInfo()
        var presentationUs = 0L
        var isRecordActive = true
        var endReason: String? = null

        fun emit(reason: String) {
            val event = synchronized(lock) { stateMap(session, reason) }
            mainHandler.post {
                NoteRecorderService.update(context)
                onStateChanged?.invoke(event)
            }
        }

        /** Writes every encoded frame that is ready; returns false on a write error. */
        fun drain(): Boolean {
            while (true) {
                val index = codec.dequeueOutputBuffer(info, 0)
                if (index < 0) return true
                val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                if (!isConfig && info.size > 0) {
                    val frame = ByteArray(info.size)
                    codec.getOutputBuffer(index)!!.apply {
                        position(info.offset)
                        get(frame)
                    }
                    try {
                        // One write per frame, so a failure never leaves a
                        // header without its payload ahead of later frames.
                        session.output.write(adtsHeader(frame.size) + frame)
                    } catch (e: IOException) {
                        Log.w(TAG, "Meeting audio write failed", e)
                        codec.releaseOutputBuffer(index, false)
                        return false
                    }
                    val event = synchronized(lock) {
                        session.segmentFrames++
                        session.sessionFrames++
                        session.segmentBytes += frame.size + 7
                        when {
                            session.priorElapsedMs + framesToMs(session.sessionFrames) >= session.maxNoteMs -> {
                                session.isPaused = true
                                "limit"
                            }
                            framesToMs(session.segmentFrames) >= session.maxSegmentMs ||
                                session.segmentBytes >= session.maxSegmentBytes -> "rollover"
                            else -> null
                        }
                    }
                    if (event == "rollover" && !rollOver(session)) return false
                    if (event != null) emit(event)
                }
                codec.releaseOutputBuffer(index, false)
            }
        }

        try {
            while (true) {
                val (isStopping, isPaused) = synchronized(lock) {
                    while (session.isPaused && !session.isStopping) {
                        if (isRecordActive) break
                        lock.wait()
                    }
                    session.isStopping to session.isPaused
                }
                if (isStopping) break
                if (isPaused && isRecordActive) {
                    record.stop()
                    isRecordActive = false
                    continue
                }
                if (!isPaused && !isRecordActive) {
                    record.startRecording()
                    isRecordActive = true
                }

                val read = record.read(pcm, 0, pcm.size)
                if (read < 0) {
                    Log.w(TAG, "AudioRecord read failed: $read")
                    endReason = "error"
                    break
                }
                if (read == 0) continue
                // Never drop captured PCM: wait for an input buffer, draining
                // output (which is what frees input buffers) meanwhile.
                var input = codec.dequeueInputBuffer(10_000)
                while (input < 0) {
                    if (!drain() || synchronized(lock) { session.isStopping }) break
                    input = codec.dequeueInputBuffer(10_000)
                }
                if (input < 0 && synchronized(lock) { session.isStopping }) break
                if (input < 0) {
                    endReason = "write_failed"
                    break
                }
                codec.getInputBuffer(input)!!.apply {
                    clear()
                    put(pcm, 0, read)
                }
                codec.queueInputBuffer(input, 0, read, presentationUs, 0)
                presentationUs += read / 2 * 1_000_000L / SAMPLE_RATE
                if (!drain()) {
                    endReason = "write_failed"
                    break
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Meeting capture failed", e)
            endReason = "error"
        } finally {
            if (endReason == null) flushEncoder(codec, info) { drain() }
            try {
                if (isRecordActive) record.stop()
            } catch (_: Exception) {}
            record.release()
            codec.release()
            try {
                session.output.close()
            } catch (_: IOException) {}
        }

        if (endReason != null) {
            val event = synchronized(lock) {
                session.isPaused = true
                val map = stateMap(session, endReason)
                if (this.session === session) this.session = null
                map
            }
            mainHandler.post {
                NoteRecorderService.update(context)
                onStateChanged?.invoke(event)
            }
        }
    }

    /** Sends end-of-stream so the last buffered audio reaches the file. */
    private fun flushEncoder(codec: MediaCodec, info: MediaCodec.BufferInfo, drain: () -> Boolean) {
        try {
            val input = codec.dequeueInputBuffer(10_000)
            if (input >= 0) codec.queueInputBuffer(input, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            val deadline = System.currentTimeMillis() + 500
            while (System.currentTimeMillis() < deadline && (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) == 0) {
                if (!drain()) return
                Thread.sleep(5)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Encoder flush failed", e)
        }
    }

    /** Switches to a new segment file between two frames. */
    private fun rollOver(session: Session): Boolean {
        val nextId = UUID.randomUUID().toString()
        val next = try {
            FileOutputStream(File(session.directory, "$nextId.aac"))
        } catch (e: IOException) {
            Log.w(TAG, "Could not open the next segment", e)
            return false
        }
        try {
            session.output.close()
        } catch (_: IOException) {}
        synchronized(lock) {
            session.output = next
            session.segmentId = nextId
            session.segmentFrames = 0
            session.segmentBytes = 0
        }
        return true
    }

    class LowStorageException : Exception("Not enough free storage to record")
}

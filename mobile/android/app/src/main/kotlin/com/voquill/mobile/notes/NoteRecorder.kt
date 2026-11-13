package com.voquill.mobile.notes

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.util.Log

/**
 * Records a meeting note segment as ADTS AAC (16 kHz mono). ADTS frames are
 * self-contained, so the file stays usable up to the last frame when the
 * process is killed. Lives as a process singleton so [NoteRecorderService]
 * (notification actions), [NoteRecorderChannel] (Dart) and the keyboard can
 * all see the same session. Only touched from the main thread.
 */
object NoteRecorder {
    private const val TAG = "NoteRecorder"

    /** Notified when the recorder changes state without a Dart call. */
    var onStateChanged: ((Map<String, Any>) -> Unit)? = null

    private var recorder: MediaRecorder? = null
    private var noteId: String? = null
    private var segmentId: String? = null
    private var isPaused = false
    private var priorElapsedMs = 0L
    private var accumulatedMs = 0L
    private var runStartedAt = 0L

    var isSyncActive = false
        private set

    val isActive: Boolean get() = noteId != null
    val isCapturing: Boolean get() = isActive && !isPaused
    val activeNoteId: String? get() = noteId
    val isRecordingPaused: Boolean get() = isPaused

    fun start(context: Context, noteId: String, segmentId: String, path: String, priorElapsedMs: Long) {
        check(this.noteId == null) { "A meeting is already recording" }
        val recorder = createMediaRecorder(context).apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(16000)
            setAudioChannels(1)
            setAudioEncodingBitRate(32000)
            setOutputFile(path)
            setOnErrorListener { _, what, extra -> handleRecorderError(context, what, extra) }
        }
        try {
            recorder.prepare()
            recorder.start()
        } catch (e: Exception) {
            recorder.release()
            throw e
        }
        this.recorder = recorder
        this.noteId = noteId
        this.segmentId = segmentId
        this.priorElapsedMs = priorElapsedMs
        accumulatedMs = 0
        runStartedAt = SystemClock.elapsedRealtime()
        isPaused = false
        NoteRecorderService.update(context)
    }

    fun pause(context: Context): Map<String, Any>? {
        val recorder = recorder ?: return state()
        if (!isPaused) {
            recorder.pause()
            accumulatedMs += SystemClock.elapsedRealtime() - runStartedAt
            isPaused = true
            NoteRecorderService.update(context)
        }
        return state()
    }

    fun resume(context: Context): Map<String, Any>? {
        val recorder = recorder ?: return null
        if (isPaused) {
            recorder.resume()
            runStartedAt = SystemClock.elapsedRealtime()
            isPaused = false
            NoteRecorderService.update(context)
        }
        return state()
    }

    fun stop(context: Context): Map<String, Any>? {
        val final = state()
        release()
        NoteRecorderService.update(context)
        return final
    }

    fun state(): Map<String, Any>? {
        val noteId = noteId ?: return null
        val segmentId = segmentId ?: return null
        return mapOf(
            "noteId" to noteId,
            "segmentId" to segmentId,
            "isPaused" to isPaused,
            "segmentElapsedMs" to segmentElapsedMs(),
        )
    }

    /** Audio of the whole note so far, for the notification chronometer. */
    fun totalElapsedMs(): Long = priorElapsedMs + segmentElapsedMs()

    fun setSyncActive(context: Context, active: Boolean) {
        isSyncActive = active
        NoteRecorderService.update(context)
    }

    /** Pause/resume from the notification; Dart hears about it afterwards. */
    fun toggleFromNotification(context: Context) {
        if (isPaused) {
            try {
                resume(context)
            } catch (e: Exception) {
                Log.w(TAG, "Resume from notification failed", e)
            }
        } else {
            pause(context)
        }
        state()?.let { onStateChanged?.invoke(it) }
    }

    private fun segmentElapsedMs(): Long =
        accumulatedMs + if (isPaused || recorder == null) 0 else SystemClock.elapsedRealtime() - runStartedAt

    /** The file stays valid up to the failure; Dart sees the note paused and
     *  starts a new segment on resume. */
    private fun handleRecorderError(context: Context, what: Int, extra: Int) {
        Log.w(TAG, "MediaRecorder error $what/$extra")
        if (!isPaused) accumulatedMs += SystemClock.elapsedRealtime() - runStartedAt
        isPaused = true
        val final = state()
        release()
        NoteRecorderService.update(context)
        final?.let { onStateChanged?.invoke(it) }
    }

    private fun release() {
        try {
            recorder?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "MediaRecorder stop failed", e)
        }
        recorder?.release()
        recorder = null
        noteId = null
        segmentId = null
        isPaused = false
        accumulatedMs = 0
    }

    @Suppress("DEPRECATION")
    private fun createMediaRecorder(context: Context): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
}

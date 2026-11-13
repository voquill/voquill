package com.voquill.mobile.notes

import android.content.Context
import android.content.Intent
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/** `com.voquill.mobile/note_recorder`: the Dart `NoteRecorder` bridge. */
class NoteRecorderChannel(messenger: BinaryMessenger, context: Context) {
    private val context = context.applicationContext
    private val channel = MethodChannel(messenger, "com.voquill.mobile/note_recorder")

    init {
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    val noteId = call.argument<String>("noteId")
                    val segmentId = call.argument<String>("segmentId")
                    val path = call.argument<String>("path")
                    val prior = call.argument<Number>("priorElapsedMs")?.toLong() ?: 0L
                    if (noteId == null || segmentId == null || path == null) {
                        result.error("INVALID_ARGS", null, null)
                        return@setMethodCallHandler
                    }
                    try {
                        NoteRecorder.start(this.context, noteId, segmentId, path, prior)
                        result.success(null)
                    } catch (e: Exception) {
                        result.error("START_FAILED", e.message, null)
                    }
                }
                "pause" -> result.success(NoteRecorder.pause(this.context))
                "resume" -> try {
                    result.success(NoteRecorder.resume(this.context))
                } catch (e: Exception) {
                    result.error("RESUME_FAILED", e.message, null)
                }
                "stop" -> result.success(NoteRecorder.stop(this.context))
                "getState" -> result.success(NoteRecorder.state())
                "takePendingAction" -> {
                    result.success(pendingAction)
                    pendingAction = null
                }
                "setSyncActive" -> {
                    NoteRecorder.setSyncActive(this.context, call.argument<Boolean>("isActive") == true)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        NoteRecorder.onStateChanged = { state -> channel.invokeMethod("onStateChanged", state) }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        NoteRecorder.onStateChanged = null
    }

    /** Forwards a notification tap; kept for Dart if it is not listening yet. */
    fun handleIntent(intent: Intent?) {
        val action = when (intent?.action) {
            ACTION_OPEN -> "open"
            ACTION_STOP -> "stop"
            else -> return
        }
        val noteId = intent.getStringExtra(EXTRA_NOTE_ID) ?: return
        intent.action = null
        val payload = mapOf("action" to action, "noteId" to noteId)
        channel.invokeMethod("onAction", payload, object : MethodChannel.Result {
            override fun success(result: Any?) {}
            override fun error(code: String, message: String?, details: Any?) {
                pendingAction = payload
            }
            override fun notImplemented() {
                pendingAction = payload
            }
        })
    }

    companion object {
        const val ACTION_OPEN = "com.voquill.mobile.notes.OPEN"
        const val ACTION_STOP = "com.voquill.mobile.notes.STOP"
        const val EXTRA_NOTE_ID = "noteId"

        private var pendingAction: Map<String, String>? = null
    }
}

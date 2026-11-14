package com.voquill.mobile.notes

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.voquill.mobile.MainActivity
import com.voquill.mobile.R

/**
 * Foreground service that keeps the process (and microphone access) alive
 * while a meeting records with the screen locked or the app in the
 * background, and while finished meetings upload. Shows the ongoing
 * "Taking notes" notification with elapsed time and Pause/Resume/Stop.
 */
class NoteRecorderService : Service() {
    private var foregroundType = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Always reach the foreground first: a service started with
        // startForegroundService must call startForeground even when it is
        // about to stop, or the app crashes.
        try {
            startInForeground()
        } catch (e: Exception) {
            // Android 15 refuses data sync once its daily allowance is used
            // up (and 14+ refuses some types from the background).
            Log.w(TAG, "Could not enter the foreground", e)
            if (!NoteRecorder.isActive) {
                NoteRecorder.clearSyncActive()
                stopSelf()
                return START_NOT_STICKY
            }
        }
        isRunning = true
        if (intent?.action == ACTION_TOGGLE_PAUSE) NoteRecorder.toggleFromNotification(this)
        if (!NoteRecorder.isActive && !NoteRecorder.isSyncActive) stopSelfCompat()
        return START_NOT_STICKY
    }

    /** Android 15 caps data-sync services at 6 hours a day. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        NoteRecorder.setSyncActive(this, false)
        if (!NoteRecorder.isActive) stopSelfCompat()
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    private fun startInForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // When stopping, keep the current type: switching to microphone
            // from the background is not allowed on Android 14+.
            val type = when {
                NoteRecorder.isActive -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                NoteRecorder.isSyncActive -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                foregroundType != 0 -> foregroundType
                else -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
            startForeground(NOTIFICATION_ID, notification, type)
            foregroundType = type
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopSelfCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        isRunning = false
        stopSelf()
    }

    private fun buildNotification(): Notification {
        ensureChannel(this)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(R.drawable.ic_mic)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)

        val noteId = NoteRecorder.activeNoteId
        if (noteId == null) {
            return builder
                .setContentTitle("Uploading your meeting")
                .setContentText("Voquill is sending your recording for notes.")
                .setProgress(0, 0, true)
                .build()
        }

        builder.setContentIntent(activityIntent(this, NoteRecorderChannel.ACTION_OPEN, noteId))
        val elapsedMs = NoteRecorder.totalElapsedMs()
        if (NoteRecorder.isRecordingPaused) {
            builder
                .setContentTitle("Notes paused")
                .setContentText("Paused at ${formatElapsed(elapsedMs)} · tap to return")
                .setUsesChronometer(false)
        } else {
            builder
                .setContentTitle("Taking notes")
                .setContentText("Recording your meeting")
                .setUsesChronometer(true)
                .setWhen(System.currentTimeMillis() - elapsedMs)
                .setShowWhen(true)
        }
        val toggle = PendingIntent.getService(
            this,
            REQUEST_TOGGLE,
            Intent(this, NoteRecorderService::class.java).setAction(ACTION_TOGGLE_PAUSE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        @Suppress("DEPRECATION")
        builder.addAction(
            Notification.Action.Builder(
                0,
                if (NoteRecorder.isRecordingPaused) "Resume" else "Pause",
                toggle,
            ).build(),
        )
        @Suppress("DEPRECATION")
        builder.addAction(
            Notification.Action.Builder(
                0,
                "Stop",
                activityIntent(this, NoteRecorderChannel.ACTION_STOP, noteId),
            ).build(),
        )
        return builder.build()
    }

    companion object {
        private const val TAG = "NoteRecorderService"
        private const val CHANNEL_ID = "notes_recording"
        private const val NOTIFICATION_ID = 4107
        private const val REQUEST_TOGGLE = 1
        private const val ACTION_TOGGLE_PAUSE = "com.voquill.mobile.notes.TOGGLE_PAUSE"

        /** True from the first startForeground until the service stops. */
        @Volatile
        private var isRunning = false

        /**
         * Starts or refreshes the service to match [NoteRecorder]. It is never
         * stopped from outside: once nothing is active, the refresh intent
         * makes it stop itself after reaching the foreground.
         */
        fun update(context: Context) {
            val shouldRun = NoteRecorder.isActive || NoteRecorder.isSyncActive
            if (!shouldRun && !isRunning) return
            val intent = Intent(context, NoteRecorderService::class.java)
            try {
                if (isRunning) {
                    context.startService(intent)
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                // Android 12+ refuses to start foreground services from the
                // background; a sync started there simply runs unprotected.
                Log.w(TAG, "Could not update the notes service", e)
            }
        }

        private fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Meeting notes", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while Voquill records or uploads a meeting"
                    setShowBadge(false)
                },
            )
        }

        private fun activityIntent(context: Context, action: String, noteId: String): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setAction(action)
                .putExtra(NoteRecorderChannel.EXTRA_NOTE_ID, noteId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(
                context,
                action.hashCode(),
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        private fun formatElapsed(ms: Long): String {
            val total = ms / 1000
            val h = total / 3600
            val m = (total % 3600) / 60
            val s = total % 60
            return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
        }
    }
}

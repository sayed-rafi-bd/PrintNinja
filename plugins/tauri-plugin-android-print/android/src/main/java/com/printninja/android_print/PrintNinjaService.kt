package com.printninja.android_print

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
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that keeps the print queue and the local API
 * server alive after the app is swiped away. Android kills background
 * work aggressively (Doze, app standby); a foreground service with a
 * persistent notification is the sanctioned way to stay alive, and the
 * user stops it explicitly from the notification itself.
 *
 * Lifetime: started from MainActivity.onCreate (see
 * scripts/patch-android-service.mjs) and from the plugin's load(), so
 * the queue survives before any command runs. Stopped only from the
 * notification action or the plugin's stopBackgroundService command.
 */
class PrintNinjaService : Service() {

    override fun onCreate() {
        super.onCreate()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithNotification()
        // If the system kills us (memory pressure), restart: the queue
        // rows persist in SQLite, so printing resumes where it stopped.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        ensureChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Print queue",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Keeps the print queue running in the background."
                    setShowBadge(false)
                },
            )
        }
    }

    private fun buildNotification(): Notification {
        val openApp = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(
                this, REQUEST_OPEN, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val stop = PendingIntent.getService(
            this, REQUEST_STOP,
            Intent(this, PrintNinjaService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PrintNinja print service is running")
            .setContentText("The print queue stays available in the background.")
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(openApp)
            .addAction(0, "Stop", stop)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "printninja-print-service"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.printninja.android_print.STOP_SERVICE"
        private const val REQUEST_OPEN = 1
        private const val REQUEST_STOP = 2

        @Volatile
        var isRunning: Boolean = false
            private set

        /** Idempotent: starting twice keeps one service. */
        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context.applicationContext, PrintNinjaService::class.java),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context.applicationContext, PrintNinjaService::class.java))
        }
    }
}

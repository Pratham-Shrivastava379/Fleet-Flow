package com.fleetflow.fleet.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.fleetflow.fleet.MainActivity
import com.fleetflow.fleet.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * FCM push receipt.
 *
 * - onNewToken: a refreshed registration token is uploaded to the backend
 *   (POST /api/users/me/device-tokens) so fleet alerts keep reaching this
 *   device — best-effort, logged-out no-op, FCM-unconfigured safe (§5.6
 *   stub-until-configured stance: no google-services.json => no FirebaseApp =>
 *   this service simply never receives anything, and every Firebase call below
 *   is failure-guarded).
 * - onMessageReceived: the backend sends `notification` messages (title/body)
 *   with `data` (alertId/type/status/lat/lng). Foreground delivery is NOT
 *   auto-displayed by the system, so we post it ourselves on the shared
 *   "FleetFlow alerts" channel (background notification-messages are handled
 *   by the system tray using that same channel — created eagerly in FleetApp).
 *
 * Background/foreground both land in MainActivity on tap; the in-app
 * banner/triage surface is the dashboard's job (drivers read their own alerts
 * in-app, §3.1), so a system notification that opens the app is the right
 * mobile UX for driver-facing alerts.
 */
class FcmMessagingService : FirebaseMessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        scope.launch { PushTokenSync.uploadToken(applicationContext, token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        val title = message.notification?.title ?: data["title"] ?: DEFAULT_TITLE
        val body = message.notification?.body
            ?: data["body"]
            ?: data["detail"]
            ?: "New FleetFlow alert"
        showNotification(title, body)
    }

    private fun showNotification(title: String, body: String) {
        createChannel(this)
        // POST_NOTIFICATIONS runtime permission (API 33+): without it the system
        // silently drops the notification — respect the user's choice instead.
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tracking)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIF_ID, notification)
    }

    companion object {
        /** Also declared as the FCM default channel in the manifest. */
        const val CHANNEL_ID = "fleetflow_alerts"
        private const val NOTIF_ID = 7
        private const val DEFAULT_TITLE = "FleetFlow"

        /** Idempotent; called eagerly from FleetApp so BACKGROUND notification
         *  messages (displayed by the system, not this service) have a channel. */
        fun createChannel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "FleetFlow alerts", NotificationManager.IMPORTANCE_HIGH),
            )
        }
    }
}

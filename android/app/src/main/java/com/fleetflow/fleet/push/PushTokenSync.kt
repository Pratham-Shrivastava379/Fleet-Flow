package com.fleetflow.fleet.push

import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import com.fleetflow.fleet.data.ApiService
import com.fleetflow.fleet.data.DeviceTokenBody
import com.fleetflow.fleet.db.TokenStore
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Graph accessor for Hilt-hostile entry points (FCM service/application paths). */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface PushGraph {
    fun apiService(): ApiService
    fun tokenStore(): TokenStore
}

/**
 * Best-effort FCM registration-token sync (blueprint §10 / Phase-7 Android half
 * — device-token upload to POST /api/users/me/device-tokens).
 *
 * Fire-and-forget and STRICTLY fail-open: FCM is stub-until-configured on
 * Android exactly as on the backend. Without google-services resources
 * FirebaseApp is never initialized and `FirebaseMessaging.getInstance()` throws
 * IllegalStateException — every call here no-ops inside runCatching (no crash,
 * no network). A configured build uploads the token after login and on refresh
 * (FcmMessagingService.onNewToken) so the notifications queue (§10.2) reaches
 * this device; logout unregisters it before the local tokens are cleared.
 */
object PushTokenSync {

    private fun graph(context: Context): PushGraph =
        EntryPointAccessors.fromApplication(context.applicationContext, PushGraph::class.java)

    /** Upload the current FCM token (login hook). No-op unless authed + FCM configured. */
    suspend fun uploadCurrentToken(context: Context): Boolean = withContext(Dispatchers.IO) {
        val g = graph(context)
        if (g.tokenStore().accessToken == null) return@withContext false
        val token = currentFcmToken() ?: return@withContext false
        runCatching { g.apiService().registerDeviceToken(DeviceTokenBody(token)); true }.getOrDefault(false)
    }

    /** Upload a freshly-refreshed token (FcmMessagingService.onNewToken). */
    suspend fun uploadToken(context: Context, token: String): Boolean = withContext(Dispatchers.IO) {
        val g = graph(context)
        if (g.tokenStore().accessToken == null || token.isBlank()) return@withContext false
        runCatching { g.apiService().registerDeviceToken(DeviceTokenBody(token)); true }.getOrDefault(false)
    }

    /** Delete this device's registration (logout) — call BEFORE clearing local tokens. */
    suspend fun unregisterCurrentToken(context: Context): Boolean = withContext(Dispatchers.IO) {
        val g = graph(context)
        if (g.tokenStore().accessToken == null) return@withContext false
        val token = currentFcmToken() ?: return@withContext false
        runCatching { g.apiService().unregisterDeviceToken(token); true }.getOrDefault(false)
    }

    private fun currentFcmToken(): String? = runCatching {
        Tasks.await(FirebaseMessaging.getInstance().token).takeIf { it.isNotBlank() }
    }.getOrNull()
}

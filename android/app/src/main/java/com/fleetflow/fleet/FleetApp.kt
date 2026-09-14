package com.fleetflow.fleet

import android.app.Application
import com.fleetflow.fleet.push.FcmMessagingService
import dagger.hilt.android.HiltAndroidApp
import io.sentry.android.core.SentryAndroid

/** Application entry point. Phase 8: Hilt replaces the manual ServiceLocator (§3.2). */
@HiltAndroidApp
class FleetApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Phase 13: Sentry crash/ANR error
        // reporting. Stub-until-configured like the other providers (FCM/SMS):
        // the DSN is injected at build time from local.properties SENTRY_DSN
        // (release builds via CI secret — never committed), and a blank DSN
        // means Sentry is never initialized: no network, no behavior change.
        // This is the ONLY Sentry init point: the SDK's auto-init ContentProvider
        // (SentryInitProvider) is disabled via <meta-data android:name=
        // "io.sentry.auto-init" android:value="false"/> in AndroidManifest.xml —
        // otherwise it runs before Application.onCreate and crashes with
        // "DSN is required" whenever no DSN is configured.
        if (BuildConfig.SENTRY_DSN.isNotBlank()) {
            SentryAndroid.init(this) { options ->
                options.dsn = BuildConfig.SENTRY_DSN
                options.tracesSampleRate = 0.25
            }
        }
        // Phase-7 Android half (§10): the alert-notification channel must exist
        // before a BACKGROUND FCM notification-message (displayed by the system
        // tray) arrives — an undeclared channel silently drops it on API 26+.
        // Harmless when FCM is unconfigured (no messages can arrive anyway).
        FcmMessagingService.createChannel(this)
    }
}

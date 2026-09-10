package com.fleetflow.fleet

import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Startup-crash regression guard: the Sentry SDK ships a SentryInitProvider
 * that Android instantiates before Application.onCreate. Unless the manifest
 * disables automatic initialization, a blank build-time DSN can terminate the
 * process before the UI appears. FleetApp.onCreate is the single, DSN-gated
 * initialization point, so the merged manifest must keep auto-init disabled.
 */
@RunWith(AndroidJUnit4::class)
class SentryAutoInitTest {

    @Test
    fun sentryAutoInitIsDisabledInMergedManifest() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val metaData = context.packageManager
            .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
            .metaData
        val autoInit = metaData?.getBoolean("io.sentry.auto-init", true) ?: true
        assertFalse(
            "Sentry auto-init must be disabled — FleetApp is the single, DSN-gated init point",
            autoInit,
        )
    }
}

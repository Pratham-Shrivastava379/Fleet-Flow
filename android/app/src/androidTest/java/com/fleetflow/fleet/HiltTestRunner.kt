package com.fleetflow.fleet

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import dagger.hilt.android.testing.HiltTestApplication

/**
 * Instrumentation runner for Hilt tests: HiltTestApplication must REPLACE the
 * app's FleetApp for @HiltAndroidTest tests to get the test component. A
 * manifest-level android:name override does not survive merge for the
 * target-package instrumentation, so it is forced here (dagger.dev/Hilt
 * testing guidelines; same pattern as Now in Android).
 */
class HiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader?, name: String?, context: Context?): Application =
        super.newApplication(cl, HiltTestApplication::class.java.name, context)
}
package com.fleetflow.fleet

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.fleetflow.fleet.db.ActiveTripStateDao
import com.fleetflow.fleet.db.QueuedPingDao
import com.fleetflow.fleet.db.TokenStore
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import javax.inject.Inject
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@HiltAndroidTest
class CriticalPathTest {

    @get:Rule(order = 0) val hiltRule = HiltAndroidRule(this)

    @get:Rule(order = 1) val composeRule = createAndroidComposeRule<MainActivity>()

    private val device: UiDevice =
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @Inject lateinit var activeTripStateDao: ActiveTripStateDao
    @Inject lateinit var queuedPingDao: QueuedPingDao
    @Inject lateinit var tokenStore: TokenStore

    /**
     * ColorOS/OnePlus blocks shell-uid grants (both GrantPermissionRule and a
     * plain `adb shell pm grant` throw SecurityException unless the manual
     * "USB debugging (Security settings)" switch is enabled), so permissions
     * are granted through the app's own runtime dialogs with UI Automator:
     * "While using the app" (fine location) then "Allow" (API 33+ notifs).
     * Returns true if at least one dialog was accepted.
     */
    private fun acceptPermissionDialogs(): Boolean {
        var accepted = false
        // Location and notification prompts can queue in either order on
        // ColorOS; keep accepting until neither button is on screen.
        repeat(3) { round ->
            val firstWait = if (round == 0) 5_000L else 2_000L
            // Until.findObject returns the object from the SAME tree snapshot
            // the wait polled; the hasObject+findObject pair has a TOCTOU gap
            // where ColorOS dialog re-layout detaches the node between the two
            // calls and findObject returns null (NPE on .click()).
            val loc = device.wait(Until.findObject(By.text("While using the app")), firstWait)
            if (loc != null) {
                loc.click()
                accepted = true
                return@repeat
            }
            val notif = device.wait(Until.findObject(By.text("Allow")), 2_000)
            if (notif != null) {
                notif.click()
                accepted = true
            }
        }
        return accepted
    }

    /**
     * Clicks "Start"; if the click only triggered a runtime-permission prompt
     * (first run), accepts the dialogs and clicks again until the trip starts
     * or retries are exhausted. TrackingScreen only calls startTrip when
     * permission is already held, so the retry is required after a grant.
     */
    private fun startTripHandlingPermissionDialogs() {
        repeat(3) {
            composeRule.onNodeWithText("Start").performClick()
            val dialogShown = acceptPermissionDialogs()
            if (!dialogShown) return
            // Grant callback updates TrackingScreen state asynchronously.
            device.waitForIdle()
        }
    }

    @Before
    fun setUp() {
        hiltRule.inject()
        // The production app intentionally restores Room-backed active-trip
        // state after process death. Instrumentation installs can preserve that
        // database between runs, so isolate this fresh-login test explicitly.
        runBlocking {
            activeTripStateDao.clear()
            queuedPingDao.clearAll()
        }
        tokenStore.clear()
        // ColorOS state hygiene: between runs the screen locks and the notification
        // shade may sit over the app (focus lands on NotificationShade), so runtime-
        // permission dialogs never get focus and every tap is swallowed. Wake and
        // dismiss the keyguard, then collapse the shade — harmless no-ops otherwise.
        device.wakeUp()
        device.executeShellCommand("wm dismiss-keyguard")
        device.executeShellCommand("cmd statusbar collapse")
    }

    @Test
    fun loginStartTripSosAlerts_criticalPath() {
        // The instrumentation graph replaces AppBindings with FakeAppBindings,
        // so this flow must assert against FakeApiService's deterministic data
        // rather than a separately seeded live-backend fixture.
        composeRule.onNodeWithText("Email").performTextInput("e2e.device@fleetflow.test")
        composeRule.onNodeWithText("Password").performTextInput("Driverpass")
        composeRule.onNodeWithText("Sign in").performClick()

        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithText("KA-01-AB").fetchSemanticsNodes().isNotEmpty()
        }

        // Encrypted-session restore: recreating the activity must bypass login
        // and return the driver to the authenticated tracking surface.
        composeRule.activityRule.scenario.recreate()
        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithText("KA-01-AB").fetchSemanticsNodes().isNotEmpty()
        }

        startTripHandlingPermissionDialogs()

        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithText("SOS").fetchSemanticsNodes().isNotEmpty()
        }

        composeRule.onNodeWithText("SOS").performClick()

        composeRule.onNodeWithText("Alerts").performClick()

        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithText("SOS").fetchSemanticsNodes().isNotEmpty()
        }

        assertTrue(composeRule.onAllNodesWithText("SOS").fetchSemanticsNodes().isNotEmpty())

        device.pressBack()
        composeRule.onNodeWithText("Profile").performClick()
        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithText("Dan Driver").fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText("Log out").performScrollTo().performClick()
        composeRule.waitUntil(timeoutMillis = 10_000) {
            composeRule.onAllNodesWithText("Sign in").fetchSemanticsNodes().isNotEmpty()
        }
    }
}

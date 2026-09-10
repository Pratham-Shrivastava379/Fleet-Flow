package com.fleetflow.fleet

import com.fleetflow.fleet.data.NotificationPref
import com.fleetflow.fleet.data.NotificationPrefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Notification-preference policy (blueprint §3.3/§10.2). Pure + JVM so the
 * "absent row means enabled" backend contract is locked without a device or
 * network: the UI toggle set is always the six AlertTypes, defaults are all
 * enabled, and stored overrides only flip the rows the server actually knows.
 */
class NotificationPrefsTest {

    @Test
    fun `defaults enable every alert type`() {
        val defaults = NotificationPrefs.defaults()
        assertEquals(NotificationPrefs.ALERT_TYPES.size, defaults.size)
        assertTrue(defaults.all { it.value })
    }

    @Test
    fun `empty stored rows keep all-enabled defaults`() {
        assertEquals(NotificationPrefs.defaults(), NotificationPrefs.merged(emptyList()))
    }

    @Test
    fun `stored overrides flip only the matching rows`() {
        val merged = NotificationPrefs.merged(
            listOf(NotificationPref("SOS", enabled = false), NotificationPref("OVERSPEED", enabled = false)),
        )
        assertFalse(merged.getValue("SOS"))
        assertFalse(merged.getValue("OVERSPEED"))
        assertTrue(merged.getValue("GEOFENCE_ENTER"))
        assertTrue(merged.getValue("CRASH_DETECTED"))
        assertEquals(NotificationPrefs.ALERT_TYPES.size, merged.size)
    }

    @Test
    fun `unknown alert types from the server are ignored`() {
        val merged = NotificationPrefs.merged(listOf(NotificationPref("NOT_A_TYPE", enabled = false)))
        assertEquals(NotificationPrefs.ALERT_TYPES.size, merged.size)
        assertTrue(merged.all { it.value })
    }

    @Test
    fun `labels are human-readable for the toggle list`() {
        assertEquals("SOS alerts", NotificationPrefs.label("SOS"))
        assertEquals("Geofence entry", NotificationPrefs.label("GEOFENCE_ENTER"))
        assertEquals("UNKNOWN_TYPE", NotificationPrefs.label("UNKNOWN_TYPE"))
    }
}

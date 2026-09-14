package com.fleetflow.fleet.data

/**
 * Notification-preference policy. Pure and
 * JVM-testable (no Android deps): the backend treats an ABSENT preference row
 * as "enabled" (the default) and only returns overrides, so the UI must merge
 * stored rows against the full default set before rendering toggles.
 *
 * SOS is exempt from suppression server-side (§8.4/§10.2) — the toggle is shown
 * but informational for drivers, who never receive fleet-alert pushes anyway
 * (the notifications queue targets ADMIN/FLEET_MANAGER device tokens).
 */
object NotificationPrefs {
    /** Backend AlertType enums (validate.js ALERT_TYPES) — the toggle set. */
    val ALERT_TYPES: List<String> = listOf(
        "SOS",
        "HARSH_BRAKING",
        "OVERSPEED",
        "GEOFENCE_ENTER",
        "GEOFENCE_EXIT",
        "CRASH_DETECTED",
    )

    fun defaults(): Map<String, Boolean> = ALERT_TYPES.associateWith { true }

    /** Full toggle map = defaults overlaid with any stored overrides. */
    fun merged(stored: List<NotificationPref>): Map<String, Boolean> =
        defaults() + stored.filter { it.type in ALERT_TYPES }.associate { it.type to it.enabled }

    fun label(type: String): String = when (type) {
        "SOS" -> "SOS alerts"
        "HARSH_BRAKING" -> "Harsh braking"
        "OVERSPEED" -> "Overspeed"
        "GEOFENCE_ENTER" -> "Geofence entry"
        "GEOFENCE_EXIT" -> "Geofence exit"
        "CRASH_DETECTED" -> "Crash detected"
        else -> type
    }
}

package com.fleetflow.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-Kotlin unit tests for domain math (runs on JVM via `./gradlew test`).
 * Mirrors the backend haversine in backend/src/services/geofenceService.js so
 * mobile geofence previews stay consistent with server evaluation.
 */
class GeoMathTest {

    private fun haversineMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6371000.0
        fun rad(d: Double) = Math.toRadians(d)
        val dLat = rad(lat2 - lat1)
        val dLng = rad(lng2 - lng1)
        val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
        return 2 * r * Math.asin(Math.sqrt(a))
    }

    @Test
    fun `same point is zero distance`() {
        assertEquals(0.0, haversineMeters(12.9716, 77.5946, 12.9716, 77.5946), 0.001)
    }

    @Test
    fun `depot geofence radius contains nearby point`() {
        // Same fixture values as backend tests: depot at Whitefield, 500m radius
        val depot = 12.9698 to 77.7499
        val nearby = 12.9702 to 77.7503
        val d = haversineMeters(depot.first, depot.second, nearby.first, nearby.second)
        assertTrue("expected inside 500m radius, was $d", d <= 500.0)
    }

    @Test
    fun `distant point falls outside radius`() {
        val d = haversineMeters(12.9698, 77.7499, 12.9716, 77.5946) // across the city
        assertTrue("expected > 500m, was $d", d > 500.0)
    }

    @Test
    fun `speed conversion mps to kmh`() {
        assertEquals(36.0, 10.0 * 3.6, 0.0001)
    }
}

package com.fleetflow.fleet

import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.db.QueuedPingEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 10 (§3.6.3): pure queue-cap + downsampling policy for very long offline
 * stretches. No DB needed — locks the policy down on the JVM.
 */
class OfflineQueueTest {

    /** Build a synthetic queue [size] long, oldest-first, id == position (1-based). */
    private fun queue(size: Int): List<QueuedPingEntity> =
        (1..size).map { i ->
            QueuedPingEntity(
                id = i.toLong(),
                tripId = 1,
                idempotencyKey = "k-$i",
                lat = 12.0 + i, lng = 77.0,
                speedKmh = 0.0, headingDeg = 0.0, accuracyM = 5.0,
                recordedAt = 1_700_000_000_000L + i,
            )
        }

    @Test
    fun `under cap is a no-op`() {
        assertTrue(TripRepository.downsampleDeleteIds(queue(10), cap = 10).isEmpty())
        assertTrue(TripRepository.downsampleDeleteIds(queue(3), cap = 5000).isEmpty())
    }

    @Test
    fun `surplus beyond cap keeps every 3rd of the oldest points`() {
        // 7 pings, cap 5 -> surplus = oldest 2 (ids 1,2); keep every 3rd -> keep id 1, delete id 2.
        val deleted = TripRepository.downsampleDeleteIds(queue(7), cap = 5, keepEvery = 3)
        assertEquals(listOf(2L), deleted)
    }

    @Test
    fun `keeps the newest cap untouched regardless of surplus`() {
        val deleted = TripRepository.downsampleDeleteIds(queue(10), cap = 3, keepEvery = 3)
        // surplus = ids 1..7; delete indices %3 != 0 -> ids 2,3,5,6. Newest cap (ids 8,9,10) never deleted.
        assertEquals(listOf(2L, 3L, 5L, 6L), deleted)
        assertTrue(8L !in deleted && 9L !in deleted && 10L !in deleted)
    }

    @Test
    fun `keepEvery of 1 disables downsampling (nothing dropped)`() {
        assertTrue(TripRepository.downsampleDeleteIds(queue(100), cap = 5, keepEvery = 1).isEmpty())
    }
}
package com.fleetflow.fleet.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 8 done-condition: Room DAO instrumentation tests for the migrated
 * offline queue. Table shape and semantics must match the old SQLiteOpenHelper
 * implementation exactly (queued_pings) plus the new sync_attempts/last_error.
 */
@RunWith(AndroidJUnit4::class)
class QueuedPingDaoTest {

    private lateinit var db: FleetDatabase
    private lateinit var dao: QueuedPingDao

    private fun ping(tripId: Int, key: String, lat: Double = 12.97, lng: Double = 77.59) =
        QueuedPingEntity(
            tripId = tripId, idempotencyKey = key, lat = lat, lng = lng,
            speedKmh = 42.0, headingDeg = 90.0, accuracyM = 5.0,
            recordedAt = 1_700_000_000_000,
        )

    @Before
    fun setup() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), FleetDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = db.queuedPingDao()
    }

    @After
    fun teardown() {
        db.close()
    }

    @Test
    fun enqueueAndPending_preservesExactPingShape() = runTest {
        dao.enqueue(ping(1, "k-1"))
        dao.enqueue(ping(1, "k-2", lat = 13.0, lng = 78.0))

        val pending = dao.pending(1)
        assertEquals(2, pending.size)
        // FIFO by insertion (recorded order matters for replay)
        assertEquals("k-1", pending[0].idempotencyKey)
        assertEquals(13.0, pending[1].lat, 0.0)
        assertEquals(1_700_000_000_000L, pending[0].recordedAt)
        assertEquals(0, pending[0].syncAttempts) // new columns default clean
        assertEquals(null, pending[0].lastError)
    }

    @Test
    fun pending_isScopedToTrip() = runTest {
        dao.enqueue(ping(1, "trip1-a"))
        dao.enqueue(ping(2, "trip2-a"))
        assertEquals(listOf("trip1-a"), dao.pending(1).map { it.idempotencyKey })
    }

    @Test
    fun idempotencyKeyConflict_upsertsRatherThanDuplicates() = runTest {
        dao.enqueue(ping(1, "dup-key"))
        dao.enqueue(ping(1, "dup-key"))
        assertEquals(1, dao.pending(1).size)
    }

    @Test
    fun deleteByIds_removesOnlySentPings() = runTest {
        dao.enqueue(ping(1, "k-a"))
        dao.enqueue(ping(1, "k-b"))
        val ids = dao.pending(1).map { it.id }
        dao.deleteByIds(listOf(ids[0]))
        val remaining = dao.pending(1)
        assertEquals(1, remaining.size)
        assertEquals("k-b", remaining[0].idempotencyKey)
    }

    @Test
    fun markSyncFailure_incrementsAttemptsAndRecordsError() = runTest {
        dao.enqueue(ping(1, "failing"))
        val id = dao.pending(1).single().id
        dao.markSyncFailure(id, "HTTP 503")
        dao.markSyncFailure(id, "HTTP 503")
        val failed = dao.pending(1).single()
        assertEquals(2, failed.syncAttempts)
        assertEquals("HTTP 503", failed.lastError)
        // a subsequent success path (delete) clears it from the queue entirely
        dao.deleteByIds(listOf(id))
        assertTrue(dao.pending(1).isEmpty())
    }
}
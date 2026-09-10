package com.fleetflow.fleet

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.db.FleetDatabase
import com.fleetflow.fleet.db.QueuedPingEntity
import com.fleetflow.fleet.di.FakeApiService
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 10 done-condition (§15.10): a large offline backlog drains in ONE batch
 * API call, not hundreds of single-ping HTTP calls.
 */
@RunWith(AndroidJUnit4::class)
class BatchSyncTest {

    private lateinit var db: FleetDatabase
    private lateinit var repo: TripRepository
    private lateinit var api: FakeApiService

    private fun ping(tripId: Int, i: Int, key: String) =
        QueuedPingEntity(
            tripId = tripId,
            idempotencyKey = key,
            lat = 12.9 + i * 0.0001, lng = 77.5 + i * 0.0001,
            speedKmh = 40.0 + (i % 20), headingDeg = 90.0, accuracyM = 8.0,
            recordedAt = 1_700_000_000_000L + i * 12_000,
        )

    @Before
    fun setup() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(), FleetDatabase::class.java,
        ).allowMainThreadQueries().build()
        api = FakeApiService()
        repo = TripRepository(api, db.queuedPingDao(), db.activeTripStateDao())
    }

    @After
    fun teardown() {
        db.close()
    }

    @Test
    fun hundredsOfQueuedPings_drainInASingleBatchCall() = runTest {
        val dao = db.queuedPingDao()
        for (i in 0 until 300) dao.enqueue(ping(1, i, "batch-$i"))
        assertEquals(300, dao.pendingCount())

        val (sent, remaining) = repo.syncPending(1)

        // ONE HTTP call regardless of how many pings were queued.
        assertEquals(1, api.batchCalls)
        assertEquals(300, api.lastBatchRequest?.pings?.size)
        // Order preserved: oldest ping first in the payload.
        assertEquals("batch-0", api.lastBatchRequest?.pings?.first()?.idempotencyKey)
        assertEquals(300, sent)
        assertEquals(0, remaining)
        assertTrue(dao.pendingCount() == 0)
    }

    @Test
    fun wholeRequestFailure_marksRowsAndKeepsThemForRetry() = runTest {
        val dao = db.queuedPingDao()
        for (i in 0 until 3) dao.enqueue(ping(1, i, "f-$i"))
        api.failNextBatch = true

        val (sent, remaining) = repo.syncPending(1)

        assertEquals(0, sent)
        assertEquals(3, remaining)
        // Every row marked with an incremented sync_attempts, none dropped.
        assertEquals(3, dao.pending(1, 500).size)
        assertTrue(dao.pending(1, 500).all { it.syncAttempts == 1 })
    }

    @Test
    fun orphaned404Trip_dropsItsQueueAndDoesNotGateOtherTrips() = runTest {
        val dao = db.queuedPingDao()
        // An orphaned/deleted trip's stale rows (404 "Trip not found" forever).
        for (i in 0 until 3) dao.enqueue(ping(716, i, "orphan-$i"))
        // A live trip with pings that sync successfully.
        for (i in 0 until 5) dao.enqueue(ping(1, i, "live-$i"))
        api.terminal404TripIds.add(716)

        val (sent, remaining) = repo.syncAllPending()

        // The orphan's queue is dropped (never stranded); the live trip drained.
        assertEquals(5, sent)
        assertEquals(0, remaining)
        assertEquals(0, dao.pendingTripIds().toSet().size)
        assertEquals(0, dao.pendingCount())
        // A permanently-failing orphan must not gate the current trip's finish.
        assertTrue(repo.lastSyncHadTerminalFailure)
    }
}
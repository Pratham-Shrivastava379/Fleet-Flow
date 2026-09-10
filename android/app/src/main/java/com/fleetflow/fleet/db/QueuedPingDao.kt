package com.fleetflow.fleet.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

/**
 * Typed DAO for the offline ping queue (Phase 8 — replaces FleetDatabase's
 * raw SQL). Same semantics as before: CONFLICT_IGNORE keeps idempotency-key
 * uniqueness, FIFO order by recorded_at, count for UI/sync decisions.
 */
@Dao
interface QueuedPingDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun enqueue(ping: QueuedPingEntity): Long

    @Query(
        "SELECT * FROM queued_pings WHERE tripId = :tripId " +
            "ORDER BY recorded_at ASC LIMIT :limit",
    )
    suspend fun pending(tripId: Int, limit: Int = 100): List<QueuedPingEntity>

    @Query("SELECT COUNT(*) FROM queued_pings")
    suspend fun pendingCount(): Int

    /** Distinct tripIds that still have queued rows — SyncWorker drains ALL of
     *  them (not just the current trip) so no row becomes stranded. */
    @Query("SELECT DISTINCT tripId FROM queued_pings ORDER BY tripId ASC")
    suspend fun pendingTripIds(): List<Int>

    /** Drop a trip's whole queue — only used for terminal (409 trip-not-active)
     *  rows that can never succeed; valid data is never discarded silently. */
    @Query("DELETE FROM queued_pings WHERE tripId = :tripId")
    suspend fun deleteByTripId(tripId: Int)

    /** Full queue ordered oldest-first — used by the Phase 10 §3.6 queue-cap
     * downsampler to pick which oldest low-value rows to drop. */
    @Query("SELECT * FROM queued_pings ORDER BY recorded_at ASC")
    suspend fun allAscending(): List<QueuedPingEntity>

    @Query("DELETE FROM queued_pings WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)

    /** Debuggability upgrade (§3.6): record sync failure per ping. */
    @Query(
        "UPDATE queued_pings SET sync_attempts = sync_attempts + 1, last_error = :error WHERE id = :id",
    )
    suspend fun markSyncFailure(id: Long, error: String)

    @Query("SELECT * FROM queued_pings ORDER BY recorded_at ASC")
    fun observeAll(): Flow<List<QueuedPingEntity>>

    @Query("DELETE FROM queued_pings")
    suspend fun clearAll()
}
package com.fleetflow.fleet.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * Persisted local mirror of the driver's active-trip state (fix for the
 * memory-only `activeTripId` blocker): survives process death and app
 * restarts so a backend-ACTIVE trip is never silently orphaned (the app used
 * to forget the trip and start a duplicate one after a restart).
 *
 * Single-row table (id is always [ROW_ID]). [pendingFinish] marks the
 * "finish requested but queued pings not yet synced / network down" state so
 * trip completion can be retried when connectivity returns instead of being
 * lost or falsely shown as completed.
 */
@Entity(tableName = "active_trip_state")
data class ActiveTripState(
    @PrimaryKey val id: Int = ROW_ID,
    val tripId: Int,
    val pendingFinish: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis(),
) {
    companion object {
        const val ROW_ID = 1
    }
}

@Dao
interface ActiveTripStateDao {

    @Query("SELECT * FROM active_trip_state WHERE id = ${ActiveTripState.ROW_ID}")
    suspend fun get(): ActiveTripState?

    @Query("SELECT * FROM active_trip_state WHERE id = ${ActiveTripState.ROW_ID}")
    fun observe(): Flow<ActiveTripState?>

    @Upsert
    suspend fun set(state: ActiveTripState)

    @Query(
        "UPDATE active_trip_state SET pendingFinish = :pending, updatedAt = :updatedAt " +
            "WHERE id = ${ActiveTripState.ROW_ID}",
    )
    suspend fun setPendingFinish(pending: Boolean, updatedAt: Long = System.currentTimeMillis())

    @Query("DELETE FROM active_trip_state")
    suspend fun clear()
}

/**
 * Offline queue entry for one location ping. Room entity (Phase 8, §3.6) —
 * table shape is EXACTLY the old SQLiteOpenHelper `queued_pings` schema plus
 * the two new debuggability columns (`sync_attempts`, `last_error`).
 * Deliberately no other tables (trip-history/vehicle/geofence caches are
 * Phase 9 scope, not this phase).
 */
@Entity(
    tableName = "queued_pings",
    indices = [
        // idempotency_key is the offline-queue de-dup key (server treats pings
        // idempotently); UNIQUE makes Room's OnConflictStrategy.IGNORE actually
        // enforce it — on-device QueuedPingDaoTest caught the missing index
        // (two rows survived a duplicate enqueue) during Phase 9.
        Index(value = ["idempotency_key"], unique = true, name = "index_queued_pings_idempotencyKey"),
        Index(value = ["tripId", "recorded_at"], name = "index_queued_pings_tripId_recordedAt"),
    ],
)
data class QueuedPingEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val tripId: Int,
    @ColumnInfo(name = "idempotency_key") val idempotencyKey: String,
    val lat: Double,
    val lng: Double,
    @ColumnInfo(name = "speed_kmh") val speedKmh: Double,
    @ColumnInfo(name = "heading_deg") val headingDeg: Double,
    @ColumnInfo(name = "accuracy_m") val accuracyM: Double,
    @ColumnInfo(name = "recorded_at") val recordedAt: Long,
    @ColumnInfo(name = "sync_attempts", defaultValue = "0") val syncAttempts: Int = 0,
    @ColumnInfo(name = "last_error", defaultValue = "") val lastError: String? = null,
)
package com.fleetflow.fleet.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Room database (Phase 8, §3.2/§3.6) — replaces the hand-rolled
 * SQLiteOpenHelper. Scope is deliberately ONLY the offline ping queue;
 * trip-history/vehicle/geofence caches are Phase 9, not this phase.
 *
 * destructiveMigration is a documented dev-stage judgment call (confirmed with
 * the product owner): no production installs exist yet, and the old helper's
 * schema is schema-compatible with v1 — the two new columns have defaults.
 *
 * v3 (offline-sync reliability fix): ADDS the `active_trip_state` single-row
 * table. v2→v3 now has an explicit non-destructive migration so an installed
 * base with queued pings upgrades in place and keeps every queued row — the
 * destructive fallback is kept only as a last-resort safety net for paths with
 * no migration (e.g. a future schema change someone forgets to migrate).
 */
@Database(
    entities = [QueuedPingEntity::class, ActiveTripState::class],
    version = 3,
    exportSchema = true,
)
abstract class FleetDatabase : RoomDatabase() {
    abstract fun queuedPingDao(): QueuedPingDao
    abstract fun activeTripStateDao(): ActiveTripStateDao

    companion object {
        /**
         * v2 → v3: create `active_trip_state` exactly as Room expects it
         * (matches the @Entity shape: PK id, tripId, pendingFinish, updatedAt).
         * Non-destructive: `queued_pings` and its rows are untouched.
         */
        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `active_trip_state` (
                        `id` INTEGER NOT NULL,
                        `tripId` INTEGER NOT NULL,
                        `pendingFinish` INTEGER NOT NULL,
                        `updatedAt` INTEGER NOT NULL,
                        PRIMARY KEY(`id`)
                    )
                    """.trimIndent(),
                )
            }
        }

        fun build(context: Context): FleetDatabase =
            Room.databaseBuilder(context, FleetDatabase::class.java, "fleetflow.db")
                .addMigrations(MIGRATION_2_3)
                .fallbackToDestructiveMigration() // last-resort only — see class doc
                .build()
    }
}

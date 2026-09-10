package com.fleetflow.fleet.data

import com.fleetflow.fleet.db.ActiveTripState
import com.fleetflow.fleet.db.ActiveTripStateDao
import com.fleetflow.fleet.db.QueuedPingDao
import com.fleetflow.fleet.db.QueuedPingEntity
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Trip repository: REST is source of truth, Room (QueuedPingDao, Phase 8) is
 * the offline queue. Pings are ALWAYS enqueued first and drained by SyncWorker —
 * this guarantees no location loss across connectivity drops and gives us
 * idempotency (idempotencyKey) end-to-end. Failed sends now record
 * sync_attempts/last_error per ping (§3.6 debuggability upgrade).
 *
 * Also owns the PERSISTED active-trip state (ActiveTripStateDao): the old
 * memory-only activeTripId was lost on process death/reinstall while the
 * backend trip stayed ACTIVE, so the app then created duplicate trips.
 */
class TripRepository(
    private val api: ApiService,
    private val dao: QueuedPingDao,
    private val activeTripDao: ActiveTripStateDao,
) {
    /** Persisted active-trip mirror; null when no local active trip. */
    suspend fun activeTripState(): ActiveTripState? = withContext(Dispatchers.IO) { activeTripDao.get() }

    /** Local-persist the active trip the moment the backend accepts the start. */
    suspend fun setActiveTrip(tripId: Int) = withContext(Dispatchers.IO) {
        activeTripDao.set(ActiveTripState(tripId = tripId))
    }

    suspend fun setPendingFinish(pending: Boolean) = withContext(Dispatchers.IO) {
        activeTripDao.setPendingFinish(pending)
    }

    suspend fun clearActiveTrip() = withContext(Dispatchers.IO) { activeTripDao.clear() }

    /** True when some trip in the offline queue was abandoned (terminal 409). */
    @Volatile
    var lastSyncHadTerminalFailure: Boolean = false
        private set

    /**
     * Ask the backend whether the logged-in driver has an ACTIVE trip and
     * reconcile local state with it (fixes ACTIVE-TRIP RECOVERY). Drivers are
     * server-scoped to their own trips, so this is exactly "my active trip".
     * Returns the restored/confirmed tripId, or null when the driver has no
     * ACTIVE trip (any stale local row is then cleared).
     */
    suspend fun reconcileActiveTrip(): ActiveTripState? = withContext(Dispatchers.IO) {
        val local = activeTripDao.get()
        val result = runCatching { api.trips(status = "ACTIVE", page = 1, pageSize = 1) }
        val remote = result.getOrNull()
        if (remote == null) {
            // Network/auth unavailable: keep local state untouched (never wipe
            // a possibly-valid active trip just because we can't ask).
            return@withContext local
        }
        val remoteActive = remote.items.firstOrNull()
        when {
            remoteActive != null -> {
                // Backend says a trip IS active — adopt it (same trip or the
                // one the app forgot after a restart).
                val state = ActiveTripState(
                    tripId = remoteActive.id,
                    pendingFinish = local?.pendingFinish ?: false,
                )
                activeTripDao.set(state)
                state
            }
            else -> {
                // No backend ACTIVE trip: clear stale local state.
                activeTripDao.clear()
                null
            }
        }
    }

    suspend fun loadVehicles(): Result<List<VehicleDto>> = withContext(Dispatchers.IO) {
        runCatching { api.vehicles().items }
    }

    suspend fun createVehicle(plate: String, model: String): Result<VehicleDto> = withContext(Dispatchers.IO) {
        runCatching { api.createVehicle(CreateVehicleRequest(plate, model)) }
    }

    suspend fun updateVehicleStatus(id: Int, status: String): Result<VehicleDto> = withContext(Dispatchers.IO) {
        runCatching { api.updateVehicleStatus(id, VehicleStatusRequest(status)) }
    }

    suspend fun assignVehicle(id: Int, driverId: Int?): Result<VehicleDto> = withContext(Dispatchers.IO) {
        runCatching { api.assignVehicle(id, VehicleDriverRequest(driverId)) }
    }

    suspend fun startTrip(vehicleId: Int): Result<Int> = withContext(Dispatchers.IO) {
        runCatching { api.startTrip(StartTripRequest(vehicleId)).id }
    }

    /**
     * True when [finishTrip] failed with the "not active" 409 — the trip is
     * already COMPLETED/CANCELLED server-side, so local state must clear.
     */
    private fun isTripNotActive(e: Throwable?): Boolean =
        e?.message?.contains("not active", ignoreCase = true) == true ||
            e?.message?.contains("already finished", ignoreCase = true) == true

    /**
     * Finish the backend trip. Returns success for the normal 200 path AND for
     * the "trip was already finished/cancelled server-side" 409 (idempotent
     * local outcome — there is nothing left to finish remotely).
     */
    suspend fun finishTrip(tripId: Int): Result<Unit> = withContext(Dispatchers.IO) {
        val result = runCatching { api.finishTrip(tripId); Unit }
        result.recoverCatching { e ->
            if (isTripNotActive(e)) Unit else throw e
        }
    }

    suspend fun raiseSos(tripId: Int?, lat: Double, lng: Double): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching { api.raiseAlert(AlertRequest(tripId, "SOS", lat, lng, "Driver SOS")) }
        }

    /**
     * §7: a HARSH_BRAKING CANDIDATE from the on-device detector. Deliberately
     * labeled unvalidated — thresholds need real-world calibration before these
     * alerts are trusted operationally. Rides the existing alert flow.
     */
    suspend fun raiseHarshBrakingCandidate(tripId: Int?, lat: Double, lng: Double): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                api.raiseAlert(
                    AlertRequest(tripId, "HARSH_BRAKING", lat, lng, "Harsh-braking candidate (unvalidated — thresholds require calibration)"),
                )
            }
        }

    /** Called by TrackingService for every location fix (Phase 10 §3.6). */
    suspend fun enqueuePing(tripId: Int, lat: Double, lng: Double, speedKmh: Double, headingDeg: Double, accuracyM: Double) {
        withContext(Dispatchers.IO) {
            dao.enqueue(
                QueuedPingEntity(
                    tripId = tripId, idempotencyKey = UUID.randomUUID().toString(),
                    lat = lat, lng = lng, speedKmh = speedKmh, headingDeg = headingDeg,
                    accuracyM = accuracyM, recordedAt = System.currentTimeMillis(),
                )
            )
            // Queue-cap + downsampling (§3.6.3): if the queue exceeds the hard cap,
            // drop old low-value surplus keeping every Nth point rather than letting
            // on-device storage grow unbounded during a very long offline stretch.
            if (dao.pendingCount() > PING_QUEUE_HARD_CAP) {
                val deleteIds = downsampleDeleteIds(dao.allAscending())
                if (deleteIds.isNotEmpty()) dao.deleteByIds(deleteIds)
            }
        }
    }

    /**
     * Drains the offline queue via ONE batch API call (Phase 10, §3.6/§4.2) —
     * the backend accepts up to MAX_PING_BATCH=500 pings per request, so a long
     * offline backlog clears in a bounded number of HTTP round-trips instead of
     * one request per ping. Returns (sent, remaining). A server-reported failed
     * ping is annotated (sync_attempts/last_error) and stays queued; WorkManager
     * retries with backoff. A whole-request network failure marks every row in
     * the chunk and returns remaining > 0 so the worker retries. A TERMINAL
     * whole-request failure (404 Trip not found / 409 not active — see
     * [isTerminalTripGone]) drops the trip's queue so an orphaned trip can't
     * strand the sync and gate the current trip's pendingFinish completion.
     */
    suspend fun syncPending(tripId: Int): Pair<Int, Int> = withContext(Dispatchers.IO) {
        val batch = dao.pending(tripId, BATCH_LIMIT)
        if (batch.isEmpty()) return@withContext 0 to dao.pendingCount()

        val result = runCatching {
            api.sendPingBatch(
                tripId,
                PingBatchRequest(
                    pings = batch.map {
                        PingRequest(
                            idempotencyKey = it.idempotencyKey, lat = it.lat, lng = it.lng,
                            speedKmh = it.speedKmh, headingDeg = it.headingDeg,
                            accuracyM = it.accuracyM,
                            recordedAt = java.time.Instant.ofEpochMilli(it.recordedAt).toString(),
                        )
                    },
                ),
            )
        }

        when {
            result.isSuccess -> {
                val resp = result.getOrThrow()
                val errorByKey = resp.failed.associate { it.idempotencyKey to it.error }
                var sent = 0
                for (ping in batch) {
                    val error = errorByKey[ping.idempotencyKey]
                    if (error != null) {
                        dao.markSyncFailure(ping.id, error)
                    } else {
                        dao.deleteByIds(listOf(ping.id))
                        sent++
                    }
                }
                sent to dao.pendingCount()
            }
            // Whole-request TERMINAL failure: the backend will NEVER accept
            // these rows again, so they must not strand the queue.
            //   - HTTP 409 "not active / already finished": the trip is no
            //     longer ACTIVE server-side (already COMPLETED/CANCELLED) —
            //     trip 673 stranded its queue exactly like this.
            //   - HTTP 404 "Trip not found": an orphaned/foreign/deleted trip
            //     (e.g. stale rows synced under a different driver's token, or
            //     a trip the server pruned). Observed live: stale queued pings
            //     for an old trip returned 404 forever → syncAllPending stayed
            //     `remaining > 0` → SyncWorker RETRY-looped → the CURRENT
            //     trip's pendingFinish completion never fired.
            // Both drop the trip's queue and report the outcome.
            isTerminalTripGone(result.exceptionOrNull()) -> {
                lastSyncHadTerminalFailure = true
                dao.deleteByTripId(tripId)
                0 to dao.pendingCount()
            }
            else -> {
                val message = result.exceptionOrNull()?.message ?: "unknown error"
                batch.forEach { dao.markSyncFailure(it.id, message) }
                0 to dao.pendingCount()
            }
        }
    }

    /**
     * Drain EVERY trip's queue (fix for SYNC WORKER LIFECYCLE): the old
     * single-trip worker stranded old-trip rows whenever a new trip started.
     * Returns total sent and the FINAL queue depth.
     *
     * Remaining-depth semantics (instrumented-test finding, CPH2617): the old
     * implementation accumulated each trip's INTERMEDIATE pendingCount
     * snapshot, so a terminal drop late in the loop could never reduce an
     * earlier stale count — SyncWorker's `remaining <= 0` gate (pendingFinish
     * completion) saw phantom backlog and retried a run that had actually
     * drained everything. The caller's real question is "how many rows are
     * still queued RIGHT NOW" — answer it from the final DAO state.
     */
    suspend fun syncAllPending(): Pair<Int, Int> = withContext(Dispatchers.IO) {
        val tripIds = dao.pendingTripIds()
        var sent = 0
        for (tripId in tripIds) {
            val (s, _) = syncPending(tripId)
            sent += s
        }
        sent to dao.pendingCount()
    }

    // ---- Phase 9 screen data ----

    suspend fun listTrips(page: Int = 1): Result<TripsResponse> = withContext(Dispatchers.IO) {
        runCatching { api.trips(page) }
    }

    suspend fun getTrip(id: Int): Result<TripDetailDto> = withContext(Dispatchers.IO) {
        runCatching { api.trip(id) }
    }

    suspend fun getTripStats(id: Int): Result<TripStatsDto> = withContext(Dispatchers.IO) {
        runCatching { api.tripStats(id) }
    }

    suspend fun listAlerts(): Result<List<AlertDto>> = withContext(Dispatchers.IO) {
        runCatching { api.alerts().items }
    }

    suspend fun updateAlertStatus(id: Int, status: String): Result<AlertDto> = withContext(Dispatchers.IO) {
        runCatching { api.updateAlert(id, AlertStatusRequest(status)) }
    }

    suspend fun listActiveTrips(): Result<List<TripListItemDto>> = withContext(Dispatchers.IO) {
        runCatching { api.trips(page = 1, pageSize = 100, status = "ACTIVE").items }
    }

    suspend fun listGeofences(): Result<List<GeofenceDto>> = withContext(Dispatchers.IO) {
        runCatching { api.geofences().items }
    }

    suspend fun createGeofence(body: CreateGeofenceRequest): Result<GeofenceDto> = withContext(Dispatchers.IO) {
        runCatching { api.createGeofence(body) }
    }

    suspend fun setGeofenceActive(id: Int, active: Boolean): Result<GeofenceDto> = withContext(Dispatchers.IO) {
        runCatching { api.updateGeofence(id, UpdateGeofenceRequest(active)) }
    }

    suspend fun listAdminUsers(): Result<List<AdminUserDto>> = withContext(Dispatchers.IO) {
        runCatching { api.adminUsers().items }
    }

    suspend fun createDriver(email: String, name: String, password: String): Result<AdminUserDto> =
        withContext(Dispatchers.IO) {
            runCatching { api.createDriver(CreateDriverRequest(email, name, password)) }
        }

    suspend fun setUserDeactivated(id: Int, deactivated: Boolean): Result<AdminUserDto> =
        withContext(Dispatchers.IO) {
            runCatching { api.updateAdminUserStatus(id, UserStatusRequest(deactivated)) }
        }

    suspend fun listAuditLogs(): Result<List<AuditLogDto>> = withContext(Dispatchers.IO) {
        runCatching { api.auditLogs().items }
    }

    suspend fun me(): Result<UserDto> = withContext(Dispatchers.IO) {
        runCatching { api.me().user }
    }

    // ---- Notification prefs + push device tokens (blueprint §10/§3.3 Profile) ----

    /** Full per-alert-type toggle map (backend returns overrides only — merged
     *  against the all-enabled defaults by NotificationPrefs). */
    suspend fun listNotificationPrefs(): Result<Map<String, Boolean>> = withContext(Dispatchers.IO) {
        runCatching { NotificationPrefs.merged(api.notificationPrefs().prefs) }
    }

    suspend fun setNotificationPrefs(prefs: Map<String, Boolean>): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                api.updateNotificationPrefs(NotificationPrefsBody(prefs.map { NotificationPref(it.key, it.value) }))
                Unit
            }
        }

    suspend fun registerDeviceToken(token: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching { api.registerDeviceToken(DeviceTokenBody(token)); Unit }
    }

    suspend fun unregisterDeviceToken(token: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching { api.unregisterDeviceToken(token); Unit }
    }

    companion object {
        /** Backend MAX_PING_BATCH (middleware/validate.js) — keep the client chunk ≤ this. */
        const val BATCH_LIMIT = 500

        /** §3.6.3 on-device offline-queue hard cap; kept in parity with backend PING_QUEUE_HARD_CAP. */
        const val PING_QUEUE_HARD_CAP = 5000

        /**
         * §3.6.3 pure downsampling policy. [all] is the full queue ordered
         * oldest-first. Rows beyond the newest [cap] are oldest, low-value
         * surplus; of those we KEEP every [keepEvery]-th point (from the oldest)
         * and DELETE the rest. Under cap it is a no-op. Kept as a pure function so
         * the JVM unit test can lock the policy down without a database.
         */
        fun downsampleDeleteIds(
            all: List<QueuedPingEntity>,
            cap: Int = PING_QUEUE_HARD_CAP,
            keepEvery: Int = 3,
        ): List<Long> {
            if (all.size <= cap || keepEvery <= 1) return emptyList()
            val surplus = all.take(all.size - cap) // oldest rows beyond the newest `cap`
            return surplus.filterIndexed { index, _ -> index % keepEvery != 0 }.map { it.id }
        }

        /**
         * Terminal sync-failure classification. True when the backend can NEVER
         * accept these queued pings again, so the trip's queue can be dropped
         * instead of RETRY-looped forever (a stuck orphan would otherwise gate
         * `remaining <= 0` and block the CURRENT trip's pendingFinish).
         *   - HTTP 404 "Trip not found": orphaned/foreign/deleted trip
         *     (e.g. stale pings synced under a different driver's token, or a
         *     trip the server pruned). Unconditionally terminal.
         *   - HTTP 409 + "not active / already finished" (or a blank body):
         *     the trip is no longer ACTIVE server-side (COMPLETED/CANCELLED).
         * Kept as a pure function in the companion so the JVM unit test can
         * lock the policy down without a database.
         */
        internal fun isTerminalTripGone(e: Throwable?): Boolean {
            if (e !is retrofit2.HttpException) return false
            val code = e.code()
            if (code == 404) return true
            if (code != 409) return false
            val body = runCatching { e.response()?.errorBody()?.string() }.getOrNull().orEmpty()
            return body.contains("not active", ignoreCase = true) ||
                body.contains("already finished", ignoreCase = true) ||
                body.isBlank()
        }
    }
}
